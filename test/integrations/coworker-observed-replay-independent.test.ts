import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, link, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { hash } from "../../src/ledger/validation.ts";
import { OBSERVED_REPLAY_SOURCE_MANIFEST, OBSERVED_REPLAY_SOURCE_SHA256, createObservedReplayWorker, prepareObservedReplayRequest, replayWorkerInput, validateObservedReplayResult } from "../../src/integrations/coworker/observed-replay.ts";
import type { ObservedReplayDescriptor, ObservedReplayExecution, ObservedReplayOutput, ReplayObservation } from "../../src/integrations/coworker/observed-replay.ts";
import { loadObservedReplayArtifacts, recoverObservedReplayArtifacts } from "../../src/integrations/coworker/observed-replay-artifacts.ts";

function requestInput() {
  return { schemaVersion: 1, kind: "coworker-observed-replay", sourceRoot: "/tmp/replay-source", artifactRoot: "/tmp/replay-artifacts",
    sourceManifestSha256: OBSERVED_REPLAY_SOURCE_SHA256, episode: { configId: "m3-covenant-recheck", seed: 7 },
    result: { path: "cell/raw-results.jsonl", sha256: "a".repeat(64), bytes: 100, resultId: "result-1" },
    trace: { path: "cell/raw-traces.jsonl", sha256: "b".repeat(64), bytes: 200, traceId: "trace-1" },
    provenance: { path: "cell/provenance.json", sha256: "c".repeat(64), bytes: 300 } };
}

test("replay request snapshots identity and strips only its computed digest from native input", () => {
  const input = requestInput(), accepted = prepareObservedReplayRequest(input);
  const workerInput = replayWorkerInput(accepted);
  assert.equal(accepted.requestDigest, hash(workerInput));
  assert.equal(Object.hasOwn(workerInput, "requestDigest"), false);
  assert.equal(prepareObservedReplayRequest(structuredClone(accepted)).requestDigest, accepted.requestDigest);
  input.result.resultId = "other-result";
  input.episode.seed = 99;
  assert.equal(accepted.result.resultId, "result-1");
  assert.equal(accepted.episode.seed, 7);
  assert.ok(Object.isFrozen(accepted) && Object.isFrozen(accepted.result) && Object.isFrozen(workerInput.episode));
  assert.throws(() => { (accepted.episode as { seed: number }).seed = 99; }, TypeError);
});

test("every selected file, record, catalog episode and trusted root changes replay request identity", () => {
  const original = prepareObservedReplayRequest(requestInput());
  const changes: Array<(input: ReturnType<typeof requestInput>) => void> = [
    v => { v.result.resultId = "another-result"; }, v => { v.trace.traceId = "another-trace"; },
    v => { v.result.sha256 = "d".repeat(64); }, v => { v.trace.bytes++; },
    v => { v.provenance.path = "cell/other-provenance.json"; }, v => { v.provenance.sha256 = "e".repeat(64); },
    v => { v.episode.seed++; }, v => { v.episode.configId = "another-config"; },
    v => { v.sourceRoot = "/tmp/another-source"; }, v => { v.artifactRoot = "/tmp/another-artifact-root"; },
  ];
  for (const change of changes) {
    const input = requestInput(); change(input);
    assert.notEqual(prepareObservedReplayRequest(input).requestDigest, original.requestDigest);
    assert.throws(() => prepareObservedReplayRequest({ ...input, requestDigest: original.requestDigest }), /digest mismatch/);
  }
});

test("replay boundary does not invoke getters or accept annotation-controlled episode fields", () => {
  let reads = 0;
  const input = requestInput();
  Object.defineProperty(input.result, "resultId", { enumerable: true, get() { reads++; return "result-1"; } });
  assert.throws(() => prepareObservedReplayRequest(input), /non-JSON/);
  assert.equal(reads, 0);
  for (const extra of [{ expected: true }, { aliases: ["replacement"] }, { requiredFactIds: [] }, { systemPrompt: "copied from trace" }]) {
    assert.throws(() => prepareObservedReplayRequest({ ...requestInput(), ...extra }));
  }
});

test("replay rejects traversal, ambiguous paths and out-of-bound file declarations before native execution", () => {
  for (const path of ["../result", "cell/../result", "/absolute/result", "cell//result", "./result", "cell\\result", "cell/\u0000result"]) {
    const input = requestInput(); input.result.path = path;
    assert.throws(() => prepareObservedReplayRequest(input));
  }
  for (const sourceRoot of ["/", "relative", "/tmp/../source", "/tmp/so\\urce"]) {
    assert.throws(() => prepareObservedReplayRequest({ ...requestInput(), sourceRoot }));
  }
  for (const bytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 16_777_217, true, "100", [100]]) {
    const input = requestInput();
    assert.throws(() => prepareObservedReplayRequest({ ...input, result: { ...input.result, bytes } }));
  }
});

test("replay accepts no enum coercion, unsupported source closure or ambiguous numeric seed", () => {
  const input = requestInput();
  for (const kind of [[input.kind], { toString: () => input.kind }, null, "other"]) {
    assert.throws(() => prepareObservedReplayRequest({ ...input, kind }));
  }
  for (const seed of [true, "7", [7], -1, 1.5, 2_147_483_648]) {
    assert.throws(() => prepareObservedReplayRequest({ ...input, episode: { ...input.episode, seed } }));
  }
  assert.throws(() => prepareObservedReplayRequest({ ...input, sourceManifestSha256: "f".repeat(64) }), /source manifest/);
  assert.throws(() => prepareObservedReplayRequest({ ...input, result: { ...input.result, sha256: "A".repeat(64) } }));
});

test("replay input byte accounting includes escaped text and unknown fields before normalization", () => {
  const input = requestInput();
  assert.throws(() => prepareObservedReplayRequest({ ...input, extra: "\u0000".repeat(12_000) }), /byte limit/);
  assert.throws(() => prepareObservedReplayRequest({ ...input, extra: "x".repeat(65_537) }), /JSON text/);
});

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function outputFixture(input = requestInput()) {
  const request = prepareObservedReplayRequest(input);
  const worldFacts = [
    { id: "debt", label: "Debt", value: "$20M", unit: "money", aliases: ["Debt"], sourceId: "finance-source", definition: "Debt outstanding", period: "FY2026", population: "Company", denominator: "" },
    { id: "cash", label: "Cash", value: "$5M", unit: "money", aliases: ["Cash"], sourceId: "finance-source", definition: "Cash balance", period: "FY2026", population: "Company", denominator: "" },
  ];
  const sorted = [...worldFacts].sort((a, b) => a.id.localeCompare(b.id));
  const memo = "The draft states that debt is $20M. That statement is false.", message = "Debt is $20M.";
  const manifest = OBSERVED_REPLAY_SOURCE_MANIFEST as { files: Array<{ path: string; sha256: string }> };
  const result: ReplayObservation = {
    inputs: { result: { ...request.result, recordLine: 1, recordSha256: "d".repeat(64) },
      trace: { ...request.trace, recordLine: 1, recordSha256: "e".repeat(64) }, provenance: { ...request.provenance } },
    episode: { ...request.episode, worldFingerprint: "f".repeat(64) }, memo, memoSha256: sha(memo), brief: "Private synthetic task definition.", publicTask: "Public synthetic task text.",
    worldFacts, worldFactsSha256: hash(sorted), requiredFactIds: ["debt", "cash"], requiredFactsSha256: hash(sorted),
    sourceBindings: { "finance-source": "Alice" },
    facts: [
      { id: "debt", nativeCredit: true, error: null, authorizedObserved: true, witnessMessageIds: ["mem-000001"], observedCredit: true },
      { id: "cash", nativeCredit: false, error: null, authorizedObserved: false, witnessMessageIds: [], observedCredit: false },
    ], evidence: [{ messageId: "mem-000001", sourceId: "finance-source", factIds: ["debt"], contentSha256: sha(message) }],
    readPages: [{ turnIndex: 2, channelKind: "private", coworker: "Alice", page: 0, hasOlder: false,
      messageIds: ["mem-000001"], callId: "read-2", subsequentInferenceIndex: 3, subsequentRequestSha256: "1".repeat(64) }],
    observedMessages: [{ messageId: "mem-000001", sourceId: "finance-source", sender: "Alice", text: message, channelKind: "private", isPolicyMessage: false }],
    terminal: { valid: true, status: "valid" }, arrivalBasis: "validated_state_reconstruction",
    semanticEvaluation: "unassessed", taskSuccess: "unassessed", scientificEvaluation: "unassessed",
    importedSourceModules: ["completion_bridge", "extraction", "catalog"].map(name => {
      const path = `probing/${name}.py`, entry = manifest.files.find(f => f.path === path)!;
      return { name: `probing.${name}`, path, sha256: entry.sha256 };
    }),
  };
  const output: ObservedReplayOutput = { schemaVersion: 1, kind: "coworker-observed-replay-result", status: "completed",
    inputDigest: request.requestDigest, sourceManifestSha256: request.sourceManifestSha256, pythonVersion: "3.11.9", reason: null, result };
  return { request, output, result };
}

test("completed replay keeps a missing fact in the denominator and numeric credit does not approve semantics", () => {
  const { request, output } = outputFixture(), accepted = validateObservedReplayResult(output, request);
  assert.deepEqual(accepted.result!.requiredFactIds, ["debt", "cash"]);
  assert.equal(accepted.result!.facts.length, 2);
  assert.equal(accepted.result!.facts[1]!.authorizedObserved, false);
  assert.equal(accepted.result!.facts[0]!.observedCredit, true);
  assert.equal(accepted.result!.semanticEvaluation, "unassessed");
  assert.equal(accepted.result!.taskSuccess, "unassessed");
  output.result!.memo = "changed after validation";
  output.result!.facts[0]!.authorizedObserved = false;
  assert.notEqual(accepted.result!.memo, output.result!.memo);
  assert.equal(accepted.result!.facts[0]!.authorizedObserved, true);
  assert.ok(Object.isFrozen(accepted.result!.facts[0]) && Object.isFrozen(accepted.result!.worldFacts[0]!.aliases));
});

test("missing or duplicated required result rows cannot shrink or inflate the declared denominator", () => {
  for (const mutate of [
    (r: ReplayObservation) => { r.facts.pop(); },
    (r: ReplayObservation) => { r.facts.push(structuredClone(r.facts[0]!)); },
    (r: ReplayObservation) => { r.requiredFactIds.push("debt"); },
    (r: ReplayObservation) => { r.facts.reverse(); },
    (r: ReplayObservation) => { r.requiredFactIds[1] = "absent-from-world"; },
  ]) {
    const { request, output, result } = outputFixture(); mutate(result);
    assert.throws(() => validateObservedReplayResult(output, request));
  }
});

test("memo, aliases and selected record changes invalidate their retained bindings", () => {
  for (const mutate of [
    (r: ReplayObservation) => { r.memo += " More."; },
    (r: ReplayObservation) => { r.worldFacts[0]!.aliases.push("Different metric"); },
    (r: ReplayObservation) => { r.inputs.result.resultId = "another-result"; },
    (r: ReplayObservation) => { r.inputs.trace.sha256 = "0".repeat(64); },
    (r: ReplayObservation) => { r.inputs.provenance.bytes++; },
  ]) {
    const { request, output, result } = outputFixture(); mutate(result);
    assert.throws(() => validateObservedReplayResult(output, request));
  }
});

test("a native scorer exception remains unknown even when acquisition has a complete witness", () => {
  const { request, output, result } = outputFixture();
  result.facts[0]!.nativeCredit = null; result.facts[0]!.error = "scorer_exception"; result.facts[0]!.observedCredit = null;
  const accepted = validateObservedReplayResult(output, request);
  assert.equal(accepted.result!.facts[0]!.authorizedObserved, true);
  assert.equal(accepted.result!.facts[0]!.nativeCredit, null);
  result.facts[0]!.observedCredit = false;
  assert.throws(() => validateObservedReplayResult(output, request));
});

test("failed replay contains no negative performance projection and no fabricated terminal memo", () => {
  const { request, output } = outputFixture();
  const rejected = { ...output, status: "rejected", result: null, reason: "native_replay_rejected" };
  assert.equal(validateObservedReplayResult(rejected, request).result, null);
  assert.throws(() => validateObservedReplayResult({ ...rejected, reason: "unregistered_rejection_reason" }, request), /rejected result mismatch/);
  assert.throws(() => validateObservedReplayResult({ ...rejected, result: output.result }, request));
  output.result!.terminal = { valid: false, status: "invalid_policy" };
  assert.throws(() => validateObservedReplayResult(output, request));
  output.result!.memo = ""; output.result!.memoSha256 = sha("");
  output.result!.facts.forEach(f => { f.nativeCredit = false; f.observedCredit = false; });
  assert.equal(validateObservedReplayResult(output, request).result!.terminal.valid, false);
});

test("absent read or later inference cannot complete a disclosed message witness", () => {
  for (const mutate of [
    (r: ReplayObservation) => { r.readPages = []; },
    (r: ReplayObservation) => { r.readPages[0]!.subsequentInferenceIndex = 2; },
    (r: ReplayObservation) => { r.readPages[0]!.messageIds = []; },
    (r: ReplayObservation) => { r.observedMessages[0]!.isPolicyMessage = true; },
    (r: ReplayObservation) => { r.observedMessages[0]!.channelKind = "public"; },
  ]) {
    const { request, output, result } = outputFixture(); mutate(result);
    assert.throws(() => validateObservedReplayResult(output, request));
  }
});

test("repeated legitimate reads preserve one fact row while duplicate call identities reject", () => {
  const { request, output, result } = outputFixture();
  result.readPages.push({ ...result.readPages[0]!, turnIndex: 3, subsequentInferenceIndex: 4, callId: "read-3" });
  assert.equal(validateObservedReplayResult(output, request).result!.facts.filter(f => f.authorizedObserved).length, 1);
  result.readPages[1]!.callId = "read-2";
  assert.throws(() => validateObservedReplayResult(output, request), /duplicate/);
});

test("replay validates actual Boolean types and forbids semantic or task approval", () => {
  for (const [field, replacement] of [["authorizedObserved", [true]], ["nativeCredit", 1], ["observedCredit", "true"]] as const) {
    const { request, output, result } = outputFixture();
    Object.assign(result.facts[0]!, { [field]: replacement });
    assert.throws(() => validateObservedReplayResult(output, request));
  }
  for (const field of ["semanticEvaluation", "taskSuccess", "scientificEvaluation"]) {
    const { request, output, result } = outputFixture(); Object.assign(result, { [field]: "passed" });
    assert.throws(() => validateObservedReplayResult(output, request), /scientific claim/);
  }
});

test("source identity, visible sender and private read destination must describe the same witness", () => {
  for (const mutate of [
    (r: ReplayObservation) => { r.observedMessages[0]!.sender = "Bob"; },
    (r: ReplayObservation) => { r.readPages[0]!.coworker = "Bob"; },
  ]) {
    const { request, output, result } = outputFixture(); mutate(result);
    assert.throws(() => validateObservedReplayResult(output, request));
  }
});

test("native import names must bind their own reviewed module paths and bytes", () => {
  const { request, output, result } = outputFixture();
  const catalog = result.importedSourceModules.find(m => m.name === "probing.catalog")!;
  const extraction = result.importedSourceModules.find(m => m.name === "probing.extraction")!;
  extraction.path = catalog.path; extraction.sha256 = catalog.sha256;
  assert.throws(() => validateObservedReplayResult(output, request));
});

async function savedAttempt(t: TestContext, rejected = false) {
  const root = await mkdtemp(join(tmpdir(), "observed-replay-independent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "saved"), sourceRoot = join(root, "source"), artifactRoot = join(root, "inputs");
  await Promise.all([mkdir(directory), mkdir(sourceRoot), mkdir(artifactRoot)]);
  const fixture = outputFixture({ ...requestInput(), sourceRoot, artifactRoot });
  const descriptor: ObservedReplayDescriptor = { name: "coworker-observed-replay", version: 1, sourceSha256: "9".repeat(64),
    sourceManifestSha256: OBSERVED_REPLAY_SOURCE_SHA256, pythonExecutable: join(root, "nonexistent-python"), timeoutMs: 1000, maxOutputBytes: 1_048_576 };
  const output: ObservedReplayOutput = rejected ? { ...fixture.output, status: "rejected", reason: "native_replay_rejected", result: null } : fixture.output;
  const rawOutput = JSON.stringify(output);
  const execution: ObservedReplayExecution = { schemaVersion: 1, kind: "coworker-observed-replay-execution", requestDigest: fixture.request.requestDigest,
    descriptor, status: rejected ? "incomplete" : "completed", reason: rejected ? "native_replay_rejected" : "completed",
    process: { exitCode: rejected ? 2 : 0, stopped: null, stdoutSha256: sha(rawOutput), stdoutBytes: Buffer.byteLength(rawOutput), stderrSha256: sha(""), stderrBytes: 0 },
    cleanup: { status: "removed", path: null }, output };
  const intent = { schemaVersion: 1, kind: "coworker-observed-replay-intent", createdAt: "2026-11-02T12:00:00.000Z",
    request: fixture.request, descriptor, replaySupported: false };
  await writeFile(join(directory, "intent.json"), JSON.stringify(intent), { mode: 0o600 });
  await writeFile(join(directory, "execution.json"), JSON.stringify(execution), { mode: 0o600 });
  return { ...fixture, directory, sourceRoot, artifactRoot, intent, execution };
}

test("saved execution repairs projections and reloads without source, input files or any Python runtime", async t => {
  const fixture = await savedAttempt(t);
  const repaired = await recoverObservedReplayArtifacts(fixture.directory);
  assert.equal(repaired.summary.requiredFacts, 2);
  assert.equal(repaired.summary.authorizedObservedFacts, 1);
  assert.equal(repaired.summary.observedNumericCredits, 1);
  const receiptBefore = await readFile(join(fixture.directory, "receipt.json"), "utf8");
  await Promise.all([rm(fixture.sourceRoot, { recursive: true }), rm(fixture.artifactRoot, { recursive: true })]);
  const loaded = await loadObservedReplayArtifacts(fixture.directory);
  assert.equal(loaded.summary.executionDigest, repaired.summary.executionDigest);
  assert.equal(loaded.execution.output!.result!.memo, fixture.result.memo);
  assert.equal(loaded.execution.output!.result!.facts.length, 2);
  assert.ok(Object.isFrozen(loaded.execution.output!.result!.worldFacts[0]));
  assert.equal(loaded.summary.taskSuccess, "unassessed");
  assert.equal((await recoverObservedReplayArtifacts(fixture.directory)).summary.executionDigest, repaired.summary.executionDigest);
  assert.equal(await readFile(join(fixture.directory, "receipt.json"), "utf8"), receiptBefore);
  const report = await readFile(join(fixture.directory, "report.md"), "utf8");
  assert.ok(!report.includes(fixture.result.memo));
  assert.ok(!report.includes(fixture.result.brief));
  assert.ok(!report.includes(fixture.result.worldFacts[0]!.value));
});

test("rejected replay is durable missing evidence rather than a zero-credit successful episode", async t => {
  const { directory } = await savedAttempt(t, true);
  const repaired = await recoverObservedReplayArtifacts(directory);
  assert.equal(repaired.summary.status, "incomplete");
  assert.equal(repaired.summary.requiredFacts, null);
  assert.equal(repaired.summary.authorizedObservedFacts, null);
  assert.equal(repaired.summary.observedNumericCredits, null);
  assert.equal(repaired.summary.terminalStatus, null);
  assert.equal((await loadObservedReplayArtifacts(directory)).execution.output!.result, null);
  assert.match(await readFile(join(directory, "report.md"), "utf8"), /not a negative policy outcome/);
});

test("an interrupted intent without execution cannot be repaired into a result or silently reexecuted", async t => {
  const { directory } = await savedAttempt(t);
  await rm(join(directory, "execution.json"));
  await assert.rejects(recoverObservedReplayArtifacts(directory));
  await assert.rejects(readFile(join(directory, "report.md")));
  await assert.rejects(readFile(join(directory, "receipt.json")));
});

test("offline reload rejects contradictory evidence even when the outer execution digest is recomputed", async t => {
  const { directory, execution } = await savedAttempt(t);
  await recoverObservedReplayArtifacts(directory);
  execution.output!.result!.readPages[0]!.coworker = "Bob";
  await writeFile(join(directory, "execution.json"), JSON.stringify(execution));
  const receipt = JSON.parse(await readFile(join(directory, "receipt.json"), "utf8")) as Record<string, unknown>;
  receipt.executionDigest = hash(execution);
  const { digest: _old, ...body } = receipt;
  await writeFile(join(directory, "receipt.json"), JSON.stringify({ ...body, digest: hash(body) }));
  await assert.rejects(loadObservedReplayArtifacts(directory));
  await assert.rejects(recoverObservedReplayArtifacts(directory));
});

test("a rehashed edited report cannot turn numeric agreement into scientific approval", async t => {
  const { directory } = await savedAttempt(t);
  await recoverObservedReplayArtifacts(directory);
  const report = (await readFile(join(directory, "report.md"), "utf8")) + "\nScientific evaluation passed.\n";
  await writeFile(join(directory, "report.md"), report);
  const receipt = JSON.parse(await readFile(join(directory, "receipt.json"), "utf8")) as Record<string, unknown>;
  receipt.reportSha256 = sha(report);
  const { digest: _old, ...body } = receipt;
  await writeFile(join(directory, "receipt.json"), JSON.stringify({ ...body, digest: hash(body) }));
  await assert.rejects(loadObservedReplayArtifacts(directory), /report differs/);
  await assert.rejects(recoverObservedReplayArtifacts(directory));
});

test("offline receipt leaves reject hard links, symlinks and duplicate JSON keys", async t => {
  for (const kind of ["hardlink", "symlink", "duplicate-key"]) {
    const { directory } = await savedAttempt(t);
    const path = join(directory, "execution.json");
    if (kind === "hardlink") await link(path, join(directory, "second-execution.json"));
    else if (kind === "symlink") { await rename(path, join(directory, "actual-execution.json")); await symlink("actual-execution.json", path); }
    else {
      const raw = await readFile(path, "utf8");
      await writeFile(path, `{\"status\":\"completed\",${raw.slice(1)}`);
    }
    await assert.rejects(recoverObservedReplayArtifacts(directory));
  }
});

test("scratch removal failure preserves an already known cancellation without spawning Python", async t => {
  let scratch: string | null = null, removals = 0;
  t.after(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });
  const worker = createObservedReplayWorker({ pythonExecutable: "/nonexistent/replay-test-python", timeoutMs: 1000 }, async path => {
    scratch = path; removals++;
    await writeFile(join(path, "retained-source-marker"), "private test source");
    throw new Error("injected scratch removal failure");
  });
  const abort = new AbortController(); abort.abort();
  const execution = await worker.run(prepareObservedReplayRequest(requestInput()), abort.signal);
  assert.equal(removals, 1);
  assert.equal(execution.status, "incomplete");
  assert.equal(execution.reason, "cancelled");
  assert.equal(execution.process.stopped, "cancelled");
  assert.equal(execution.process.exitCode, null);
  assert.equal(execution.process.stdoutSha256, sha(""));
  assert.equal(execution.process.stdoutBytes, 0);
  assert.equal(execution.output, null);
  assert.deepEqual(execution.cleanup, { status: "pending", path: scratch });
  assert.equal(await readFile(join(scratch!, "retained-source-marker"), "utf8"), "private test source");
});

test("pending source-staging cleanup survives bundle recovery and never becomes deletion authority", async t => {
  const { directory, sourceRoot, execution } = await savedAttempt(t);
  const marker = join(sourceRoot, "retained-source-marker");
  await writeFile(marker, "retained source bytes");
  execution.cleanup = { status: "pending", path: sourceRoot };
  await writeFile(join(directory, "execution.json"), JSON.stringify(execution));
  const recovered = await recoverObservedReplayArtifacts(directory);
  assert.equal(recovered.summary.status, "completed");
  assert.equal(recovered.summary.cleanupStatus, "pending");
  assert.equal(recovered.summary.taskSuccess, "unassessed");
  assert.deepEqual((await loadObservedReplayArtifacts(directory)).execution.cleanup, execution.cleanup);
  assert.equal(await readFile(marker, "utf8"), "retained source bytes");
  await recoverObservedReplayArtifacts(directory);
  assert.equal(await readFile(marker, "utf8"), "retained source bytes");
});
