import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { investigationArchiveFixture, syntheticInvestigationExecution, SYNTHETIC_WORKER, INVESTIGATION_TIME } from "../integrations/coworker-investigation-fixtures.ts";
import { createResearchTaskHandlers } from "../../src/scheduler/handlers.ts";
import { createInvestigationTaskHandlers } from "../../src/scheduler/investigation-handlers.ts";
import { openTaskQueue } from "../../src/scheduler/index.ts";
import { ledgerAuthority } from "../../src/scheduler/runner.ts";
import { prepareAssessmentWorkflow, runAssessmentWorkflow, loadAssessmentFollowups } from "../../src/scheduler/assessment-workflow.ts";
import { advanceInvestigationWorkflow, loadInvestigationWorkflow, prepareInvestigationWorkflow, runInvestigationWorkflow } from "../../src/scheduler/investigation-workflow.ts";
import type { InvestigationWorkflowRequest } from "../../src/scheduler/investigation-workflow.ts";
import type { CoworkerInvestigationWorker } from "../../src/integrations/coworker/investigation-worker.ts";

const deadlineAt = "2026-11-02T12:05:00.000Z";
async function fixture(t: TestContext, complete = true) {
  const archive = await investigationArchiveFixture(t), directory = await mkdtemp(join(tmpdir(), "investigation-queue-"));
  const path = join(directory, "queue.sqlite"); let calls = 0;
  const worker: CoworkerInvestigationWorker = { descriptor: structuredClone(SYNTHETIC_WORKER), async run(request) {
    calls++; return syntheticInvestigationExecution(request, SYNTHETIC_WORKER, complete);
  } };
  let queue = openTaskQueue({ path, now: archive.now, authority: projectId => ledgerAuthority(archive.ledger(), projectId) });
  for (const scopeId of ["global", "project:study"]) queue.configureBudget({ scopeId, expectedVersion: 0, maxCalls: 0, maxParallel: 2 });
  t.after(async () => { queue.close(); await rm(directory, { recursive: true, force: true }); });
  const ordinary = () => createResearchTaskHandlers({ ledger: archive.ledger(), projects: { study: { root: archive.root, summaryDirectory: join(directory, "summaries") } },
    now: archive.now, review: async () => { throw new Error("No model calls in this fixture"); } });
  const handlers = () => createInvestigationTaskHandlers({ ledger: archive.ledger(), projects: { study: { root: archive.root } }, worker, now: archive.now });
  const assessment = prepareAssessmentWorkflow(archive.ledger(), queue, ordinary(), { projectId: "study", workflowId: "assessment", captureId: archive.capture.eventId,
    captureDigest: archive.capture.digest, notBefore: INVESTIGATION_TIME, deadlineAt }, archive.now);
  assert.equal((await runAssessmentWorkflow(archive.ledger(), queue, ordinary(), assessment.observationId,
    { workerId: "fixture", now: archive.now, maxExecutionMs: 1000 })).status, "evidence_required");
  const request = (): InvestigationWorkflowRequest => ({ workflowId: "investigate", assessmentWorkflowObservationId: assessment.observationId,
    investigationId: archive.request.investigationId, localArtifacts: archive.request.localArtifacts, notBefore: INVESTIGATION_TIME, deadlineAt });
  return { ...archive, request, worker, ordinary, handlers, calls: () => calls, queue: () => queue, assessment,
    prepare: () => prepareInvestigationWorkflow(archive.ledger(), queue, handlers(), request(), archive.now),
    run: (observationId: string) => runInvestigationWorkflow(archive.ledger(), queue, handlers(), observationId, { workerId: "fixture", now: archive.now, maxExecutionMs: 1000 }),
    reopen() { queue.close(); archive.reopen(); queue = openTaskQueue({ path, now: archive.now, authority: projectId => ledgerAuthority(archive.ledger(), projectId) }); },
  };
}

test("queued investigation archives exact evidence without closing scientific requests or consuming calls", async t => {
  const f = await fixture(t), followups = loadAssessmentFollowups(f.ledger(), f.assessment.observationId), plan = f.prepare();
  const unrelated = f.ordinary().find(item => item.policy.kind === "project_summary")!;
  f.queue().registerHandler(unrelated.policy);
  f.queue().enqueue({ taskId: "unrelated", projectId: "study", kind: unrelated.policy.kind, handlerVersion: unrelated.policy.version,
    input: {}, dependencies: [], maxAttempts: 1, notBefore: INVESTIGATION_TIME, deadlineAt });
  assert.equal(advanceInvestigationWorkflow(f.ledger(), f.queue(), plan.observationId).status, "pending");
  const progress = await f.run(plan.observationId); assert.equal(progress.status, "evidence_required");
  if (progress.status !== "evidence_required") return;
  assert.equal(progress.inspectionStatus, "completed"); assert.equal(progress.interventionAuthorized, false);
  assert.equal(progress.scientificEvaluation, "unassessed");
  assert.deepEqual(progress.unresolvedWorkItems, followups.workItems.map(item => item.workItemId));
  assert.deepEqual(loadAssessmentFollowups(f.ledger(), f.assessment.observationId), followups);
  assert.equal(f.queue().getTask("unrelated").state, "queued"); assert.equal(f.queue().getBudget("global").consumedCalls, 0);
  assert.equal(f.ledger().listRuns().length, 0); assert.equal(f.calls(), 1);
});

test("reopening completed investigation uses only archived receipts even after source deletion", async t => {
  const f = await fixture(t), plan = f.prepare(), first = await f.run(plan.observationId), count = f.ledger().listObservations("study").length;
  await rm(f.root, { recursive: true }); f.reopen();
  assert.deepEqual(await f.run(plan.observationId), first);
  assert.deepEqual(loadInvestigationWorkflow(f.ledger(), plan.observationId), plan);
  assert.equal(f.ledger().listObservations("study").length, count); assert.equal(f.calls(), 1);
  assert.equal(f.queue().getTask(plan.task.taskId).attempts, 1);
});

test("workflow intent survives enqueue failure and repairs the same task after restart", async t => {
  const f = await fixture(t), enqueue = f.queue().enqueue;
  f.queue().enqueue = () => { throw new Error("queue write interrupted"); };
  assert.throws(() => f.prepare(), /write interrupted/u); f.queue().enqueue = enqueue;
  const record = f.ledger().listObservations("study").find(item => item.source === "coworker-investigation-workflow.v1")!;
  const before = advanceInvestigationWorkflow(f.ledger(), f.queue(), record.eventId);
  assert.equal(before.status, "pending"); if (before.status === "pending") assert.equal(before.taskState, "missing");
  f.reopen(); const restored = f.prepare(); assert.equal(restored.observationId, record.eventId);
  assert.equal((await f.run(restored.observationId)).status, "evidence_required"); assert.equal(f.calls(), 1);
});

test("partial inspection is durable evidence without becoming scientific completion", async t => {
  const f = await fixture(t, false), plan = f.prepare(), progress = await f.run(plan.observationId);
  assert.equal(progress.status, "evidence_required");
  if (progress.status === "evidence_required") { assert.equal(progress.inspectionStatus, "incomplete"); assert.ok(progress.unresolvedWorkItems.length > 0); }
  f.reopen(); assert.deepEqual(await f.run(plan.observationId), progress); assert.equal(f.calls(), 1);
});

test("worker upgrades and investigation identity changes cannot silently alter queued work", async t => {
  const f = await fixture(t), plan = f.prepare();
  f.worker.descriptor = { ...SYNTHETIC_WORKER, sourceSha256: "e".repeat(64) };
  await assert.rejects(f.run(plan.observationId), /worker changed/u); assert.equal(f.calls(), 0);
  f.worker.descriptor = structuredClone(SYNTHETIC_WORKER);
  assert.throws(() => prepareInvestigationWorkflow(f.ledger(), f.queue(), f.handlers(), { ...f.request(), investigationId: "other" }, f.now), /another request/u);
  const handler = f.handlers()[0]!, input = structuredClone(plan.task.input);
  (input.request as Record<string, unknown>).projectId = "other";
  assert.throws(() => handler.validate(input, "study"), /project/u);
});

test("crash after archival requires explicit reconciliation and reuses the durable result", async t => {
  const f = await fixture(t), plan = f.prepare(), claim = f.queue().claim({ workerId: "crashing-worker", taskIds: [plan.task.taskId] })!;
  assert.equal((await f.handlers()[0]!.execute(claim, new AbortController().signal)).status, "completed");
  f.reopen(); assert.equal((await f.run(plan.observationId)).status, "blocked"); assert.equal(f.calls(), 1);
  f.queue().requeueUncertain({ commandId: "explicit-fixture-reconciliation", taskId: plan.task.taskId, attemptId: claim.attemptId,
    notBefore: INVESTIGATION_TIME, evidence: { reason: "Exact archived result exists; no further project read is required" } });
  assert.equal((await f.run(plan.observationId)).status, "evidence_required"); assert.equal(f.calls(), 1);
  assert.equal(f.queue().getTask(plan.task.taskId).attempts, 2);
});

test("invented completed queue text cannot stand in for the exact archived receipt", async t => {
  const f = await fixture(t), plan = f.prepare(), claim = f.queue().claim({ workerId: "fixture", taskIds: [plan.task.taskId] })!;
  const outcome = await f.handlers()[0]!.execute(claim, new AbortController().signal);
  f.queue().recordOutcome({ resultId: "forged-output", taskId: plan.task.taskId, attemptId: claim.attemptId,
    status: "completed", result: { ...outcome.result, meaning: "Scientific requirements satisfied" } });
  assert.throws(() => advanceInvestigationWorkflow(f.ledger(), f.queue(), plan.observationId), /exact investigation receipt/u);
});

test("persisted stop prevents inspection across reopening", async t => {
  const f = await fixture(t), plan = f.prepare();
  f.ledger().stopScope({ scopeId: "global", expectedEpoch: f.ledger().getScope("global").epoch, reason: "fixture stop" });
  assert.equal((await f.run(plan.observationId)).status, "pending");
  assert.equal(f.queue().getTask(plan.task.taskId).attempts, 0); assert.equal(f.calls(), 0);
  f.reopen(); assert.equal(f.ledger().getScope("global").stopped, true);
  assert.equal((await f.run(plan.observationId)).status, "pending"); assert.equal(f.calls(), 0);
});

test("untrusted workflow and task getters are rejected without invocation", async t => {
  const f = await fixture(t); let getterCalls = 0;
  const input = f.request();
  Object.defineProperty(input, "investigationId", { enumerable: true, get() { getterCalls++; return "getter"; } });
  assert.throws(() => prepareInvestigationWorkflow(f.ledger(), f.queue(), f.handlers(), input, f.now), /accessors/u);
  const plan = f.prepare(), task = structuredClone(plan.task.input);
  Object.defineProperty(task, "worker", { enumerable: true, get() { getterCalls++; return SYNTHETIC_WORKER; } });
  assert.throws(() => f.handlers()[0]!.validate(task, "study"), /accessors/u);
  assert.equal(getterCalls, 0); assert.equal(f.calls(), 0);
});

test("wrong configured root fails before investigation intent or queue admission", async t => {
  const f = await fixture(t), count = f.queue().listTasks().length;
  const handlers = createInvestigationTaskHandlers({ ledger: f.ledger(), projects: { study: { root: "/other" } }, worker: f.worker });
  assert.throws(() => prepareInvestigationWorkflow(f.ledger(), f.queue(), handlers, f.request(), f.now), /root\/report binding/u);
  assert.equal(f.queue().listTasks().length, count);
  assert.equal(f.ledger().listObservations("study").filter(item => item.source.startsWith("coworker-investigation")).length, 0);
  assert.equal(f.calls(), 0);
});

test("handler cancellation before execution leaves no investigation attempt", async t => {
  const f = await fixture(t), plan = f.prepare(), claim = f.queue().claim({ workerId: "fixture", taskIds: [plan.task.taskId] })!;
  const control = new AbortController(); control.abort();
  assert.equal((await f.handlers()[0]!.execute(claim, control.signal)).status, "cancelled");
  assert.equal(f.ledger().getObservation(plan.investigationObservationId), null); assert.equal(f.calls(), 0);
});
