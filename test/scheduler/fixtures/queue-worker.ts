import { DatabaseSync } from "node:sqlite";
import { openTaskQueue } from "../../../src/scheduler/index.ts";
import { authority, clock, initialize, task } from "../queue-helpers.ts";
const [path, phase] = process.argv.slice(2);
if (!path) throw new Error("path required");
const queue = openTaskQueue({ path, authority, now: clock }); initialize(queue); queue.enqueue(task());
if (phase === "before-claim-commit") {
  const original = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql: string): void {
    if (sql === "COMMIT") { process.stdout.write("ready\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
    original.call(this, sql);
  };
}
if (phase !== "queued") queue.claim({ workerId: "fixture-worker" });
process.stdout.write("ready\n"); setInterval(() => {}, 1000);
