import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fail } from "./validation.js";

const schema = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
INSERT OR IGNORE INTO meta VALUES('schema_version','1');
CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY, kind TEXT NOT NULL, entity TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS manifests(digest TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, project TEXT NOT NULL, manifest TEXT NOT NULL REFERENCES manifests(digest), replica TEXT NOT NULL, data TEXT NOT NULL, digest TEXT NOT NULL, UNIQUE(project,manifest,replica)) STRICT;
CREATE TABLE IF NOT EXISTS scopes(id TEXT PRIMARY KEY, stopped INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '') STRICT;
CREATE TABLE IF NOT EXISTS budgets(id TEXT PRIMARY KEY, parent TEXT REFERENCES budgets(id), revision INTEGER NOT NULL, limit_amount TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS policies(scope TEXT PRIMARY KEY REFERENCES scopes(id), version INTEGER NOT NULL, data TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS validations(id TEXT PRIMARY KEY, manifest TEXT NOT NULL REFERENCES manifests(digest), check_name TEXT NOT NULL, source TEXT NOT NULL, sequence INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, digest TEXT NOT NULL, UNIQUE(manifest,check_name,sequence)) STRICT;
CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), operation TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL, attempt TEXT, job TEXT, finalized INTEGER NOT NULL DEFAULT 0, UNIQUE(run_id,operation,revision)) STRICT;
CREATE TABLE IF NOT EXISTS action_scopes(action_id TEXT NOT NULL REFERENCES actions(id), scope TEXT NOT NULL REFERENCES budgets(id), PRIMARY KEY(action_id,scope)) STRICT;
CREATE TABLE IF NOT EXISTS outbox(action_id TEXT PRIMARY KEY REFERENCES actions(id), state TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES actions(id), data TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES actions(id), data TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS observations(id TEXT PRIMARY KEY, project TEXT NOT NULL, data TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS facts(id TEXT PRIMARY KEY, dimension TEXT NOT NULL, entity TEXT NOT NULL, source TEXT NOT NULL, sequence INTEGER NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, digest TEXT NOT NULL, UNIQUE(dimension,entity,sequence)) STRICT;
CREATE TABLE IF NOT EXISTS charges(id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES actions(id), amount TEXT NOT NULL, data TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS settlements(id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES actions(id), data TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
`;

export interface LedgerDatabase { db: DatabaseSync; close(): void }
/** Lock files must never be unlinked. This boundary requires a service-owned local directory. */
export function openDatabase(inputPath: string): LedgerDatabase {
  if (typeof inputPath !== "string" || !inputPath.trim() || inputPath === ":memory:" || inputPath.includes("\0")) fail("invalid", "A persistent local database path is required");
  const absolute = resolve(inputPath);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const path = join(realpathSync(dirname(absolute)), basename(absolute));
  const ownerPath = `${path}.owner.sqlite`;
  for (const file of [path, ownerPath]) {
    if (existsSync(file)) {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("invalid", "Ledger and owner files must be regular files without aliases or hard links");
    }
  }
  let owner: DatabaseSync | undefined;
  let db: DatabaseSync | undefined;
  try {
    owner = new DatabaseSync(ownerPath, { timeout: 0 });
    try { owner.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE"); }
    catch { fail("owned", "Another controller owns this ledger, or its ownership lock is unavailable"); }
    db = new DatabaseSync(path, { timeout: 0, enableForeignKeyConstraints: true, defensive: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if (tables.length) {
      if (!tables.some(table => table.name === "meta")) fail("invalid", "Database is not an experiment ledger");
      const version = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value;
      if (version !== "1") fail("invalid", "Unsupported ledger schema version");
    }
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    db.exec(`BEGIN IMMEDIATE; ${schema} COMMIT;`);
    const main = db, lock = owner;
    let closed = false;
    return { db: main, close() {
      if (closed) return;
      // A failed main close must not release ownership while it may still be live.
      main.close(); lock.close(); closed = true;
    } };
  } catch (error) { try { db?.close(); } finally { owner?.close(); } throw error; }
}
