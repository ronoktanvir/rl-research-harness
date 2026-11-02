import type { ExperimentLedger, JsonObject, ObservationRecord } from "../ledger/types.ts";
import { digestValue, encode, hash, id, integer, keys, policyScope, timestamp } from "../ledger/validation.ts";
import { freezeSnapshot } from "../research/evidence.ts";
import type { EvidencePacket } from "../research/types.ts";
import { copyCoworkerInvestigationData, loadCoworkerInvestigation } from "../integrations/coworker/investigation.ts";
import { assessCoworkerInvestigationEvidence } from "../integrations/coworker/evidence-assessment.ts";
import type { CoworkerEvidenceAssessment, CoworkerEvidenceAssessmentBinding, InvestigationRequestUpdate } from "../integrations/coworker/evidence-assessment.ts";
import { buildCoworkerPlanningPacket, COWORKER_PLANNING_SCOPE } from "../integrations/coworker/planning-packet.ts";
import { loadAssessmentFollowups, loadAssessmentWorkflow } from "./assessment-workflow.ts";
import type { AssessmentFollowupPlan } from "./assessment-workflow.ts";
import { advanceInvestigationWorkflow, loadInvestigationWorkflow } from "./investigation-workflow.ts";
import { investigationTaskInput, INVESTIGATION_HANDLER_POLICY, INVESTIGATION_TASK_MEANING } from "./investigation-handlers.ts";
import type { TaskQueue, TaskRecord } from "./types.ts";

export const COWORKER_EVIDENCE_UPDATE_SOURCE = "coworker-evidence-update.v1";
export interface CoworkerEvidenceReference { observationId: string; observationDigest: string }
export interface CoworkerEvidenceUpdateRequest {
  projectId: string; updateId: string;
  investigationWorkflow: CoworkerEvidenceReference; investigation: CoworkerEvidenceReference; followups: CoworkerEvidenceReference;
}
export interface CoworkerEvidenceCompletionWitness {
  taskId: string; attemptId: string; attemptNumber: number; workerId: string; claimedAt: string; witnessedAt: string;
  inputDigest: string; handlerDigest: string; status: "completed"; result: JsonObject; resultDigest: string;
  meaning: "trusted_controller_observation_of_local_queue_completion";
}
export interface CoworkerEvidenceUpdate {
  schemaVersion: 1; kind: typeof COWORKER_EVIDENCE_UPDATE_SOURCE; observationId: string;
  /** Canonical payload digest; observationDigest identifies the outer ledger envelope. */
  digest: string; observationDigest: string; createdAt: string; request: CoworkerEvidenceUpdateRequest; requestDigest: string;
  bindings: { assessmentWorkflow: CoworkerEvidenceReference; assessment: CoworkerEvidenceReference; capture: CoworkerEvidenceReference };
  completionWitness: CoworkerEvidenceCompletionWitness;
  assessment: CoworkerEvidenceAssessment; packet: EvidencePacket;
  followupProgress: { followupsObservationId: string; followupsObservationDigest: string;
    workItems: AssessmentFollowupPlan["workItems"]; requestUpdates: CoworkerEvidenceAssessment["requestUpdates"];
    workItemUpdates: Array<InvestigationRequestUpdate & { workItemId: string }>;
    state: "unresolved"; executionAuthorized: false };
  decisionScope: typeof COWORKER_PLANNING_SCOPE; executionAuthorized: false; scientificEvaluation: "unassessed"; interventionAuthorized: false;
  limitations: string[];
}
type SavedUpdate = Omit<CoworkerEvidenceUpdate, "observationDigest">;

function invalid(reason: string): never { throw new Error(`Invalid Coworker evidence update: ${reason}`); }
function same(actual: unknown, expected: unknown, reason: string): void { if (encode(actual) !== encode(expected)) invalid(reason); }
function reference(raw: unknown): CoworkerEvidenceReference {
  keys(raw, ["observationId", "observationDigest"]); id(raw.observationId); digestValue(raw.observationDigest);
  return { observationId: raw.observationId, observationDigest: raw.observationDigest };
}
export function normalizeCoworkerEvidenceUpdateRequest(raw: unknown): CoworkerEvidenceUpdateRequest {
  const value = copyCoworkerInvestigationData(raw); keys(value, ["projectId", "updateId", "investigationWorkflow", "investigation", "followups"]);
  id(value.projectId); policyScope(`project:${value.projectId}`); id(value.updateId);
  return freezeSnapshot<unknown>({ projectId: value.projectId, updateId: value.updateId,
    investigationWorkflow: reference(value.investigationWorkflow), investigation: reference(value.investigation), followups: reference(value.followups) }) as CoworkerEvidenceUpdateRequest;
}
function identity(input: CoworkerEvidenceUpdateRequest): string { return `coworker-evidence-update:${hash([input.projectId, input.updateId])}`; }
function read(ledger: ExperimentLedger, observationId: string, projectId: string): ObservationRecord {
  const raw = ledger.getObservation(observationId); if (!raw) invalid("referenced observation missing");
  const value = copyCoworkerInvestigationData(raw);
  keys(value, ["eventId", "projectId", "runId", "actionId", "jobId", "source", "sequence", "observedAt", "payload", "digest"]);
  const { digest, ...body } = value; digestValue(digest); timestamp(value.observedAt);
  if (hash(body) !== digest || value.eventId !== observationId || value.projectId !== projectId || value.sequence !== 0
    || value.runId !== null || value.actionId !== null || value.jobId !== null) invalid("observation envelope mismatch");
  return value as unknown as ObservationRecord;
}
function ref(record: ObservationRecord): CoworkerEvidenceReference { return { observationId: record.eventId, observationDigest: record.digest }; }
function resolve(ledger: ExperimentLedger, input: CoworkerEvidenceUpdateRequest) {
  const workflowRecord = read(ledger, input.investigationWorkflow.observationId, input.projectId);
  same(ref(workflowRecord), input.investigationWorkflow, "investigation workflow envelope digest mismatch");
  const workflow = loadInvestigationWorkflow(ledger, workflowRecord.eventId);
  if (workflow.projectId !== input.projectId || workflow.investigationObservationId !== input.investigation.observationId
    || workflow.followupsObservationId !== input.followups.observationId) invalid("workflow reference chain mismatch");
  const investigation = loadCoworkerInvestigation(ledger, input.investigation.observationId);
  same(ref(investigation), input.investigation, "investigation envelope digest mismatch");
  if (investigation.projectId !== input.projectId) invalid("investigation project mismatch");
  const taskInput = investigationTaskInput(workflow.task.input);
  same(investigation.payload.requestIdentity, taskInput.request, "investigation request differs from workflow");
  same(investigation.payload.worker, taskInput.worker, "investigation worker differs from workflow");
  const assessmentWorkflow = loadAssessmentWorkflow(ledger, workflow.request.assessmentWorkflowObservationId);
  if (assessmentWorkflow.request.projectId !== input.projectId || workflow.assessmentWorkflowDigest !== assessmentWorkflow.digest) invalid("assessment workflow mismatch");
  const followups = loadAssessmentFollowups(ledger, assessmentWorkflow.observationId), followupRecord = read(ledger, followups.observationId, input.projectId);
  same(ref(followupRecord), input.followups, "follow-up envelope digest mismatch");
  if (workflow.followupsDigest !== followups.digest) invalid("follow-up content digest mismatch");
  const assessmentRecord = read(ledger, followups.assessmentObservationId, input.projectId);
  if (assessmentRecord.digest !== followups.assessmentObservationDigest) invalid("assessment envelope digest mismatch");
  const captureRecord = read(ledger, assessmentWorkflow.request.captureId, input.projectId);
  if (captureRecord.digest !== assessmentWorkflow.request.captureDigest) invalid("capture envelope digest mismatch");
  const bindings = { assessmentWorkflow: ref(read(ledger, assessmentWorkflow.observationId, input.projectId)), assessment: ref(assessmentRecord), capture: ref(captureRecord) };
  const assessmentBinding: CoworkerEvidenceAssessmentBinding = { projectId: input.projectId, assessmentObservationId: assessmentRecord.eventId,
    assessmentObservationDigest: assessmentRecord.digest, investigationObservationId: investigation.eventId, investigationObservationDigest: investigation.digest };
  const expectedTaskResult: JsonObject = { kind: INVESTIGATION_HANDLER_POLICY.kind, observationId: investigation.eventId, observationDigest: investigation.digest,
    requestDigest: hash(taskInput.request), workerDigest: hash(taskInput.worker), meaning: INVESTIGATION_TASK_MEANING };
  return { workflow, followups, bindings, assessmentBinding, expectedTaskResult };
}
type EvidenceContext = ReturnType<typeof resolve>;
function validateWitness(raw: unknown, context: EvidenceContext, createdAt: string): CoworkerEvidenceCompletionWitness {
  const value = copyCoworkerInvestigationData(raw);
  keys(value, ["taskId", "attemptId", "attemptNumber", "workerId", "claimedAt", "witnessedAt", "inputDigest", "handlerDigest", "status", "result", "resultDigest", "meaning"]);
  id(value.taskId); id(value.attemptId); id(value.workerId); integer(value.attemptNumber, 1); timestamp(value.claimedAt); timestamp(value.witnessedAt);
  if (value.taskId !== context.workflow.task.taskId || !/^task-attempt:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value.attemptId)
    || value.attemptNumber > context.workflow.task.maxAttempts || value.witnessedAt !== createdAt || value.status !== "completed"
    || value.meaning !== "trusted_controller_observation_of_local_queue_completion"
    || Date.parse(value.claimedAt) < Date.parse(context.workflow.task.notBefore) || Date.parse(value.claimedAt) >= Date.parse(context.workflow.task.deadlineAt)
    || Date.parse(value.claimedAt) > Date.parse(createdAt) || value.inputDigest !== hash(context.workflow.task.input)
    || value.handlerDigest !== hash(INVESTIGATION_HANDLER_POLICY) || value.resultDigest !== hash(context.expectedTaskResult)) invalid("completion witness mismatch");
  same(value.result, context.expectedTaskResult, "completion receipt differs from archived investigation");
  return value as unknown as CoworkerEvidenceCompletionWitness;
}
function taskDeclaration(task: TaskRecord) {
  const { taskId, projectId, kind, handlerVersion, input, dependencies, maxAttempts, notBefore, deadlineAt } = task;
  return { taskId, projectId, kind, handlerVersion, input, dependencies, maxAttempts, notBefore, deadlineAt };
}
function witness(queue: TaskQueue, context: EvidenceContext, createdAt: string): CoworkerEvidenceCompletionWitness {
  const task = copyCoworkerInvestigationData(queue.getTask(context.workflow.task.taskId)) as TaskRecord;
  same(taskDeclaration(task), context.workflow.task, "queue task differs from workflow");
  same(task.handler, INVESTIGATION_HANDLER_POLICY, "queue handler differs from fixed policy");
  if (task.state !== "completed" || task.inputDigest !== hash(context.workflow.task.input) || !task.currentAttemptId) invalid("investigation queue task is not completed");
  same(task.result, context.expectedTaskResult, "queue completion receipt mismatch");
  const attempts = copyCoworkerInvestigationData(queue.attempts(task.taskId)) as ReturnType<TaskQueue["attempts"]>;
  const selected = attempts.filter(attempt => attempt.attemptId === task.currentAttemptId);
  if (selected.length !== 1) invalid("completed queue attempt missing or ambiguous");
  const attempt = selected[0]!;
  if (attempt.taskId !== task.taskId || attempt.number !== task.attempts || attempt.status !== "completed"
    || attempt.claim.attemptId !== attempt.attemptId || attempt.claim.task.currentAttemptId !== attempt.attemptId
    || attempt.claim.task.attempts !== attempt.number || attempt.claim.task.state !== "running") invalid("completed queue attempt binding mismatch");
  same(taskDeclaration(attempt.claim.task), context.workflow.task, "attempt claim differs from workflow");
  same(attempt.claim.task.handler, INVESTIGATION_HANDLER_POLICY, "attempt handler mismatch");
  if (attempt.claim.task.inputDigest !== task.inputDigest) invalid("attempt input digest mismatch");
  same(attempt.result, context.expectedTaskResult, "attempt completion receipt mismatch");
  return validateWitness({ taskId: task.taskId, attemptId: attempt.attemptId, attemptNumber: attempt.number, workerId: attempt.claim.workerId,
    claimedAt: attempt.claim.claimedAt, witnessedAt: createdAt, inputDigest: task.inputDigest, handlerDigest: hash(task.handler), status: "completed",
    result: context.expectedTaskResult, resultDigest: hash(context.expectedTaskResult), meaning: "trusted_controller_observation_of_local_queue_completion" }, context, createdAt);
}
function build(ledger: ExperimentLedger, input: CoworkerEvidenceUpdateRequest, context: EvidenceContext,
  completionWitness: CoworkerEvidenceCompletionWitness, createdAt: string): SavedUpdate {
  timestamp(createdAt);
  const checkedWitness = validateWitness(completionWitness, context, createdAt), assessment = assessCoworkerInvestigationEvidence(ledger, context.assessmentBinding);
  const packet = buildCoworkerPlanningPacket(ledger, context.assessmentBinding, createdAt);
  const updates = new Map(assessment.requestUpdates.map(update => [update.kind, update]));
  if (updates.size !== assessment.requestUpdates.length || updates.size !== context.followups.workItems.length
    || new Set(context.followups.workItems.map(item => item.kind)).size !== context.followups.workItems.length) invalid("missing or duplicate request updates");
  const workItemUpdates = context.followups.workItems.map(item => {
    const update = updates.get(item.kind); if (!update) invalid("request update does not match original work item");
    return { workItemId: item.workItemId, ...update };
  });
  const body = { schemaVersion: 1 as const, kind: COWORKER_EVIDENCE_UPDATE_SOURCE, observationId: identity(input), createdAt, request: input,
    requestDigest: hash(input), bindings: context.bindings, completionWitness: checkedWitness, assessment, packet,
    followupProgress: { followupsObservationId: input.followups.observationId, followupsObservationDigest: input.followups.observationDigest,
      workItems: context.followups.workItems, requestUpdates: assessment.requestUpdates, workItemUpdates, state: "unresolved" as const, executionAuthorized: false as const },
    decisionScope: COWORKER_PLANNING_SCOPE, executionAuthorized: false as const, scientificEvaluation: "unassessed" as const, interventionAuthorized: false as const,
    limitations: ["Criterion updates preserve narrow observed evidence; original scientific requests remain unresolved.",
      "Queue completion is a saved trusted-controller observation, not a cryptographic attestation against arbitrary ledger writers.",
      "This record performs no source-file read, council/model invocation, scientific approval, experiment admission or resource-state change."] };
  return freezeSnapshot<unknown>({ ...body, digest: hash(body) }) as SavedUpdate;
}
/** Pure load: recompute from saved evidence and the current versioned rules, never queue or files. */
export function loadCoworkerEvidenceUpdate(ledger: ExperimentLedger, observationId: string): CoworkerEvidenceUpdate {
  if (!/^coworker-evidence-update:[a-f0-9]{64}$/u.test(observationId)) invalid("update identity format");
  const raw = ledger.getObservation(observationId); if (!raw) invalid("update missing");
  const initial = copyCoworkerInvestigationData(raw); keys(initial, ["eventId", "projectId", "runId", "actionId", "jobId", "source", "sequence", "observedAt", "payload", "digest"]);
  id(initial.projectId);
  const record = read(ledger, observationId, initial.projectId);
  if (record.source !== COWORKER_EVIDENCE_UPDATE_SOURCE) invalid("wrong update source");
  const saved = record.payload, input = normalizeCoworkerEvidenceUpdateRequest(saved.request);
  if (input.projectId !== record.projectId || identity(input) !== observationId || saved.createdAt !== record.observedAt) invalid("update identity mismatch");
  const context = resolve(ledger, input), expected = build(ledger, input, context,
    validateWitness(saved.completionWitness, context, record.observedAt), record.observedAt);
  same(saved, expected, "update projection differs from its bound evidence");
  return freezeSnapshot<unknown>({ ...expected, observationDigest: record.digest }) as CoworkerEvidenceUpdate;
}
/** One deterministic archival append; existing updates replay without queue access. */
export function archiveCoworkerEvidenceUpdate(ledger: ExperimentLedger, queue: TaskQueue, raw: CoworkerEvidenceUpdateRequest,
  now: () => Date = () => new Date()): CoworkerEvidenceUpdate {
  const input = normalizeCoworkerEvidenceUpdateRequest(raw), observationId = identity(input), existing = ledger.getObservation(observationId);
  if (existing) {
    const saved = loadCoworkerEvidenceUpdate(ledger, observationId);
    same(saved.request, input, "update identity already belongs to another request"); return saved;
  }
  const context = resolve(ledger, input), progress = advanceInvestigationWorkflow(ledger, queue, input.investigationWorkflow.observationId);
  if (progress.status !== "evidence_required" || progress.investigationObservationId !== input.investigation.observationId
    || progress.investigationObservationDigest !== input.investigation.observationDigest) invalid("investigation workflow is not completed");
  const createdAt = now().toISOString(), payload = build(ledger, input, context, witness(queue, context, createdAt), createdAt);
  const event = { eventId: observationId, projectId: input.projectId, runId: null, actionId: null, jobId: null,
    source: COWORKER_EVIDENCE_UPDATE_SOURCE, sequence: 0, observedAt: createdAt, payload: payload as unknown as JsonObject };
  const saved = ledger.appendObservation(event);
  same(saved, { ...event, digest: hash(event) }, "archive returned inconsistent update");
  return freezeSnapshot<unknown>({ ...payload, observationDigest: saved.digest }) as CoworkerEvidenceUpdate;
}
