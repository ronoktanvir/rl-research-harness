import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dispatchNext, reconcileAction } from "../../src/controller/dispatcher.ts";
import type { BackendReply, BackendRequest, ExperimentBackend } from "../../src/controller/dispatcher.ts";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import type { DispatchClaim, ExperimentLedger } from "../../src/ledger/types.ts";

const now = () => new Date("2026-11-02T12:00:00.000Z");
const options = { workerId: "test-worker", deadlineAt: "2026-11-02T12:00:30.000Z", timeoutMs: 1_000 };
const evidence = { kind: "synthetic test fixture; no production backend" };

async function fixture(body: (ledger: ExperimentLedger, path: string, actionId: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "harness-dispatch-"));
  const path = join(directory, "ledger.sqlite");
  const ledger = openExperimentLedger({ path, now });
  try {
    for (const scopeId of ["global", "project:study"]) {
      ledger.configureBudget({ scopeId, parentScopeId: scopeId === "global" ? null : "global", expectedRevision: 0, limitMicrodollars: 100n });
      ledger.configurePolicy({ scopeId, expectedVersion: 0, allowedBackends: ["fixture"], allowedOperations: ["launch"], requiredChecks: ["fixture-check"] });
    }
    const { digest } = ledger.registerManifest({ schemaVersion: 1,
      code: { revision: "a".repeat(40), dirtyPatchSha256: null },
      environment: { imageDigest: `sha256:${"b".repeat(64)}`, dependenciesDigest: "c".repeat(64) },
      adapter: { kind: "conventional_rl", name: "fixture", config: {} },
      data: { version: "fixture-data", splitsDigest: "d".repeat(64) },
      model: { version: "fixture-model" }, reward: { version: "fixture-reward" }, evaluator: { version: "fixture-evaluator" },
      seeds: [1], resources: { maxDurationSeconds: 60, maxCostMicrodollars: "100" }, evaluationPolicy: { fixture: true } });
    ledger.recordValidation({ validationId: "validation", manifestDigest: digest, check: "fixture-check", source: "fixture", sequence: 1, status: "passed", evidence });
    ledger.createRun({ runId: "run", projectId: "study", manifestDigest: digest, replicaId: "replica-1" });
    const action = ledger.admitAction({ runId: "run", operation: "launch", operationRevision: 1, backend: "fixture", payload: { task: "test" },
      reservation: { amountMicrodollars: 60n, category: "compute", basis: "fixture upper bound" } });
    await body(ledger, path, action.actionId);
  } finally { ledger.close(); await rm(directory, { recursive: true, force: true }); }
}

function request(claim: DispatchClaim): BackendRequest {
  return { actionId: claim.action.actionId, attemptId: claim.attemptId, manifestDigest: claim.action.manifestDigest,
    backend: claim.action.backend, backendKey: claim.action.backendKey };
}
function accepted(identity: BackendRequest): BackendReply { return { ...identity, outcome: "accepted", jobId: "job-1", evidence }; }

test("lost launch reply survives reopen and reconciles the existing job without submitting twice", async () => {
  await fixture(async (ledger, path, actionId) => {
    const jobs = new Map<string, string>();
    let submits = 0;
    const backend: ExperimentBackend = { name: "fixture",
      async submit(claim) { submits++; jobs.set(claim.action.backendKey, "job-1"); throw new Error("simulated lost response"); },
      async reconcile(query) { assert.equal(jobs.get(query.backendKey), "job-1"); return accepted(query); },
    };
    assert.equal((await dispatchNext(ledger, [backend], options))?.state, "unknown");
    assert.equal(await dispatchNext(ledger, [backend], options), null);
    ledger.close();
    const reopened = openExperimentLedger({ path, now });
    try {
      const result = await reconcileAction(reopened, backend, actionId);
      assert.equal(result.state, "acknowledged");
      assert.equal(result.jobId, "job-1");
      assert.equal(submits, 1);
      assert.equal(result.reservation.outstandingMicrodollars, 60n);
      assert.equal(reopened.getRun("run").execution, "unknown");
      assert.equal(reopened.getRun("run").evaluation, "unassessed");
    } finally { reopened.close(); }
  });
});

test("malformed and mismatched acknowledgements preserve unknown exposure", async () => {
  for (const change of [ { manifestDigest: "f".repeat(64) }, { outcome: ["accepted"] }, { jobId: "" }, { evidence: new Map() } ]) {
    await fixture(async (ledger, _path, actionId) => {
      const backend: ExperimentBackend = { name: "fixture", async submit(claim) { return { ...accepted(request(claim)), ...change }; },
        async reconcile() { throw new Error("not invoked"); } };
      assert.equal((await dispatchNext(ledger, [backend], options))?.state, "unknown");
      assert.equal(ledger.getAction(actionId).reservation.outstandingMicrodollars, 60n);
    });
  }
});

test("timeout aborts the wait but a late acknowledgement cannot overwrite unknown state", async () => {
  await fixture(async (ledger, _path, actionId) => {
    let reply!: (value: unknown) => void;
    let query!: BackendRequest;
    let signal: AbortSignal | undefined;
    const backend: ExperimentBackend = { name: "fixture", submit(claim, childSignal) {
      signal = childSignal; query = request(claim); return new Promise(resolve => { reply = resolve; });
    }, async reconcile() { return { ...query, outcome: "unknown", evidence }; } };
    const result = await dispatchNext(ledger, [backend], { ...options, timeoutMs: 10 });
    assert.equal(result?.state, "unknown");
    assert.equal(signal?.aborted, true);
    reply(accepted(query));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(ledger.getAction(actionId).state, "unknown");
    assert.equal((await reconcileAction(ledger, backend, actionId)).state, "unknown");
  });
});

test("pre-cancelled dispatch leaves the durable queue untouched", async () => {
  await fixture(async (ledger, _path, actionId) => {
    const abort = new AbortController(); abort.abort();
    assert.equal(await dispatchNext(ledger, [], { ...options, signal: abort.signal }), null);
    assert.equal(ledger.getAction(actionId).state, "queued");
  });
});

test("missing adapter records known nonacceptance without inventing settlement", async () => {
  await fixture(async (ledger, _path, actionId) => {
    const result = await dispatchNext(ledger, [], options);
    assert.equal(result?.state, "confirmed_not_accepted");
    assert.equal(ledger.getAction(actionId).reservation.finalized, false);
    assert.equal(await dispatchNext(ledger, [], options), null);
  });
});

test("stop between durable claim and invocation prevents the local backend request", async () => {
  await fixture(async (ledger, _path, actionId) => {
    let submits = 0;
    const claim = ledger.claimDispatch.bind(ledger);
    ledger.claimDispatch = input => {
      const result = claim(input);
      ledger.stopScope({ scopeId: "global", expectedEpoch: ledger.getScope("global").epoch, reason: "test stop race" });
      return result;
    };
    const backend: ExperimentBackend = { name: "fixture", async submit(value) { submits++; return accepted(request(value)); }, async reconcile() { return null; } };
    await dispatchNext(ledger, [backend], options);
    assert.equal(submits, 0);
    assert.equal(ledger.getAction(actionId).state, "confirmed_not_accepted");
  });
});

test("acceptance received after stop remains recorded as real work requiring cancellation", async () => {
  await fixture(async (ledger, _path, actionId) => {
    const backend: ExperimentBackend = { name: "fixture", async submit(value) {
      ledger.stopScope({ scopeId: "global", expectedEpoch: ledger.getScope("global").epoch, reason: "stop while remote request in flight" });
      return accepted(request(value));
    }, async reconcile() { return null; } };
    assert.equal((await dispatchNext(ledger, [backend], options))?.state, "acknowledged");
    assert.equal(ledger.getScope("global").stopped, true);
    assert.equal(ledger.getAction(actionId).reservation.outstandingMicrodollars, 60n);
  });
});
