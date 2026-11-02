import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { hash } from "../../src/ledger/validation.ts";
import type { ObservationRecord } from "../../src/ledger/types.ts";
import { openJobJournal } from "../../src/execution/journal.ts";
import { createJobDeclaration } from "../../src/execution/worker.ts";
import type { ServiceSnapshot } from "../../src/execution/types.ts";
import { collectConventionalSupervised } from "../../src/integrations/conventional/supervised-collection.ts";
import { supervisedFixture } from "./supervised-fixtures.ts";

const now = () => new Date("2026-11-02T12:00:00.000Z");

/** Durable synthetic observations only: no supervisor, Python reader, trainer or provider runs. */
async function fixture(t: TestContext) {
  const f = await supervisedFixture();
  const ledger = openExperimentLedger({ path: join(f.directory, "collection-ledger.sqlite"), now });
  const journal = openJobJournal({ path: join(f.directory, "collection-jobs.sqlite"), now });
  t.after(async () => { ledger.close(); journal.close(); await f.close(); });
  const { plan } = f, workerId = plan.declarations.deployment.workerId;
  for (const scopeId of ["global", "project:frozenlake"]) {
    ledger.configureBudget({ scopeId, parentScopeId: scopeId === "global" ? null : "global", expectedRevision: 0, limitMicrodollars: 1000n });
    ledger.configurePolicy({ scopeId, expectedVersion: 0, allowedBackends: [plan.binding.backend], allowedOperations: ["launch"], requiredChecks: [] });
  }
  ledger.registerManifest(f.input.manifest.manifest); ledger.createRun(f.input.run);
  const admitted = ledger.admitAction({ runId: plan.binding.runId, operation: "launch", operationRevision: 1,
    backend: plan.binding.backend, payload: { attemptPlanDigest: plan.digest },
    reservation: { amountMicrodollars: 1n, category: "compute", basis: "Synthetic collection evidence fixture" } });
  const claim = ledger.claimDispatch({ workerId, deadlineAt: "2026-11-02T12:00:30.000Z" })!;
  const declaration = createJobDeclaration({ actionId: admitted.actionId, backendKey: admitted.backendKey,
    manifestDigest: admitted.manifestDigest, planDigest: plan.digest, workerId, command: plan.command,
    limits: plan.limits, deadlineAt: claim.deadlineAt, host: f.input.deployment.host });
  const job = journal.prepareIntent(declaration).record;
  const backendRequest = { actionId: admitted.actionId, attemptId: claim.attemptId, manifestDigest: admitted.manifestDigest,
    backend: admitted.backend, backendKey: admitted.backendKey };
  const intent = ledger.appendObservation({ eventId: `supervised-intent:${hash([admitted.backend, workerId, backendRequest])}`,
    projectId: plan.binding.projectId, runId: admitted.runId, actionId: admitted.actionId, jobId: null,
    source: `supervised-backend:${hash([admitted.backend, workerId]).slice(0, 32)}`, sequence: 0, observedAt: now().toISOString(),
    payload: { kind: "intent", workerId, payloadDigest: admitted.payloadDigest, request: backendRequest,
      targetActionId: admitted.actionId, jobId: declaration.jobId, declarationDigest: job.digest, deploymentEvidence: null } });
  const action = ledger.recordDispatchOutcome({ receiptId: "synthetic-dispatch", actionId: admitted.actionId,
    attemptId: claim.attemptId, manifestDigest: admitted.manifestDigest, backend: admitted.backend,
    outcome: "accepted", jobId: declaration.jobId, evidence: { fixture: true } });
  function observe(observationId: string, changes: Partial<ServiceSnapshot> = {}, cleanup = false) {
    const snapshot: ServiceSnapshot = { identity: declaration.request.identity, host: declaration.request.expectedHost,
      observedAt: now().toISOString(), invocationId: "d".repeat(32), loadState: "loaded", activeState: "active",
      subState: "exited", result: "success", mainPid: 0, execMainCode: 1, execMainStatus: 0,
      controlGroup: `/system.slice/${declaration.request.identity.unitName}`, cgroupPopulated: false, ...changes };
    if (cleanup) snapshot.cleanupEvidence = { kind: "cgroup_v2_absent", controlGroup: snapshot.controlGroup,
      invocationId: snapshot.invocationId, observedAt: snapshot.observedAt, confirmedAt: snapshot.observedAt };
    return journal.recordObservation({ observationId, jobId: declaration.jobId, actionId: action.actionId,
      declarationDigest: job.digest, observedAt: now().toISOString(), observation: { operation: "query", result: { kind: "present", snapshot } } });
  }
  const observation = observe("synthetic-terminal-without-new-cleanup-proof");
  const request = { collectionId: "independent-collection", actionId: action.actionId, plan,
    observationId: observation.observationId, observationDigest: observation.digest };
  return { ledger, journal, plan, action, job, intent, request, observation, observe };
}

test("collection rejects changed or rehashed bridge envelopes before retaining their claimed provenance", async t => {
  const f = await fixture(t), original = f.ledger.getObservation.bind(f.ledger);
  const mutations: ((record: ObservationRecord) => void)[] = [
    value => { value.digest = "0".repeat(64); },
    value => { value.eventId = "unrelated-intent"; },
    value => { value.sequence = 1; },
    value => { value.jobId = f.job.declaration.jobId; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const altered = structuredClone(f.intent); mutate(altered);
    if (index !== 0) { const { digest: _digest, ...body } = altered; altered.digest = hash(body); }
    f.ledger.getObservation = eventId => eventId === f.intent.eventId ? altered : original(eventId);
    await assert.rejects(collectConventionalSupervised(f, f.request, { now }), /intent are not joined/u);
    assert.equal(original(f.request.collectionId), null);
  }
  f.ledger.getObservation = original;
});

test("collection requires the requested journal digest and cannot substitute an unrelated action observation", async t => {
  const f = await fixture(t);
  await assert.rejects(collectConventionalSupervised(f, { ...f.request, observationDigest: "a".repeat(64) }, { now }), /exact worker observation/u);
  const altered = structuredClone(f.observation); altered.actionId = "another-action";
  const { digest: _digest, ...body } = altered; altered.digest = hash(body);
  const journal = { readByAction: f.journal.readByAction, observations: () => [altered] };
  await assert.rejects(collectConventionalSupervised({ ledger: f.ledger, journal }, { ...f.request, observationDigest: altered.digest }, { now }), /exact worker observation/u);
  assert.equal(f.ledger.getObservation(f.request.collectionId), null);
});

test("success-shaped process metadata without explicit cleanup remains incomplete and cannot settle science or exposure", async t => {
  const f = await fixture(t), beforeAction = f.ledger.getAction(f.action.actionId), beforeRun = f.ledger.getRun(f.action.runId);
  const result = await collectConventionalSupervised(f, f.request, { now });
  assert.equal(result.payload.status, "incomplete");
  assert.equal(result.payload.reason, "successful_terminal_cleanup_not_established");
  assert.equal(result.payload.summary, null);
  assert.equal(result.payload.scientificEvaluation, "unassessed");
  assert.equal(result.payload.scientificReplicationCount, 1);
  assert.deepEqual(result.payload.artifacts, {});
  assert.deepEqual(f.ledger.getAction(f.action.actionId), beforeAction);
  assert.deepEqual(f.ledger.getRun(f.action.runId), beforeRun);
  assert.equal(beforeAction.reservation.outstandingMicrodollars, 1n);
  assert.deepEqual(await collectConventionalSupervised(f, f.request, { now: () => new Date("2026-11-03T00:00:00.000Z") }), result);
  assert.ok(Object.isFrozen(result.payload));
});

test("cached collection cannot change scientific scope or admitted identity through a self-consistent wrong projection", async t => {
  const f = await fixture(t), receipt = await collectConventionalSupervised(f, f.request, { now });
  const original = f.ledger.getObservation.bind(f.ledger);
  for (const change of [
    (value: ObservationRecord) => { value.payload.scientificEvaluation = "valid"; },
    (value: ObservationRecord) => { value.payload.scientificReplicationCount = 99; },
    (value: ObservationRecord) => { value.payload.manifestDigest = "a".repeat(64); },
    (value: ObservationRecord) => { value.payload.status = "completed"; },
  ]) {
    const altered = structuredClone(receipt); change(altered);
    const { digest: _digest, ...body } = altered; altered.digest = hash(body);
    f.ledger.getObservation = eventId => eventId === receipt.eventId ? altered : original(eventId);
    await assert.rejects(collectConventionalSupervised(f, f.request, { now }), /Invalid conventional collection: cached /u);
  }
  f.ledger.getObservation = original;
});
