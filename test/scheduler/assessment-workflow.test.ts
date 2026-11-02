import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { hash } from "../../src/ledger/validation.ts";
import type { ExperimentLedger, JsonObject, ObservationRecord } from "../../src/ledger/types.ts";
import { captureCoworkerReport } from "../../src/integrations/coworker/capture.ts";
import { archiveCoworkerAssessment, COWORKER_ASSESSMENT_RULES } from "../../src/integrations/coworker/assessment.ts";
import { createResearchTaskHandlers } from "../../src/scheduler/handlers.ts";
import { openTaskQueue } from "../../src/scheduler/index.ts";
import { ledgerAuthority } from "../../src/scheduler/runner.ts";
import { advanceAssessmentWorkflow, loadAssessmentWorkflow, prepareAssessmentWorkflow, runAssessmentWorkflow } from "../../src/scheduler/assessment-workflow.ts";
import type { AssessmentWorkflowRequest } from "../../src/scheduler/assessment-workflow.ts";

const time = "2026-11-02T12:00:00.000Z", deadlineAt = "2026-11-02T12:01:00.000Z";
const clock = () => new Date(time);
const signal = () => new AbortController().signal;
async function fixture(t: TestContext, report: unknown = { config: { steps: 2, training_seed: 7 }, steps: [
  { step_index: 0, loss: 0.5, grad_norm: 1, optimizer_step_applied: false, post_update_serve_ok: false,
    checkpoint: { full_training_state: false, round_trip_verified: false } },
] }) {
  const directory = await mkdtemp(join(tmpdir(), "assessment-workflow-")), root = join(directory, "project");
  await mkdir(root); await writeFile(join(root, "report.json"), JSON.stringify(report));
  const ledgerPath = join(directory, "ledger.sqlite"), queuePath = join(directory, "queue.sqlite");
  let current = new Date(time), calls = 0;
  const now = () => new Date(current);
  let ledger = openExperimentLedger({ path: ledgerPath, now });
  let queue = openTaskQueue({ path: queuePath, now, authority: project => ledgerAuthority(ledger, project) });
  for (const scopeId of ["global", "project:study"]) queue.configureBudget({ scopeId, expectedVersion: 0, maxCalls: 0, maxParallel: 2 });
  const capture = await captureCoworkerReport(ledger, { captureId: "historical", projectId: "study", root, reportPath: "report.json", observedAt: time });
  const handlers = () => createResearchTaskHandlers({ ledger, projects: { study: { root, summaryDirectory: join(directory, "summaries") } },
    review: async () => { calls++; throw new Error("No client invocation is allowed"); },
    capture: async () => { throw new Error("Assessment must not reread project files"); }, now });
  const request = (): AssessmentWorkflowRequest => ({ projectId: "study", workflowId: "followup-one", captureId: capture.eventId,
    captureDigest: capture.digest, notBefore: time, deadlineAt });
  t.after(async () => { queue.close(); ledger.close(); await rm(directory, { recursive: true, force: true }); });
  return { root, capture, request, now, handlers, calls: () => calls, ledger: () => ledger, queue: () => queue,
    setTime(value: string) { current = new Date(value); },
    reopen() { queue.close(); ledger.close(); ledger = openExperimentLedger({ path: ledgerPath, now });
      queue = openTaskQueue({ path: queuePath, now, authority: project => ledgerAuthority(ledger, project) }); },
    prepare() { return prepareAssessmentWorkflow(ledger, queue, handlers(), request(), now); },
    run(observationId: string) { return runAssessmentWorkflow(ledger, queue, handlers(), observationId, { workerId: "assessment-fixture", now, maxExecutionMs: 1000 }); },
  };
}

test("one zero-call task archives assessment then publishes unresolved ranked evidence requests", async t => {
  const f = await fixture(t), plan = f.prepare();
  assert.equal(f.ledger().getObservation(plan.assessmentId), null);
  assert.equal(plan.handler.callUnits, 0); assert.equal(plan.handler.resourceKey, null);
  assert.equal(advanceAssessmentWorkflow(f.ledger(), f.queue(), plan.observationId).status, "pending");
  await rm(f.root, { recursive: true });
  const result = await f.run(plan.observationId);
  assert.equal(result.status, "evidence_required");
  if (result.status !== "evidence_required") return;
  const items = result.followups.workItems;
  assert.deepEqual(items.map(item => item.rank), items.map((_, index) => index + 1));
  assert.equal(items[0]!.kind, "inspect_serving");
  assert.ok(items.every(item => item.state === "unresolved" && item.mode === "evidence_request" && !item.executionAuthorized));
  const manifest = items.find(item => item.kind === "recover_manifest")!;
  const evaluation = items.find(item => item.kind === "collect_independent_evaluation")!;
  assert.ok(evaluation.interpretationDependencies.some(dependency => dependency.workItemId === manifest.workItemId));
  assert.match(evaluation.interpretationDependencies[0]!.reason, /collection and prospective drafting may proceed/u);
  assert.equal(result.followups.interventionAuthorized, false);
  assert.equal(f.queue().listTasks().length, 1); assert.equal(f.ledger().listRuns().length, 0);
  assert.equal(f.queue().getBudget("global").consumedCalls, 0); assert.equal(f.calls(), 0);
  assert.ok(Object.isFrozen(result.followups.workItems));
});

test("intent survives failed enqueue, restart and deleted source without replacing task or assessment", async t => {
  const f = await fixture(t), original = f.queue().enqueue;
  f.queue().enqueue = () => { throw new Error("simulated queue write failure"); };
  assert.throws(() => f.prepare(), /queue write failure/u);
  f.queue().enqueue = original;
  const record = f.ledger().listObservations("study").find(item => item.source === "coworker-assessment-workflow.v1")!;
  assert.equal(advanceAssessmentWorkflow(f.ledger(), f.queue(), record.eventId).status, "pending");
  await rm(f.root, { recursive: true }); f.reopen();
  const restored = f.prepare(); assert.equal(restored.observationId, record.eventId);
  assert.equal(restored.createdAt, time); assert.deepEqual(loadAssessmentWorkflow(f.ledger(), record.eventId), restored);
  const first = await f.run(restored.observationId), count = f.ledger().listObservations("study").length;
  f.reopen(); const second = await f.run(f.prepare().observationId);
  assert.deepEqual(second, first); assert.equal(f.queue().getTask(restored.task.taskId).attempts, 1);
  assert.equal(f.ledger().listObservations("study").length, count); assert.equal(f.calls(), 0);
});

test("exact task selection leaves unrelated zero-call and client work queued", async t => {
  const f = await fixture(t), handlers = f.handlers(), summary = handlers.find(handler => handler.policy.kind === "project_summary")!;
  f.queue().registerHandler(summary.policy);
  f.queue().enqueue({ taskId: "unrelated-first", projectId: "study", kind: summary.policy.kind, handlerVersion: summary.policy.version,
    input: {}, dependencies: [], maxAttempts: 1, notBefore: time, deadlineAt });
  const plan = f.prepare(); await f.run(plan.observationId);
  assert.equal(f.queue().getTask("unrelated-first").state, "queued");
  assert.equal(f.queue().getTask(plan.task.taskId).state, "completed"); assert.equal(f.calls(), 0);
});

test("expired and stopped workflows do not masquerade as completed research", async t => {
  const f = await fixture(t), plan = f.prepare();
  f.ledger().stopScope({ scopeId: "global", expectedEpoch: f.ledger().getScope("global").epoch, reason: "fixture stop" });
  assert.equal((await f.run(plan.observationId)).status, "pending");
  assert.equal(f.queue().getTask(plan.task.taskId).attempts, 0);
  // Expiration is reconciled by claim even when no task can be run.
  f.setTime("2026-11-02T12:02:00.000Z");
  const result = await f.run(plan.observationId);
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") assert.equal(result.taskState, "expired");
  assert.equal(f.ledger().getObservation(plan.assessmentId), null);
});

test("a crash after archival leaves uncertainty until explicit safe reconciliation", async t => {
  const f = await fixture(t), plan = f.prepare(), claim = f.queue().claim({ workerId: "crashing-worker", taskIds: [plan.task.taskId] })!;
  const handler = f.handlers().find(item => item.policy.kind === "coworker_assessment")!;
  const output = await handler.execute(claim, signal()); assert.equal(output.status, "completed");
  const assessment = f.ledger().getObservation(plan.assessmentId)!;
  f.reopen();
  assert.equal((await f.run(plan.observationId)).status, "blocked");
  assert.equal(f.queue().getTask(plan.task.taskId).attempts, 1);
  f.queue().requeueUncertain({ commandId: "explicit-local-reconciliation", taskId: plan.task.taskId, attemptId: claim.attemptId,
    notBefore: time, evidence: { reason: "Deterministic archive repeats exact bound evidence without external effects" } });
  assert.equal((await f.run(plan.observationId)).status, "evidence_required");
  assert.deepEqual(f.ledger().getObservation(plan.assessmentId), assessment);
  assert.equal(f.queue().getTask(plan.task.taskId).attempts, 2); assert.equal(f.calls(), 0);
});

test("completed queue text cannot replace the exact assessment receipt", async t => {
  const f = await fixture(t), plan = f.prepare();
  archiveCoworkerAssessment(f.ledger(), { projectId: "study", captureId: f.capture.eventId, captureDigest: f.capture.digest });
  const claim = f.queue().claim({ workerId: "fixture", taskIds: [plan.task.taskId] })!;
  f.queue().recordOutcome({ resultId: "invented-completion", taskId: plan.task.taskId, attemptId: claim.attemptId,
    status: "completed", result: { assessmentObservationId: plan.assessmentId, assessmentDigest: plan.assessmentDigest } });
  assert.throws(() => advanceAssessmentWorkflow(f.ledger(), f.queue(), plan.observationId), /exact archived assessment/u);
  assert.equal(f.ledger().listObservations("study").filter(item => item.source === "coworker-assessment-followups.v1").length, 0);
});

test("capture changes, workflow identity reuse and unsupported rule digests fail closed", async t => {
  const f = await fixture(t), input = f.request();
  assert.throws(() => prepareAssessmentWorkflow(f.ledger(), f.queue(), f.handlers(), { ...input, captureDigest: "a".repeat(64) }, clock), /capture identity or digest/u);
  const plan = f.prepare();
  assert.throws(() => prepareAssessmentWorkflow(f.ledger(), f.queue(), f.handlers(), { ...input, deadlineAt: "2026-11-02T12:03:00.000Z" }, clock), /another request/u);
  const handler = f.handlers().find(item => item.policy.kind === "coworker_assessment")!;
  assert.throws(() => handler.validate({ captureId: input.captureId, captureDigest: input.captureDigest, rulesDigest: "b".repeat(64) }, "study"), /rule digest/u);
  assert.throws(() => handler.validate({ captureId: input.captureId, captureDigest: input.captureDigest, rulesDigest: COWORKER_ASSESSMENT_RULES.digest, root: "/outside" }, "study"), /Unexpected/u);
  assert.equal(f.queue().listTasks().length, 1); assert.equal(f.queue().getTask(plan.task.taskId).attempts, 0);
  let invoked = false; const accessor = { ...input };
  Object.defineProperty(accessor, "captureId", { enumerable: true, get() { invoked = true; return input.captureId; } });
  assert.throws(() => prepareAssessmentWorkflow(f.ledger(), f.queue(), f.handlers(), accessor, clock), /inert/u);
  assert.equal(invoked, false);
  const nested = { ...input, projectId: { get value() { invoked = true; return "study"; } } };
  assert.throws(() => prepareAssessmentWorkflow(f.ledger(), f.queue(), f.handlers(), nested as unknown as AssessmentWorkflowRequest, clock), /primitive strings/u);
  assert.equal(invoked, false);
});

test("assessment handler rechecks fixed metadata and cancellation before archival", async t => {
  const f = await fixture(t), plan = f.prepare(), claim = f.queue().claim({ workerId: "fixture", taskIds: [plan.task.taskId] })!;
  const handler = f.handlers().find(item => item.policy.kind === "coworker_assessment")!;
  const changed = structuredClone(claim); changed.task.handler.callUnits = 1;
  assert.equal((await handler.execute(changed, signal())).status, "rejected");
  const abort = new AbortController(); abort.abort();
  assert.equal((await handler.execute(claim, abort.signal)).status, "cancelled");
  assert.equal(f.ledger().getObservation(plan.assessmentId), null); assert.equal(f.calls(), 0);
});

test("self-hashed altered workflow records cannot change the derived plan", async t => {
  const f = await fixture(t), plan = f.prepare(), record = f.ledger().getObservation(plan.observationId)!;
  const modified = structuredClone(record);
  (modified.payload.task as JsonObject).input = { captureId: "other", captureDigest: f.capture.digest, rulesDigest: COWORKER_ASSESSMENT_RULES.digest };
  const { digest: _digest, ...body } = modified; modified.digest = hash(body);
  const archive = new Proxy(f.ledger(), { get(target, property) {
    if (property === "getObservation") return (eventId: string): ObservationRecord | null => eventId === plan.observationId ? modified : target.getObservation(eventId);
    const value: unknown = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } }) as ExperimentLedger;
  assert.throws(() => loadAssessmentWorkflow(archive, plan.observationId), /bound evidence/u);
});

test("exhausted invocation caps and account holds survive a successful zero-call workflow", async t => {
  const f = await fixture(t), queue = f.queue();
  for (const scopeId of ["global", "project:study"]) queue.configureBudget({ scopeId, expectedVersion: 1, maxCalls: 2, maxParallel: 2 });
  for (const backend of ["codex", "claude"]) {
    const kind = `fixture-${backend}`, resourceKey = `${backend}:default`;
    queue.registerHandler({ kind, version: "1", replay: "never", callUnits: 1, resourceKey });
    queue.enqueue({ taskId: kind, projectId: "study", kind, handlerVersion: "1", input: {}, dependencies: [], maxAttempts: 1, notBefore: time, deadlineAt });
    const claim = queue.claim({ workerId: "offline-fixture", taskIds: [kind] })!;
    queue.recordOutcome({ resultId: `quota:${backend}`, taskId: kind, attemptId: claim.attemptId, status: "waiting_quota", retryAt: null,
      result: { reason: "synthetic quota; no client called" } });
  }
  const holds = queue.listResourceHolds(), budget = queue.getBudget("global");
  assert.equal(budget.consumedCalls, 2);
  assert.equal((await f.run(f.prepare().observationId)).status, "evidence_required");
  assert.deepEqual(queue.listResourceHolds(), holds); assert.equal(queue.getBudget("global").consumedCalls, 2);
  assert.equal(queue.getBudget("global").maxCalls, budget.maxCalls); assert.equal(f.calls(), 0);
});
