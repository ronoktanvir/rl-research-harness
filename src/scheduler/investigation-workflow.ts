import type { ExperimentLedger, JsonObject, ObservationRecord } from "../ledger/types.ts";
import { encode, hash, id, keys, snapshot, timestamp } from "../ledger/validation.ts";
import { freezeSnapshot } from "../research/evidence.ts";
import { copyCoworkerInvestigationData, coworkerInvestigationObservationId, loadCoworkerInvestigation, normalizeCoworkerInvestigationRequest } from "../integrations/coworker/investigation.ts";
import { advanceAssessmentWorkflow, loadAssessmentFollowups, loadAssessmentWorkflow } from "./assessment-workflow.ts";
import { INVESTIGATION_HANDLER_POLICY, INVESTIGATION_TASK_MEANING, investigationTaskInput } from "./investigation-handlers.ts";
import type { InvestigationRequest, InvestigationTaskHandler, InvestigationWorkerDescriptor } from "./investigation-handlers.ts";
import type { ResearchTaskHandler } from "./handlers.ts";
import { runNextResearchTask } from "./runner.ts";
import type { RunnerOptions } from "./runner.ts";
import type { EnqueueTaskInput, TaskQueue, TaskState } from "./types.ts";

const SOURCE = "coworker-investigation-workflow.v1";
export interface InvestigationWorkflowRequest {
  workflowId: string; assessmentWorkflowObservationId: string; investigationId: string;
  localArtifacts: InvestigationRequest["localArtifacts"]; notBefore: string; deadlineAt: string;
}
export interface InvestigationWorkflow {
  schemaVersion: 1; kind: typeof SOURCE; observationId: string; digest: string; createdAt: string;
  request: InvestigationWorkflowRequest; projectId: string; assessmentWorkflowDigest: string;
  followupsObservationId: string; followupsDigest: string; investigationObservationId: string;
  task: EnqueueTaskInput;
}
export type InvestigationWorkflowProgress =
  | { status: "pending" | "blocked"; workflowObservationId: string; taskId: string; taskState: TaskState | "missing"; reason: string }
  | { status: "evidence_required"; workflowObservationId: string; taskId: string; investigationObservationId: string;
    investigationObservationDigest: string; inspectionStatus: string; unresolvedWorkItems: string[];
    scientificEvaluation: "unassessed"; interventionAuthorized: false; meaning: string };

function request(raw: unknown): InvestigationWorkflowRequest {
  const input = copyCoworkerInvestigationData(raw); keys(input, ["workflowId", "assessmentWorkflowObservationId", "investigationId", "localArtifacts", "notBefore", "deadlineAt"]);
  id(input.workflowId); id(input.assessmentWorkflowObservationId); id(input.investigationId);
  timestamp(input.notBefore); timestamp(input.deadlineAt);
  if (Date.parse(input.notBefore as string) >= Date.parse(input.deadlineAt as string)) throw new Error("Investigation eligibility must precede deadline");
  // The archive's normalizer validates the five bounded relative selectors below
  // after the original capture/project are recovered from the assessment.
  return input as unknown as InvestigationWorkflowRequest;
}
function verified(record: ObservationRecord | null): ObservationRecord {
  if (!record) throw new Error("Investigation workflow observation is missing");
  const value = snapshot(record), { digest, ...body } = value;
  if (hash(body) !== digest || value.runId !== null || value.actionId !== null || value.jobId !== null || value.sequence !== 0) throw new Error("Investigation workflow envelope is inconsistent");
  return value;
}
function build(ledger: ExperimentLedger, input: InvestigationWorkflowRequest, worker: InvestigationWorkerDescriptor, createdAt: string): InvestigationWorkflow {
  timestamp(createdAt);
  const assessment = loadAssessmentWorkflow(ledger, input.assessmentWorkflowObservationId), followups = loadAssessmentFollowups(ledger, assessment.observationId);
  const projectId = assessment.request.projectId;
  const investigation = normalizeCoworkerInvestigationRequest({ projectId, investigationId: input.investigationId,
    captureId: assessment.request.captureId, captureDigest: assessment.request.captureDigest, localArtifacts: input.localArtifacts });
  const identity = hash([projectId, input.workflowId]);
  const task: EnqueueTaskInput = { taskId: `investigation-task:${identity}`, projectId, kind: INVESTIGATION_HANDLER_POLICY.kind,
    handlerVersion: INVESTIGATION_HANDLER_POLICY.version, input: { request: snapshot(investigation), worker: snapshot(worker) } as unknown as JsonObject,
    dependencies: [followups.completedAssessmentTaskId], maxAttempts: 2, notBefore: input.notBefore, deadlineAt: input.deadlineAt };
  const body = { schemaVersion: 1 as const, kind: SOURCE as typeof SOURCE, observationId: `investigation-workflow:${identity}`, createdAt,
    request: input, projectId, assessmentWorkflowDigest: assessment.digest, followupsObservationId: followups.observationId,
    followupsDigest: followups.digest, investigationObservationId: coworkerInvestigationObservationId(projectId, input.investigationId), task };
  return freezeSnapshot<unknown>({ ...body, digest: hash(body) }) as InvestigationWorkflow;
}
export function loadInvestigationWorkflow(ledger: ExperimentLedger, observationId: string): InvestigationWorkflow {
  id(observationId); const record = verified(ledger.getObservation(observationId));
  if (record.source !== SOURCE || record.eventId !== observationId) throw new Error("Observation is not an investigation workflow");
  const saved = record.payload as unknown as InvestigationWorkflow, input = request(saved.request), taskInput = investigationTaskInput(saved.task?.input);
  const expected = build(ledger, input, taskInput.worker, saved.createdAt);
  if (record.projectId !== expected.projectId || record.observedAt !== expected.createdAt || expected.observationId !== observationId || encode(expected) !== encode(saved)) {
    throw new Error("Investigation workflow differs from its bound assessment and task");
  }
  return expected;
}
function installed(handlers: readonly ResearchTaskHandler[]): InvestigationTaskHandler {
  const selected = handlers.filter(handler => handler.policy.kind === INVESTIGATION_HANDLER_POLICY.kind && handler.policy.version === INVESTIGATION_HANDLER_POLICY.version);
  if (selected.length !== 1 || encode(selected[0]!.policy) !== encode(INVESTIGATION_HANDLER_POLICY) || !("workerDescriptor" in selected[0]!)) throw new Error("Fixed investigation handler is unavailable or ambiguous");
  return selected[0] as InvestigationTaskHandler;
}
function assertTask(queue: TaskQueue, plan: InvestigationWorkflow): void {
  const task = queue.getTask(plan.task.taskId);
  const { taskId, projectId, kind, handlerVersion, input, dependencies, maxAttempts, notBefore, deadlineAt } = task;
  if (encode({ taskId, projectId, kind, handlerVersion, input, dependencies, maxAttempts, notBefore, deadlineAt }) !== encode(plan.task)
    || task.inputDigest !== hash(input) || encode(task.handler) !== encode(INVESTIGATION_HANDLER_POLICY)) throw new Error("Investigation queue task conflicts with workflow");
}
/** Workflow intent precedes enqueue; the worker's own intent precedes reading files. */
export function prepareInvestigationWorkflow(ledger: ExperimentLedger, queue: TaskQueue, handlers: readonly ResearchTaskHandler[], raw: InvestigationWorkflowRequest,
  now: () => Date = () => new Date()): InvestigationWorkflow {
  const input = request(raw), prior = advanceAssessmentWorkflow(ledger, queue, input.assessmentWorkflowObservationId, now);
  if (prior.status !== "evidence_required") throw new Error("Assessment must finish before investigation preparation");
  const selected = installed(handlers), candidate = build(ledger, input, selected.workerDescriptor, now().toISOString());
  const existing = ledger.getObservation(candidate.observationId), plan = existing ? loadInvestigationWorkflow(ledger, candidate.observationId) : candidate;
  if (encode(plan.request) !== encode(input)) throw new Error("Investigation workflow identity already belongs to another request");
  selected.validate(plan.task.input, plan.projectId);
  queue.registerHandler(selected.policy);
  if (!existing) ledger.appendObservation({ eventId: plan.observationId, projectId: plan.projectId, runId: null, actionId: null, jobId: null,
    source: SOURCE, sequence: 0, observedAt: plan.createdAt, payload: snapshot(plan) as unknown as JsonObject });
  queue.enqueue(snapshot(plan.task)); assertTask(queue, plan); return plan;
}
export function advanceInvestigationWorkflow(ledger: ExperimentLedger, queue: TaskQueue, observationId: string): InvestigationWorkflowProgress {
  const plan = loadInvestigationWorkflow(ledger, observationId);
  let task;
  try { task = queue.getTask(plan.task.taskId); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "missing")) throw error;
    return { status: "pending", workflowObservationId: observationId, taskId: plan.task.taskId, taskState: "missing", reason: "prepare_again_to_repair_enqueue" }; }
  assertTask(queue, plan);
  if (task.state !== "completed") return { status: ["queued", "running"].includes(task.state) ? "pending" : "blocked", workflowObservationId: observationId,
    taskId: task.taskId, taskState: task.state, reason: task.state === "uncertain" ? "explicit_read_only_reconciliation_required" : `investigation_task_${task.state}` };
  const result = loadCoworkerInvestigation(ledger, plan.investigationObservationId), taskInput = investigationTaskInput(plan.task.input);
  if (result.projectId !== plan.projectId || encode(result.payload.requestIdentity) !== encode(taskInput.request)
    || encode(result.payload.worker) !== encode(taskInput.worker)) throw new Error("Archived investigation differs from the exact task request or worker");
  const expected = { kind: INVESTIGATION_HANDLER_POLICY.kind, observationId: result.eventId, observationDigest: result.digest,
    requestDigest: hash(taskInput.request), workerDigest: hash(taskInput.worker), meaning: INVESTIGATION_TASK_MEANING };
  if (encode(task.result) !== encode(expected)) throw new Error("Completed task does not identify the exact investigation receipt");
  const inspectionStatus = result.payload.status;
  if (inspectionStatus !== "completed" && inspectionStatus !== "incomplete") throw new Error("Investigation inspection status is unsupported");
  const followups = loadAssessmentFollowups(ledger, plan.request.assessmentWorkflowObservationId);
  return { status: "evidence_required", workflowObservationId: observationId, taskId: task.taskId, investigationObservationId: result.eventId,
    investigationObservationDigest: result.digest, inspectionStatus, unresolvedWorkItems: followups.workItems.map(item => item.workItemId),
    scientificEvaluation: "unassessed", interventionAuthorized: false, meaning: INVESTIGATION_TASK_MEANING };
}
/** Executes at most the one selected read-only task, even when unrelated work is eligible. */
export async function runInvestigationWorkflow(ledger: ExperimentLedger, queue: TaskQueue, handlers: readonly ResearchTaskHandler[], observationId: string,
  options: Omit<RunnerOptions, "taskIds">): Promise<InvestigationWorkflowProgress> {
  const plan = loadInvestigationWorkflow(ledger, observationId), before = advanceInvestigationWorkflow(ledger, queue, observationId);
  if (before.status !== "pending") return before;
  const handler = installed(handlers); handler.validate(plan.task.input, plan.projectId);
  await runNextResearchTask(queue, [handler], { ...options, taskIds: [plan.task.taskId] });
  return advanceInvestigationWorkflow(ledger, queue, observationId);
}
