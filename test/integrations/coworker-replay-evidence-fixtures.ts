/** Synthetic validation/persistence fixtures. Never runs Python or native CoworkeRL. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { encode, hash } from "../../src/ledger/validation.ts";
import { OBSERVED_REPLAY_SOURCE_MANIFEST, prepareObservedReplayRequest } from "../../src/integrations/coworker/observed-replay.ts";
import type { ObservedReplayDescriptor, ObservedReplayExecution, ObservedReplayOutput, ReplayObservation } from "../../src/integrations/coworker/observed-replay.ts";
import { recoverObservedReplayArtifacts, validateObservedReplayBundle } from "../../src/integrations/coworker/observed-replay-artifacts.ts";
import { importCoworkerReplayEvidence } from "../../src/integrations/coworker/replay-evidence.ts";
import type { ReplayEvidenceRequest } from "../../src/integrations/coworker/replay-evidence.ts";

export interface ReplayEvidenceFixtureOptions {
  status?: "completed" | "rejected" | "cancelled";
  mutateObservation?: (result: ReplayObservation) => void;
}
export const replayFixtureSha = (value: string) => createHash("sha256").update(value).digest("hex");

export async function writeReplayEvidenceBundle(directory: string, options: ReplayEvidenceFixtureOptions = {}) {
  const sourceManifestSha256 = hash(OBSERVED_REPLAY_SOURCE_MANIFEST);
  const request = prepareObservedReplayRequest({ sourceRoot: "/missing/native/source", artifactRoot: "/missing/native/inputs",
    sourceManifestSha256, episode: { configId: "m3-covenant-recheck", seed: 7 },
    result: { path: "results.jsonl", sha256: "a".repeat(64), bytes: 100, resultId: "result-1" },
    trace: { path: "traces.jsonl", sha256: "b".repeat(64), bytes: 200, traceId: "trace-1" },
    provenance: { path: "provenance.json", sha256: "c".repeat(64), bytes: 300 } });
  const worldFacts = [
    { id: "cash", label: "Cash", value: "$5M", unit: "money", aliases: ["Cash"], sourceId: "finance-source", definition: "Cash balance", period: "FY2026", population: "Company", denominator: "" },
    { id: "debt", label: "Debt", value: "$20M", unit: "money", aliases: ["Debt"], sourceId: "finance-source", definition: "Debt outstanding", period: "FY2026", population: "Company", denominator: "" },
  ];
  const memo = "PRIVATE-MEMO: The draft states debt is $20M. That statement is false.", message = "PRIVATE-OBSERVATION: Debt is $20M.";
  const manifest = OBSERVED_REPLAY_SOURCE_MANIFEST as { files: Array<{ path: string; sha256: string }> };
  const result: ReplayObservation = {
    inputs: { result: { ...request.result, recordLine: 1, recordSha256: "d".repeat(64) }, trace: { ...request.trace, recordLine: 1, recordSha256: "e".repeat(64) }, provenance: { ...request.provenance } },
    episode: { ...request.episode, worldFingerprint: "f".repeat(64) }, memo, memoSha256: replayFixtureSha(memo), brief: "PRIVATE-BRIEF: synthetic task.", publicTask: "Synthetic task.",
    worldFacts, worldFactsSha256: hash(worldFacts), requiredFactIds: ["debt", "cash"], requiredFactsSha256: hash(worldFacts),
    sourceBindings: { "finance-source": "Alice" },
    facts: [
      { id: "debt", nativeCredit: true, error: null, authorizedObserved: true, witnessMessageIds: ["mem-000001"], observedCredit: true },
      { id: "cash", nativeCredit: false, error: null, authorizedObserved: false, witnessMessageIds: [], observedCredit: false },
    ], evidence: [{ messageId: "mem-000001", sourceId: "finance-source", factIds: ["debt"], contentSha256: replayFixtureSha(message) }],
    readPages: [{ turnIndex: 2, channelKind: "private", coworker: "Alice", page: 0, hasOlder: false, messageIds: ["mem-000001"], callId: "read-2", subsequentInferenceIndex: 3, subsequentRequestSha256: "1".repeat(64) }],
    observedMessages: [{ messageId: "mem-000001", sourceId: "finance-source", sender: "Alice", text: message, channelKind: "private", isPolicyMessage: false }],
    terminal: { valid: true, status: "valid" }, arrivalBasis: "validated_state_reconstruction", semanticEvaluation: "unassessed", taskSuccess: "unassessed", scientificEvaluation: "unassessed",
    importedSourceModules: ["catalog", "completion_bridge", "extraction"].map(name => { const path = `probing/${name}.py`; return { name: `probing.${name}`, path, sha256: manifest.files.find(file => file.path === path)!.sha256 }; }),
  };
  options.mutateObservation?.(result);
  const status = options.status ?? "completed";
  const output: ObservedReplayOutput | null = status === "cancelled" ? null : {
    schemaVersion: 1, kind: "coworker-observed-replay-result", status: status === "completed" ? "completed" : "rejected",
    inputDigest: request.requestDigest, sourceManifestSha256, pythonVersion: "3.11.9",
    reason: status === "completed" ? null : "native_replay_rejected", result: status === "completed" ? result : null,
  };
  const stdout = output ? `${encode(output)}\n` : "";
  const descriptor: ObservedReplayDescriptor = { name: "coworker-observed-replay", version: 1, sourceSha256: "9".repeat(64), sourceManifestSha256,
    pythonExecutable: "/definitely-missing-python", timeoutMs: 60_000, maxOutputBytes: 1_048_576 };
  const execution: ObservedReplayExecution = { schemaVersion: 1, kind: "coworker-observed-replay-execution", requestDigest: request.requestDigest, descriptor,
    status: status === "completed" ? "completed" : "incomplete", reason: status === "completed" ? "completed" : status === "rejected" ? "native_replay_rejected" : "cancelled",
    process: { exitCode: status === "completed" ? 0 : status === "rejected" ? 2 : null, stopped: status === "cancelled" ? "cancelled" : null,
      stdoutSha256: replayFixtureSha(stdout), stdoutBytes: Buffer.byteLength(stdout), stderrSha256: replayFixtureSha(""), stderrBytes: 0 },
    cleanup: { status: "removed", path: null }, output };
  const intent = { schemaVersion: 1, kind: "coworker-observed-replay-intent", createdAt: "2026-11-02T00:00:00.000Z", request, descriptor, replaySupported: false };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [name, value] of [["intent.json", intent], ["execution.json", execution]] as const) {
    await writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  const saved = await recoverObservedReplayArtifacts(directory);
  const bundle = validateObservedReplayBundle({ intent: saved.intent, execution: saved.execution, receipt: saved.receipt, report: saved.report });
  return { bundle, expected: { requestDigest: request.requestDigest, executionDigest: hash(execution), receiptDigest: bundle.receipt.digest } };
}

export async function prepareReplayEvidenceFixture(t: TestContext, options: ReplayEvidenceFixtureOptions = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "rlh-replay-evidence-")));
  const artifactRoot = join(base, "artifacts"), bundlePath = "selected/episode", directory = join(artifactRoot, bundlePath);
  const { bundle, expected } = await writeReplayEvidenceBundle(directory, options);
  const database = join(base, "evidence.sqlite"), ledger = openExperimentLedger({ path: database });
  t.after(async () => { try { ledger.close(); } finally { await rm(base, { recursive: true, force: true }); } });
  const request: ReplayEvidenceRequest = { projectId: "alpha", evidenceId: "episode-1", bundlePath, expected,
    origin: { kind: "synthetic_fixture", description: "Synthetic validation fixture; no native process was executed.", sourceReference: { locator: "fixture:independent-replay", sha256: "7".repeat(64) } } };
  return { base, artifactRoot, bundlePath, directory, database, ledger, request, bundle };
}

export async function createReplayEvidenceFixture(t: TestContext, options: ReplayEvidenceFixtureOptions = {}) {
  const fixture = await prepareReplayEvidenceFixture(t, options);
  const record = await importCoworkerReplayEvidence(fixture.ledger, fixture.request, { artifactRoot: fixture.artifactRoot });
  return { ...fixture, record };
}
