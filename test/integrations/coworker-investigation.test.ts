import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { hash } from "../../src/ledger/validation.ts";
import type { ObservationInput, ObservationRecord } from "../../src/ledger/types.ts";
import { COWORKER_INVESTIGATION_SOURCE, coworkerInvestigationObservationId, loadCoworkerInvestigation,
  copyCoworkerInvestigationData, normalizeCoworkerInvestigationRequest, prepareCoworkerInvestigation, runCoworkerInvestigation,
  validateCoworkerInvestigationPreparation } from "../../src/integrations/coworker/investigation.ts";
import type { CoworkerInvestigationWorker, CoworkerInvestigationExecution } from "../../src/integrations/coworker/investigation-worker.ts";
import { investigationArchiveFixture, syntheticInvestigationExecution, SYNTHETIC_WORKER } from "./coworker-investigation-fixtures.ts";

test("pure preparation rejects invalid queued evidence and identity reuse without files or archival mutation", async t => {
  const f = await investigationArchiveFixture(t), options = { root: f.root, worker: SYNTHETIC_WORKER };
  await rm(f.root, { recursive: true });
  const before = f.ledger().listObservations("study");
  const archive = { getObservation: f.ledger().getObservation.bind(f.ledger()), appendObservation() { throw new Error("Pure validation must not append"); } };
  validateCoworkerInvestigationPreparation(archive, f.request, options);
  assert.throws(() => validateCoworkerInvestigationPreparation(archive, f.request, { ...options, root: "/wrong" }), /root\/report/u);
  assert.throws(() => validateCoworkerInvestigationPreparation(archive, { ...f.request, captureDigest: "0".repeat(64) }, options), /capture identity/u);
  assert.deepEqual(f.ledger().listObservations("study"), before);
  prepareCoworkerInvestigation(f.ledger(), f.request, { ...options, now: f.now });
  const prepared = f.ledger().listObservations("study");
  validateCoworkerInvestigationPreparation(archive, f.request, options);
  assert.throws(() => validateCoworkerInvestigationPreparation(archive, f.request,
    { ...options, worker: { ...SYNTHETIC_WORKER, timeoutMs: 2000 } }), /another request\/worker/u);
  assert.deepEqual(f.ledger().listObservations("study"), prepared);
  const phase2 = await investigationArchiveFixture(t, "52ef847e".padEnd(40, "0"));
  const phase2Before = phase2.ledger().listObservations("study");
  assert.throws(() => validateCoworkerInvestigationPreparation(phase2.ledger(), phase2.request,
    { root: phase2.root, worker: SYNTHETIC_WORKER }), /unsupported capture source/u);
  assert.deepEqual(phase2.ledger().listObservations("study"), phase2Before);
});

test("exported inert copy rejects nested getters and separates caller-owned JSON values", () => {
  let calls = 0;
  assert.throws(() => copyCoworkerInvestigationData({ nested: { get value() { calls++; return "hidden"; } } }), /accessors/u);
  assert.equal(calls, 0);
  const original = { nested: { values: [1, 2] } }, copied = copyCoworkerInvestigationData(original);
  original.nested.values[0] = 999;
  assert.deepEqual(copied, { nested: { values: [1, 2] } });
  assert.throws(() => copyCoworkerInvestigationData({ value: "x".repeat(1_500_001) }), /byte bound/u);
});

test("investigation intent precedes one read-only worker and completed evidence reloads without files or execution", async t => {
  const f = await investigationArchiveFixture(t); let calls = 0;
  const worker: CoworkerInvestigationWorker = { descriptor: SYNTHETIC_WORKER, async run(input) {
    calls++; const records = f.ledger().listObservations("study");
    assert.ok(records.some(record => record.source === "coworker-investigation-intent.v1"));
    assert.ok(records.some(record => record.source === "coworker-investigation-attempt.v1"));
    assert.equal(input.report.sha256, (f.capture.payload.reportObservation as any).reportReference.sha256);
    assert.notEqual(input.report.bytes, 58_876, "Synthetic captures use their own bytes, not the real dataset constant");
    return syntheticInvestigationExecution(input);
  } };
  const intent = prepareCoworkerInvestigation(f.ledger(), f.request, { root: f.root, worker: worker.descriptor, now: f.now });
  assert.equal(calls, 0);
  const result = await runCoworkerInvestigation(f.ledger(), f.request, { root: f.root, worker, now: f.now });
  assert.equal(result.source, COWORKER_INVESTIGATION_SOURCE); assert.equal(result.payload.status, "completed");
  assert.equal(result.payload.intentId, intent.eventId); assert.equal(result.payload.intentDigest, intent.digest);
  assert.deepEqual(result.payload.requestIdentity, f.request); assert.equal(result.payload.scientificEvaluation, "unassessed");
  assert.equal(result.payload.followupDisposition, "unresolved"); assert.equal(result.runId, null);
  assert.equal(f.ledger().listRuns().length, 0); assert.equal(f.ledger().listActions().length, 0);
  await rm(f.root, { recursive: true }); f.reopen();
  assert.deepEqual(loadCoworkerInvestigation(f.ledger(), result.eventId), result);
  assert.deepEqual(await runCoworkerInvestigation(f.ledger(), f.request, { root: f.root, worker, now: () => new Date("2027-01-01") }), result);
  assert.equal(calls, 1);
});

test("capture/source identity, root and artifact traversal fail before a worker attempt", async t => {
  const f = await investigationArchiveFixture(t); let calls = 0;
  const worker: CoworkerInvestigationWorker = { descriptor: SYNTHETIC_WORKER, async run(input) { calls++; return syntheticInvestigationExecution(input); } };
  for (const request of [{ ...f.request, captureDigest: "a".repeat(64) }, { ...f.request, projectId: "other" },
    { ...f.request, localArtifacts: { ...f.request.localArtifacts, trainedTracePath: "../outside" } }]) {
    await assert.rejects(runCoworkerInvestigation(f.ledger(), request, { root: f.root, worker }));
  }
  await assert.rejects(runCoworkerInvestigation(f.ledger(), f.request, { root: `${f.root}-other`, worker }), /root\/report/u);
  assert.equal(calls, 0); assert.equal(f.ledger().listObservations("study").length, 1);
  const phase2 = await investigationArchiveFixture(t, "52ef847e".padEnd(40, "0"));
  await assert.rejects(runCoworkerInvestigation(phase2.ledger(), phase2.request, { root: phase2.root, worker }), /unsupported capture source/u);
  assert.equal(calls, 0);
});

test("immutable identity rejects changed source program, timeout, capture and selection after preparation", async t => {
  const f = await investigationArchiveFixture(t);
  prepareCoworkerInvestigation(f.ledger(), f.request, { root: f.root, worker: SYNTHETIC_WORKER, now: f.now });
  for (const descriptor of [{ ...SYNTHETIC_WORKER, sourceSha256: "0".repeat(64) }, { ...SYNTHETIC_WORKER, timeoutMs: 2000 },
    { ...SYNTHETIC_WORKER, pythonExecutable: "/another/python" }]) {
    assert.throws(() => prepareCoworkerInvestigation(f.ledger(), f.request, { root: f.root, worker: descriptor }), /another request\/worker/u);
  }
  const changed = structuredClone(f.request);
  changed.localArtifacts.trainedEvaluationDirectory = changed.localArtifacts.trainedEvaluationDirectory.replace("s11-trained", "another-trained");
  changed.localArtifacts.trainedTracePath = `.local-artifacts/${changed.localArtifacts.trainedEvaluationDirectory}/step0-trace.jsonl`;
  assert.throws(() => prepareCoworkerInvestigation(f.ledger(), changed, { root: f.root, worker: SYNTHETIC_WORKER }), /another request\/worker/u);
});

test("committed worker output repairs a failed final projection without rerunning the worker", async t => {
  const f = await investigationArchiveFixture(t); let calls = 0, failed = false;
  const append = f.ledger().appendObservation.bind(f.ledger());
  f.ledger().appendObservation = input => {
    if (!failed && input.source === COWORKER_INVESTIGATION_SOURCE) { failed = true; throw new Error("projection write failed"); }
    return append(input);
  };
  const worker: CoworkerInvestigationWorker = { descriptor: SYNTHETIC_WORKER, async run(input) { calls++; return syntheticInvestigationExecution(input); } };
  await assert.rejects(runCoworkerInvestigation(f.ledger(), f.request, { root: f.root, worker, now: f.now }), /projection write failed/u);
  assert.equal(f.ledger().listObservations("study").filter(record => record.source === "coworker-investigation-output.v1").length, 1);
  f.reopen(); const recovered = await runCoworkerInvestigation(f.ledger(), f.request, { root: f.root, worker, now: f.now });
  assert.equal(recovered.payload.status, "completed"); assert.equal(calls, 1);
});

test("unrecorded read-only outcomes repeat under distinct bounded attempts and retain the immutable input", async t => {
  const f = await investigationArchiveFixture(t); let calls = 0, fail = true;
  const append = f.ledger().appendObservation.bind(f.ledger());
  f.ledger().appendObservation = input => { if (fail && input.source === "coworker-investigation-output.v1") throw new Error("lost output commit"); return append(input); };
  const worker: CoworkerInvestigationWorker = { descriptor: SYNTHETIC_WORKER, async run(input) { calls++; return syntheticInvestigationExecution(input); } };
  await assert.rejects(runCoworkerInvestigation(f.ledger(), f.request, { root: f.root, worker, now: f.now }), /lost output commit/u);
  fail = false; f.reopen();
  const recovered = await runCoworkerInvestigation(f.ledger(), f.request, { root: f.root, worker, now: f.now });
  assert.equal((recovered.payload.output as any).attempt, 2); assert.equal(calls, 2);
  const attempts = f.ledger().listObservations("study").filter(record => record.source === "coworker-investigation-attempt.v1");
  assert.equal(attempts.length, 2); assert.equal(attempts[1]!.payload.replayMeaning, "previous_outcome_unrecorded_read_only_reinspection");
  assert.equal(attempts[0]!.payload.inputDigest, attempts[1]!.payload.inputDigest);
});

test("three interrupted attempts exhaust the fixed identity without creating a fourth inspection", async t => {
  const f = await investigationArchiveFixture(t); let calls = 0;
  const append = f.ledger().appendObservation.bind(f.ledger());
  f.ledger().appendObservation = input => { if (input.source === "coworker-investigation-output.v1") throw new Error("lost output commit"); return append(input); };
  const worker: CoworkerInvestigationWorker = { descriptor: SYNTHETIC_WORKER, async run(input) { calls++; return syntheticInvestigationExecution(input); } };
  for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(runCoworkerInvestigation(f.ledger(), f.request, { root: f.root, worker, now: f.now }), /lost output commit/u);
  await assert.rejects(runCoworkerInvestigation(f.ledger(), f.request, { root: f.root, worker, now: f.now }), /attempt limit/u);
  assert.equal(calls, 3);
});

test("incomplete, invalid and throwing workers preserve different receipts without leaking raw content", async t => {
  const f = await investigationArchiveFixture(t);
  for (const mode of ["partial", "invalid", "throws"] as const) {
    const request = { ...f.request, investigationId: mode }; let calls = 0;
    const worker: CoworkerInvestigationWorker = { descriptor: SYNTHETIC_WORKER, async run(input) {
      calls++; if (mode === "throws") throw new Error("private-message-not-for-archive");
      if (mode === "invalid") return { ...syntheticInvestigationExecution(input), rawPrompts: "private-message-not-for-archive" } as CoworkerInvestigationExecution;
      const partial = structuredClone(syntheticInvestigationExecution(input, SYNTHETIC_WORKER, false));
      partial.observations = [{ check: "report", status: "verified", reason: "verified_byte_correspondence_and_producer_counts", files: [input.report,
        { path: input.report.path.replace(/report\.json$/u, "run-manifest.json"), sha256: "a".repeat(64), bytes: 10 }] },
        { check: "source", status: "failed", reason: "missing_file", files: [] }];
      return partial;
    } };
    const result = await runCoworkerInvestigation(f.ledger(), request, { root: f.root, worker, now: f.now });
    assert.equal(result.payload.status, "incomplete"); assert.equal(result.payload.reason, mode === "partial" ? "missing_file" : mode === "invalid" ? "invalid_worker_output" : "worker_exception");
    if (mode === "partial") assert.equal((result.payload.execution as any).observations[0].files[0].sha256, (f.capture.payload.reportObservation as any).reportReference.sha256);
    assert.deepEqual(await runCoworkerInvestigation(f.ledger(), request, { root: f.root, worker }), result); assert.equal(calls, 1);
  }
  assert.doesNotMatch(JSON.stringify(f.ledger().listObservations("study")), /private-message-not-for-archive/u);
});

test("request/worker mutations after invocation cannot drift an intent and concurrent same-ID reads are blocked", async t => {
  const f = await investigationArchiveFixture(t); let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; }), request = structuredClone(f.request), descriptor = structuredClone(SYNTHETIC_WORKER);
  const worker: CoworkerInvestigationWorker = { descriptor, async run(input) { await wait; return syntheticInvestigationExecution(input); } };
  const options = { root: f.root, worker, now: f.now };
  const pending = runCoworkerInvestigation(f.ledger(), request, options);
  request.investigationId = "mutated"; options.root = "/changed"; descriptor.sourceSha256 = "a".repeat(64);
  try {
    await assert.rejects(runCoworkerInvestigation(f.ledger(), f.request, { root: f.root,
      worker: { ...worker, descriptor: SYNTHETIC_WORKER } }), /already running/u);
  } finally { release(); }
  const result = await pending;
  assert.equal(result.eventId, coworkerInvestigationObservationId(f.request.projectId, f.request.investigationId));
  assert.equal(result.payload.status, "completed"); assert.deepEqual(result.payload.requestIdentity, f.request);
});

test("inert request validation rejects getters without evaluating them and offline load rejects rehashed scope drift", async t => {
  const f = await investigationArchiveFixture(t); let getterCalls = 0;
  assert.throws(() => normalizeCoworkerInvestigationRequest({ ...f.request, localArtifacts: { ...f.request.localArtifacts,
    get adapterPath() { getterCalls++; return f.request.localArtifacts.adapterPath; } } }));
  assert.equal(getterCalls, 0);
  const result = await runCoworkerInvestigation(f.ledger(), f.request, { root: f.root, worker: { descriptor: SYNTHETIC_WORKER,
    async run(input) { return syntheticInvestigationExecution(input); } }, now: f.now });
  const changed = structuredClone(result); changed.payload.scientificEvaluation = "validated";
  const { digest: _digest, ...body } = changed;
  const archive = { getObservation(eventId: string): ObservationRecord | null { return eventId === result.eventId ? { ...body, digest: hash(body) } : f.ledger().getObservation(eventId); },
    appendObservation(input: ObservationInput) { return f.ledger().appendObservation(input); } };
  assert.throws(() => loadCoworkerInvestigation(archive, result.eventId), /result projection mismatch/u);
});
