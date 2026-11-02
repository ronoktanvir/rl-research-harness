import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { hash, keys } from "../../ledger/validation.ts";
import { freezeSnapshot } from "../../research/evidence.ts";
import { createObservedReplayWorker, prepareObservedReplayRequest, validateObservedReplayDescriptor, validateObservedReplayExecution } from "./observed-replay.ts";
import type { ObservedReplayDescriptor, ObservedReplayExecution, ObservedReplayRequest } from "./observed-replay.ts";
import { parseReplayJson, replayError } from "./replay-validation.ts";

interface ReplayIntent { schemaVersion: 1; kind: "coworker-observed-replay-intent"; createdAt: string;
  request: ObservedReplayRequest; descriptor: ObservedReplayDescriptor; replaySupported: false }
const bytesHash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Local artifact roots are operator-trusted. Leaves must be stable, singly linked regular files. */
async function readText(path: string, max: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > max) replayError("invalid artifact file");
    const data = Buffer.alloc(max + 1); let size = 0;
    while (size < data.length) {
      const { bytesRead } = await file.read(data, size, data.length - size, size);
      if (!bytesRead) break; size += bytesRead;
    }
    const after = await file.stat();
    if (size !== before.size || size > max || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.nlink !== 1) replayError("artifact changed during read");
    return new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, size));
  } finally { await file.close(); }
}
export async function readObservedReplayJson(path: string, max = 65_536): Promise<unknown> {
  if (!Number.isSafeInteger(max) || max < 1 || max > 1_500_000) replayError("invalid artifact read limit");
  return parseReplayJson(await readText(path, max), max);
}
async function saveText(path: string, text: string): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
}
const jsonText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
async function existingDirectory(path: string): Promise<string> {
  const directory = resolve(path), info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) replayError("expected artifact directory");
  // Resolve only the operator-selected parent path; source/artifact inputs are not followed here.
  return realpath(directory);
}
function reportFor(execution: ObservedReplayExecution): string {
  const result = execution.output?.result;
  return `# CoworkerRL observed replay\n\nExecution: **${execution.status}** (${execution.reason}).\n\n` +
    `Temporary source staging cleanup: ${execution.cleanup.status}.\n\n` +
    `Request: \`${execution.requestDigest}\`. Source manifest: \`${execution.descriptor.sourceManifestSha256}\`.\n\n` +
    (result ? `Native terminal status: ${result.terminal.status}. Required facts: ${result.requiredFactIds.length}. ` +
      `Authorized observed facts: ${result.facts.filter(f => f.authorizedObserved).length}. ` +
      `Observed numeric credits: ${result.facts.filter(f => f.observedCredit === true).length}. ` +
      `Scorer errors: ${result.facts.filter(f => f.error !== null).length}.\n\n` +
      `Memo SHA256: \`${result.memoSha256}\`. Required fact definitions: \`${result.requiredFactsSha256}\`.\n\n`
      : "No complete native replay was accepted. Failure is not a negative policy outcome.\n\n") +
    "Semantic evaluation, task success and scientific evaluation remain unassessed. Reconstructed message IDs are validated state reconstruction, not historical execution custody. Private task, memo, world and observation content is retained in execution.json.\n";
}
function receiptFor(intent: ReplayIntent, execution: ObservedReplayExecution, report: string) {
  const body = { schemaVersion: 1, kind: "coworker-observed-replay-receipt", requestDigest: intent.request.requestDigest,
    intentDigest: hash(intent), executionDigest: hash(execution), reportSha256: bytesHash(report), status: execution.status,
    scientificEvaluation: "unassessed", artifacts: ["intent.json", "execution.json", "report.md"] };
  return { ...body, digest: hash(body) };
}
async function readAttempt(directory: string) {
  const raw = await readObservedReplayJson(join(directory, "intent.json"), 80_000);
  keys(raw, ["schemaVersion", "kind", "createdAt", "request", "descriptor", "replaySupported"]);
  if (raw.schemaVersion !== 1 || raw.kind !== "coworker-observed-replay-intent" || raw.replaySupported !== false || typeof raw.createdAt !== "string" || !/^\d{4}-\d\d-\d\dT/.test(raw.createdAt) || !Number.isFinite(Date.parse(raw.createdAt))) replayError("invalid saved intent");
  const request = prepareObservedReplayRequest(raw.request), descriptor = validateObservedReplayDescriptor(raw.descriptor);
  if (hash(raw.request) !== hash(request)) replayError("saved request is not normalized");
  const intent = freezeSnapshot(raw) as unknown as ReplayIntent;
  const execution = validateObservedReplayExecution(await readObservedReplayJson(join(directory, "execution.json"), 1_500_000), request, descriptor);
  return { intent, execution };
}
function projection(directory: string, intent: ReplayIntent, execution: ObservedReplayExecution) {
  const result = execution.output?.result;
  return freezeSnapshot({ status: execution.status, reason: execution.reason, requestDigest: intent.request.requestDigest,
    cleanupStatus: execution.cleanup.status,
    executionDigest: hash(execution), requiredFacts: result?.requiredFactIds.length ?? null,
    authorizedObservedFacts: result?.facts.filter(f => f.authorizedObserved).length ?? null,
    observedNumericCredits: result?.facts.filter(f => f.observedCredit === true).length ?? null,
    terminalStatus: result?.terminal.status ?? null, semanticEvaluation: "unassessed", taskSuccess: "unassessed", scientificEvaluation: "unassessed",
    artifacts: { directory, report: join(directory, "report.md"), execution: join(directory, "execution.json"), receipt: join(directory, "receipt.json") } });
}

/** Reopens a completed bundle without reading original source/input files or spawning any process. */
export async function loadObservedReplayArtifacts(path: string) {
  const directory = await existingDirectory(path), { intent, execution } = await readAttempt(directory);
  const report = await readText(join(directory, "report.md"), 16_384);
  if (report !== reportFor(execution)) replayError("saved report differs from derived observations");
  const receipt = await readObservedReplayJson(join(directory, "receipt.json"), 8192);
  if (hash(receipt) !== hash(receiptFor(intent, execution, report))) replayError("receipt mismatch");
  return freezeSnapshot({ intent, execution, summary: projection(directory, intent, execution) });
}

/** Repairs only missing projections after a validated execution was saved. Never reruns native work. */
export async function recoverObservedReplayArtifacts(path: string) {
  const directory = await existingDirectory(path), { intent, execution } = await readAttempt(directory);
  const report = reportFor(execution), receipt = jsonText(receiptFor(intent, execution, report));
  for (const [name, text] of [["report.md", report], ["receipt.json", receipt]] as const) {
    try { await saveText(join(directory, name), text); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readText(join(directory, name), 16_384) !== text) throw error;
    }
  }
  return loadObservedReplayArtifacts(directory);
}

export async function runObservedReplayToArtifacts(raw: unknown, options: { pythonExecutable: string; timeoutMs?: number; signal?: AbortSignal }, outputDirectory: string) {
  const request = prepareObservedReplayRequest(raw), worker = createObservedReplayWorker(options), signal = options.signal;
  const directory = resolve(outputDirectory);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const intent: ReplayIntent = { schemaVersion: 1, kind: "coworker-observed-replay-intent", createdAt: new Date().toISOString(),
    request, descriptor: worker.descriptor, replaySupported: false };
  await saveText(join(directory, "intent.json"), jsonText(intent));
  const execution = await worker.run(request, signal);
  await saveText(join(directory, "execution.json"), jsonText(execution));
  return (await recoverObservedReplayArtifacts(directory)).summary;
}
