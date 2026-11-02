import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import type { ExperimentLedger, ObservationRecord } from "../../src/ledger/types.ts";
import { hash } from "../../src/ledger/validation.ts";
import { investigationArchiveFixture, syntheticInvestigationExecution, SYNTHETIC_WORKER, INVESTIGATION_TIME } from "../integrations/coworker-investigation-fixtures.ts";
import { createResearchTaskHandlers } from "../../src/scheduler/handlers.ts";
import { createInvestigationTaskHandlers } from "../../src/scheduler/investigation-handlers.ts";
import { openTaskQueue } from "../../src/scheduler/index.ts";
import { ledgerAuthority } from "../../src/scheduler/runner.ts";
import { prepareAssessmentWorkflow, runAssessmentWorkflow, loadAssessmentFollowups } from "../../src/scheduler/assessment-workflow.ts";
import { prepareInvestigationWorkflow, runInvestigationWorkflow } from "../../src/scheduler/investigation-workflow.ts";
import { archiveCoworkerEvidenceUpdate, loadCoworkerEvidenceUpdate, normalizeCoworkerEvidenceUpdateRequest } from "../../src/scheduler/evidence-update.ts";
import type { CoworkerEvidenceUpdateRequest } from "../../src/scheduler/evidence-update.ts";
import type { TaskQueue } from "../../src/scheduler/types.ts";

const deadlineAt = "2026-11-02T12:05:00.000Z";
async function fixture(t: TestContext, complete = true, run = true) {
  const f = await investigationArchiveFixture(t), directory = await mkdtemp(join(tmpdir(), "evidence-update-queue-"));
  const queuePath = join(directory, "queue.sqlite"); let calls = 0;
  const queue = openTaskQueue({ path: queuePath, now: f.now, authority: projectId => ledgerAuthority(f.ledger(), projectId) });
  for (const scopeId of ["global", "project:study"]) queue.configureBudget({ scopeId, expectedVersion: 0, maxCalls: 0, maxParallel: 2 });
  t.after(async () => { queue.close(); await rm(directory, { recursive: true, force: true }); });
  const ordinary = createResearchTaskHandlers({ ledger: f.ledger(), projects: { study: { root: f.root, summaryDirectory: join(directory, "summaries") } }, now: f.now,
    review: async () => { throw new Error("No model call is authorized in this fixture"); } });
  const handlers = createInvestigationTaskHandlers({ ledger: f.ledger(), projects: { study: { root: f.root } }, now: f.now,
    worker: { descriptor: SYNTHETIC_WORKER, async run(request) { calls++; return syntheticInvestigationExecution(request, SYNTHETIC_WORKER, complete); } } });
  const assessment = prepareAssessmentWorkflow(f.ledger(), queue, ordinary, { projectId: "study", workflowId: "assessment", captureId: f.capture.eventId,
    captureDigest: f.capture.digest, notBefore: INVESTIGATION_TIME, deadlineAt }, f.now);
  await runAssessmentWorkflow(f.ledger(), queue, ordinary, assessment.observationId, { workerId: "fixture", now: f.now, maxExecutionMs: 1000 });
  const followups = loadAssessmentFollowups(f.ledger(), assessment.observationId);
  const workflow = prepareInvestigationWorkflow(f.ledger(), queue, handlers, { workflowId: "investigation", assessmentWorkflowObservationId: assessment.observationId,
    investigationId: f.request.investigationId, localArtifacts: f.request.localArtifacts, notBefore: INVESTIGATION_TIME, deadlineAt }, f.now);
  if (run) await runInvestigationWorkflow(f.ledger(), queue, handlers, workflow.observationId, { workerId: "fixture", now: f.now, maxExecutionMs: 1000 });
  const request = (): CoworkerEvidenceUpdateRequest => ({ projectId: "study", updateId: "update-one",
    investigationWorkflow: { observationId: workflow.observationId, observationDigest: f.ledger().getObservation(workflow.observationId)!.digest },
    investigation: { observationId: workflow.investigationObservationId, observationDigest: f.ledger().getObservation(workflow.investigationObservationId)!.digest },
    followups: { observationId: followups.observationId, observationDigest: f.ledger().getObservation(followups.observationId)!.digest } });
  return { ...f, queue, queuePath, directory, handlers, assessment, followups, workflow, request, calls: () => calls };
}

test("evidence update archives a completed exact task while preserving original requests and all runtime states", async t => {
  const f = await fixture(t), records = f.ledger().listObservations("study"), taskBefore = f.queue.getTask(f.workflow.task.taskId);
  const budgetBefore = f.queue.getBudget("global"), originalPacket = f.ledger().getObservation(f.followups.assessmentObservationId)!.payload.packet;
  const result = archiveCoworkerEvidenceUpdate(f.ledger(), f.queue, f.request(), f.now);
  assert.equal(result.observationDigest, f.ledger().getObservation(result.observationId)!.digest);
  assert.deepEqual(result.request, f.request()); assert.equal(result.completionWitness.attemptId, taskBefore.currentAttemptId);
  assert.deepEqual(result.followupProgress.workItems, f.followups.workItems);
  assert.ok(result.followupProgress.workItems.every(item => item.state === "unresolved" && !item.executionAuthorized));
  assert.equal(result.scientificEvaluation, "unassessed"); assert.equal(result.interventionAuthorized, false);
  assert.equal(result.packet.revision, 1); assert.notEqual(result.packet.packetId, (originalPacket as any).packetId);
  for (const record of records) assert.deepEqual(f.ledger().getObservation(record.eventId), record);
  assert.equal(f.ledger().listObservations("study").length, records.length + 1);
  assert.deepEqual(f.queue.getTask(taskBefore.taskId), taskBefore); assert.deepEqual(f.queue.getBudget("global"), budgetBefore);
  assert.equal(f.ledger().listRuns().length, 0); assert.equal(f.ledger().listActions().length, 0); assert.equal(f.calls(), 1);
});

test("saved updates recompute offline after source deletion and without any queue access", async t => {
  const f = await fixture(t), input = f.request(), result = archiveCoworkerEvidenceUpdate(f.ledger(), f.queue, input, f.now);
  await rm(f.root, { recursive: true }); f.queue.close(); await rm(f.queuePath, { force: true }); f.reopen();
  assert.deepEqual(loadCoworkerEvidenceUpdate(f.ledger(), result.observationId), result);
  const unavailable = new Proxy({}, { get() { throw new Error("Offline replay must not query the queue"); } }) as TaskQueue;
  assert.deepEqual(archiveCoworkerEvidenceUpdate(f.ledger(), unavailable, input, () => new Date("2027-01-01")), result);
  assert.equal(f.calls(), 1);
});

test("lost acknowledgement after the sole archival append recovers the same update without another queue witness", async t => {
  const f = await fixture(t), input = f.request(), append = f.ledger().appendObservation.bind(f.ledger());
  let stored: ObservationRecord | undefined;
  f.ledger().appendObservation = event => {
    stored = append(event); throw new Error("lost append acknowledgement");
  };
  assert.throws(() => archiveCoworkerEvidenceUpdate(f.ledger(), f.queue, input, f.now), /lost append acknowledgement/u);
  assert.ok(stored); f.reopen();
  const unavailable = new Proxy({}, { get() { throw new Error("Committed replay must not revisit the queue"); } }) as TaskQueue;
  const recovered = archiveCoworkerEvidenceUpdate(f.ledger(), unavailable, input, () => new Date("2027-01-01"));
  assert.equal(recovered.observationId, stored.eventId); assert.equal(recovered.observationDigest, stored.digest);
  assert.equal(f.ledger().listObservations("study").filter(item => item.source === "coworker-evidence-update.v1").length, 1);
  assert.equal(f.calls(), 1);
});

test("a valid reader receipt cannot replace missing queue completion or a different completed attempt", async t => {
  const f = await fixture(t, true, false), claim = f.queue.claim({ workerId: "fixture", taskIds: [f.workflow.task.taskId] })!;
  const outcome = await f.handlers[0]!.execute(claim, new AbortController().signal), input = f.request();
  const before = f.ledger().listObservations("study").length;
  assert.throws(() => archiveCoworkerEvidenceUpdate(f.ledger(), f.queue, input, f.now), /workflow is not completed/u);
  f.queue.recordOutcome({ resultId: "read-completed", taskId: claim.task.taskId, attemptId: claim.attemptId, status: "completed", result: outcome.result });
  const attempts = f.queue.attempts.bind(f.queue);
  f.queue.attempts = taskId => attempts(taskId).map(attempt => ({ ...attempt, attemptId: "task-attempt:00000000-0000-0000-0000-000000000000" }));
  assert.throws(() => archiveCoworkerEvidenceUpdate(f.ledger(), f.queue, input, f.now), /completed queue attempt/u);
  assert.equal(f.ledger().listObservations("study").length, before);
});

test("envelope digests and project/workflow/followup references cannot be substituted", async t => {
  const f = await fixture(t), input = f.request(), count = f.ledger().listObservations("study").length;
  const variants: CoworkerEvidenceUpdateRequest[] = [
    { ...input, projectId: "other" },
    { ...input, investigationWorkflow: { ...input.investigationWorkflow, observationDigest: f.workflow.digest } },
    { ...input, investigation: { ...input.investigation, observationDigest: "a".repeat(64) } },
    { ...input, followups: { observationId: f.assessment.observationId, observationDigest: f.ledger().getObservation(f.assessment.observationId)!.digest } },
  ];
  for (const variant of variants) assert.throws(() => archiveCoworkerEvidenceUpdate(f.ledger(), f.queue, variant, f.now));
  assert.equal(f.ledger().listObservations("study").length, count);
});

test("incomplete inspection retains open requirements and cannot inherit full comparison claims", async t => {
  const f = await fixture(t, false), result = archiveCoworkerEvidenceUpdate(f.ledger(), f.queue, f.request(), f.now);
  assert.equal(result.scientificEvaluation, "unassessed");
  assert.ok(result.followupProgress.workItems.every(item => item.state === "unresolved"));
  assert.deepEqual(loadCoworkerEvidenceUpdate(f.ledger(), result.observationId), result);
  // A reader result is absent; no artifact/count values may be synthesized into
  // this derived assessment from the mere existence of a completed queue task.
  const investigation = f.ledger().getObservation(f.workflow.investigationObservationId)!;
  assert.equal((investigation.payload.execution as any).result, null);
  assert.doesNotMatch(JSON.stringify(result.assessment), /"producerCreditedDifference":|"producerTargetsCredited":/u);
});

test("update ID reuse, getters and rehashed scope/check/workitem edits fail closed", async t => {
  const f = await fixture(t), input = f.request(); let calls = 0;
  assert.throws(() => normalizeCoworkerEvidenceUpdateRequest({ ...input, investigation: { ...input.investigation,
    get observationDigest() { calls++; return input.investigation.observationDigest; } } }), /accessors/u);
  assert.equal(calls, 0);
  const result = archiveCoworkerEvidenceUpdate(f.ledger(), f.queue, input, f.now);
  assert.throws(() => archiveCoworkerEvidenceUpdate(f.ledger(), f.queue,
    { ...input, investigation: { ...input.investigation, observationDigest: "a".repeat(64) } }, f.now), /another request/u);
  const original = f.ledger().getObservation(result.observationId)!;
  for (const mutate of [
    (payload: any) => { payload.scientificEvaluation = "validated"; },
    (payload: any) => { payload.followupProgress.workItems[0].state = "resolved"; },
    (payload: any) => { payload.packet.checks[0].status = "failed"; const { digest: _digest, ...body } = payload.packet; payload.packet.digest = hash(body); },
    (payload: any) => { payload.completionWitness.result.meaning = "Approved for training"; payload.completionWitness.resultDigest = hash(payload.completionWitness.result); },
  ]) {
    const changed = structuredClone(original); mutate(changed.payload);
    const { digest: _payloadDigest, ...payloadBody } = changed.payload; changed.payload.digest = hash(payloadBody);
    const { digest: _digest, ...body } = changed; const forged: ObservationRecord = { ...body, digest: hash(body) };
    const ledger = new Proxy(f.ledger(), { get(target, key) {
      if (key === "getObservation") return (eventId: string) => eventId === forged.eventId ? forged : target.getObservation(eventId);
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } }) as ExperimentLedger;
    assert.throws(() => loadCoworkerEvidenceUpdate(ledger, result.observationId), /projection|witness|receipt/u);
  }
});
