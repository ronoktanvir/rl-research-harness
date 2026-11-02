import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { mkdtemp, readFile, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import type { ExperimentLedger, ObservationInput } from "../../src/ledger/index.ts";
import { admission, deadline, fixedNow, initialize, manifest } from "./helpers.ts";

async function fixture(body: (ledger: ExperimentLedger, path: string) => void | Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "research-ledger-")), path = join(directory, "ledger.sqlite");
  const ledger = openExperimentLedger({ path, now: fixedNow });
  try { initialize(ledger); await body(ledger, path); } finally { ledger.close(); await rm(directory, { recursive: true, force: true }); }
}
const observation = (runId: string | null = null): ObservationInput => ({ eventId: "observed-one", projectId: "study", runId, actionId: null, jobId: null, source: "fixture-reader", sequence: 0, observedAt: fixedNow().toISOString(), payload: { loss: 0.2 } });

test("identical run/action/observation retries survive reopen without duplicate spending", async () => {
  await fixture((ledger, path) => {
    const input = admission(), action = ledger.admitAction(input), observed = ledger.appendObservation(observation("run-one"));
    ledger.close();
    const reopened = openExperimentLedger({ path, now: fixedNow });
    try {
      assert.equal(reopened.admitAction(input).actionId, action.actionId);
      assert.deepEqual(reopened.appendObservation(observation("run-one")), observed);
      assert.equal(reopened.listActions().length, 1);
      assert.equal(reopened.listObservations("study").length, 1);
      assert.equal(reopened.getBudget("global").outstandingMicrodollars, 100n);
      assert.throws(() => reopened.admitAction({ ...input, payload: { different: true } }), /different content/);
      assert.throws(() => reopened.appendObservation({ ...observation("run-one"), source: "different-source" }), /different content/);
      assert.throws(() => reopened.createRun({ runId: "another-name", projectId: "study", manifestDigest: action.manifestDigest, replicaId: "replica-one" }), /Replica identity/);
      assert.equal(reopened.createRun({ runId: "explicit-replica", projectId: "study", manifestDigest: action.manifestDigest, replicaId: "replica-two" }).replicaId, "replica-two");
    } finally { reopened.close(); }
  });
});

test("failure at the final admission event rolls back action, reservation and outbox together", async () => {
  await fixture((ledger, path) => {
    const raw = new DatabaseSync(path);
    try {
      raw.exec("CREATE TRIGGER fail_admission BEFORE INSERT ON events WHEN NEW.kind='action_admitted' BEGIN SELECT RAISE(ABORT,'injected final write failure'); END");
      const before = ledger.events().length;
      assert.throws(() => ledger.admitAction(admission()), /injected final write failure/);
      assert.equal(ledger.listActions().length, 0);
      assert.equal(ledger.getBudget("global").outstandingMicrodollars, 0n);
      assert.equal(raw.prepare("SELECT count(*) AS count FROM action_scopes").get()?.count, 0);
      assert.equal(raw.prepare("SELECT count(*) AS count FROM outbox").get()?.count, 0);
      assert.equal(ledger.events().length, before);
      raw.exec("DROP TRIGGER fail_admission");
      assert.equal(ledger.admitAction(admission()).state, "queued");
    } finally { raw.close(); }
  });
});

test("concurrent callers share one ancestor allowance and cannot independently reserve copies", async () => {
  await fixture(async ledger => {
    ledger.configureBudget({ scopeId: "global", parentScopeId: null, expectedRevision: 1, limitMicrodollars: 101n });
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => Promise.resolve().then(() => ledger.admitAction(admission(index + 1, 25n)))));
    assert.equal(results.filter(item => item.status === "fulfilled").length, 4);
    assert.equal(ledger.getBudget("global").outstandingMicrodollars, 100n);
    assert.equal(ledger.getBudget("project:study").outstandingMicrodollars, 100n);
  });
});

test("lost acceptance is reconciled by identity without issuing a second launch", async () => {
  await fixture((ledger, path) => {
    const action = ledger.admitAction(admission());
    const claim = ledger.claimDispatch({ workerId: "fixture-worker", deadlineAt: deadline })!;
    let launches = 0;
    const backend = new Map<string, string>();
    launches++; backend.set(action.backendKey, "job-fixture"); // Acceptance happened; receipt was lost.
    ledger.close();
    const reopened = openExperimentLedger({ path, now: fixedNow });
    try {
      assert.equal(reopened.getAction(action.actionId).state, "unknown");
      assert.equal(reopened.claimDispatch({ workerId: "fixture-worker", deadlineAt: deadline }), null);
      assert.throws(() => reopened.requeueAction(action.actionId), /Only confirmed/);
      const receipt = { receiptId: "reconciled-one", actionId: action.actionId, attemptId: claim.attemptId, manifestDigest: action.manifestDigest, backend: action.backend, outcome: "accepted" as const, jobId: backend.get(action.backendKey)!, evidence: { source: "synthetic backend identity lookup" } };
      assert.equal(reopened.recordDispatchOutcome(receipt).state, "acknowledged");
      assert.equal(reopened.recordDispatchOutcome(receipt).jobId, "job-fixture");
      assert.throws(() => reopened.recordDispatchOutcome({ ...receipt, receiptId: "contradictory", jobId: "different-job" }), /contradicts/);
      assert.equal(launches, 1);
    } finally { reopened.close(); }
  });
});

test("proven nonacceptance permits a new attempt under the original logical action", async () => {
  await fixture(ledger => {
    const action = ledger.admitAction(admission());
    const first = ledger.claimDispatch({ workerId: "fixture-worker", deadlineAt: deadline })!;
    ledger.recordDispatchOutcome({ receiptId: "refused", actionId: action.actionId, attemptId: first.attemptId, manifestDigest: action.manifestDigest, backend: action.backend, outcome: "not_accepted", evidence: { authoritative: "synthetic refusal before work" } });
    ledger.requeueAction(action.actionId);
    const second = ledger.claimDispatch({ workerId: "fixture-worker", deadlineAt: deadline })!;
    assert.equal(second.action.actionId, first.action.actionId);
    assert.equal(second.action.backendKey, first.action.backendKey);
    assert.notEqual(second.attemptId, first.attemptId);
    assert.equal(ledger.getBudget("global").outstandingMicrodollars, 100n);
    assert.throws(() => ledger.recordDispatchOutcome({ receiptId: "late-old-attempt", actionId: action.actionId, attemptId: first.attemptId, manifestDigest: action.manifestDigest, backend: action.backend, outcome: "accepted", jobId: "unexpected", evidence: {} }), /current attempt/);
  });
});

test("stop persists across reopen and a scope resume cannot clear the global barrier", async () => {
  await fixture((ledger, path) => {
    const action = ledger.admitAction(admission());
    const global = ledger.stopScope({ scopeId: "global", expectedEpoch: ledger.getScope("global").epoch, reason: "operator stop" });
    const project = ledger.stopScope({ scopeId: "project:study", expectedEpoch: ledger.getScope("project:study").epoch, reason: "project stop" });
    assert.equal(ledger.claimDispatch({ workerId: "fixture-worker", deadlineAt: deadline }), null);
    ledger.close();
    const reopened = openExperimentLedger({ path, now: fixedNow });
    try {
      assert.equal(reopened.getScope("global").stopped, true);
      assert.ok(reopened.getScope("global").epoch > global.epoch);
      reopened.resumeScope({ scopeId: "project:study", expectedEpoch: project.epoch, reason: "explicit project resume" });
      assert.equal(reopened.getScope("global").stopped, true);
      assert.equal(reopened.claimDispatch({ workerId: "fixture-worker", deadlineAt: deadline }), null);
      assert.equal(reopened.getAction(action.actionId).state, "queued");
    } finally { reopened.close(); }
  });
});

test("trainer cancellation, allocation release, billing and scientific evaluation remain independent", async () => {
  await fixture(ledger => {
    const action = ledger.admitAction(admission()), claim = ledger.claimDispatch({ workerId: "fixture-worker", deadlineAt: deadline })!;
    ledger.recordDispatchOutcome({ receiptId: "accepted", actionId: action.actionId, attemptId: claim.attemptId, manifestDigest: action.manifestDigest, backend: action.backend, outcome: "accepted", jobId: "job-one", evidence: {} });
    ledger.recordExecution({ eventId: "stopped", runId: "run-one", source: "worker", sequence: 2, state: "cancelled", evidence: { exit: "confirmed" } });
    ledger.recordExecution({ eventId: "late-running", runId: "run-one", source: "worker", sequence: 1, state: "running", evidence: { older: true } });
    assert.equal(ledger.getRun("run-one").execution, "cancelled");
    assert.equal(ledger.getRun("run-one").evaluation, "unassessed");
    assert.equal(ledger.getAction(action.actionId).allocation, "unknown");
    const charge = { chargeId: "invoice-part", actionId: action.actionId, amountMicrodollars: 20n, source: "billing", evidence: { invoice: "part1" } };
    ledger.recordCharge(charge);
    const settlement = { settlementId: "final-bill", actionId: action.actionId, finalChargeMicrodollars: 20n, source: "billing", exposureEnded: true as const, evidence: { invoice: "final" } };
    assert.throws(() => ledger.finalizeReservation(settlement), /allocation release/);
    ledger.recordAllocation({ eventId: "released", actionId: action.actionId, source: "allocator", sequence: 1, state: "released", evidence: { terminated: true } });
    assert.equal(ledger.getBudget("global").outstandingMicrodollars, 80n);
    ledger.finalizeReservation(settlement);
    assert.equal(ledger.getBudget("global").outstandingMicrodollars, 0n);
    assert.equal(ledger.getRun("run-one").evaluation, "unassessed");
    ledger.recordCharge({ ...charge, chargeId: "late-bill", amountMicrodollars: 90n });
    assert.equal(ledger.getAction(action.actionId).reservation.chargedMicrodollars, 110n);
    assert.equal(ledger.getAction(action.actionId).reservation.finalized, false);
    assert.equal(ledger.getRun("run-one").execution, "cancelled");
    assert.throws(() => ledger.recordCharge({ ...charge, amountMicrodollars: 21n }), /different content/);
    assert.equal(ledger.events().filter(event => event.kind === "execution_confirmed").length, 2);
  });
});

test("changing getters produce one immutable manifest snapshot, and unknown JSON values fail", async () => {
  await fixture(ledger => {
    const input = manifest(); let reads = 0;
    Object.defineProperty(input.model, "version", { enumerable: true, get: () => ++reads === 1 ? "first-model" : "changed-model" });
    const record = ledger.registerManifest(input);
    assert.equal(reads, 1); assert.equal(record.manifest.model.version, "first-model");
    const changed = ledger.getManifest(record.digest); changed.manifest.model.version = "mutation";
    assert.equal(ledger.getManifest(record.digest).manifest.model.version, "first-model");
    assert.throws(() => ledger.registerManifest({ ...manifest(), evaluationPolicy: { invalid: NaN } }));
    const sparse = manifest(); sparse.seeds = Array(1) as number[]; assert.throws(() => ledger.registerManifest(sparse));
  });
});

test("unsupported or foreign stores fail before main schema writes and release ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ledger-version-")), path = join(directory, "future.sqlite");
  try {
    const raw = new DatabaseSync(path); raw.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('schema_version','999')"); raw.close();
    const before = await readFile(path);
    assert.throws(() => openExperimentLedger({ path }), /Unsupported ledger schema/);
    assert.deepEqual(await readFile(path), before);
    const repair = new DatabaseSync(path); repair.exec("UPDATE meta SET value='1'"); repair.close();
    const opened = openExperimentLedger({ path, now: fixedNow }); opened.close();
    const foreignPath = join(directory, "foreign.sqlite"), foreign = new DatabaseSync(foreignPath); foreign.exec("CREATE TABLE unrelated(value TEXT)"); foreign.close();
    assert.throws(() => openExperimentLedger({ path: foreignPath }), /not an experiment ledger/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the live owner excludes aliases and preserves the owner file through orderly close", async () => {
  await fixture(async (ledger, path) => {
    assert.throws(() => openExperimentLedger({ path }), /owns this ledger/);
    assert.throws(() => openExperimentLedger({ path: join(path, "..", "ledger.sqlite") }), /owns this ledger/);
    const alias = join(path, "..", "alias.sqlite"); await symlink(path, alias);
    assert.throws(() => openExperimentLedger({ path: alias }), /without aliases/);
    const hard = join(path, "..", "hard.sqlite"); await link(path, hard);
    assert.throws(() => openExperimentLedger({ path: hard }), /without aliases/);
    await rm(hard);
    ledger.close();
    assert.ok((await readFile(`${path}.owner.sqlite`)).length >= 0);
    const reopened = openExperimentLedger({ path, now: fixedNow }); reopened.close();
  });
});

async function launchCrashWorker(path: string, phase: string): Promise<ReturnType<typeof spawn>> {
  const child = spawn(process.execPath, ["--expose-gc", "--import", "tsx", resolve("test/ledger/fixtures/crash-worker.ts"), path, phase], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr!.on("data", data => { stderr += String(data); });
  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Crash fixture timed out: ${stderr}`)); }, 10_000);
    child.stdout!.on("data", data => { if (String(data).includes("ready")) { clearTimeout(timeout); resolveReady(); } });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Fixture exited ${code}: ${stderr}`)); });
  });
  return child;
}

test("ownership survives garbage collection until real process death preserves each dispatch boundary", async t => {
  for (const phase of ["before-commit", "after-admission", "after-claim"]) await t.test(phase, async () => {
    const directory = await mkdtemp(join(tmpdir(), "ledger-crash-")), path = join(directory, "ledger.sqlite");
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = await launchCrashWorker(path, phase);
      assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
      assert.throws(() => { const contender = openExperimentLedger({ path }); contender.close(); }, /owns this ledger/);
      const exited = once(child, "exit"); child.kill("SIGKILL");
      assert.deepEqual(await exited, [null, "SIGKILL"]);
      const reopened = openExperimentLedger({ path, now: fixedNow });
      try {
        const actions = reopened.listActions();
        assert.equal(actions.length, phase === "before-commit" ? 0 : 1);
        if (actions.length) assert.equal(actions[0]!.state, phase === "after-claim" ? "unknown" : "queued");
        assert.equal(reopened.getBudget("global").outstandingMicrodollars, phase === "before-commit" ? 0n : 100n);
        if (phase === "after-claim") assert.equal(reopened.claimDispatch({ workerId: "new-worker", deadlineAt: deadline }), null);
      } finally { reopened.close(); }
    } finally {
      if (child?.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("reaching the reservation bound holds new ordinary work until authoritative settlement", async () => {
  await fixture(ledger => {
    const action = ledger.admitAction(admission());
    ledger.recordCharge({ chargeId: "exhausted", actionId: action.actionId, amountMicrodollars: 100n, source: "billing", evidence: {} });
    assert.equal(ledger.getBudget("global").availableMicrodollars, 900n);
    assert.throws(() => ledger.admitAction(admission(2, 1n)), /exhausted its bound/);
    assert.equal(ledger.claimDispatch({ workerId: "fixture-worker", deadlineAt: deadline }), null);
  });
});

test("cleanup remains scoped and dispatchable while stopped and scientifically invalidated", async () => {
  await fixture((ledger, path) => {
    const action = ledger.admitAction(admission());
    const originalClaim = ledger.claimDispatch({ workerId: "fixture-worker", deadlineAt: deadline })!;
    for (const scopeId of ["global", "project:study"]) ledger.configurePolicy({ scopeId, expectedVersion: 1, allowedBackends: ["fixture"], allowedOperations: ["launch", "cancel", "release"], requiredChecks: ["adapter-contract"] });
    ledger.recordValidation({ validationId: "now-invalid", manifestDigest: action.manifestDigest, check: "adapter-contract", source: "trusted-validator", sequence: 2, status: "failed", evidence: { discovered: "invalid evaluator" } });
    ledger.stopScope({ scopeId: "global", expectedEpoch: ledger.getScope("global").epoch, reason: "stop everything" });
    ledger.close();
    const reopened = openExperimentLedger({ path, now: fixedNow });
    try {
      assert.equal(reopened.getAction(action.actionId).state, "unknown");
      const input = { targetActionId: action.actionId, operation: "cancel" as const, operationRevision: 1, reservation: { amountMicrodollars: 0n, category: "other" as const, basis: "synthetic free cancellation" } };
      const cleanup = reopened.admitCleanup(input);
      assert.equal(cleanup.cleanupTargetActionId, action.actionId);
      assert.equal(cleanup.payload.targetBackendKey, action.backendKey);
      assert.equal(cleanup.backend, action.backend);
      assert.throws(() => reopened.admitAction({ ...admission(2, 0n), operation: "cancel" }), /stopped/);
      const claim = reopened.claimDispatch({ workerId: "cleanup-worker", deadlineAt: deadline })!;
      assert.equal(claim.action.actionId, cleanup.actionId);
      assert.equal(reopened.isDispatchAuthorized(claim), true);
      assert.throws(() => reopened.admitCleanup({ ...input, targetActionId: cleanup.actionId, operationRevision: 2 }), /original possibly accepted/);
      reopened.recordDispatchOutcome({ receiptId: "original-not-accepted", actionId: action.actionId, attemptId: originalClaim.attemptId, manifestDigest: action.manifestDigest, backend: action.backend, outcome: "not_accepted", evidence: { lookup: "authoritative absence" } });
      assert.equal(reopened.admitCleanup(input).actionId, cleanup.actionId); // Retry after target state changes.
      assert.throws(() => reopened.admitCleanup({ ...input, reservation: { ...input.reservation, amountMicrodollars: 1n } }), /different content/);
    } finally { reopened.close(); }
  });
});

test("positive-cost cleanup remains bounded when an allowance shrinks after admission", async () => {
  await fixture(ledger => {
    const action = ledger.admitAction(admission()), claim = ledger.claimDispatch({ workerId: "fixture-worker", deadlineAt: deadline })!;
    ledger.recordDispatchOutcome({ receiptId: "accepted-cleanup-target", actionId: action.actionId, attemptId: claim.attemptId, manifestDigest: action.manifestDigest, backend: action.backend, outcome: "accepted", jobId: "job", evidence: {} });
    for (const scopeId of ["global", "project:study"]) ledger.configurePolicy({ scopeId, expectedVersion: 1, allowedBackends: ["fixture"], allowedOperations: ["launch", "cancel", "release"], requiredChecks: [] });
    const input = { targetActionId: action.actionId, operation: "release" as const, operationRevision: 1, reservation: { amountMicrodollars: 10n, category: "other" as const, basis: "fee" } };
    ledger.admitCleanup(input);
    ledger.configureBudget({ scopeId: "global", parentScopeId: null, expectedRevision: 1, limitMicrodollars: 1n });
    assert.equal(ledger.claimDispatch({ workerId: "fixture-worker", deadlineAt: deadline }), null);
    const free = ledger.admitCleanup({ ...input, operationRevision: 2, reservation: { ...input.reservation, amountMicrodollars: 0n } });
    const cleanupClaim = ledger.claimDispatch({ workerId: "fixture-worker", deadlineAt: deadline })!;
    assert.equal(cleanupClaim.action.actionId, free.actionId);
    assert.equal(ledger.isDispatchAuthorized(cleanupClaim), true);
  });
});

test("a project can be stopped before its first run or policy exists", async () => {
  await fixture(ledger => {
    assert.throws(() => ledger.getScope("project:future"), /does not exist/);
    const state = ledger.stopScope({ scopeId: "project:future", expectedEpoch: 0, reason: "preemptive stop" });
    assert.equal(state.stopped, true);
    ledger.configurePolicy({ scopeId: "project:future", expectedVersion: 0, allowedBackends: ["fixture"], allowedOperations: ["launch"], requiredChecks: [] });
    assert.equal(ledger.getScope("project:future").stopped, true);
    assert.throws(() => ledger.resumeScope({ scopeId: "project:missing", expectedEpoch: 0, reason: "must exist" }), /does not exist/);
  });
});

test("aggregate charges stay exact beyond SQLite signed integers and can be explicitly settled", async () => {
  await fixture(ledger => {
    const action = ledger.admitAction(admission()), claim = ledger.claimDispatch({ workerId: "fixture-worker", deadlineAt: deadline })!;
    ledger.recordDispatchOutcome({ receiptId: "refused-with-fees", actionId: action.actionId, attemptId: claim.attemptId, manifestDigest: action.manifestDigest, backend: action.backend, outcome: "not_accepted", evidence: { refused: true } });
    const maximum = 9_223_372_036_854_775_807n;
    for (const chargeId of ["large-fee-one", "large-fee-two"]) ledger.recordCharge({ chargeId, actionId: action.actionId, amountMicrodollars: maximum, source: "billing", evidence: { synthetic: true } });
    assert.equal(ledger.getBudget("global").chargedMicrodollars, maximum * 2n);
    assert.equal(ledger.getBudget("global").availableMicrodollars, 1000n - maximum * 2n);
    const settled = ledger.finalizeReservation({ settlementId: "large-final-total", actionId: action.actionId, finalChargeMicrodollars: maximum * 2n, source: "billing", exposureEnded: true, evidence: { syntheticInvoiceFinal: true } });
    assert.equal(settled.reservation.finalized, true);
    assert.equal(settled.reservation.chargedMicrodollars, maximum * 2n);
    assert.throws(() => ledger.requeueAction(action.actionId), /unused, retained bound/);
  });
});

test("manifest digest fields reject placeholders and noncanonical SHA-256 spellings", async () => {
  await fixture(ledger => {
    const eventCount = ledger.events().length;
    for (const bad of ["fixture-image-digest", "b".repeat(64), `sha256:${"B".repeat(64)}`, `sha256:${"b".repeat(63)}`, `sha512:${"b".repeat(64)}`]) {
      const input = manifest(); input.environment.imageDigest = bad;
      assert.throws(() => ledger.registerManifest(input), /Image digest/);
    }
    for (const bad of ["fixture-digest", "C".repeat(64), "c".repeat(63), `sha256:${"c".repeat(64)}`, "g".repeat(64)]) {
      const dependencies = manifest(); dependencies.environment.dependenciesDigest = bad;
      assert.throws(() => ledger.registerManifest(dependencies), /SHA-256/);
      const splits = manifest(); splits.data.splitsDigest = bad;
      assert.throws(() => ledger.registerManifest(splits), /SHA-256/);
    }
    assert.equal(ledger.events().length, eventCount);
    assert.equal(ledger.registerManifest(manifest()).manifest.environment.imageDigest, `sha256:${"b".repeat(64)}`);
  });
});
