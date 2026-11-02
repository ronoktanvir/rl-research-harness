import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openTaskQueue } from "../../src/scheduler/index.ts";
import type { EnqueueTaskInput, QueueAuthority, TaskClaim, TaskQueue } from "../../src/scheduler/types.ts";

const start = Date.parse("2026-11-02T12:00:00.000Z");
const proof = { fixture: "injected test evidence; no external client was invoked" };
function task(taskId: string, overrides: Partial<EnqueueTaskInput> = {}): EnqueueTaskInput {
  return { taskId, projectId: "study", kind: "review", handlerVersion: "v1", input: { backend: "fixture", packet: "frozen-packet" },
    dependencies: [], maxAttempts: 3, deadlineAt: new Date(start + 60_000).toISOString(), notBefore: new Date(start).toISOString(), ...overrides };
}
function initialize(queue: TaskQueue, maxCalls = 3, maxParallel = 1): void {
  queue.registerHandler({ kind: "review", version: "v1", replay: "never", callUnits: 1, resourceKey: "fixture-account" });
  queue.registerHandler({ kind: "capture", version: "v1", replay: "reconcile_safe", callUnits: 0, resourceKey: null });
  for (const scopeId of ["global", "project:study"]) queue.configureBudget({ scopeId, expectedVersion: 0, maxCalls, maxParallel });
}
function finish(queue: TaskQueue, claim: TaskClaim, status: "completed" | "waiting_quota" | "uncertain" | "rejected" = "completed"): void {
  queue.recordOutcome({ resultId: `result:${claim.attemptId}`, taskId: claim.task.taskId, attemptId: claim.attemptId, status,
    result: proof, ...(status === "waiting_quota" ? { retryAt: null } : {}) });
}
async function withQueue(body: (queue: TaskQueue, controls: { advance: (ms: number) => void; authority: QueueAuthority; setAuthorityFailure: (fail: boolean) => void }) => void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "queue-adversarial-"));
  let milliseconds = start;
  let failAuthority = false;
  const authority = { globalEpoch: 1, projectEpoch: 1, stopped: false };
  const queue = openTaskQueue({ path: join(directory, "queue.sqlite"), now: () => new Date(milliseconds),
    authority: () => { if (failAuthority) throw new Error("authority unavailable"); return { ...authority }; } });
  try {
    initialize(queue);
    body(queue, { advance: ms => { milliseconds += ms; }, authority, setAuthorityFailure: fail => { failAuthority = fail; } });
  } finally { queue.close(); await rm(directory, { recursive: true, force: true }); }
}

test("task and handler identities cannot be weakened by retries or caller mutation", async () => {
  await withQueue(queue => {
    const input = task("immutable");
    let reads = 0;
    Object.defineProperty(input.input, "packet", { enumerable: true, get: () => ++reads === 1 ? "first-packet" : "changed-packet" });
    const registered = queue.enqueue(input);
    assert.equal(reads, 1);
    assert.equal(registered.input.packet, "first-packet");
    registered.input.packet = "outside mutation";
    assert.equal(queue.getTask("immutable").input.packet, "first-packet");
    assert.throws(() => queue.enqueue(task("immutable", { maxAttempts: 100 })));
    assert.throws(() => queue.registerHandler({ kind: "review", version: "v1", replay: "reconcile_safe", callUnits: 0, resourceKey: null }));
    assert.equal(queue.getTask("immutable").handler.callUnits, 1);
    assert.equal(queue.getTask("immutable").handler.replay, "never");
  });
});

test("quota without a known reset never wakes itself or refunds consumed attempts", async () => {
  await withQueue((queue, controls) => {
    queue.enqueue(task("quota"));
    const first = queue.claim({ workerId: "worker" });
    assert.ok(first);
    finish(queue, first, "waiting_quota");
    assert.equal(queue.getBudget("global").consumedCalls, 1);
    controls.advance(30_000);
    assert.equal(queue.claim({ workerId: "worker" }), null);
    assert.equal(queue.getTask("quota").state, "waiting_quota");
    queue.resumeTask({ commandId: "explicit-quota-retry", taskId: "quota", evidence: proof, notBefore: new Date(start + 31_000).toISOString() });
    assert.equal(queue.claim({ workerId: "worker" }), null);
    controls.advance(1000);
    assert.equal(queue.claim({ workerId: "worker" }), null);
    const held = queue.getResourceHold("fixture-account");
    assert.ok(held?.held);
    queue.releaseResource({ resourceKey: "fixture-account", expectedVersion: held.version, evidence: proof });
    const second = queue.claim({ workerId: "worker" });
    assert.ok(second);
    assert.notEqual(second.attemptId, first.attemptId);
    assert.equal(second.task.attempts, 2);
    assert.equal(queue.getBudget("global").consumedCalls, 2);
  });
});

test("completed negative scientific reviews unblock aggregation while rejected tasks do not", async () => {
  await withQueue(queue => {
    queue.enqueue(task("review-negative"));
    queue.enqueue(task("aggregate", { kind: "capture", dependencies: ["review-negative"] }));
    const review = queue.claim({ workerId: "worker" });
    assert.equal(review?.task.taskId, "review-negative");
    queue.recordOutcome({ resultId: "negative-assessment", taskId: "review-negative", attemptId: review!.attemptId, status: "completed",
      result: { recommendation: "reject", objection: "Independent evaluation is missing." } });
    const aggregate = queue.claim({ workerId: "worker" });
    assert.equal(aggregate?.task.taskId, "aggregate");
    finish(queue, aggregate!);
    queue.enqueue(task("invalid-review"));
    queue.enqueue(task("blocked-aggregate", { kind: "capture", dependencies: ["invalid-review"] }));
    const invalid = queue.claim({ workerId: "worker" });
    finish(queue, invalid!, "rejected");
    assert.equal(queue.claim({ workerId: "worker" }), null);
  });
});

test("dependencies cannot cross projects, reference missing work, or refer to themselves", async () => {
  await withQueue(queue => {
    queue.enqueue(task("existing"));
    assert.throws(() => queue.enqueue(task("self", { dependencies: ["self"] })));
    assert.throws(() => queue.enqueue(task("missing", { dependencies: ["absent"] })));
    assert.throws(() => queue.enqueue(task("foreign", { projectId: "other", dependencies: ["existing"] })));
    assert.equal(queue.listTasks().length, 1);
  });
});

test("unresolved external attempts retain concurrency slots even after deadline and cancel request", async () => {
  await withQueue((queue, controls) => {
    queue.enqueue(task("external"));
    queue.enqueue(task("local", { kind: "capture" }));
    const first = queue.claim({ workerId: "worker" });
    assert.ok(first);
    finish(queue, first, "uncertain");
    queue.cancelTask({ commandId: "cancel-uncertain", taskId: "external", reason: "Request cancellation; no external confirmation" });
    assert.equal(queue.getTask("external").state, "uncertain");
    assert.equal(queue.getBudget("global").activeAttempts, 1);
    assert.equal(queue.claim({ workerId: "worker" }), null);
    controls.advance(90_000);
    assert.equal(queue.getTask("external").state, "uncertain");
    assert.equal(queue.getBudget("global").activeAttempts, 1);
    assert.throws(() => queue.requeueUncertain({ commandId: "unsafe-retry", taskId: "external", attemptId: first.attemptId,
      evidence: proof, notBefore: new Date(start + 90_000).toISOString() }));
  });
});

test("ledger authority failure rolls back admission and stale claims cannot regain authority", async () => {
  await withQueue((queue, controls) => {
    queue.enqueue(task("authority"));
    controls.setAuthorityFailure(true);
    assert.throws(() => queue.claim({ workerId: "worker" }));
    assert.equal(queue.getBudget("global").consumedCalls, 0);
    assert.equal(queue.getBudget("global").activeAttempts, 0);
    controls.setAuthorityFailure(false);
    const claim = queue.claim({ workerId: "worker" });
    assert.ok(claim);
    assert.equal(queue.isAuthorized(claim), true);
    controls.authority.stopped = true;
    controls.authority.globalEpoch++;
    assert.equal(queue.isAuthorized(claim), false);
    controls.authority.stopped = false;
    controls.authority.globalEpoch++;
    assert.equal(queue.isAuthorized(claim), false);
  });
});

test("shared client-call allowance survives retries while zero-call local work remains possible", async () => {
  await withQueue(queue => {
    queue.configureBudget({ scopeId: "global", expectedVersion: 1, maxCalls: 1, maxParallel: 1 });
    queue.enqueue(task("one-call"));
    queue.enqueue(task("another-call"));
    queue.enqueue(task("no-call", { kind: "capture" }));
    const first = queue.claim({ workerId: "worker" });
    assert.equal(first?.task.taskId, "one-call");
    finish(queue, first!);
    const deterministic = queue.claim({ workerId: "worker" });
    assert.equal(deterministic?.task.taskId, "no-call");
    assert.equal(queue.getBudget("global").consumedCalls, 1);
    finish(queue, deterministic!);
    assert.equal(queue.claim({ workerId: "worker" }), null);
  });
});

test("queue reopen never replays an interrupted external client or resets its allowance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "queue-uncertain-reopen-"));
  const options = { path: join(directory, "queue.sqlite"), now: () => new Date(start),
    authority: () => ({ globalEpoch: 1, projectEpoch: 1, stopped: false }) };
  const first = openTaskQueue(options);
  try {
    initialize(first);
    first.enqueue(task("interrupted"));
    const claim = first.claim({ workerId: "old-worker" });
    assert.ok(claim);
    first.close();
    const reopened = openTaskQueue(options);
    try {
      assert.equal(reopened.getTask("interrupted").state, "uncertain");
      assert.equal(reopened.getBudget("global").consumedCalls, 1);
      assert.equal(reopened.getBudget("global").activeAttempts, 1);
      assert.equal(reopened.isAuthorized(claim), false);
      assert.equal(reopened.claim({ workerId: "new-worker" }), null);
    } finally { reopened.close(); }
  } finally { first.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a quota hold covers every project sharing the account and survives unrelated completion", async () => {
  await withQueue(queue => {
    queue.configureBudget({ scopeId: "project:other", expectedVersion: 0, maxCalls: 3, maxParallel: 1 });
    queue.enqueue(task("limited"));
    queue.enqueue(task("other-project", { projectId: "other" }));
    queue.enqueue(task("local-work", { kind: "capture" }));
    const first = queue.claim({ workerId: "worker" });
    assert.equal(first?.task.taskId, "limited");
    finish(queue, first!, "waiting_quota");
    const local = queue.claim({ workerId: "worker" });
    assert.equal(local?.task.taskId, "local-work");
    finish(queue, local!);
    assert.equal(queue.getResourceHold("fixture-account")?.held, true);
    assert.equal(queue.claim({ workerId: "worker" }), null);
    assert.equal(queue.getBudget("project:other").consumedCalls, 0);
    const hold = queue.getResourceHold("fixture-account")!;
    assert.throws(() => queue.releaseResource({ resourceKey: "fixture-account", expectedVersion: hold.version - 1, evidence: proof }));
    queue.releaseResource({ resourceKey: "fixture-account", expectedVersion: hold.version, evidence: proof });
    const next = queue.claim({ workerId: "worker" });
    assert.equal(next?.task.taskId, "other-project");
    assert.equal(queue.getTask("limited").state, "waiting_quota");
  });
});

test("lowering a call allowance revokes an uninvoked external claim without blocking zero-call work", async () => {
  await withQueue(queue => {
    queue.enqueue(task("claimed-external"));
    const claim = queue.claim({ workerId: "worker" });
    assert.ok(claim);
    assert.equal(queue.isAuthorized(claim), true);
    queue.configureBudget({ scopeId: "global", expectedVersion: 1, maxCalls: 0, maxParallel: 1 });
    assert.equal(queue.isAuthorized(claim), false);
    finish(queue, claim, "rejected");
    queue.enqueue(task("local-after-reduction", { kind: "capture" }));
    const local = queue.claim({ workerId: "worker" });
    assert.equal(local?.task.taskId, "local-after-reduction");
    assert.equal(queue.isAuthorized(local!), true);
  });
});
