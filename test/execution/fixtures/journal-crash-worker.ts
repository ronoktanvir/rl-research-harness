import { DatabaseSync } from "node:sqlite";
import { openJobJournal } from "../../../src/execution/journal.ts";
import type { JobDeclaration } from "../../../src/execution/types.ts";
const [path, phase, encoded] = process.argv.slice(2);
if (!path || !phase || !encoded) throw new Error("Journal path, phase and declaration required");
if (!globalThis.gc) throw new Error("Crash fixture requires --expose-gc");
function ready(): void {
  for (let index = 0; index < 3; index++) globalThis.gc!();
  process.stdout.write("ready\n");
}
const journal = openJobJournal({ path, now: () => new Date("2026-11-02T00:00:00.000Z") });
if (phase === "before-commit") {
  const original = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql: string): void {
    if (sql === "COMMIT") {
      ready();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    original.call(this, sql);
  };
}
const declaration = JSON.parse(encoded) as JobDeclaration;
journal.prepareIntent(declaration);
// Retain the owner itself, not just a live event loop, until real process death.
setInterval(() => { journal.read(declaration.jobId); }, 1000);
setImmediate(ready);
