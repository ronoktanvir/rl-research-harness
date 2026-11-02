import { LedgerError } from "../ledger/index.ts";
import type { ExperimentLedger } from "../ledger/types.ts";
import { encode, enumValue, jsonObject, keys, timestamp } from "../ledger/validation.ts";
import type { HandlerOutcome, ResearchTaskHandler } from "./handlers.ts";
import type { EnqueueTaskInput, QueueAuthority, TaskClaim, TaskQueue, TaskRecord } from "./types.ts";

/** The queue consults this function; it never maintains a competing global stop flag. */
export function ledgerAuthority(ledger: ExperimentLedger, projectId: string): QueueAuthority {
  const global = ledger.getScope("global");
  let project;
  try { project = ledger.getScope(`project:${projectId}`); }
  catch (error) { if (!(error instanceof LedgerError && error.code === "missing")) throw error; }
  return { globalEpoch: global.epoch, projectEpoch: project?.epoch ?? null,
    stopped: global.stopped || (project?.stopped ?? false) };
}

export function registerResearchHandlers(queue: TaskQueue, handlers: readonly ResearchTaskHandler[]): void {
  const kinds = new Set<string>();
  for (const handler of handlers) {
    if (kinds.has(handler.policy.kind)) throw new Error("Handler kinds must be unique");
    kinds.add(handler.policy.kind);
    queue.registerHandler(handler.policy);
  }
}

/** Validate through the actual handler before reserving any invocation opportunity. */
export function enqueueResearchTask(queue: TaskQueue, handlers: readonly ResearchTaskHandler[], raw: EnqueueTaskInput): TaskRecord {
  const input = structuredClone(raw);
  const handler = handlers.find(item => item.policy.kind === input.kind && item.policy.version === input.handlerVersion);
  if (!handler) throw new Error("No matching installed handler version");
  handler.validate(input.input, input.projectId);
  return queue.enqueue(input);
}

export interface RunnerOptions {
  workerId: string;
  /** Optional exact task selection; admission and shared caps still apply. */
  taskIds?: string[];
  signal?: AbortSignal;
  maxExecutionMs?: number;
  cleanupGraceMs?: number;
  authorityCheckMs?: number;
  now?: () => Date;
}

function milliseconds(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new RangeError(`Duration must be 1–${maximum} milliseconds`);
  return result;
}

function detach<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item && typeof item === "object") { for (const child of Object.values(item)) freeze(child); Object.freeze(item); }
  };
  freeze(copy);
  return copy;
}

const interrupted = (reason: string): HandlerOutcome => ({ status: "uncertain", result: { reason, completionConfirmed: false } });

function validatedOutcome(raw: unknown): HandlerOutcome {
  const value: unknown = structuredClone(raw);
  keys(value, ["status", "result", "retryAt"], ["status", "result"]);
  enumValue(value.status, ["completed", "rejected", "failed", "cancelled", "waiting_quota", "waiting_auth", "uncertain"]);
  jsonObject(value.result);
  if (value.retryAt !== undefined && value.retryAt !== null) timestamp(value.retryAt);
  return { status: value.status, result: value.result,
    ...(value.retryAt !== undefined ? { retryAt: value.retryAt as string | null } : {}) };
}

/** Bound the wait and request cancellation, without claiming an unresponsive callback stopped. */
async function invoke(queue: TaskQueue, handler: ResearchTaskHandler, claim: TaskClaim, signal: AbortSignal | undefined,
  executionMs: number, graceMs: number, pollMs: number): Promise<HandlerOutcome> {
  const child = new AbortController();
  let finished = false;
  let stopping = false;
  let entered = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (value: HandlerOutcome) => void;
  const completion = new Promise<HandlerOutcome>(done => { resolve = value => {
    if (!finished) { finished = true; done(value); }
  }; });
  const stop = (reason: string): void => {
    if (finished || stopping) return;
    stopping = true;
    child.abort();
    if (!entered) resolve({ status: "cancelled", result: { reason, invocationStarted: false } });
    else grace = setTimeout(() => resolve(interrupted(reason)), graceMs);
  };
  const cancelled = () => stop("controller_cancelled");
  const timer = setTimeout(() => stop("task_execution_deadline"), executionMs);
  const authority = setInterval(() => {
    try { if (!queue.isAuthorized(claim)) stop("authority_revoked_or_task_cancelled"); }
    catch { stop("authority_check_failed"); }
  }, pollMs);
  signal?.addEventListener("abort", cancelled, { once: true });
  try {
    if (signal?.aborted) cancelled();
    Promise.resolve().then(async () => {
      if (stopping || finished) return;
      if (!queue.isAuthorized(claim)) { stop("authority_revoked_before_invocation"); return; }
      entered = true;
      try { resolve(validatedOutcome(await handler.execute(detach(claim), child.signal))); }
      catch { resolve(interrupted("handler_exception")); }
    }).catch(() => resolve(interrupted("handler_boundary_failed")));
    return await completion;
  } finally {
    clearTimeout(timer); clearInterval(authority); if (grace) clearTimeout(grace);
    signal?.removeEventListener("abort", cancelled);
  }
}

/** Execute at most one claimed task. An uncertain outcome keeps its consumed allowance
 * and concurrency slot; neither this function nor a restart repeats it automatically.
 */
export async function runNextResearchTask(queue: TaskQueue, handlers: readonly ResearchTaskHandler[],
  options: RunnerOptions): Promise<TaskRecord | null> {
  const workerId = options.workerId, signal = options.signal;
  const taskIds = options.taskIds === undefined ? undefined : structuredClone(options.taskIds);
  const executionLimit = milliseconds(options.maxExecutionMs, 180_000, 3_600_000);
  const grace = milliseconds(options.cleanupGraceMs, 2_000, 30_000);
  const poll = milliseconds(options.authorityCheckMs, 100, 5_000);
  const now = (options.now ?? (() => new Date()))();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Invalid runner clock");
  if (signal?.aborted) return null;
  const claim = queue.claim({ workerId, kinds: handlers.map(handler => handler.policy.kind),
    ...(taskIds !== undefined ? { taskIds } : {}) });
  if (!claim) return null;
  const handler = handlers.find(item => item.policy.kind === claim.task.kind && item.policy.version === claim.task.handlerVersion);
  let outcome: HandlerOutcome;
  try {
    if (!handler || encode(handler.policy) !== encode(claim.task.handler)) throw new Error("Handler policy changed");
    handler.validate(claim.task.input, claim.task.projectId);
  } catch {
    outcome = { status: "rejected", result: { reason: "invalid_task_contract", invocationStarted: false } };
    return queue.recordOutcome({ resultId: `result:${claim.attemptId}`, taskId: claim.task.taskId, attemptId: claim.attemptId, ...outcome });
  }
  const remaining = Date.parse(claim.task.deadlineAt) - now.getTime();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    outcome = { status: "cancelled", result: { reason: "deadline_before_invocation", invocationStarted: false } };
  } else {
    outcome = await invoke(queue, handler!, claim, signal, Math.min(executionLimit, remaining), grace, poll);
  }
  const receipt = { resultId: `result:${claim.attemptId}`, taskId: claim.task.taskId, attemptId: claim.attemptId };
  try { return queue.recordOutcome({ ...receipt, ...outcome }); }
  catch (error) {
    // A malformed handler return cannot leave the attempt looking available for retry.
    // If persistence itself failed, this second write also fails and crash recovery retains uncertainty.
    if (queue.getTask(claim.task.taskId).state !== "running") throw error;
    return queue.recordOutcome({ ...receipt, ...interrupted("handler_outcome_not_persistable") });
  }
}
