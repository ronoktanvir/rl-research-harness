import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fail } from "./validation.js";
const schema = `
CREATE TABLE IF NOT EXISTS task_queue_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
INSERT OR IGNORE INTO task_queue_meta VALUES('identity','research-task-queue'),('schema_version','1');
CREATE TABLE IF NOT EXISTS handlers(kind TEXT NOT NULL,version TEXT NOT NULL,data TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(kind,version)) STRICT;
CREATE TABLE IF NOT EXISTS budgets(scope TEXT PRIMARY KEY,version INTEGER NOT NULL,max_calls INTEGER NOT NULL,max_parallel INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,project TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,current_attempt TEXT,result TEXT,waiting_until TEXT,not_before TEXT NOT NULL,cancel_requested INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE IF NOT EXISTS dependencies(task_id TEXT NOT NULL REFERENCES tasks(id),dependency_id TEXT NOT NULL REFERENCES tasks(id),PRIMARY KEY(task_id,dependency_id)) STRICT;
CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),number INTEGER NOT NULL,call_units INTEGER NOT NULL,state TEXT NOT NULL,claim TEXT NOT NULL,result TEXT,UNIQUE(task_id,number)) STRICT;
CREATE TABLE IF NOT EXISTS results(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),attempt_id TEXT NOT NULL REFERENCES attempts(id),data TEXT NOT NULL,digest TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,data TEXT NOT NULL,digest TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS resource_holds(resource TEXT PRIMARY KEY,version INTEGER NOT NULL,held INTEGER NOT NULL,reason TEXT,retry_at TEXT,not_before TEXT) STRICT;
CREATE TABLE IF NOT EXISTS queue_events(sequence INTEGER PRIMARY KEY,kind TEXT NOT NULL,task_id TEXT,data TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
`;
/** Same OS-lock pattern as the ledger, with a disjoint schema identity. Never delete the owner file. */
export function openQueueDatabase(input: string): { db: DatabaseSync; close(): void } {
  if (typeof input !== "string" || !input.trim() || input === ":memory:" || input.includes("\0")) fail("invalid", "Persistent local queue path required");
  const absolute = resolve(input); mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const path = join(realpathSync(dirname(absolute)), basename(absolute)), ownerPath = `${path}.owner.sqlite`;
  for (const file of [path, ownerPath]) if (existsSync(file)) { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("invalid", "Queue files must be regular and unaliased"); }
  let owner: DatabaseSync | undefined, db: DatabaseSync | undefined;
  try {
    owner = new DatabaseSync(ownerPath, { timeout: 0 });
    try { owner.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE"); } catch { fail("owned", "Another controller owns this queue or the lock is unavailable"); }
    db = new DatabaseSync(path, { timeout: 0, enableForeignKeyConstraints: true, defensive: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if (tables.length) {
      if (!tables.some(table => table.name === "task_queue_meta")) fail("invalid", "Database is not a research task queue");
      if (db.prepare("SELECT value FROM task_queue_meta WHERE key='identity'").get()?.value !== "research-task-queue" || db.prepare("SELECT value FROM task_queue_meta WHERE key='schema_version'").get()?.value !== "1") fail("invalid", "Unsupported task queue identity or schema");
    }
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
    db.exec(`BEGIN IMMEDIATE; ${schema} COMMIT;`);
    const main = db, lock = owner; let closed = false;
    return { db: main, close() { if (!closed) { main.close(); lock.close(); closed = true; } } };
  } catch (error) { try { db?.close(); } finally { owner?.close(); } throw error; }
}
