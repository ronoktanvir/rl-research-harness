import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { openTaskQueue } from "../../src/scheduler/index.ts";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import type { TaskQueue } from "../../src/scheduler/types.ts";
import { authority, clock, initialize, task } from "./queue-helpers.ts";
async function fixture(fn: (queue: TaskQueue, path: string) => void | Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "task-queue-")), path = join(directory, "queue.sqlite");
  const queue = openTaskQueue({ path, authority, now: clock });
  try { initialize(queue); await fn(queue, path); } finally { queue.close(); await rm(directory, { recursive: true, force: true }); }
}

test("task identity and completed result survive reopen without another call", async () => {
  await fixture((queue, path) => {
    queue.enqueue(task()); const claim = queue.claim({ workerId: "worker" })!;
    const result = { resultId: "result-one", taskId: claim.task.taskId, attemptId: claim.attemptId, status: "completed" as const, result: { answer: "synthetic" } };
    queue.recordOutcome(result); queue.close();
    const reopened = openTaskQueue({ path, authority, now: clock });
    try {
      assert.equal(reopened.enqueue(task()).state, "completed");
      assert.deepEqual(reopened.recordOutcome(result).result, { answer: "synthetic" });
      assert.equal(reopened.getBudget("global").consumedCalls, 1);
      assert.equal(reopened.claim({ workerId: "worker" }), null);
      assert.throws(() => reopened.enqueue({ ...task(), maxAttempts: 4 }), /different content/);
      assert.throws(() => reopened.recordOutcome({ ...result, result: { answer: "changed" } }), /different content/);
    } finally { reopened.close(); }
  });
});

test("only durable completed dependencies unblock children", async () => {
  await fixture(queue => {
    queue.enqueue(task("parent")); queue.enqueue({ ...task("child", "capture"), dependencies: ["parent"] });
    const parent = queue.claim({ workerId: "worker" })!;
    assert.equal(parent.task.taskId, "parent"); assert.equal(queue.claim({ workerId: "worker" }), null);
    queue.recordOutcome({ resultId: "rejected-parent", taskId: "parent", attemptId: parent.attemptId, status: "rejected", result: { malformed: true } });
    assert.equal(queue.claim({ workerId: "worker" }), null);
    queue.enqueue(task("good-parent")); queue.enqueue({ ...task("good-child", "capture"), dependencies: ["good-parent"] });
    const good = queue.claim({ workerId: "worker" })!;
    queue.recordOutcome({ resultId: "complete-parent", taskId: "good-parent", attemptId: good.attemptId, status: "completed", result: {} });
    assert.equal(queue.claim({ workerId: "worker" })?.task.taskId, "good-child");
    assert.throws(() => queue.enqueue({ ...task("self"), dependencies: ["self"] }), /itself/);
    assert.throws(() => queue.enqueue({ ...task("missing-child"), dependencies: ["future-task"] }), /missing/);
  });
});

test("claim failure rolls back attempt counters and events together", async () => {
  await fixture((queue, path) => {
    queue.enqueue(task()); const raw = new DatabaseSync(path);
    try {
      raw.exec("CREATE TRIGGER fail_claim BEFORE INSERT ON queue_events WHEN NEW.kind='task_claimed' BEGIN SELECT RAISE(ABORT,'injected claim failure'); END");
      assert.throws(() => queue.claim({ workerId: "worker" }), /injected claim failure/);
      assert.equal(queue.getTask("task-one").state, "queued"); assert.equal(queue.attempts("task-one").length, 0);
      assert.equal(queue.getBudget("global").consumedCalls, 0); assert.equal(queue.getBudget("global").activeAttempts, 0);
      raw.exec("DROP TRIGGER fail_claim"); assert.equal(queue.claim({ workerId: "worker" })?.task.attempts, 1);
    } finally { raw.close(); }
  });
});

test("concurrent callers share invocation and parallel caps", async () => {
  await fixture(async queue => {
    for (let i = 0; i < 6; i++) queue.enqueue(task(`task-${i}`));
    const claims = await Promise.all(Array.from({ length: 6 }, (_, i) => Promise.resolve().then(() => queue.claim({ workerId: `worker-${i}` }))));
    assert.equal(claims.filter(Boolean).length, 2); assert.equal(queue.getBudget("global").consumedCalls, 2);
    const one = claims.find(Boolean)!;
    queue.recordOutcome({ resultId: "failed-one", taskId: one.task.taskId, attemptId: one.attemptId, status: "failed", result: { explicitFailure: true } });
    assert.ok(queue.claim({ workerId: "another" })); assert.equal(queue.getBudget("global").consumedCalls, 3);
  });
});

test("unknown model calls remain held and occupy a slot through restart", async () => {
  await fixture((queue, path) => {
    queue.enqueue(task()); const claim = queue.claim({ workerId: "worker" })!; queue.close();
    const reopened = openTaskQueue({ path, authority, now: clock });
    try {
      assert.equal(reopened.getTask("task-one").state, "uncertain"); assert.equal(reopened.getBudget("global").activeAttempts, 1); assert.equal(reopened.getBudget("global").consumedCalls, 1);
      assert.equal(reopened.claim({ workerId: "worker" }), null);
      assert.throws(() => reopened.requeueUncertain({ commandId: "unsafe-replay", taskId: "task-one", attemptId: claim.attemptId, notBefore: clock().toISOString(), evidence: { assertion: "try again" } }), /does not permit/);
      reopened.cancelTask({ commandId: "cancel", taskId: "task-one", reason: "request cancellation" });
      assert.equal(reopened.getTask("task-one").state, "uncertain"); assert.equal(reopened.getBudget("global").activeAttempts, 1);
    } finally { reopened.close(); }
  });
});

test("safe observation replay requires explicit reconciliation and preserves attempt limits", async () => {
  await fixture((queue, path) => {
    queue.enqueue({ ...task("observe", "capture"), maxAttempts: 2 }); const claim = queue.claim({ workerId: "worker" })!; queue.close();
    const reopened = openTaskQueue({ path, authority, now: clock });
    try {
      const command = { commandId: "reconcile", taskId: "observe", attemptId: claim.attemptId, notBefore: clock().toISOString(), evidence: { capture: "stable capture ID found or absent; reader is idempotent" } };
      reopened.requeueUncertain(command); reopened.requeueUncertain(command);
      const next = reopened.claim({ workerId: "worker" })!; assert.equal(next.task.attempts, 2); assert.notEqual(next.attemptId, claim.attemptId);
      assert.equal(reopened.attempts("observe")[0]!.status, "reconciled");
      reopened.recordOutcome({ resultId: "uncertain-again", taskId: "observe", attemptId: next.attemptId, status: "uncertain", result: {} });
      assert.throws(() => reopened.requeueUncertain({ ...command, commandId: "third-attempt", attemptId: next.attemptId }), /attempt limit/);
      assert.equal(reopened.getBudget("global").consumedCalls, 0);
      assert.throws(() => reopened.recordOutcome({ resultId: "stale-result", taskId: "observe", attemptId: claim.attemptId, status: "completed", result: {} }), /current active/);
    } finally { reopened.close(); }
  });
});

test("quota hold persists across projects and needs explicit resource and task release", async () => {
  await fixture((queue, path) => {
    queue.configureBudget({ scopeId: "project:other", expectedVersion: 0, maxCalls: 5, maxParallel: 2 });
    queue.enqueue(task()); const claim = queue.claim({ workerId: "worker" })!;
    queue.recordOutcome({ resultId: "quota", taskId: "task-one", attemptId: claim.attemptId, status: "waiting_quota", result: { clientStatus: "rate_limited", reset: "unknown" }, retryAt: null });
    queue.enqueue({ ...task("sibling"), projectId: "other" }); queue.enqueue(task("local", "capture")); queue.close();
    const reopened = openTaskQueue({ path, authority, now: clock });
    try {
      assert.equal(reopened.getResourceHold("codex:default")?.held, true);
      assert.equal(reopened.claim({ workerId: "worker" })?.task.taskId, "local"); assert.equal(reopened.claim({ workerId: "worker" }), null);
      reopened.resumeTask({ commandId: "resume-task", taskId: "task-one", notBefore: clock().toISOString(), evidence: { operator: "explicit release requested" } });
      assert.equal(reopened.claim({ workerId: "worker" }), null);
      const hold = reopened.getResourceHold("codex:default")!;
      reopened.releaseResource({ resourceKey: hold.resourceKey, expectedVersion: hold.version, evidence: { operator: "account availability independently checked" } });
      assert.equal(reopened.claim({ workerId: "worker" })?.task.taskId, "task-one");
      assert.equal(reopened.getBudget("global").consumedCalls, 2);
    } finally { reopened.close(); }
  });
});

test("a known quota reset cannot be cleared by an earlier scheduled release", async () => {
  await fixture(queue => {
    queue.enqueue(task()); const claim = queue.claim({ workerId: "worker" })!, retryAt = "2026-11-02T12:30:00.000Z";
    queue.recordOutcome({ resultId: "known-reset", taskId: "task-one", attemptId: claim.attemptId, status: "waiting_quota", result: { resetSource: "synthetic authoritative field" }, retryAt });
    const hold = queue.getResourceHold("codex:default")!;
    assert.throws(() => queue.releaseResource({ resourceKey: hold.resourceKey, expectedVersion: hold.version, evidence: { operator: "request" } }), /cannot precede/);
    queue.releaseResource({ resourceKey: hold.resourceKey, expectedVersion: hold.version, notBefore: retryAt, evidence: { resetSource: "synthetic authoritative field" } });
    queue.enqueue(task("sibling")); assert.equal(queue.claim({ workerId: "worker" }), null);
    assert.throws(() => queue.resumeTask({ commandId: "too-early", taskId: "task-one", notBefore: clock().toISOString(), evidence: { operator: "request" } }), /cannot precede/);
  });
});

test("ledger authority changes invalidate claims without a second queue stop switch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "queue-authority-")), path = join(directory, "queue.sqlite");
  const ledger = openExperimentLedger({ path: join(directory, "ledger.sqlite"), now: clock });
  const readAuthority = () => { const global = ledger.getScope("global"); return { globalEpoch: global.epoch, projectEpoch: null, stopped: global.stopped }; };
  const queue = openTaskQueue({ path, authority: readAuthority, now: clock });
  try {
    initialize(queue); queue.enqueue(task()); const claim = queue.claim({ workerId: "worker" })!; assert.equal(queue.isAuthorized(claim), true);
    const stopped = ledger.stopScope({ scopeId: "global", expectedEpoch: ledger.getScope("global").epoch, reason: "test" });
    assert.equal(queue.isAuthorized(claim), false);
    ledger.resumeScope({ scopeId: "global", expectedEpoch: stopped.epoch, reason: "explicit resume" }); assert.equal(queue.isAuthorized(claim), false);
    queue.enqueue(task("second")); assert.ok(queue.claim({ workerId: "worker" }));
  } finally { queue.close(); ledger.close(); await rm(directory, { recursive: true, force: true }); }
});

test("queue never initializes its schema in the experiment ledger or a foreign store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "queue-identity-")), path = join(directory, "ledger.sqlite");
  try {
    const ledger = openExperimentLedger({ path, now: clock }); ledger.close(); const before = await readFile(path);
    assert.throws(() => openTaskQueue({ path, authority, now: clock }), /not a research task queue/); assert.deepEqual(await readFile(path), before);
    const queuePath = join(directory, "queue.sqlite"), queue = openTaskQueue({ path: queuePath, authority, now: clock }); queue.close();
    assert.throws(() => openExperimentLedger({ path: queuePath }), /not an experiment ledger/);
    const future = new DatabaseSync(queuePath); future.exec("UPDATE task_queue_meta SET value='999' WHERE key='schema_version'"); future.close();
    const futureBefore = await readFile(queuePath); assert.throws(() => openTaskQueue({ path: queuePath, authority }), /Unsupported task queue/); assert.deepEqual(await readFile(queuePath), futureBefore);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function crashWorker(path: string, phase: string): Promise<ReturnType<typeof spawn>> {
  const child = spawn(process.execPath, ["--import", "tsx", resolve("test/scheduler/fixtures/queue-worker.ts"), path, phase], { stdio: ["ignore", "pipe", "pipe"] });
  let errorText = ""; child.stderr!.on("data", data => { errorText += String(data); });
  await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Fixture timeout: ${errorText}`)); }, 10_000);
    child.stdout!.on("data", data => { if (String(data).includes("ready")) { clearTimeout(timer); resolveReady(); } });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${errorText}`)); });
  }); return child;
}

test("process death distinguishes queued, uncommitted claim and committed uncertain attempt", async t => {
  for (const phase of ["queued", "before-claim-commit", "running"]) await t.test(phase, async () => {
    const directory = await mkdtemp(join(tmpdir(), "queue-crash-")), path = join(directory, "queue.sqlite"); let child: ReturnType<typeof spawn> | undefined;
    try {
      child = await crashWorker(path, phase); assert.throws(() => openTaskQueue({ path, authority }), /owns this queue/);
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      const queue = openTaskQueue({ path, authority, now: clock });
      try {
        assert.equal(queue.getTask("task-one").state, phase === "running" ? "uncertain" : "queued");
        assert.equal(queue.getBudget("global").consumedCalls, phase === "running" ? 1 : 0);
        assert.equal(queue.getBudget("global").activeAttempts, phase === "running" ? 1 : 0);
      } finally { queue.close(); }
    } finally { if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await rm(directory, { recursive: true, force: true }); }
  });
});
