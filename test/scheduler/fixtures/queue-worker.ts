import { DatabaseSync } from "node:sqlite";
import { openTaskQueue } from "../../../src/scheduler/index.ts";
import { authority, clock, initialize, task } from "../queue-helpers.ts";
const [path, phase] = process.argv.slice(2);
if (!path) throw new Error("path required");
if (!globalThis.gc) throw new Error("Crash fixture requires --expose-gc");
function ready(): void {
  for (let index = 0; index < 3; index++) globalThis.gc!();
  process.stdout.write("ready\n");
}
const queue = openTaskQueue({ path, authority, now: clock }); initialize(queue); queue.enqueue(task());
if (phase === "before-claim-commit") {
  const original = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql: string): void {
    if (sql === "COMMIT") { ready(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
    original.call(this, sql);
  };
}
if (phase !== "queued") queue.claim({ workerId: "fixture-worker" });
// Retain the owner itself, not just a live event loop, until real process death.
setInterval(() => { queue.getTask("task-one"); }, 1000);
setImmediate(ready);
