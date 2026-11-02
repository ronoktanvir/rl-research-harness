import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dispatchNext } from "../../src/controller/dispatcher.ts";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import type { AdmitActionInput, ExperimentLedger, ExperimentManifest } from "../../src/ledger/types.ts";

const now = () => new Date("2026-11-02T12:00:00.000Z");
const evidence = { fixture: "synthetic controller test; no external verification" };

function manifest(maxCostMicrodollars = "1000"): ExperimentManifest {
  return {
    schemaVersion: 1,
    code: { revision: "a".repeat(40), dirtyPatchSha256: null },
    environment: { imageDigest: `sha256:${"b".repeat(64)}`, dependenciesDigest: "c".repeat(64) },
    adapter: { kind: "llm_posttraining", name: "fixture", config: { batchSize: 1 } },
    data: { version: "fixture-v1", splitsDigest: "d".repeat(64) },
    model: { version: "fixture-model-v1" }, reward: { version: "reward-v1" }, evaluator: { version: "evaluator-v1" },
    seeds: [1], resources: { maxDurationSeconds: 60, maxCostMicrodollars }, evaluationPolicy: { heldOut: true },
  };
}

function addScope(ledger: ExperimentLedger, scopeId: string, parentScopeId: string | null, limit = 100n): void {
  ledger.configureBudget({ scopeId, parentScopeId, expectedRevision: 0, limitMicrodollars: limit });
  if (scopeId === "global" || scopeId.startsWith("project:")) {
    ledger.configurePolicy({ scopeId, expectedVersion: 0, allowedBackends: ["fixture", "fixture-alt"], allowedOperations: ["launch"], requiredChecks: ["contract"] });
  }
}

function initialize(ledger: ExperimentLedger, options: { limit?: bigint; runLimit?: string } = {}): string {
  addScope(ledger, "global", null, options.limit ?? 100n);
  addScope(ledger, "project:study", "global", options.limit ?? 100n);
  const record = ledger.registerManifest(manifest(options.runLimit));
  ledger.recordValidation({ validationId: "contract-validation", manifestDigest: record.digest, check: "contract", source: "fixture-validator", sequence: 1, status: "passed", evidence });
  ledger.createRun({ runId: "run-1", projectId: "study", manifestDigest: record.digest, replicaId: "replica-1" });
  return record.digest;
}

function action(overrides: Partial<AdmitActionInput> = {}): AdmitActionInput {
  return {
    runId: "run-1", operation: "launch", operationRevision: 1, backend: "fixture", payload: { task: "bounded synthetic work" },
    reservation: { amountMicrodollars: 60n, category: "compute", basis: "fixture upper bound" }, ...overrides,
  };
}

async function withLedger(body: (ledger: ExperimentLedger) => void | Promise<void>, options: { limit?: bigint; runLimit?: string } = {}): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ledger-adversarial-"));
  const ledger = openExperimentLedger({ path: join(directory, "ledger.sqlite"), now });
  try { initialize(ledger, options); await body(ledger); }
  finally { ledger.close(); await rm(directory, { recursive: true, force: true }); }
}

test("child allowances cannot bypass ancestor caps or change their ancestry", async () => {
  await withLedger(ledger => {
    addScope(ledger, "allowance:a", "project:study");
    addScope(ledger, "allowance:b", "project:study");
    addScope(ledger, "project:other", "global");
    ledger.admitAction(action({ budgetScopeId: "allowance:a" }));
    assert.throws(() => ledger.admitAction(action({ operationRevision: 2, budgetScopeId: "allowance:b" })));
    assert.throws(() => ledger.admitAction(action({ operationRevision: 3, budgetScopeId: "project:other" })));
    assert.throws(() => ledger.configureBudget({ scopeId: "allowance:a", parentScopeId: "allowance:b", expectedRevision: 1, limitMicrodollars: 100n }));
    assert.equal(ledger.getBudget("global").outstandingMicrodollars, 60n);
    assert.equal(ledger.getBudget("project:study").outstandingMicrodollars, 60n);
    assert.equal(ledger.getBudget("allowance:b").outstandingMicrodollars, 0n);
    assert.equal(ledger.listActions().length, 1);
  });
});

test("action identity binds reservation metadata and backend as well as payload", async () => {
  await withLedger(ledger => {
    const original = action();
    const admitted = ledger.admitAction(original);
    assert.equal(ledger.admitAction(structuredClone(original)).actionId, admitted.actionId);
    for (const changed of [
      { ...original, backend: "fixture-alt" },
      { ...original, payload: { task: "different work" } },
      { ...original, reservation: { ...original.reservation, amountMicrodollars: 59n } },
      { ...original, reservation: { ...original.reservation, category: "model" as const } },
      { ...original, reservation: { ...original.reservation, basis: "a different bound" } },
    ]) assert.throws(() => ledger.admitAction(changed));
    assert.equal(ledger.listActions().length, 1);
    assert.equal(ledger.getBudget("global").outstandingMicrodollars, 60n);
  });
});

test("admission persists one snapshot and rejects non-JSON or non-string enum payloads", async () => {
  await withLedger(ledger => {
    let reads = 0;
    const input = action();
    Object.defineProperty(input.payload, "task", { enumerable: true, get: () => ++reads === 1 ? "first value" : "later value" });
    const admitted = ledger.admitAction(input);
    assert.equal(reads, 1);
    assert.equal(admitted.payload.task, "first value");
    admitted.payload.task = "caller mutation";
    assert.equal(ledger.getAction(admitted.actionId).payload.task, "first value");
    const invalidEnum = action({ operationRevision: 2 });
    Object.assign(invalidEnum.reservation, { category: ["compute"] });
    assert.throws(() => ledger.admitAction(invalidEnum));
    const cyclic = action({ operationRevision: 3 });
    cyclic.payload.self = cyclic.payload;
    assert.throws(() => ledger.admitAction(cyclic));
    assert.equal(ledger.listActions().length, 1);
    assert.equal(ledger.getBudget("global").outstandingMicrodollars, 60n);
  });
});

test("a frozen manifest cap limits aggregate run exposure across action revisions", async () => {
  await withLedger(ledger => {
    ledger.admitAction(action());
    assert.throws(() => ledger.admitAction(action({ operationRevision: 2, reservation: { amountMicrodollars: 40n, category: "compute", basis: "fixture" } })));
    assert.equal(ledger.getBudget("global").outstandingMicrodollars, 60n);
    assert.equal(ledger.listActions().length, 1);
  }, { limit: 1000n, runLimit: "90" });
});

test("dispatch deadlines cannot exceed the manifest bound or authorize an altered claim", async () => {
  await withLedger(ledger => {
    ledger.admitAction(action());
    assert.throws(() => ledger.claimDispatch({ workerId: "fixture-worker", deadlineAt: "2026-11-02T12:02:00.000Z" }));
    const claim = ledger.claimDispatch({ workerId: "fixture-worker", deadlineAt: "2026-11-02T12:00:30.000Z" });
    assert.ok(claim);
    assert.equal(ledger.isDispatchAuthorized(claim), true);
    const forged = structuredClone(claim);
    forged.action.payload.task = "unadmitted replacement work";
    assert.equal(ledger.isDispatchAuthorized(forged), false);
  });
});

test("stop and resume invalidate old claims without clearing another scope's barrier", async () => {
  await withLedger(ledger => {
    addScope(ledger, "allowance:a", "project:study");
    ledger.admitAction(action());
    const claim = ledger.claimDispatch({ workerId: "fixture-worker", deadlineAt: "2026-11-02T12:00:30.000Z" });
    assert.ok(claim);
    const stopped = ledger.stopScope({ scopeId: "project:study", expectedEpoch: ledger.getScope("project:study").epoch, reason: "test stop" });
    assert.equal(ledger.isDispatchAuthorized(claim), false);
    ledger.stopScope({ scopeId: "global", expectedEpoch: ledger.getScope("global").epoch, reason: "global test stop" });
    ledger.resumeScope({ scopeId: "project:study", expectedEpoch: stopped.epoch, reason: "explicit local resume" });
    assert.equal(ledger.isDispatchAuthorized(claim), false);
    assert.equal(ledger.getScope("global").stopped, true);
    assert.throws(() => ledger.stopScope({ scopeId: "allowance:a", expectedEpoch: 0, reason: "unsupported child stop" }));
    assert.throws(() => ledger.resumeScope({ scopeId: "project:study", expectedEpoch: stopped.epoch, reason: "stale resume" }));
  });
});

test("unknown launch retains exposure and cannot be silently retried or settled", async () => {
  await withLedger(ledger => {
    const admitted = ledger.admitAction(action());
    const claim = ledger.claimDispatch({ workerId: "fixture-worker", deadlineAt: "2026-11-02T12:00:30.000Z" });
    assert.ok(claim);
    ledger.recordDispatchOutcome({ receiptId: "lost-reply", actionId: admitted.actionId, attemptId: claim.attemptId, manifestDigest: admitted.manifestDigest, backend: admitted.backend, outcome: "unknown", evidence });
    assert.throws(() => ledger.requeueAction(admitted.actionId));
    assert.throws(() => ledger.finalizeReservation({ settlementId: "premature-settlement", actionId: admitted.actionId, finalChargeMicrodollars: 0n, source: "fixture", exposureEnded: true, evidence }));
    assert.equal(ledger.getAction(admitted.actionId).state, "unknown");
    assert.equal(ledger.getBudget("global").outstandingMicrodollars, 60n);
  });
});

test("partial and late above-reservation charges stay truthful without double counting", async () => {
  await withLedger(ledger => {
    const admitted = ledger.admitAction(action());
    const partial = { chargeId: "partial-charge", actionId: admitted.actionId, amountMicrodollars: 20n, source: "fixture-billing", evidence };
    ledger.recordCharge(partial);
    ledger.recordCharge(structuredClone(partial));
    assert.throws(() => ledger.recordCharge({ ...partial, amountMicrodollars: 21n }));
    assert.equal(ledger.getBudget("global").chargedMicrodollars, 20n);
    assert.equal(ledger.getBudget("global").outstandingMicrodollars, 40n);
    assert.equal(ledger.getBudget("global").availableMicrodollars, 40n);
    ledger.recordCharge({ ...partial, chargeId: "late-overage", amountMicrodollars: 90n });
    assert.equal(ledger.getBudget("global").chargedMicrodollars, 110n);
    assert.equal(ledger.getBudget("global").outstandingMicrodollars, 0n);
    assert.equal(ledger.getBudget("global").availableMicrodollars, -10n);
    assert.throws(() => ledger.admitAction(action({ operationRevision: 2, reservation: { amountMicrodollars: 1n, category: "compute", basis: "fixture" } })));
  });
});

test("historical observations cannot assert live execution or scientific validity", async () => {
  await withLedger(ledger => {
    const original = { eventId: "historical-report", projectId: "study", runId: "run-1", actionId: null, jobId: null, source: "historical-coworker-report", sequence: 1, observedAt: "2026-11-01T00:00:00.000Z", payload: { execution: "succeeded", evaluation: "valid", reportedReward: 100 } };
    ledger.appendObservation(original);
    ledger.appendObservation(structuredClone(original));
    assert.throws(() => ledger.appendObservation({ ...original, payload: { execution: "running" } }));
    assert.throws(() => ledger.appendObservation({ ...original, eventId: "wrong-project", projectId: "other" }));
    const run = ledger.getRun("run-1");
    assert.equal(run.execution, "unknown");
    assert.equal(run.evaluation, "unassessed");
    assert.equal(ledger.listObservations("study").length, 1);
    assert.throws(() => ledger.recordEvaluation({ eventId: "wrong-evaluator", runId: "run-1", evaluatorVersion: "replacement-evaluator", state: "valid", source: "fixture-evaluator", sequence: 1, evidence }));
  });
});

test("a different source cannot supersede a failed authoritative validation", async () => {
  await withLedger(ledger => {
    const manifestDigest = ledger.getRun("run-1").manifestDigest;
    ledger.recordValidation({ validationId: "failed-contract", manifestDigest, check: "contract", source: "fixture-validator", sequence: 2, status: "failed", evidence });
    assert.throws(() => ledger.recordValidation({ validationId: "replacement-source", manifestDigest, check: "contract", source: "unrelated-validator", sequence: 3, status: "passed", evidence }));
    assert.throws(() => ledger.admitAction(action()));
    assert.equal(ledger.listActions().length, 0);
    assert.equal(ledger.getBudget("global").outstandingMicrodollars, 0n);
  });
});

test("an unsettled reservation overrun blocks further admission even below the project cap", async () => {
  await withLedger(ledger => {
    const admitted = ledger.admitAction(action());
    ledger.recordCharge({ chargeId: "over-estimate", actionId: admitted.actionId, amountMicrodollars: 70n, source: "fixture-billing", evidence });
    assert.equal(ledger.getBudget("global").chargedMicrodollars, 70n);
    assert.equal(ledger.getAction(admitted.actionId).reservation.finalized, false);
    assert.throws(() => ledger.admitAction(action({ operationRevision: 2, reservation: { amountMicrodollars: 1n, category: "compute", basis: "fixture" } })));
    assert.equal(ledger.listActions().length, 1);
  }, { limit: 1000n });
});

test("sparse backend evidence becomes durable unknown rather than escaping reply validation", async () => {
  await withLedger(async ledger => {
    const admitted = ledger.admitAction(action());
    const result = await dispatchNext(ledger, [{ name: "fixture",
      async submit(claim) {
        return { actionId: claim.action.actionId, attemptId: claim.attemptId, manifestDigest: claim.action.manifestDigest,
          backend: claim.action.backend, backendKey: claim.action.backendKey, outcome: "accepted", jobId: "job-1",
          evidence: { items: new Array(1) } };
      },
      async reconcile() { throw new Error("must not reconcile implicitly"); },
    }], { workerId: "fixture-worker", deadlineAt: "2026-11-02T12:00:30.000Z", timeoutMs: 1000 });
    assert.equal(result?.state, "unknown");
    assert.equal(ledger.getAction(admitted.actionId).state, "unknown");
    assert.equal(ledger.getAction(admitted.actionId).reservation.outstandingMicrodollars, 60n);
  });
});

test("own prototype-named JSON keys retain their identity through dispatch serialization", async () => {
  await withLedger(ledger => {
    const payload = JSON.parse('{"__proto__":{"tag":"ordinary JSON data"},"task":"fixture"}') as AdmitActionInput["payload"];
    const admitted = ledger.admitAction(action({ payload }));
    assert.equal(Object.hasOwn(admitted.payload, "__proto__"), true);
    const claim = ledger.claimDispatch({ workerId: "fixture-worker", deadlineAt: "2026-11-02T12:00:30.000Z" });
    assert.ok(claim);
    assert.deepEqual(claim.action.payload, payload);
    assert.equal(ledger.isDispatchAuthorized(claim), true);
  });
});

test("an admitted cleanup retry remains idempotent after its target is reconciled", async () => {
  await withLedger(ledger => {
    for (const scopeId of ["global", "project:study"]) {
      ledger.configurePolicy({ scopeId, expectedVersion: 1, allowedBackends: ["fixture"], allowedOperations: ["launch", "cancel", "release"], requiredChecks: ["contract"] });
    }
    const target = ledger.admitAction(action());
    const claim = ledger.claimDispatch({ workerId: "fixture-worker", deadlineAt: "2026-11-02T12:00:30.000Z" });
    assert.ok(claim);
    const outcome = { actionId: target.actionId, attemptId: claim.attemptId, manifestDigest: target.manifestDigest, backend: target.backend, evidence };
    ledger.recordDispatchOutcome({ ...outcome, receiptId: "ambiguous-target", outcome: "unknown" });
    const cleanupInput = { targetActionId: target.actionId, operation: "cancel" as const, operationRevision: 1,
      reservation: { amountMicrodollars: 0n, category: "other" as const, basis: "no-charge synthetic cancellation" } };
    const cleanup = ledger.admitCleanup(cleanupInput);
    ledger.recordDispatchOutcome({ ...outcome, receiptId: "target-not-accepted", outcome: "not_accepted" });
    assert.equal(ledger.admitCleanup(cleanupInput).actionId, cleanup.actionId);
    assert.equal(ledger.listActions().length, 2);
  });
});

test("dispatch authorization rejects type substitutions hidden by monetary serialization", async () => {
  await withLedger(ledger => {
    ledger.admitAction(action({ payload: { count: "60" } }));
    const claim = ledger.claimDispatch({ workerId: "fixture-worker", deadlineAt: "2026-11-02T12:00:30.000Z" });
    assert.ok(claim);
    const changedPayload = structuredClone(claim);
    Object.assign(changedPayload.action.payload, { count: 60n });
    assert.equal(ledger.isDispatchAuthorized(changedPayload), false);
    const changedMoney = structuredClone(claim);
    Object.assign(changedMoney.action.reservation, { amountMicrodollars: "60" });
    assert.equal(ledger.isDispatchAuthorized(changedMoney), false);
  });
});
