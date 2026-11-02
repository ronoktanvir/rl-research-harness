import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dispatchNext, reconcileAction } from "../../src/controller/dispatcher.ts";
import type { ExperimentBackend } from "../../src/controller/dispatcher.ts";
import { createSupervisedExperimentBackend } from "../../src/execution/backend.ts";
import type { PreparedLocalLaunch } from "../../src/execution/backend.ts";
import { openJobJournal } from "../../src/execution/journal.ts";
import { createJobDeclaration } from "../../src/execution/worker.ts";
import type { ServiceLaunchRequest, ServiceQueryResult, ServiceSnapshot, SystemdTransport } from "../../src/execution/types.ts";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import type { DispatchClaim } from "../../src/ledger/types.ts";
import { prepareCoworkerAttempt } from "../../src/integrations/coworker/attempt-plan.ts";
import { coworkerAttemptFixture } from "../integrations/coworker-attempt-fixtures.ts";

const now = () => new Date("2026-11-02T12:00:00.000Z");
const host = { machineId: "a".repeat(32), bootId: "11111111-1111-1111-1111-111111111111" };
const dispatchOptions = { workerId: "fixture-worker", deadlineAt: "2026-11-02T12:03:00.000Z", timeoutMs: 1_000 };
const signal = () => new AbortController().signal;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "harness-backend-"));
  const ledgerPath = join(directory, "ledger.sqlite"), journalPath = join(directory, "jobs.sqlite");
  let ledger = openExperimentLedger({ path: ledgerPath, now });
  let journal = openJobJournal({ path: journalPath, now });
  const input = coworkerAttemptFixture(), plan = prepareCoworkerAttempt(input);
  for (const scopeId of ["global", "project:coworker"]) {
    ledger.configureBudget({ scopeId, parentScopeId: scopeId === "global" ? null : "global", expectedRevision: 0, limitMicrodollars: 2_000_000n });
    ledger.configurePolicy({ scopeId, expectedVersion: 0, allowedBackends: [plan.binding.backend], allowedOperations: ["launch", "cancel", "release"], requiredChecks: [] });
  }
  ledger.registerManifest(input.manifest.manifest); ledger.createRun(input.run);
  const action = ledger.admitAction({ runId: input.run.runId, operation: "launch", operationRevision: 1,
    backend: plan.binding.backend, payload: { attemptPlanDigest: plan.digest }, reservation: { amountMicrodollars: 10n, category: "compute", basis: "synthetic fixture" } });
  let starts = 0, stops = 0, prepares = 0, deploymentAllowed = true;
  let request: ServiceLaunchRequest | null = null;
  let mode: "running" | "succeeded" | "failed" | "absent" | "unknown" = "running";
  function snapshot(q: ServiceLaunchRequest): ServiceSnapshot {
    const ended = mode === "succeeded" || mode === "failed";
    return { identity: q.identity, host: q.expectedHost, observedAt: now().toISOString(), invocationId: "b".repeat(32),
      loadState: "loaded", activeState: mode === "failed" ? "failed" : "active", subState: mode === "failed" ? "failed" : ended ? "exited" : "running",
      result: mode === "failed" ? "timeout" : "success", mainPid: ended ? 0 : 123, execMainCode: ended ? mode === "failed" ? 2 : 1 : 0,
      execMainStatus: mode === "failed" ? 9 : 0, controlGroup: `/system.slice/${q.identity.unitName}`, cgroupPopulated: !ended };
  }
  function observation(): ServiceQueryResult {
    if (!request || mode === "unknown") return { kind: "unknown", reason: "fixture_manager_unavailable" };
    if (mode === "absent") return { kind: "absent", host, observedAt: now().toISOString() };
    return { kind: "present", snapshot: snapshot(request) };
  }
  const transport: SystemdTransport = {
    async hostIdentity() { return host; },
    async start(value, _signal, authorize) {
      if (!authorize()) return { kind: "unknown", reason: "fixture_authority_denied" };
      starts++; request = value;
      return { kind: "accepted", evidence: { source: "fixture", identity: { ...value.identity }, host: { ...host } } };
    },
    async query() { return observation(); },
    async stop(_request, _signal, authorize) {
      if (!authorize()) return { command: "not_sent", observation: observation() };
      stops++; mode = "failed"; return { command: "sent", observation: observation() };
    },
  };
  function prepared(claim: DispatchClaim): PreparedLocalLaunch {
    const declaration = createJobDeclaration({ actionId: action.actionId, backendKey: action.backendKey, manifestDigest: action.manifestDigest,
      planDigest: plan.digest, workerId: dispatchOptions.workerId, host, deadlineAt: claim.deadlineAt,
      command: { executable: plan.command.executable, args: [...plan.command.args], cwd: plan.command.cwd, environment: { ...plan.command.environment.values } },
      limits: { runtimeMs: 120_000, startTimeoutMs: 30_000, stopTimeoutMs: 10_000, memoryMaxBytes: 8_589_934_592, tasksMax: 128 } });
    return { declaration, evidence: { kind: "injected_deployment_fixture", qualification: "synthetic_only" }, authorizeDeployment: () => deploymentAllowed };
  }
  const backend = (prepareLaunch: (claim: DispatchClaim, signal: AbortSignal) => Promise<PreparedLocalLaunch | null> = async claim => prepared(claim)) =>
    createSupervisedExperimentBackend({ name: plan.binding.backend, workerId: dispatchOptions.workerId, ledger, journal, transport, now, callTimeoutMs: 100,
      async prepareLaunch(claim, child) { prepares++; return prepareLaunch(claim, child); } });
  return { action, plan, transport, backend, prepared, ledger: () => ledger, journal: () => journal,
    counts: () => ({ starts, stops, prepares }), setMode(value: typeof mode) { mode = value; }, setDeployment(value: boolean) { deploymentAllowed = value; },
    cancel(operation: "cancel" | "release" = "cancel") { return ledger.admitCleanup({ targetActionId: action.actionId, operation, operationRevision: 1,
      reservation: { amountMicrodollars: 0n, category: "compute", basis: "zero additional fixture liability" } }); },
    reopen() { ledger.close(); journal.close(); ledger = openExperimentLedger({ path: ledgerPath, now }); journal = openJobJournal({ path: journalPath, now }); },
    async close() { ledger.close(); journal.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("admitted launch connects durable stores and status changes execution without approving science or release", async () => {
  const f = await fixture();
  try {
    const backend = f.backend();
    const accepted = await dispatchNext(f.ledger(), [backend], dispatchOptions);
    assert.equal(accepted?.state, "acknowledged"); assert.equal(f.counts().starts, 1);
    const job = f.journal().readByAction(f.action.actionId)!;
    assert.equal(accepted?.jobId, job.declaration.jobId);
    const intent = f.ledger().listObservations("coworker").find(item => item.payload.kind === "intent")!;
    assert.deepEqual(intent.payload.deploymentEvidence, { kind: "injected_deployment_fixture", qualification: "synthetic_only" });
    assert.equal(intent.payload.declarationDigest, job.digest);
    assert.equal((await backend.observe(f.action.actionId, signal())).executionProjected, true);
    assert.equal(f.ledger().getRun(f.action.runId).execution, "running");
    f.setMode("succeeded");
    assert.equal((await backend.observe(f.action.actionId, signal())).result.execution, "succeeded");
    assert.equal(f.ledger().getRun(f.action.runId).execution, "succeeded");
    assert.equal(f.ledger().getRun(f.action.runId).evaluation, "unassessed");
    assert.equal(f.ledger().getAction(f.action.actionId).allocation, "unknown");
    assert.equal(f.ledger().getAction(f.action.actionId).reservation.outstandingMicrodollars, 10n);
  } finally { await f.close(); }
});

test("lost bridge response recovers the conclusive receipt after both stores reopen without resolving or starting again", async () => {
  const f = await fixture();
  try {
    const real = f.backend();
    const losing: ExperimentBackend = { name: real.name, async submit(claim, child) { await real.submit(claim, child); throw new Error("lost response"); }, reconcile: real.reconcile };
    assert.equal((await dispatchNext(f.ledger(), [losing], dispatchOptions))?.state, "unknown");
    f.reopen();
    const resumed = f.backend(async () => { throw new Error("deployment is no longer available; recovery must not resolve it"); });
    assert.equal((await reconcileAction(f.ledger(), resumed, f.action.actionId)).state, "acknowledged");
    assert.deepEqual(f.counts(), { starts: 1, stops: 0, prepares: 1 });
  } finally { await f.close(); }
});

test("unknown launch queries the existing journal and later acceptance never replays preparation", async () => {
  const f = await fixture();
  try {
    const start = f.transport.start;
    f.transport.start = async (...args) => { await start(...args); f.setMode("unknown"); throw new Error("manager reply lost"); };
    assert.equal((await dispatchNext(f.ledger(), [f.backend()], dispatchOptions))?.state, "unknown");
    f.reopen(); f.setMode("running");
    assert.equal((await reconcileAction(f.ledger(), f.backend(), f.action.actionId)).state, "acknowledged");
    assert.equal(f.counts().starts, 1); assert.equal(f.counts().prepares, 1);
  } finally { await f.close(); }
});

test("missing journal after an interrupted resolver remains unknown instead of authorizing a new launch", async () => {
  const f = await fixture();
  try {
    assert.equal((await dispatchNext(f.ledger(), [f.backend(async () => { throw new Error("preparation interrupted"); })], dispatchOptions))?.state, "unknown");
    f.reopen();
    assert.equal((await reconcileAction(f.ledger(), f.backend(), f.action.actionId)).state, "unknown");
    assert.deepEqual(f.counts(), { starts: 0, stops: 0, prepares: 1 });
  } finally { await f.close(); }
});

test("a resolver that ignores cancellation cannot block reconciliation or launch from a late result", async () => {
  const f = await fixture();
  try {
    let late!: (value: PreparedLocalLaunch) => void;
    let supplied!: DispatchClaim;
    const backend = f.backend(async claim => { supplied = claim; return new Promise(resolve => { late = resolve; }); });
    assert.equal((await dispatchNext(f.ledger(), [backend], { ...dispatchOptions, timeoutMs: 10 }))?.state, "unknown");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal((await reconcileAction(f.ledger(), backend, f.action.actionId, { timeoutMs: 1_000 })).state, "confirmed_not_accepted");
    late(f.prepared(supplied)); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.counts().starts, 0); assert.equal(f.journal().readByAction(f.action.actionId), null);
  } finally { await f.close(); }
});

test("stop during preparation and deployment revocation before manager dispatch prevent any start", async () => {
  for (const cause of ["ledger_stop", "deployment_revoked"] as const) {
    const f = await fixture();
    try {
      const backend = f.backend(async claim => {
        if (cause === "ledger_stop") f.ledger().stopScope({ scopeId: "global", expectedEpoch: f.ledger().getScope("global").epoch, reason: "fixture stop" });
        else f.setDeployment(false);
        return f.prepared(claim);
      });
      assert.equal((await dispatchNext(f.ledger(), [backend], dispatchOptions))?.state, "confirmed_not_accepted");
      assert.equal(f.counts().starts, 0); assert.equal(f.journal().readByAction(f.action.actionId), null);
    } finally { await f.close(); }
  }
});

test("a prepared declaration cannot borrow a different plan or deadline", async () => {
  for (const field of ["planDigest", "deadlineAt"] as const) {
    const f = await fixture();
    try {
      const backend = f.backend(async claim => {
        const p = f.prepared(claim), d = p.declaration;
        p.declaration = createJobDeclaration({ actionId: d.actionId, backendKey: d.backendKey, manifestDigest: d.manifestDigest,
          planDigest: field === "planDigest" ? "f".repeat(64) : d.planDigest, workerId: d.workerId, command: d.request.command,
          limits: d.request.limits, host: d.request.expectedHost,
          deadlineAt: field === "deadlineAt" ? "2026-11-02T12:04:00.000Z" : d.request.deadlineAt });
        return p;
      });
      assert.equal((await dispatchNext(f.ledger(), [backend], dispatchOptions))?.state, "unknown");
      assert.equal(f.counts().starts, 0); assert.equal(f.journal().readByAction(f.action.actionId), null);
    } finally { await f.close(); }
  }
});

test("targeted cancellation remains available after global stop and uses its own stop receipt", async () => {
  const f = await fixture();
  try {
    const backend = f.backend(); await dispatchNext(f.ledger(), [backend], dispatchOptions);
    f.ledger().stopScope({ scopeId: "global", expectedEpoch: f.ledger().getScope("global").epoch, reason: "stop research" });
    const cleanup = f.cancel();
    const cancelled = await dispatchNext(f.ledger(), [backend], dispatchOptions);
    assert.equal(cancelled?.actionId, cleanup.actionId); assert.equal(cancelled?.state, "acknowledged");
    assert.equal(f.counts().stops, 1);
    const receipt = f.ledger().listObservations("coworker").find(o => o.actionId === cleanup.actionId && o.payload.kind === "receipt")!;
    const reply = receipt.payload.reply as any;
    assert.equal(reply.evidence.stopCommand, "sent");
    assert.ok(f.journal().observations(cancelled!.jobId!).some(o => o.observationId === reply.evidence.stopObservationId && o.observation.operation === "stop"));
    assert.equal((await backend.observe(f.action.actionId, signal())).result.execution, "failed");
    assert.equal(f.ledger().getRun(f.action.runId).execution, "failed");
    assert.equal(f.ledger().getAction(f.action.actionId).reservation.finalized, false);
  } finally { await f.close(); }
});

test("lost cancel response recovers its receipt without sending a second stop", async () => {
  const f = await fixture();
  try {
    const backend = f.backend(); await dispatchNext(f.ledger(), [backend], dispatchOptions); const cleanup = f.cancel();
    const losing: ExperimentBackend = { name: backend.name, async submit(claim, child) { await backend.submit(claim, child); throw new Error("cancel reply lost"); }, reconcile: backend.reconcile };
    assert.equal((await dispatchNext(f.ledger(), [losing], dispatchOptions))?.state, "unknown");
    f.reopen();
    assert.equal((await reconcileAction(f.ledger(), f.backend(), cleanup.actionId)).state, "acknowledged");
    assert.equal(f.counts().stops, 1);
  } finally { await f.close(); }
});

test("uncertain cancel is never inferred from original launch acceptance or replayed on reconciliation", async () => {
  const f = await fixture();
  try {
    const backend = f.backend(); await dispatchNext(f.ledger(), [backend], dispatchOptions); const cleanup = f.cancel();
    f.transport.stop = async () => ({ command: "unknown", observation: { kind: "unknown", reason: "stop reply missing" } });
    assert.equal((await dispatchNext(f.ledger(), [backend], dispatchOptions))?.state, "unknown");
    f.reopen(); f.setMode("failed");
    assert.equal((await reconcileAction(f.ledger(), f.backend(), cleanup.actionId)).state, "unknown");
    assert.equal(f.counts().stops, 0); assert.equal(f.counts().starts, 1);
  } finally { await f.close(); }
});

test("resource release is rejected before effects and cannot settle the training allocation", async () => {
  const f = await fixture();
  try {
    const backend = f.backend(); await dispatchNext(f.ledger(), [backend], dispatchOptions); f.cancel("release");
    assert.equal((await dispatchNext(f.ledger(), [backend], dispatchOptions))?.state, "confirmed_not_accepted");
    assert.equal(f.counts().stops, 0); assert.equal(f.ledger().getAction(f.action.actionId).allocation, "unknown");
  } finally { await f.close(); }
});

test("another confirmed execution source remains authoritative while contradictory status is retained", async () => {
  const f = await fixture();
  try {
    const backend = f.backend(); await dispatchNext(f.ledger(), [backend], dispatchOptions);
    f.ledger().recordExecution({ eventId: "external-fact", runId: f.action.runId, source: "external-worker", sequence: 1, state: "failed", evidence: { fixture: true } });
    const observed = await backend.observe(f.action.actionId, signal());
    assert.equal(observed.result.execution, "running"); assert.equal(observed.executionProjected, false);
    assert.equal(f.ledger().getRun(f.action.runId).execution, "failed"); assert.ok(f.ledger().getObservation(observed.observation.eventId));
  } finally { await f.close(); }
});
