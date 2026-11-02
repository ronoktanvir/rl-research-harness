import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openTaskQueue } from "../../src/scheduler/index.ts";
import { runNextResearchTask } from "../../src/scheduler/runner.ts";
import type { RunnerOptions } from "../../src/scheduler/runner.ts";
import type { HandlerOutcome, ResearchTaskHandler } from "../../src/scheduler/handlers.ts";
import { authority, clock, initialize, task } from "./queue-helpers.ts";

test("caller option mutation cannot redirect cancellation cleanup to a different signal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runner-option-review-"));
  const queue = openTaskQueue({ path: join(directory, "queue.sqlite"), authority, now: clock });
  let finish!: (outcome: HandlerOutcome) => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const first = new AbortController(), second = new AbortController();
  const handler: ResearchTaskHandler = {
    policy: { kind: "review", version: "1", replay: "never", callUnits: 1, resourceKey: "codex:default" },
    validate() {}, execute: async () => { started(); return new Promise<HandlerOutcome>(resolve => { finish = resolve; }); },
  };
  try {
    initialize(queue); queue.enqueue(task());
    const options: RunnerOptions = { workerId: "worker", signal: first.signal, now: clock };
    const pending = runNextResearchTask(queue, [handler], options);
    await entered;
    assert.equal(getEventListeners(first.signal, "abort").length, 1);
    options.signal = second.signal;
    finish({ status: "completed", result: { fixture: true } });
    assert.equal((await pending)?.state, "completed");
    assert.equal(getEventListeners(first.signal, "abort").length, 0);
    assert.equal(getEventListeners(second.signal, "abort").length, 0);
  } finally { queue.close(); await rm(directory, { recursive: true, force: true }); }
});
