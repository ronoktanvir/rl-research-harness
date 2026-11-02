import type { ExperimentLedger, JsonObject, ObservationRecord } from "../ledger/types.ts";
import { digestValue, encode, hash, id, keys, snapshot, timestamp } from "../ledger/validation.ts";
import { assessCoworkerCapture, COWORKER_ASSESSMENT_RULES, COWORKER_ASSESSMENT_SOURCE } from "../integrations/coworker/assessment.ts";
import type { CoworkerAssessment, CoworkerDiagnosticRequest } from "../integrations/coworker/assessment.ts";
import { freezeSnapshot } from "../research/evidence.ts";
import type { DeepReadonly } from "../research/types.ts";
import { COWORKER_ASSESSMENT_HANDLER_POLICY } from "./handlers.ts";
import type { ResearchTaskHandler } from "./handlers.ts";
import { runNextResearchTask } from "./runner.ts";
import type { RunnerOptions } from "./runner.ts";
import type { EnqueueTaskInput, HandlerPolicy, TaskQueue, TaskRecord, TaskState } from "./types.ts";

const WORKFLOW_SOURCE = "coworker-assessment-workflow.v1";
const FOLLOWUP_SOURCE = "coworker-assessment-followups.v1";
const RESULT_MEANING = "Retrospective assessment archived; evidence requests remain unresolved and no intervention is authorized.";

export interface AssessmentWorkflowRequest {
  projectId: string; workflowId: string; captureId: string; captureDigest: string;
  notBefore: string; deadlineAt: string;
}
export type AssessmentWorkflow = DeepReadonly<{
  schemaVersion: 1; kind: typeof WORKFLOW_SOURCE; observationId: string; digest: string;
  request: AssessmentWorkflowRequest; requestDigest: string; createdAt: string;
  rulesDigest: string; assessmentId: string; assessmentDigest: string;
  task: EnqueueTaskInput; handler: HandlerPolicy;
}>;
export interface DiagnosticWorkItem {
  workItemId: string; rank: number; kind: CoworkerDiagnosticRequest["kind"];
  priority: CoworkerDiagnosticRequest["priority"]; mode: "evidence_request";
  action: string; completionEvidence: string; findingIds: string[]; evidenceIds: string[];
  /** Gates supported interpretation, not raw evidence collection or prospective drafting. */
  interpretationDependencies: { workItemId: string; reason: string }[];
  planningDependency: string;
  state: "unresolved"; executionAuthorized: false;
}
export type AssessmentFollowupPlan = DeepReadonly<{
  schemaVersion: 1; kind: typeof FOLLOWUP_SOURCE; observationId: string; digest: string;
  workflowObservationId: string; workflowDigest: string;
  assessmentObservationId: string; assessmentObservationDigest: string; assessmentDigest: string;
  completedAssessmentTaskId: string; workItems: DiagnosticWorkItem[];
  interventionAuthorized: false; meaning: string; limitations: string[];
}>;
export type AssessmentWorkflowProgress =
  | { status: "pending" | "blocked"; workflowObservationId: string; taskId: string; taskState: TaskState | "missing"; reason: string }
  | { status: "evidence_required"; workflowObservationId: string; followups: AssessmentFollowupPlan };

function request(raw: AssessmentWorkflowRequest): AssessmentWorkflowRequest {
  // A bounded flat DTO can be checked before cloning without executing getters.
  keys(raw, ["projectId", "workflowId", "captureId", "captureDigest", "notBefore", "deadlineAt"]);
  const fields = Object.getOwnPropertyDescriptors(raw);
  if (Object.getOwnPropertySymbols(raw).length || Object.values(fields).some(field => !Object.hasOwn(field, "value") || !field.enumerable)) {
    throw new Error("Workflow request must contain inert enumerable fields");
  }
  if (Object.values(fields).some(field => typeof field.value !== "string" || field.value.length > 128)) throw new Error("Workflow fields must be bounded primitive strings");
  const value = snapshot(raw);
  for (const name of [value.projectId, value.workflowId, value.captureId]) { id(name); if (name.length > 128) throw new Error("Workflow IDs exceed 128 characters"); }
  digestValue(value.captureDigest); timestamp(value.notBefore); timestamp(value.deadlineAt);
  if (Date.parse(value.notBefore) >= Date.parse(value.deadlineAt)) throw new Error("Workflow eligibility must precede its deadline");
  return value;
}
function assessment(ledger: ExperimentLedger, input: AssessmentWorkflowRequest): CoworkerAssessment {
  const capture = ledger.getObservation(input.captureId);
  if (!capture) throw new Error("Workflow capture is unavailable");
  return assessCoworkerCapture(capture, { projectId: input.projectId, captureId: input.captureId, captureDigest: input.captureDigest });
}
function verified(record: ObservationRecord | null): ObservationRecord {
  if (!record) throw new Error("Required workflow observation is missing");
  const value = snapshot(record), { digest, ...body } = value;
  digestValue(digest); timestamp(value.observedAt);
  if (hash(body) !== digest || value.runId !== null || value.actionId !== null || value.jobId !== null || value.sequence !== 0) {
    throw new Error("Workflow archive identity or digest is inconsistent");
  }
  return value;
}
function workflow(input: AssessmentWorkflowRequest, assessed: CoworkerAssessment, createdAt: string): AssessmentWorkflow {
  timestamp(createdAt);
  const identity = hash([input.projectId, input.workflowId]);
  const task: EnqueueTaskInput = { taskId: `assessment-task:${identity}`, projectId: input.projectId,
    kind: COWORKER_ASSESSMENT_HANDLER_POLICY.kind, handlerVersion: COWORKER_ASSESSMENT_HANDLER_POLICY.version,
    input: { captureId: input.captureId, captureDigest: input.captureDigest, rulesDigest: assessed.rulesDigest },
    dependencies: [], maxAttempts: 2, notBefore: input.notBefore, deadlineAt: input.deadlineAt };
  const body = { schemaVersion: 1 as const, kind: WORKFLOW_SOURCE as typeof WORKFLOW_SOURCE, observationId: `assessment-workflow:${identity}`,
    request: input, requestDigest: hash(input), createdAt, rulesDigest: assessed.rulesDigest,
    assessmentId: assessed.assessmentId, assessmentDigest: assessed.digest, task, handler: COWORKER_ASSESSMENT_HANDLER_POLICY };
  return freezeSnapshot({ ...body, digest: hash(body) });
}
/** Recompute from the bound capture and current rule implementation; hashes are not authority. */
export function loadAssessmentWorkflow(ledger: ExperimentLedger, observationId: string): AssessmentWorkflow {
  id(observationId);
  const record = verified(ledger.getObservation(observationId));
  if (record.source !== WORKFLOW_SOURCE || record.eventId !== observationId) throw new Error("Observation is not an assessment workflow");
  const saved = record.payload;
  const input = request(saved.request as unknown as AssessmentWorkflowRequest);
  if (record.projectId !== input.projectId || record.observedAt !== saved.createdAt) throw new Error("Workflow project or creation time changed");
  if (saved.rulesDigest !== COWORKER_ASSESSMENT_RULES.digest) throw new Error("Workflow rules are unavailable; create a new explicit workflow for changed rules");
  const expected = workflow(input, assessment(ledger, input), saved.createdAt as string);
  if (expected.observationId !== observationId || encode(expected) !== encode(saved)) throw new Error("Workflow no longer matches its bound evidence");
  return expected;
}
function assertTask(record: TaskRecord, plan: AssessmentWorkflow): void {
  const { taskId, projectId, kind, handlerVersion, input, dependencies, maxAttempts, notBefore, deadlineAt } = record;
  if (encode({ taskId, projectId, kind, handlerVersion, input, dependencies, maxAttempts, notBefore, deadlineAt }) !== encode(plan.task)
    || record.inputDigest !== hash(input) || encode(record.handler) !== encode(plan.handler)) throw new Error("Assessment task conflicts with archived workflow");
}
function installed(handlers: readonly ResearchTaskHandler[], plan: AssessmentWorkflow): ResearchTaskHandler {
  const matches = handlers.filter(handler => handler.policy.kind === plan.handler.kind && handler.policy.version === plan.handler.version);
  if (matches.length !== 1 || encode(matches[0]!.policy) !== encode(plan.handler)) throw new Error("Fixed zero-call assessment handler is unavailable or ambiguous");
  matches[0]!.validate(snapshot<unknown>(plan.task.input), plan.request.projectId);
  return matches[0]!;
}
/** Intent precedes queue writes. Repeating the same request repairs a missing enqueue only. */
export function prepareAssessmentWorkflow(ledger: ExperimentLedger, queue: TaskQueue, handlers: readonly ResearchTaskHandler[],
  raw: AssessmentWorkflowRequest, now: () => Date = () => new Date()): AssessmentWorkflow {
  const input = request(raw), observationId = `assessment-workflow:${hash([input.projectId, input.workflowId])}`;
  const existing = ledger.getObservation(observationId);
  const plan = existing ? loadAssessmentWorkflow(ledger, observationId) : workflow(input, assessment(ledger, input), now().toISOString());
  if (plan.requestDigest !== hash(input)) throw new Error("Workflow identity already belongs to another request");
  installed(handlers, plan);
  queue.registerHandler(snapshot<HandlerPolicy>(plan.handler));
  if (!existing) ledger.appendObservation({ eventId: observationId, projectId: input.projectId,
    runId: null, actionId: null, jobId: null, source: WORKFLOW_SOURCE, sequence: 0, observedAt: plan.createdAt, payload: snapshot(plan) as unknown as JsonObject });
  assertTask(queue.enqueue(snapshot<unknown>(plan.task) as EnqueueTaskInput), plan);
  return plan;
}
function archivedAssessment(ledger: ExperimentLedger, plan: AssessmentWorkflow): { record: ObservationRecord; assessed: CoworkerAssessment } {
  const assessed = assessment(ledger, plan.request), record = verified(ledger.getObservation(plan.assessmentId));
  if (record.eventId !== plan.assessmentId || record.source !== COWORKER_ASSESSMENT_SOURCE || record.projectId !== plan.request.projectId
    || record.observedAt !== assessed.observedAt || assessed.digest !== plan.assessmentDigest || encode(record.payload) !== encode(assessed)) {
    throw new Error("Archived assessment differs from the workflow's bound evidence and rules");
  }
  return { record, assessed };
}
function followups(plan: AssessmentWorkflow, archived: ObservationRecord, assessed: CoworkerAssessment): AssessmentFollowupPlan {
  const workId = (kind: CoworkerDiagnosticRequest["kind"]) => `diagnostic:${hash([plan.digest, kind])}`;
  const kinds = new Set(assessed.requests.map(item => item.kind));
  const workItems = assessed.requests.map(item => {
    const prerequisites: { kind: CoworkerDiagnosticRequest["kind"]; reason: string }[] = [];
    if (["collect_independent_evaluation", "design_matched_baseline", "verify_checkpoint"].includes(item.kind)) {
      prerequisites.push({ kind: "recover_manifest", reason: "Recovered provenance is required to claim comparability or checkpoint lineage; collection and prospective drafting may proceed with unknowns explicit." });
    }
    if (["collect_independent_evaluation", "design_matched_baseline"].includes(item.kind)) {
      for (const issue of assessed.requests.filter(candidate => candidate.priority === "integrity")) {
        prerequisites.push({ kind: issue.kind, reason: "Resolve the cited integrity finding before using the affected trajectory to support learning or comparison claims; independent evidence collection is not blocked." });
      }
    }
    return { workItemId: workId(item.kind), rank: item.rank, kind: item.kind, priority: item.priority,
      mode: "evidence_request" as const, action: item.action, completionEvidence: item.completionEvidence,
      findingIds: [...item.findingIds], evidenceIds: [...item.evidenceIds],
      interpretationDependencies: prerequisites.filter(dependency => kinds.has(dependency.kind) && dependency.kind !== item.kind)
        .map(dependency => ({ workItemId: workId(dependency.kind), reason: dependency.reason })),
      planningDependency: plan.task.taskId, state: "unresolved" as const, executionAuthorized: false as const };
  });
  const body = { schemaVersion: 1 as const, kind: FOLLOWUP_SOURCE as typeof FOLLOWUP_SOURCE, observationId: `assessment-followups:${hash([plan.digest, archived.digest])}`,
    workflowObservationId: plan.observationId, workflowDigest: plan.digest, assessmentObservationId: archived.eventId,
    assessmentObservationDigest: archived.digest, assessmentDigest: assessed.digest, completedAssessmentTaskId: plan.task.taskId, workItems,
    interventionAuthorized: false as const, meaning: "Ranked evidence requests derived from an archived assessment; none is an admitted experiment or a completed investigation.",
    limitations: ["Interpretation dependencies express evidence requirements, not a ban on collecting raw evidence or drafting prospective protocols.",
      "No request is automatically marked resolved; evidence collection, verification and any later execution need their own typed records and authority.",
      "This workflow neither consumes client invocation units nor releases existing quota/authentication holds.",
      "A clean captured trajectory does not establish current liveness, checkpoint validity, independent learning benefit or publication quality."] };
  return freezeSnapshot({ ...body, digest: hash(body) });
}
/** Publish follow-ups only after the queue result and immutable assessment agree. */
export function advanceAssessmentWorkflow(ledger: ExperimentLedger, queue: TaskQueue, observationId: string,
  now: () => Date = () => new Date()): AssessmentWorkflowProgress {
  const plan = loadAssessmentWorkflow(ledger, observationId);
  let task: TaskRecord;
  try { task = queue.getTask(plan.task.taskId); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "missing")) throw error;
    return { status: "pending", workflowObservationId: observationId, taskId: plan.task.taskId, taskState: "missing", reason: "prepare_again_to_repair_enqueue" };
  }
  assertTask(task, plan);
  if (task.state !== "completed") return { status: ["queued", "running"].includes(task.state) ? "pending" : "blocked",
    workflowObservationId: observationId, taskId: task.taskId, taskState: task.state,
    reason: task.state === "uncertain" ? "explicit_reconciliation_required" : `assessment_task_${task.state}` };
  const { record, assessed } = archivedAssessment(ledger, plan);
  const expectedResult = { kind: "coworker_assessment", assessmentObservationId: record.eventId, assessmentObservationDigest: record.digest,
    assessmentDigest: assessed.digest, rulesDigest: assessed.rulesDigest, captureId: plan.request.captureId,
    captureDigest: plan.request.captureDigest, meaning: RESULT_MEANING };
  if (encode(task.result) !== encode(expectedResult)) throw new Error("Completed task does not identify the exact archived assessment");
  const next = followups(plan, record, assessed), existing = ledger.getObservation(next.observationId);
  if (existing) {
    const stored = verified(existing);
    if (stored.eventId !== next.observationId || stored.projectId !== plan.request.projectId || stored.source !== FOLLOWUP_SOURCE
      || encode(stored.payload) !== encode(next)) throw new Error("Follow-up archive conflicts with derived requests");
  } else ledger.appendObservation({ eventId: next.observationId, projectId: plan.request.projectId, runId: null, actionId: null, jobId: null,
    source: FOLLOWUP_SOURCE, sequence: 0, observedAt: now().toISOString(), payload: snapshot(next) as unknown as JsonObject });
  return { status: "evidence_required", workflowObservationId: observationId, followups: next };
}
/** At most one exact zero-call task. No unselected task, model, capture reread or trainer runs. */
export async function runAssessmentWorkflow(ledger: ExperimentLedger, queue: TaskQueue, handlers: readonly ResearchTaskHandler[],
  observationId: string, options: Omit<RunnerOptions, "taskIds">): Promise<AssessmentWorkflowProgress> {
  const plan = loadAssessmentWorkflow(ledger, observationId), selected = installed([...handlers], plan);
  const limits = { ...options, taskIds: [plan.task.taskId] };
  const before = advanceAssessmentWorkflow(ledger, queue, observationId, options.now);
  if (before.status !== "pending") return before;
  await runNextResearchTask(queue, [selected], limits);
  return advanceAssessmentWorkflow(ledger, queue, observationId, limits.now);
}
