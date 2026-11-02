import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestValue, encode, hash, keys } from "../../ledger/validation.ts";
import { freezeSnapshot } from "../../research/evidence.ts";
import { runProcess } from "../../workers/process.ts";
import type { ProcessResult } from "../../workers/process.ts";
import { parseReplayJson, replayAbsolute, replayArray, replayError, replayInteger, replayJson, replayRelative, replayText, replayUnique } from "./replay-validation.ts";

const manifestText = readFileSync(new URL("./observed-replay-source-manifest.json", import.meta.url), "utf8");
export const OBSERVED_REPLAY_SOURCE_MANIFEST = freezeSnapshot(JSON.parse(manifestText) as unknown);
export const OBSERVED_REPLAY_SOURCE_SHA256 = hash(OBSERVED_REPLAY_SOURCE_MANIFEST);
export const OBSERVED_REPLAY_LIMITS = Object.freeze({ requestBytes: 65_536, outputBytes: 1_048_576,
  resultBytes: 16_777_216, traceBytes: 67_108_864, provenanceBytes: 262_144, timeoutMs: 60_000 });
const REPLAY_REJECTIONS = ["artifact_mismatch", "artifact_read_failed", "invalid_json", "invalid_request", "native_import_failed",
  "native_replay_rejected", "provenance_invalid", "reader_unavailable", "record_ambiguous", "record_missing", "runtime_unavailable",
  "side_effect_denied", "size_limit", "source_changed", "source_mismatch", "source_read_failed", "unsafe_path", "unsupported_config", "worker_failed"];

export interface ReplayFile { path: string; sha256: string; bytes: number }
export interface ObservedReplayRequest {
  schemaVersion: 1; kind: "coworker-observed-replay"; sourceRoot: string; artifactRoot: string;
  sourceManifestSha256: string; episode: { configId: string; seed: number };
  result: ReplayFile & { resultId: string }; trace: ReplayFile & { traceId: string }; provenance: ReplayFile;
  requestDigest: string;
}
function validateFile(raw: unknown, max: number, selector?: "resultId" | "traceId"): void {
  keys(raw, ["path", "sha256", "bytes", ...(selector ? [selector] : [])]);
  replayRelative(raw.path); digestValue(raw.sha256); replayInteger(raw.bytes, max, 1);
  if (selector) replayText(raw[selector]);
}
export function prepareObservedReplayRequest(raw: unknown): ObservedReplayRequest {
  const v = replayJson(raw, OBSERVED_REPLAY_LIMITS.requestBytes);
  const fields = ["schemaVersion", "kind", "sourceRoot", "artifactRoot", "sourceManifestSha256", "episode", "result", "trace", "provenance"];
  keys(v, [...fields, "requestDigest"], fields.filter(k => k !== "schemaVersion" && k !== "kind"));
  if ((v.schemaVersion !== undefined && v.schemaVersion !== 1) || (v.kind !== undefined && v.kind !== "coworker-observed-replay")) replayError("unsupported request");
  replayAbsolute(v.sourceRoot); replayAbsolute(v.artifactRoot);
  if (v.sourceManifestSha256 !== OBSERVED_REPLAY_SOURCE_SHA256) replayError("unsupported source manifest");
  keys(v.episode, ["configId", "seed"]); replayText(v.episode.configId, 256); replayInteger(v.episode.seed, 2_147_483_647);
  validateFile(v.result, OBSERVED_REPLAY_LIMITS.resultBytes, "resultId");
  validateFile(v.trace, OBSERVED_REPLAY_LIMITS.traceBytes, "traceId");
  validateFile(v.provenance, OBSERVED_REPLAY_LIMITS.provenanceBytes);
  replayUnique([v.result, v.trace, v.provenance].map(f => (f as ReplayFile).path));
  const input = { schemaVersion: 1 as const, kind: "coworker-observed-replay" as const, sourceRoot: v.sourceRoot, artifactRoot: v.artifactRoot,
    sourceManifestSha256: v.sourceManifestSha256, episode: v.episode, result: v.result, trace: v.trace, provenance: v.provenance };
  const requestDigest = hash(input);
  if (v.requestDigest !== undefined && v.requestDigest !== requestDigest) replayError("request digest mismatch");
  return freezeSnapshot({ ...input, requestDigest }) as ObservedReplayRequest;
}
export function replayWorkerInput(raw: ObservedReplayRequest) {
  const { requestDigest: _digest, ...input } = prepareObservedReplayRequest(raw);
  return freezeSnapshot(input);
}

export interface ReplayWorldFact { id: string; label: string; value: string; unit: string; aliases: string[]; sourceId: string;
  definition: string; period: string; population: string; denominator: string }
export interface ReplayObservation {
  inputs: { result: ReplayFile & { resultId: string; recordLine: number; recordSha256: string };
    trace: ReplayFile & { traceId: string; recordLine: number; recordSha256: string }; provenance: ReplayFile };
  episode: { configId: string; seed: number; worldFingerprint: string };
  memo: string; memoSha256: string; brief: string; publicTask: string; worldFacts: ReplayWorldFact[]; worldFactsSha256: string;
  requiredFactIds: string[]; requiredFactsSha256: string; sourceBindings: Record<string, string>;
  facts: { id: string; nativeCredit: boolean | null; error: null | "scorer_exception" | "invalid_verdict";
    authorizedObserved: boolean; witnessMessageIds: string[]; observedCredit: boolean | null }[];
  evidence: { messageId: string; sourceId: string; factIds: string[]; contentSha256: string }[];
  readPages: { turnIndex: number; channelKind: "public" | "private"; coworker: string | null; page: number;
    hasOlder: boolean; messageIds: string[]; callId: string; subsequentInferenceIndex: number; subsequentRequestSha256: string }[];
  observedMessages: { messageId: string; sourceId: string | null; sender: string; text: string;
    channelKind: "public" | "private"; isPolicyMessage: boolean }[];
  terminal: { valid: boolean; status: "valid" | "invalid_policy" };
  arrivalBasis: "validated_state_reconstruction"; semanticEvaluation: "unassessed";
  taskSuccess: "unassessed"; scientificEvaluation: "unassessed";
  importedSourceModules: { name: string; path: string; sha256: string }[];
}
export interface ObservedReplayOutput {
  schemaVersion: 1; kind: "coworker-observed-replay-result"; status: "completed" | "rejected";
  inputDigest: string | null; sourceManifestSha256: string; pythonVersion: string; reason: string | null;
  result: ReplayObservation | null;
}
export interface ObservedReplayDescriptor {
  name: "coworker-observed-replay"; version: 1; sourceSha256: string; sourceManifestSha256: string;
  pythonExecutable: string; timeoutMs: number; maxOutputBytes: 1048576;
}
export interface ObservedReplayExecution {
  schemaVersion: 1; kind: "coworker-observed-replay-execution"; requestDigest: string; descriptor: ObservedReplayDescriptor;
  status: "completed" | "incomplete"; reason: string;
  process: { exitCode: number | null; stopped: ProcessResult["stopped"]; stdoutSha256: string; stdoutBytes: number; stderrSha256: string; stderrBytes: number };
  cleanup: { status: "removed" | "pending"; path: string | null };
  output: ObservedReplayOutput | null;
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function equal(a: unknown, b: unknown): void { if (hash(a) !== hash(b)) replayError("identity mismatch"); }
function strings(raw: unknown, max: number): asserts raw is string[] { replayArray(raw, max); raw.forEach(v => replayText(v)); replayUnique(raw as string[]); }
function boolean(raw: unknown): asserts raw is boolean { if (typeof raw !== "boolean") replayError("expected boolean"); }
function multiline(raw: unknown, max: number): asserts raw is string {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) replayError("invalid bounded content");
}
function channel(raw: unknown): asserts raw is "public" | "private" { if (raw !== "public" && raw !== "private") replayError("invalid channel"); }
const sortedFacts = (facts: ReplayWorldFact[]) => [...facts].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Validate mechanical observations without converting their agreement into scientific approval. */
export function validateObservedReplayResult(raw: unknown, requestRaw: ObservedReplayRequest): ObservedReplayOutput {
  const request = prepareObservedReplayRequest(requestRaw), v = replayJson(raw, OBSERVED_REPLAY_LIMITS.outputBytes);
  keys(v, ["schemaVersion", "kind", "status", "inputDigest", "sourceManifestSha256", "pythonVersion", "reason", "result"]);
  if (v.schemaVersion !== 1 || v.kind !== "coworker-observed-replay-result" || v.sourceManifestSha256 !== request.sourceManifestSha256) replayError("result source mismatch");
  if (typeof v.pythonVersion !== "string" || !/^3\.\d+\.\d+$/.test(v.pythonVersion)) replayError("invalid Python version");
  if (v.status === "rejected") {
    replayText(v.reason, 80);
    if (!REPLAY_REJECTIONS.includes(v.reason) || v.result !== null || (v.inputDigest !== request.requestDigest && !(v.inputDigest === null && v.reason === "runtime_unavailable"))) replayError("rejected result mismatch");
    return freezeSnapshot(v) as unknown as ObservedReplayOutput;
  }
  if (v.status !== "completed" || v.reason !== null || v.inputDigest !== request.requestDigest || Number(v.pythonVersion.split(".")[1]) < 11) replayError("invalid completion");
  const r = v.result;
  keys(r, ["inputs", "episode", "memo", "memoSha256", "brief", "publicTask", "worldFacts", "worldFactsSha256", "requiredFactIds", "requiredFactsSha256", "sourceBindings", "facts", "evidence", "readPages", "observedMessages", "terminal", "arrivalBasis", "semanticEvaluation", "taskSuccess", "scientificEvaluation", "importedSourceModules"]);
  keys(r.inputs, ["result", "trace", "provenance"]);
  for (const kind of ["result", "trace"] as const) {
    const f = r.inputs[kind], field = kind === "result" ? "resultId" : "traceId";
    keys(f, ["path", "sha256", "bytes", field, "recordLine", "recordSha256"]);
    const { recordLine, recordSha256, ...reference } = f;
    equal(reference, request[kind]); replayInteger(recordLine, 1000, 1); digestValue(recordSha256);
  }
  equal(r.inputs.provenance, request.provenance);
  keys(r.episode, ["configId", "seed", "worldFingerprint"]);
  if (r.episode.configId !== request.episode.configId || r.episode.seed !== request.episode.seed) replayError("episode mismatch");
  digestValue(r.episode.worldFingerprint);
  multiline(r.memo, 131_072); if (r.memoSha256 !== sha(r.memo)) replayError("memo digest mismatch");
  multiline(r.brief, 131_072); multiline(r.publicTask, 131_072);
  if (r.arrivalBasis !== "validated_state_reconstruction" || r.semanticEvaluation !== "unassessed" || r.taskSuccess !== "unassessed" || r.scientificEvaluation !== "unassessed") replayError("unsupported scientific claim");
  keys(r.terminal, ["valid", "status"]); boolean(r.terminal.valid);
  if (r.terminal.status !== (r.terminal.valid ? "valid" : "invalid_policy") || (!r.terminal.valid && r.memo !== "")) replayError("terminal status mismatch");
  keys(r.sourceBindings, Object.keys(r.sourceBindings && typeof r.sourceBindings === "object" ? r.sourceBindings : {}));
  if (Object.keys(r.sourceBindings).length > 256) replayError("source limit");
  for (const [id, name] of Object.entries(r.sourceBindings)) { replayText(id); replayText(name); }
  replayArray(r.worldFacts, 256);
  for (const fact of r.worldFacts) {
    keys(fact, ["id", "label", "value", "unit", "aliases", "sourceId", "definition", "period", "population", "denominator"]);
    replayText(fact.id); replayText(fact.label); replayText(fact.value, 1024); replayText(fact.unit, 64, true); replayText(fact.sourceId);
    for (const field of ["definition", "period", "population", "denominator"]) multiline(fact[field], 8192);
    strings(fact.aliases, 64); if (!fact.aliases.length || !Object.hasOwn(r.sourceBindings, fact.sourceId)) replayError("fact source or aliases absent");
  }
  const world = r.worldFacts as unknown as ReplayWorldFact[];
  replayUnique(world.map(f => f.id));
  const byId = new Map(world.map(f => [f.id, f]));
  strings(r.requiredFactIds, 64);
  if (!r.requiredFactIds.length || r.requiredFactIds.some(id => !byId.has(id))) replayError("required fact missing");
  if (r.worldFactsSha256 !== hash(sortedFacts(world)) || r.requiredFactsSha256 !== hash(sortedFacts(r.requiredFactIds.map(id => byId.get(id)!)))) replayError("fact definition digest mismatch");
  replayArray(r.observedMessages, 2048);
  for (const message of r.observedMessages) {
    keys(message, ["messageId", "sourceId", "sender", "text", "channelKind", "isPolicyMessage"]);
    replayText(message.messageId); replayText(message.sender); multiline(message.text, 131_072); channel(message.channelKind); boolean(message.isPolicyMessage);
    if (message.sourceId !== null) { replayText(message.sourceId); if (r.sourceBindings[message.sourceId] !== message.sender || message.isPolicyMessage) replayError("unknown message source"); }
  }
  const messages = r.observedMessages as unknown as ReplayObservation["observedMessages"];
  replayUnique(messages.map(m => m.messageId)); const messagesById = new Map(messages.map(m => [m.messageId, m]));
  replayArray(r.readPages, 128);
  for (const page of r.readPages) {
    keys(page, ["turnIndex", "channelKind", "coworker", "page", "hasOlder", "messageIds", "callId", "subsequentInferenceIndex", "subsequentRequestSha256"]);
    replayInteger(page.turnIndex, 127); replayInteger(page.subsequentInferenceIndex, 128, 1);
    if (page.subsequentInferenceIndex !== page.turnIndex + 1) replayError("missing subsequent inference");
    channel(page.channelKind); if (page.coworker !== null) replayText(page.coworker);
    if ((page.channelKind === "public") !== (page.coworker === null)) replayError("page channel mismatch");
    replayInteger(page.page, Number.MAX_SAFE_INTEGER); boolean(page.hasOlder); strings(page.messageIds, 2048); replayText(page.callId); digestValue(page.subsequentRequestSha256);
    if (page.messageIds.some(id => !messagesById.has(id) || messagesById.get(id)!.channelKind !== page.channelKind)) replayError("unbound page message");
    if (page.channelKind === "private" && page.messageIds.some(id => {
      const message = messagesById.get(id)!;
      return message.sourceId !== null && message.sender !== page.coworker;
    })) replayError("private page owner mismatch");
  }
  const pages = r.readPages as unknown as ReplayObservation["readPages"];
  replayUnique(pages.map(p => String(p.turnIndex))); replayUnique(pages.map(p => p.callId));
  const seen = new Set(pages.flatMap(p => p.messageIds));
  if (messages.some(m => !seen.has(m.messageId))) replayError("unobserved context message");
  replayArray(r.evidence, 2048);
  for (const evidence of r.evidence) {
    keys(evidence, ["messageId", "sourceId", "factIds", "contentSha256"]); replayText(evidence.messageId); replayText(evidence.sourceId); strings(evidence.factIds, 256); digestValue(evidence.contentSha256);
    const message = messagesById.get(evidence.messageId);
    if (!message || !seen.has(message.messageId) || message.isPolicyMessage || message.channelKind !== "private" || message.sourceId !== evidence.sourceId || evidence.contentSha256 !== sha(message.text) || !evidence.factIds.length) replayError("incomplete authorized observation witness");
    if (evidence.factIds.some(id => byId.get(id)?.sourceId !== evidence.sourceId)) replayError("unowned fact evidence");
  }
  const evidence = r.evidence as unknown as ReplayObservation["evidence"];
  replayUnique(evidence.map(e => e.messageId));
  replayArray(r.facts, 64);
  if (r.facts.length !== r.requiredFactIds.length) replayError("required denominator mismatch");
  r.facts.forEach((fact: unknown, i: number) => {
    keys(fact, ["id", "nativeCredit", "error", "authorizedObserved", "witnessMessageIds", "observedCredit"]);
    if (fact.id !== (r.requiredFactIds as string[])[i]) replayError("required fact order mismatch");
    const scored = typeof fact.nativeCredit === "boolean" && fact.error === null;
    const failed = fact.nativeCredit === null && ["scorer_exception", "invalid_verdict"].includes(fact.error as string);
    if (!scored && !failed) replayError("invalid native verdict");
    boolean(fact.authorizedObserved); strings(fact.witnessMessageIds, 2048);
    const witnesses = evidence.filter(e => e.factIds.includes(fact.id as string)).map(e => e.messageId);
    equal([...fact.witnessMessageIds].sort(), [...witnesses].sort());
    if (fact.authorizedObserved !== Boolean(witnesses.length) || fact.observedCredit !== (scored ? fact.authorizedObserved && fact.nativeCredit : null)) replayError("credit witness mismatch");
  });
  replayArray(r.importedSourceModules, 150);
  const manifest = OBSERVED_REPLAY_SOURCE_MANIFEST as { files: { path: string; sha256: string }[] };
  const sources = new Map(manifest.files.map(f => [f.path, f.sha256]));
  for (const entry of r.importedSourceModules) {
    keys(entry, ["name", "path", "sha256"]); replayText(entry.name); replayRelative(entry.path); digestValue(entry.sha256);
    const modulePath = entry.name.replaceAll(".", "/");
    if (!/^probing(?:\.[A-Za-z_]\w*)*$/.test(entry.name) || ![`${modulePath}.py`, `${modulePath}/__init__.py`].includes(entry.path) || sources.get(entry.path) !== entry.sha256) replayError("unbound imported source");
  }
  const imports = r.importedSourceModules as unknown as ReplayObservation["importedSourceModules"];
  replayUnique(imports.map(m => m.name)); replayUnique(imports.map(m => m.path));
  if (!imports.some(m => m.name === "probing.completion_bridge") || !imports.some(m => m.name === "probing.extraction") || !imports.some(m => m.name === "probing.catalog")) replayError("missing native imports");
  return freezeSnapshot(v) as unknown as ObservedReplayOutput;
}

export function validateObservedReplayDescriptor(raw: unknown): ObservedReplayDescriptor {
  const v = replayJson(raw, 8192); keys(v, ["name", "version", "sourceSha256", "sourceManifestSha256", "pythonExecutable", "timeoutMs", "maxOutputBytes"]);
  if (v.name !== "coworker-observed-replay" || v.version !== 1 || v.sourceManifestSha256 !== OBSERVED_REPLAY_SOURCE_SHA256 || v.maxOutputBytes !== OBSERVED_REPLAY_LIMITS.outputBytes) replayError("unsupported worker descriptor");
  digestValue(v.sourceSha256); replayAbsolute(v.pythonExecutable); replayInteger(v.timeoutMs, OBSERVED_REPLAY_LIMITS.timeoutMs, 1);
  return freezeSnapshot(v) as unknown as ObservedReplayDescriptor;
}
export function validateObservedReplayExecution(raw: unknown, requestRaw: ObservedReplayRequest, descriptorRaw: ObservedReplayDescriptor): ObservedReplayExecution {
  const request = prepareObservedReplayRequest(requestRaw), descriptor = validateObservedReplayDescriptor(descriptorRaw), v = replayJson(raw, 1_200_000);
  keys(v, ["schemaVersion", "kind", "requestDigest", "descriptor", "status", "reason", "process", "cleanup", "output"]);
  if (v.schemaVersion !== 1 || v.kind !== "coworker-observed-replay-execution" || v.requestDigest !== request.requestDigest) replayError("execution identity mismatch");
  equal(v.descriptor, descriptor); replayText(v.reason, 80);
  keys(v.cleanup, ["status", "path"]);
  if (v.cleanup.status === "pending") replayAbsolute(v.cleanup.path);
  else if (v.cleanup.status !== "removed" || v.cleanup.path !== null) replayError("invalid staging cleanup status");
  keys(v.process, ["exitCode", "stopped", "stdoutSha256", "stdoutBytes", "stderrSha256", "stderrBytes"]);
  if (v.process.exitCode !== null) replayInteger(v.process.exitCode, 255);
  if (![null, "timeout", "cancelled", "output_limit", "spawn_error"].includes(v.process.stopped as null)) replayError("unknown process outcome");
  digestValue(v.process.stdoutSha256); digestValue(v.process.stderrSha256);
  replayInteger(v.process.stdoutBytes, descriptor.maxOutputBytes); replayInteger(v.process.stderrBytes, descriptor.maxOutputBytes);
  if (v.process.stdoutBytes + v.process.stderrBytes > descriptor.maxOutputBytes) replayError("combined output bound");
  const output = v.output === null ? null : validateObservedReplayResult(v.output, request);
  if (v.status === "completed") {
    if (v.reason !== "completed" || v.process.exitCode !== 0 || v.process.stopped !== null || output?.status !== "completed") replayError("incomplete native execution");
  } else if (v.status !== "incomplete" || output?.status === "completed" || v.reason === "completed") replayError("invalid incomplete execution");
  else if (output && (v.process.stopped !== null || v.process.exitCode !== 2 || v.reason !== output.reason)) replayError("rejection process mismatch");
  else if (!output && v.reason !== (v.process.stopped ?? (v.process.exitCode === 0 ? "invalid_worker_result" : "worker_failed"))) replayError("failure reason mismatch");
  return freezeSnapshot(v) as unknown as ObservedReplayExecution;
}

/** Captures the exact wrapper and reviewed source registry before the caller persists intent. */
export function createObservedReplayWorker(options: { pythonExecutable: string; timeoutMs?: number },
  removeScratch: (path: string) => Promise<void> = path => rm(path, { recursive: true, force: true })) {
  const template = readFileSync(new URL("./observed-replay-worker.py", import.meta.url), "utf8");
  const marker = "__COWORKER_OBSERVED_REPLAY_MANIFEST_LITERAL__";
  if (template.split(marker).length !== 2) replayError("worker registry marker mismatch");
  const source = template.replace(marker, JSON.stringify(encode(OBSERVED_REPLAY_SOURCE_MANIFEST)));
  const descriptor = validateObservedReplayDescriptor({ name: "coworker-observed-replay", version: 1, sourceSha256: sha(source),
    sourceManifestSha256: OBSERVED_REPLAY_SOURCE_SHA256, pythonExecutable: options.pythonExecutable, timeoutMs: options.timeoutMs ?? 60_000, maxOutputBytes: OBSERVED_REPLAY_LIMITS.outputBytes });
  return Object.freeze({ descriptor, async run(raw: ObservedReplayRequest, signal?: AbortSignal): Promise<ObservedReplayExecution> {
    const request = prepareObservedReplayRequest(raw);
    // Parent cleanup also runs when timeout/cancellation kills Python before its finally block.
    // A controller crash can still leave this private source-only staging directory behind.
    const scratch = await mkdtemp(join(tmpdir(), "rlh-replay-owner-"));
    let p: ProcessResult;
    let cleanup: ObservedReplayExecution["cleanup"] = { status: "removed", path: null };
    try {
      p = await runProcess({ executable: descriptor.pythonExecutable, args: ["-I", "-S", "-B", "-c", source], cwd: "/", env: { PATH: "/usr/bin:/bin", TMPDIR: await realpath(scratch) },
        input: encode(replayWorkerInput(request)), timeoutMs: descriptor.timeoutMs, maxOutputBytes: descriptor.maxOutputBytes, ...(signal ? { signal } : {}) });
    } finally {
      try { await removeScratch(scratch); }
      catch { cleanup = { status: "pending", path: scratch }; }
    }
    let output: ObservedReplayOutput | null = null, reason: string = p.stopped ?? (p.exitCode === 0 ? "invalid_worker_result" : "worker_failed");
    if (!p.stopped && (p.exitCode === 0 || p.exitCode === 2)) {
      try {
        const parsed = validateObservedReplayResult(parseReplayJson(p.stdout, descriptor.maxOutputBytes), request);
        if ((parsed.status === "completed" && p.exitCode === 0) || (parsed.status === "rejected" && p.exitCode === 2)) { output = parsed; reason = parsed.status === "completed" ? "completed" : parsed.reason!; }
      } catch { /* Preserve failure and output hashes, never malformed evidence. */ }
    }
    return validateObservedReplayExecution({ schemaVersion: 1, kind: "coworker-observed-replay-execution", requestDigest: request.requestDigest, descriptor,
      status: output?.status === "completed" ? "completed" : "incomplete", reason,
      process: { exitCode: p.exitCode, stopped: p.stopped, stdoutSha256: sha(p.stdout), stdoutBytes: Buffer.byteLength(p.stdout), stderrSha256: sha(p.stderr), stderrBytes: Buffer.byteLength(p.stderr) }, cleanup, output }, request, descriptor);
  } });
}
