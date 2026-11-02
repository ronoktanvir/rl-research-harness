import { DatabaseSync } from "node:sqlite";
import { openJobJournal } from "../../../src/execution/journal.ts";
import type { JobDeclaration } from "../../../src/execution/types.ts";
const [path, phase, encoded] = process.argv.slice(2);
if (!path || !phase || !encoded) throw new Error("Journal path, phase and declaration required");
const journal = openJobJournal({ path, now: () => new Date("2026-11-02T00:00:00.000Z") });
if (phase === "before-commit") {
  const original = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql: string): void {
    if (sql === "COMMIT") {
      process.stdout.write("ready\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    original.call(this, sql);
  };
}
journal.prepareIntent(JSON.parse(encoded) as JobDeclaration);
process.stdout.write("ready\n");
setInterval(() => {}, 1000);
