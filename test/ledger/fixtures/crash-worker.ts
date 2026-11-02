import { DatabaseSync } from "node:sqlite";
import { openExperimentLedger } from "../../../src/ledger/index.ts";
import { admission, deadline, fixedNow, initialize } from "../helpers.ts";
const [path, phase] = process.argv.slice(2);
if (!path || !phase) throw new Error("path and phase required");
const ledger = openExperimentLedger({ path, now: fixedNow });
initialize(ledger);
if (phase === "before-commit") {
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql: string): void {
    if (sql === "COMMIT") {
      process.stdout.write("ready\n");
      // Halt exactly after action/reservation/event/outbox writes, before transaction commit.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    exec.call(this, sql);
  };
}
if (phase !== "owner") ledger.admitAction(admission());
if (phase === "after-claim") ledger.claimDispatch({ workerId: "fixture-worker", deadlineAt: deadline });
process.stdout.write("ready\n");
setInterval(() => {}, 1000);
