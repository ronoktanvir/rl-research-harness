import { DatabaseSync } from "node:sqlite";
import { openExperimentLedger } from "../../../src/ledger/index.ts";
import { admission, deadline, fixedNow, initialize } from "../helpers.ts";
const [path, phase] = process.argv.slice(2);
if (!path || !phase) throw new Error("path and phase required");
if (!globalThis.gc) throw new Error("Crash fixture requires --expose-gc");
function ready(): void {
  for (let index = 0; index < 3; index++) globalThis.gc!();
  process.stdout.write("ready\n");
}
const ledger = openExperimentLedger({ path, now: fixedNow });
initialize(ledger);
if (phase === "before-commit") {
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql: string): void {
    if (sql === "COMMIT") {
      ready();
      // Halt exactly after action/reservation/event/outbox writes, before transaction commit.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    exec.call(this, sql);
  };
}
if (phase !== "owner") ledger.admitAction(admission());
if (phase === "after-claim") ledger.claimDispatch({ workerId: "fixture-worker", deadlineAt: deadline });
// An empty timer keeps only the process alive: GC may close unreachable SQLite
// connections. Keep the controller reachable until the parent's real SIGKILL.
setInterval(() => { ledger.getScope("global"); }, 1000);
// Collect after the module's synchronous stack has unwound, before the parent
// checks ownership. This reproduces the original fixture's premature release.
setImmediate(ready);
