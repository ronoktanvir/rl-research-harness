import type { ExperimentLedger, JsonObject, ObservationRecord } from "../ledger/types.ts";
import { encode, hash, integer, keys, snapshot, timestamp } from "../ledger/validation.ts";
import { freezeSnapshot } from "../research/evidence.ts";
import { runCouncil } from "../research/council.ts";
import type { CouncilResult } from "../research/types.ts";
import { buildCouncilStage, COUNCIL_PLAN_SOURCE, COUNCIL_STAGE_SOURCE, loadCouncilPlan,
  loadCouncilStage, validateCouncilPlanRequest } from "./council-contracts.ts";
import type { CouncilPlan, CouncilPlanRequest, CouncilStage } from "./council-contracts.ts";
import type { ResearchTaskHandler } from "./handlers.ts";
import { enqueueResearchTask, runNextResearchTask } from "./runner.ts";
import type { RunnerOptions } from "./runner.ts";
import type { EnqueueTaskInput, TaskQueue, TaskRecord, TaskState } from "./types.ts";

const RESULT_SOURCE = "durable-council-result.v1";
const PENDING = new Set<TaskState>(["queued", "running", "waiting_quota", "waiting_auth", "uncertain"]);
class PendingStage extends Error {}
class StageFailure extends Error {}

export type CouncilProgress =
  | { status: "pending"; planObservationId: string; tasks: { taskId: string; state: TaskState }[] }
  | { status: "complete"; planObservationId: string; resultObservationId: string; decision: CouncilResult };
export interface CouncilArchiveOptions { now?: () => Date }

function clock(options: CouncilArchiveOptions): string {
  const value = (options.now ?? (() => new Date()))().toISOString(); timestamp(value); return value;
}

function verified(record: ObservationRecord | null, source: string, projectId: string): ObservationRecord {
  if (!record) throw new Error("Required council observation is missing");
  const { digest, ...data } = record;
  if (hash(data) !== digest || record.source !== source || record.projectId !== projectId
    || record.runId !== null || record.actionId !== null || record.jobId !== null) throw new Error("Council observation identity or digest does not match");
  return record;
}

/** Archive the complete authority and evidence contract before creating external-call tasks. */
export function prepareCouncilCampaign(ledger: ExperimentLedger, raw: CouncilPlanRequest,
  options: CouncilArchiveOptions = {}): CouncilPlan {
  const request = validateCouncilPlanRequest(raw);
  const planObservationId = `council-plan:${hash([request.projectId, request.campaignId])}`;
  const existing = ledger.getObservation(planObservationId);
  if (existing) {
    const plan = loadCouncilPlan(ledger, planObservationId);
    if (plan.requestDigest !== hash(request)) throw new Error("Council campaign already belongs to a different request");
    return plan;
  }
  const createdAt = clock(options);
  const data: Omit<CouncilPlan, "planDigest"> = { schemaVersion: 1, kind: COUNCIL_PLAN_SOURCE, planObservationId,
    requestDigest: hash(request), createdAt, request };
  const plan: CouncilPlan = { ...data, planDigest: hash(data) };
  ledger.appendObservation({ eventId: planObservationId, projectId: request.projectId, source: COUNCIL_PLAN_SOURCE,
    runId: null, actionId: null, jobId: null, sequence: 0, observedAt: createdAt, payload: plan as unknown as JsonObject });
  return loadCouncilPlan(ledger, planObservationId);
}

function stageId(plan: CouncilPlan, operation: "review" | "revision", round: number, reviewerId: string): string {
  return `council-stage:${hash([plan.planDigest, operation, round, reviewerId])}`;
}
const taskId = (observationId: string) => `council-task:${hash(observationId)}`;

function taskInput(plan: CouncilPlan, stage: CouncilStage): EnqueueTaskInput {
  const dependencies = stage.operation === "revision"
    ? plan.request.reviewers.map(reviewer => taskId(stageId(plan, "review", stage.round, reviewer.id)))
    : stage.round === 0 ? [] : [taskId(stageId(plan, "revision", stage.round - 1, "reviser"))];
  return { taskId: taskId(stage.stageObservationId), projectId: plan.request.projectId,
    kind: `council-${stage.operation === "review" ? "review" : "revise"}-${stage.backend}`, handlerVersion: "1",
    input: { stageObservationId: stage.stageObservationId }, dependencies, maxAttempts: 2,
    deadlineAt: plan.request.deadlineAt, notBefore: plan.request.notBefore };
}

function ensureStage(ledger: ExperimentLedger, queue: TaskQueue, handlers: readonly ResearchTaskHandler[],
  plan: CouncilPlan, stage: CouncilStage, options: CouncilArchiveOptions): TaskRecord {
  const existing = ledger.getObservation(stage.stageObservationId);
  if (existing) {
    const saved = loadCouncilStage(ledger, stage.stageObservationId);
    if (encode(saved) !== encode(stage)) throw new Error("Archived council stage differs from regenerated evidence");
  } else {
    ledger.appendObservation({ eventId: stage.stageObservationId, projectId: plan.request.projectId, source: COUNCIL_STAGE_SOURCE,
      runId: null, actionId: null, jobId: null, sequence: stage.round, observedAt: clock(options), payload: stage as unknown as JsonObject });
  }
  // The immutable archive precedes enqueue. A retry fills a missing task; it cannot
  // change an existing task's model, context, dependency list, deadline or result.
  const input = taskInput(plan, stage);
  const task = enqueueResearchTask(queue, handlers, input);
  const { taskId: id, projectId, kind, handlerVersion, input: data, dependencies, maxAttempts, deadlineAt, notBefore } = task;
  if (encode({ taskId: id, projectId, kind, handlerVersion, input: data, dependencies, maxAttempts, deadlineAt, notBefore }) !== encode(input)
    || task.inputDigest !== hash(input.input)) throw new Error("Queued council stage differs from its archived contract");
  return task;
}

function completedResult(task: TaskRecord, stage: CouncilStage): JsonObject {
  const result = task.result;
  if (task.state !== "completed" || !result) throw new Error(`Council task ${task.taskId} ended ${task.state}`);
  if (result.planDigest !== stage.planDigest || result.stageDigest !== stage.stageDigest
    || result.packetDigest !== stage.request.packet.digest || result.operation !== stage.operation
    || result.round !== stage.round || result.backend !== stage.backend || result.modelSelector !== stage.model) {
    throw new Error("Cached council result does not match its archived stage");
  }
  keys(result.client, ["backend", "status", "billing", "sessionId", "usage", "diagnostic"], ["backend", "status", "billing"]);
  if (result.client.backend !== stage.backend || result.client.status !== "succeeded" || result.client.billing !== "client_managed_account") {
    throw new Error("Council result lacks a matching successful client receipt");
  }
  return result;
}

/** Replay the deterministic council protocol from immutable cached stage outputs.
 * Missing work is materialized, never invoked here. All reviewers in a round see
 * the same pre-round context; a revision cannot be scheduled from partial reviews.
 */
export async function advanceCouncilCampaign(ledger: ExperimentLedger, queue: TaskQueue,
  handlers: readonly ResearchTaskHandler[], planObservationId: string, options: CouncilArchiveOptions = {}): Promise<CouncilProgress> {
  const plan = loadCouncilPlan(ledger, planObservationId);
  const pending = new Map<string, TaskState>();
  let infrastructureError: unknown;
  const guard = async <T>(callback: () => Promise<T>): Promise<T> => {
    try { return await callback(); }
    catch (error) {
      // The core turns reviewer exceptions into review outcomes. Persistence or
      // contract failures must instead remain repairable controller errors.
      if (!(error instanceof PendingStage) && !(error instanceof StageFailure)) infrastructureError = error;
      throw error;
    }
  };
  const decision = await runCouncil({ councilId: `durable-council:${hash([plan.request.projectId, plan.request.campaignId]).slice(0, 40)}`,
    packet: plan.request.packet, reviewers: plan.request.reviewers.map(({ id, role }) => ({ id, role })),
    maxRevisions: plan.request.maxRevisions, now: () => new Date(plan.createdAt),
    review: request => guard(async () => {
      const { signal: _signal, ...context } = request;
      const stage = buildCouncilStage(plan, "review", request.round, snapshot(context));
      const task = ensureStage(ledger, queue, handlers, plan, stage, options);
      if (PENDING.has(task.state)) { pending.set(task.taskId, task.state); throw new PendingStage(); }
      if (task.state !== "completed") {
        const outcome = task.result?.reviewOutcome;
        if (outcome && typeof outcome === "object" && !Array.isArray(outcome)) {
          if (outcome.status === "missing") return null;
          if (outcome.status === "malformed") return { malformedCachedReview: true };
        }
        throw new StageFailure(`Required reviewer task ended ${task.state}`);
      }
      const result = completedResult(task, stage);
      keys(result.reviewOutcome, ["reviewerId", "status", "issues", "review"], ["reviewerId", "status", "issues", "review"]);
      if (result.reviewOutcome.status !== "valid" || result.reviewOutcome.reviewerId !== request.reviewer.id) throw new Error("Cached reviewer identity is invalid");
      return result.reviewOutcome.review;
    }),
    ...(plan.request.reviser ? { revise: request => guard(async () => {
      if (pending.size) throw new PendingStage();
      if (infrastructureError) throw infrastructureError;
      if (request.completedRounds.some(round => round.reviews.some(review => review.status !== "valid"))) {
        throw new StageFailure("Cannot revise from missing, malformed or failed required reviewers");
      }
      const { signal: _signal, ...context } = request;
      const round = request.completedRounds.length - 1;
      const stage = buildCouncilStage(plan, "revision", round, snapshot(context));
      const task = ensureStage(ledger, queue, handlers, plan, stage, options);
      if (PENDING.has(task.state)) { pending.set(task.taskId, task.state); throw new PendingStage(); }
      if (task.state !== "completed") throw new StageFailure(`Required reviser task ended ${task.state}`);
      const result = completedResult(task, stage);
      if (typeof result.proposal !== "string" || !result.proposal.trim()) throw new Error("Revision did not return proposal text");
      const { digest: _digest, ...input } = request.packet;
      return { ...input, proposal: result.proposal, revision: input.revision + 1 };
    }) } : {}) });
  if (infrastructureError) throw infrastructureError;
  if (pending.size) return { status: "pending", planObservationId, tasks: [...pending].map(([taskId, state]) => ({ taskId, state })) };

  decision.limitations.push("This durable council reuses archived evidence and completed stage outputs. Revisions change proposal text only; they cannot establish missing experiments, source truth or scientific quality.");
  const resultObservationId = `council-result:${hash(plan.planDigest)}`;
  const payload: JsonObject = { schemaVersion: 1, kind: RESULT_SOURCE, planObservationId, planDigest: plan.planDigest,
    decision: decision as unknown as JsonObject, decisionDigest: hash(decision) };
  const existing = ledger.getObservation(resultObservationId);
  if (existing) {
    const saved = verified(existing, RESULT_SOURCE, plan.request.projectId);
    if (encode(saved.payload) !== encode(payload)) throw new Error("Archived final council result differs from replayed evidence");
  } else {
    ledger.appendObservation({ eventId: resultObservationId, projectId: plan.request.projectId, source: RESULT_SOURCE,
      runId: null, actionId: null, jobId: null, sequence: decision.rounds.length, observedAt: clock(options), payload });
  }
  return { status: "complete", planObservationId, resultObservationId, decision: freezeSnapshot(decision) as CouncilResult };
}

/** Progress one campaign through independent reviews and bounded revision rounds.
 * At most maximumTasks handlers run; unavailable/uncertain work returns pending.
 * Task-ID filtering prevents this command from spending allowance on other campaigns.
 */
export async function runCouncilCampaign(ledger: ExperimentLedger, queue: TaskQueue,
  handlers: readonly ResearchTaskHandler[], planObservationId: string, maximumTasks: number,
  options: Omit<RunnerOptions, "taskIds">): Promise<{ progress: CouncilProgress; executed: { taskId: string; state: TaskState }[] }> {
  integer(maximumTasks, 1); if (maximumTasks > 1000) throw new Error("At most 1,000 tasks may run per command");
  const fixedOptions = { ...options }, fixedHandlers = [...handlers];
  const executed: { taskId: string; state: TaskState }[] = [];
  const archiveOptions = fixedOptions.now ? { now: fixedOptions.now } : {};
  let progress = await advanceCouncilCampaign(ledger, queue, fixedHandlers, planObservationId, archiveOptions);
  for (let count = 0; count < maximumTasks && progress.status === "pending" && !fixedOptions.signal?.aborted; count++) {
    const result = await runNextResearchTask(queue, fixedHandlers, { ...fixedOptions, taskIds: progress.tasks.map(task => task.taskId) });
    if (!result) {
      // Claim can expire selected tasks without invoking a handler. Reconcile that
      // terminal state now rather than returning the pre-claim pending snapshot.
      progress = await advanceCouncilCampaign(ledger, queue, fixedHandlers, planObservationId, archiveOptions);
      break;
    }
    executed.push({ taskId: result.taskId, state: result.state });
    progress = await advanceCouncilCampaign(ledger, queue, fixedHandlers, planObservationId, archiveOptions);
  }
  return { progress, executed };
}
