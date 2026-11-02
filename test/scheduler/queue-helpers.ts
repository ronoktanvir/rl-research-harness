import type { EnqueueTaskInput, QueueAuthority, TaskQueue } from "../../src/scheduler/types.ts";
export const clock = () => new Date("2026-11-02T12:00:00.000Z");
export const authority = (): QueueAuthority => ({ globalEpoch: 1, projectEpoch: null, stopped: false });
export function initialize(queue: TaskQueue): void {
  queue.registerHandler({ kind: "review", version: "1", replay: "never", callUnits: 1, resourceKey: "codex:default" });
  queue.registerHandler({ kind: "capture", version: "1", replay: "reconcile_safe", callUnits: 0, resourceKey: null });
  for (const scopeId of ["global", "project:study"]) queue.configureBudget({ scopeId, expectedVersion: 0, maxCalls: 5, maxParallel: 2 });
}
export function task(taskId = "task-one", kind = "review"): EnqueueTaskInput {
  return { taskId, projectId: "study", kind, handlerVersion: "1", input: { evidence: "synthetic-only" }, dependencies: [], maxAttempts: 3, notBefore: clock().toISOString(), deadlineAt: "2026-11-02T13:00:00.000Z" };
}
