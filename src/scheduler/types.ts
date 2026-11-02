import type { JsonObject } from "../ledger/types.js";
export type { JsonObject } from "../ledger/types.js";
export type TaskState = "queued" | "running" | "waiting_quota" | "waiting_auth" | "uncertain" | "completed" | "rejected" | "failed" | "cancelled" | "expired";
export interface HandlerPolicy { kind: string; version: string; replay: "never" | "reconcile_safe"; callUnits: number; resourceKey: string | null }
export interface EnqueueTaskInput {
  taskId: string; projectId: string; kind: string; handlerVersion: string; input: JsonObject;
  dependencies: string[]; maxAttempts: number; deadlineAt: string; notBefore: string;
}
export interface TaskRecord extends EnqueueTaskInput {
  inputDigest: string; handler: HandlerPolicy; state: TaskState; attempts: number;
  currentAttemptId: string | null; eligibleAt: string; result: JsonObject | null; waitingUntil: string | null; cancelRequested: boolean;
}
/** Derived on demand from the experiment ledger, never stored as a second stop authority. */
export interface QueueAuthority { globalEpoch: number; projectEpoch: number | null; stopped: boolean }
export interface QueueOptions { path: string; authority: (projectId: string) => QueueAuthority; now?: () => Date }
export interface QueueBudgetInput { scopeId: string; expectedVersion: number; maxCalls: number; maxParallel: number }
export interface QueueBudget { scopeId: string; version: number; maxCalls: number; maxParallel: number; consumedCalls: number; activeAttempts: number }
export interface ResourceHold { resourceKey: string; version: number; held: boolean; reason: "quota" | "auth" | null; retryAt: string | null; notBefore: string | null }
export interface ReleaseResourceInput { resourceKey: string; expectedVersion: number; evidence: JsonObject; notBefore?: string }
export interface ClaimTaskInput { workerId: string; kinds?: string[]; taskIds?: string[] }
export interface TaskClaim { task: TaskRecord; attemptId: string; workerId: string; authority: QueueAuthority; claimedAt: string }
export interface TaskOutcomeInput {
  resultId: string; taskId: string; attemptId: string;
  status: "completed" | "rejected" | "failed" | "cancelled" | "waiting_quota" | "waiting_auth" | "uncertain";
  result: JsonObject;
  /** Quota reset is metadata only; resumeTask remains an explicit controller operation. */
  retryAt?: string | null;
}
export interface ResumeTaskInput { commandId: string; taskId: string; evidence: JsonObject; notBefore: string }
export interface RequeueUncertainInput extends ResumeTaskInput { attemptId: string }
export interface CancelTaskInput { commandId: string; taskId: string; reason: string }
export interface QueueEvent { sequence: number; kind: string; taskId: string | null; data: JsonObject; createdAt: string }
export interface TaskAttempt { attemptId: string; taskId: string; number: number; status: TaskState | "reconciled"; claim: TaskClaim; result: JsonObject | null }
/** Trusted local controller API. This store contains no experiment runs or execution money. */
export interface TaskQueue {
  registerHandler(policy: HandlerPolicy): HandlerPolicy;
  configureBudget(input: QueueBudgetInput): QueueBudget;
  getBudget(scopeId: string): QueueBudget;
  getResourceHold(resourceKey: string): ResourceHold | null;
  listResourceHolds(): ResourceHold[];
  releaseResource(input: ReleaseResourceInput): ResourceHold;
  enqueue(input: EnqueueTaskInput): TaskRecord;
  getTask(taskId: string): TaskRecord;
  listTasks(projectId?: string): TaskRecord[];
  claim(input: ClaimTaskInput): TaskClaim | null;
  isAuthorized(claim: TaskClaim): boolean;
  recordOutcome(input: TaskOutcomeInput): TaskRecord;
  resumeTask(input: ResumeTaskInput): TaskRecord;
  requeueUncertain(input: RequeueUncertainInput): TaskRecord;
  cancelTask(input: CancelTaskInput): TaskRecord;
  attempts(taskId: string): TaskAttempt[];
  events(afterSequence?: number): QueueEvent[];
  close(): void;
}
