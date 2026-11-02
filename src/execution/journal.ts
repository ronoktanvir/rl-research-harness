import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { encode, hash } from "../ledger/validation.ts";
import type { HostIdentity, JobDeclaration, JobJournal, JobObservationInput, JobObservationRecord, JobRecord,
  ServiceQueryResult, ServiceSnapshot, UnitIdentity } from "./types.ts";

export class JobJournalError extends Error {
  constructor(public readonly code: "invalid" | "conflict" | "missing" | "owned" | "closed", message: string) {
    super(message); this.name = "JobJournalError";
  }
}
function fail(code: JobJournalError["code"], message: string): never { throw new JobJournalError(code, message); }

const KIND = "linux-supervisor-job-journal";
const VERSION = "1";
const TABLES = ["journal_meta", "job_intents", "job_observations"];
const SCHEMA = `
CREATE TABLE journal_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
INSERT INTO journal_meta VALUES('journal_kind','${KIND}'),('schema_version','${VERSION}');
CREATE TABLE job_intents(job_id TEXT PRIMARY KEY, action_id TEXT NOT NULL UNIQUE, declaration_digest TEXT NOT NULL,
  declaration TEXT NOT NULL, intent_created_at TEXT NOT NULL) STRICT;
CREATE TABLE job_observations(observation_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES job_intents(job_id),
  ordinal INTEGER NOT NULL UNIQUE, payload TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
CREATE INDEX observations_by_job ON job_observations(job_id, ordinal);
`;

/** Lifetime ownership is local and crash-released by SQLite. The service-owned
 * directory and owner file must not be replaced, unlinked, or shared over a
 * network filesystem. This is not a remote-worker fence or distributed lease. */
function openDatabase(inputPath: string): { db: DatabaseSync; close(): void } {
  if (typeof inputPath !== "string" || !inputPath.trim() || inputPath === ":memory:" || inputPath.includes("\0")) fail("invalid", "A persistent local journal path is required");
  const absolute = resolve(inputPath);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const path = join(realpathSync(dirname(absolute)), basename(absolute));
  const ownerPath = `${path}.owner.sqlite`;
  for (const file of [path, ownerPath]) if (existsSync(file)) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("invalid", "Journal and owner must be regular files without aliases or hard links");
  }
  let owner: DatabaseSync | undefined, db: DatabaseSync | undefined;
  try {
    owner = new DatabaseSync(ownerPath, { timeout: 0 });
    try { owner.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE"); }
    catch { fail("owned", "Another controller owns this journal, or its ownership lock is unavailable"); }
    db = new DatabaseSync(path, { timeout: 0, enableForeignKeyConstraints: true, defensive: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
    // Existing foreign/future stores are rejected before any PRAGMA/schema write.
    if (tables.length) {
      if (!tables.includes("journal_meta")) fail("invalid", "Database is not a supervisor job journal");
      const meta = db.prepare("SELECT value FROM journal_meta WHERE key=?");
      if (meta.get("journal_kind")?.value !== KIND || meta.get("schema_version")?.value !== VERSION) fail("invalid", "Unsupported supervisor journal kind or schema version");
      if (tables.length !== TABLES.length || TABLES.some(table => !tables.includes(table))) fail("invalid", "Supervisor journal schema is incomplete or unsupported");
    }
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    if (!tables.length) db.exec(`BEGIN IMMEDIATE; ${SCHEMA} COMMIT;`);
    const main = db, lock = owner; let closed = false;
    return { db: main, close() {
      if (closed) return;
      // Main close must succeed before the lifetime owner lock is released.
      main.close(); lock.close(); closed = true;
    } };
  } catch (error) { try { db?.close(); } finally { owner?.close(); } throw error; }
}

function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("invalid", "Expected a plain object");
}
function keys(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  object(value);
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) fail("invalid", "Unexpected or missing journal fields");
}
function string(value: unknown, label: string, maximum = 4096, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > maximum || /[\0\r\n]/u.test(value)) fail("invalid", `Invalid ${label}`);
}
function identifier(value: unknown, label: string, maximum = 200): asserts value is string {
  string(value, label, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value)) fail("invalid", `Invalid ${label}`);
}
function digest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail("invalid", "Expected lowercase SHA-256 digest");
}
function integer(value: unknown, minimum = 0): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail("invalid", "Expected a bounded safe integer");
}
function timestamp(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/u.test(value) || !Number.isFinite(Date.parse(value))) fail("invalid", "Expected an ISO timestamp");
}
function choice(value: unknown, allowed: readonly string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) fail("invalid", "Invalid journal result enumeration");
}
function invocationId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/u.test(value) || /^0+$/u.test(value)) fail("invalid", "Expected a nonzero service invocation ID");
}
function path(value: unknown): asserts value is string {
  string(value, "absolute path", 4096);
  if (!value.startsWith("/") || /[\0-\x1f\x7f]/u.test(value)) fail("invalid", "Expected an absolute Linux path");
}
/** Snapshot inert JSON without invoking getters or retaining caller references. */
function snapshot<T>(raw: T): T {
  let nodes = 0;
  const active = new WeakSet<object>();
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > 50_000 || depth > 32) fail("invalid", "Journal data exceeds structural bounds");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || active.has(value) || Object.getOwnPropertySymbols(value).length) fail("invalid", "Journal data must be acyclic plain JSON");
    if (Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype)) fail("invalid", "Journal data must be plain JSON");
    active.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some(property => !Object.hasOwn(property, "value"))) fail("invalid", "Accessors are not journal data");
    let result: unknown;
    if (Array.isArray(value)) {
      if (value.length > 50_000 || Object.keys(descriptors).length !== value.length + 1) fail("invalid", "Expected dense JSON array");
      result = Array.from({ length: value.length }, (_, index) => {
        const property = descriptors[String(index)];
        if (!property?.enumerable) fail("invalid", "Expected dense JSON array");
        return copy(property.value, depth + 1);
      });
    } else {
      result = Object.fromEntries(Object.entries(descriptors).map(([key, property]) => {
        if (!property.enumerable) fail("invalid", "Non-enumerable fields are not journal data");
        return [key, copy(property.value, depth + 1)];
      }));
    }
    active.delete(value); return result;
  }
  const result = copy(raw, 0);
  if (Buffer.byteLength(encode(result)) > 1_048_576) fail("invalid", "Journal record exceeds 1 MiB");
  return result as T;
}
function host(raw: unknown): asserts raw is HostIdentity {
  keys(raw, ["machineId", "bootId"]); string(raw.machineId, "machine ID", 256); string(raw.bootId, "boot ID", 256);
}
function unit(raw: unknown): asserts raw is UnitIdentity {
  keys(raw, ["unitName", "description"]); string(raw.unitName, "unit name", 255); string(raw.description, "unit description", 4096);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@-]*\.service$/u.test(raw.unitName)) fail("invalid", "Expected a literal service unit name");
}
function declaration(raw: unknown): asserts raw is JobDeclaration {
  keys(raw, ["jobId", "actionId", "backendKey", "manifestDigest", "planDigest", "workerId", "request"]);
  identifier(raw.jobId, "job ID", 512); identifier(raw.actionId, "action ID"); identifier(raw.backendKey, "backend key");
  identifier(raw.workerId, "worker ID"); digest(raw.manifestDigest); digest(raw.planDigest);
  keys(raw.request, ["identity", "expectedHost", "command", "limits", "deadlineAt"]);
  unit(raw.request.identity); host(raw.request.expectedHost); timestamp(raw.request.deadlineAt);
  keys(raw.request.command, ["executable", "args", "cwd", "environment"]);
  path(raw.request.command.executable); path(raw.request.command.cwd);
  if (!Array.isArray(raw.request.command.args) || raw.request.command.args.length > 4096) fail("invalid", "Invalid command argument vector");
  for (const argument of raw.request.command.args) {
    if (typeof argument !== "string" || argument.includes("\0") || argument.length > 65_536) fail("invalid", "Invalid literal command argument");
  }
  object(raw.request.command.environment);
  if (Object.keys(raw.request.command.environment).length > 128) fail("invalid", "Too many declared environment fields");
  for (const [name, value] of Object.entries(raw.request.command.environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) || typeof value !== "string" || value.includes("\0") || value.length > 8192) fail("invalid", "Invalid declared environment field");
  }
  keys(raw.request.limits, ["runtimeMs", "startTimeoutMs", "stopTimeoutMs", "memoryMaxBytes", "tasksMax"]);
  for (const value of Object.values(raw.request.limits)) integer(value, 1);
}
function match(value: unknown, expected: unknown, label: string): void {
  if (encode(value) !== encode(expected)) fail("conflict", `${label} does not match the job declaration`);
}
function serviceSnapshot(raw: unknown, job: JobDeclaration): asserts raw is ServiceSnapshot {
  keys(raw, ["identity", "host", "observedAt", "invocationId", "loadState", "activeState", "subState", "result", "mainPid", "execMainCode", "execMainStatus", "controlGroup", "cgroupPopulated"]);
  unit(raw.identity); host(raw.host); match(raw.identity, job.request.identity, "Unit identity"); match(raw.host, job.request.expectedHost, "Host identity");
  timestamp(raw.observedAt);
  invocationId(raw.invocationId);
  if (raw.loadState !== "loaded") fail("invalid", "A present service snapshot requires a loaded unit");
  choice(raw.activeState, ["active", "inactive", "failed", "activating", "deactivating", "reloading", "maintenance", "refreshing"]);
  for (const field of ["subState", "result"]) if (typeof raw[field] !== "string" || !/^[a-z][a-z-]{0,63}$/u.test(raw[field])) fail("invalid", `Invalid service ${field}`);
  string(raw.controlGroup, "control group", 4096, true);
  integer(raw.mainPid); integer(raw.execMainCode); integer(raw.execMainStatus);
  if (raw.mainPid > 0xffff_ffff || raw.execMainCode > 6 || raw.execMainStatus > 255) fail("invalid", "Invalid service process outcome");
  if (raw.cgroupPopulated !== null && typeof raw.cgroupPopulated !== "boolean") fail("invalid", "Invalid cgroup observation");
  const expectedGroup = `/system.slice/${job.request.identity.unitName}`;
  if ((raw.controlGroup !== "" && raw.controlGroup !== expectedGroup) || (raw.cgroupPopulated !== null && raw.controlGroup !== expectedGroup)) fail("invalid", "Cgroup population requires the declared unit's cgroup path");
}
function query(raw: unknown, job: JobDeclaration): asserts raw is ServiceQueryResult {
  object(raw); choice(raw.kind, ["present", "absent", "unknown"]);
  if (raw.kind === "present") { keys(raw, ["kind", "snapshot"]); serviceSnapshot(raw.snapshot, job); }
  else if (raw.kind === "absent") { keys(raw, ["kind", "host", "observedAt"]); host(raw.host); match(raw.host, job.request.expectedHost, "Host identity"); timestamp(raw.observedAt); }
  else { keys(raw, ["kind", "reason"]); string(raw.reason, "unknown reason"); }
}
function acceptedEvidence(raw: unknown, job: JobDeclaration): void {
  object(raw);
  const structuredIdentity = ["identity", "unitIdentity"].some(name => Object.hasOwn(raw, name))
    && ["host", "expectedHost"].some(name => Object.hasOwn(raw, name));
  const scalarIdentity = ["unitName", "description", "machineId", "bootId"].every(name => Object.hasOwn(raw, name));
  if (!structuredIdentity && !scalarIdentity) fail("invalid", "Accepted receipt requires complete unit and host identity");
  // The transport's receipt may expose identity in either structured or scalar
  // metadata. It may not contradict the declaration under those known names.
  for (const name of ["identity", "unitIdentity"]) if (Object.hasOwn(raw, name)) { unit(raw[name]); match(raw[name], job.request.identity, "Receipt unit identity"); }
  for (const name of ["host", "expectedHost"]) if (Object.hasOwn(raw, name)) { host(raw[name]); match(raw[name], job.request.expectedHost, "Receipt host identity"); }
  const scalars = { jobId: job.jobId, actionId: job.actionId, backendKey: job.backendKey, manifestDigest: job.manifestDigest, planDigest: job.planDigest,
    workerId: job.workerId, unitName: job.request.identity.unitName, description: job.request.identity.description,
    machineId: job.request.expectedHost.machineId, bootId: job.request.expectedHost.bootId };
  for (const [name, expected] of Object.entries(scalars)) if (Object.hasOwn(raw, name)) match(raw[name], expected, `Receipt ${name}`);
  if (Object.hasOwn(raw, "invocationId")) invocationId(raw.invocationId);
}
function observation(raw: unknown, job: JobDeclaration, declarationDigest: string): asserts raw is JobObservationInput {
  keys(raw, ["observationId", "jobId", "actionId", "declarationDigest", "observedAt", "observation"]);
  identifier(raw.observationId, "observation ID", 512); identifier(raw.jobId, "job ID", 512); identifier(raw.actionId, "action ID"); digest(raw.declarationDigest); timestamp(raw.observedAt);
  if (raw.jobId !== job.jobId || raw.actionId !== job.actionId || raw.declarationDigest !== declarationDigest) fail("conflict", "Observation is bound to another job declaration");
  keys(raw.observation, ["operation", "result"]); choice(raw.observation.operation, ["start", "query", "stop"]);
  const result = raw.observation.result;
  if (raw.observation.operation === "start") {
    object(result); choice(result.kind, ["accepted", "unknown"]);
    if (result.kind === "accepted") { keys(result, ["kind", "evidence"]); acceptedEvidence(result.evidence, job); }
    else { keys(result, ["kind", "reason"]); string(result.reason, "unknown reason"); }
  } else if (raw.observation.operation === "query") query(result, job);
  else { keys(result, ["command", "observation"]); choice(result.command, ["sent", "not_sent", "unknown"]); query(result.observation, job); }
}
function invocation(input: JobObservationInput): string | null {
  const data = input.observation;
  if (data.operation === "start") return data.result.kind === "accepted" && typeof data.result.evidence.invocationId === "string" ? data.result.evidence.invocationId || null : null;
  const result = data.operation === "query" ? data.result : data.result.observation;
  return result.kind === "present" ? result.snapshot.invocationId || null : null;
}

export interface JobJournalOptions { path: string; now?: () => Date }

/** The journal records intent and evidence only. It cannot authorize a start,
 * infer nonacceptance from absence, or settle allocation/billing/evaluation. */
export function openJobJournal(options: JobJournalOptions): JobJournal {
  // Capture option access before acquiring ownership; a throwing getter must not
  // strand a live owner connection behind a failed constructor.
  const inputPath = options.path, now = options.now ?? (() => new Date());
  if (typeof now !== "function") fail("invalid", "Journal clock must be a function");
  const database = openDatabase(inputPath), db = database.db;
  let closed = false;
  const assertOpen = () => { if (closed) fail("closed", "Job journal is closed"); };
  const transaction = <T>(callback: () => T): T => {
    assertOpen(); db.exec("BEGIN IMMEDIATE");
    try { const result = callback(); db.exec("COMMIT"); return result; }
    catch (error) { try { db.exec("ROLLBACK"); } catch { /* Preserve the failed operation's error. */ } throw error; }
  };
  const readDeclaration = (jobId: string): Omit<JobRecord, "latestObservation"> | null => {
    const row = db.prepare("SELECT * FROM job_intents WHERE job_id=?").get(jobId);
    if (!row) return null;
    const value: unknown = JSON.parse(row.declaration as string); declaration(value);
    if (value.jobId !== row.job_id || value.actionId !== row.action_id || hash(value) !== row.declaration_digest) fail("invalid", "Stored job declaration is inconsistent");
    timestamp(row.intent_created_at);
    return { declaration: value, digest: row.declaration_digest as string, intentCreatedAt: row.intent_created_at };
  };
  const readObservation = (row: Record<string, unknown>, job: Omit<JobRecord, "latestObservation">): JobObservationRecord => {
    const input: unknown = JSON.parse(row.payload as string); observation(input, job.declaration, job.digest); integer(row.ordinal, 1);
    const body = { ...input, sequence: row.ordinal };
    if (input.observationId !== row.observation_id || input.jobId !== row.job_id || hash(body) !== row.digest) fail("invalid", "Stored job observation is inconsistent");
    return { ...body, digest: row.digest as string };
  };
  const getRecord = (jobId: string): JobRecord | null => {
    const job = readDeclaration(jobId); if (!job) return null;
    const latest = db.prepare("SELECT * FROM job_observations WHERE job_id=? ORDER BY ordinal DESC LIMIT 1").get(jobId);
    return { ...job, latestObservation: latest ? readObservation(latest, job) : null };
  };
  const journal: JobJournal = {
    prepareIntent(raw) {
      assertOpen(); const input = snapshot(raw); declaration(input); const digest = hash(input);
      return transaction(() => {
        const existing = getRecord(input.jobId);
        if (existing) {
          if (existing.digest !== digest || encode(existing.declaration) !== encode(input)) fail("conflict", "Job identity already belongs to a different declaration");
          return { record: existing, created: false };
        }
        if (db.prepare("SELECT job_id FROM job_intents WHERE action_id=?").get(input.actionId)) fail("conflict", "Action already belongs to a different job");
        const createdAt = now().toISOString(); timestamp(createdAt);
        db.prepare("INSERT INTO job_intents VALUES(?,?,?,?,?)").run(input.jobId, input.actionId, digest, encode(input), createdAt);
        return { record: { declaration: input, digest, intentCreatedAt: createdAt, latestObservation: null }, created: true };
      });
    },
    read(jobId) { assertOpen(); identifier(jobId, "job ID", 512); return getRecord(jobId); },
    readByAction(actionId) {
      assertOpen(); identifier(actionId, "action ID");
      const row = db.prepare("SELECT job_id FROM job_intents WHERE action_id=?").get(actionId);
      return row ? getRecord(row.job_id as string) : null;
    },
    recordObservation(raw) {
      assertOpen(); const input = snapshot(raw);
      // Validate the routing field before querying; full shape follows its binding.
      object(input); identifier(input.jobId, "job ID", 512);
      return transaction(() => {
        const job = readDeclaration(input.jobId); if (!job) fail("missing", "No durable start intent exists for this job");
        observation(input, job.declaration, job.digest);
        const existing = db.prepare("SELECT * FROM job_observations WHERE observation_id=?").get(input.observationId);
        if (existing) {
          if (existing.job_id !== input.jobId || existing.payload !== encode(input)) fail("conflict", "Observation identity already belongs to another receipt");
          return readObservation(existing, job);
        }
        const current = invocation(input);
        if (current) for (const row of db.prepare("SELECT * FROM job_observations WHERE job_id=? ORDER BY ordinal").all(input.jobId)) {
          const prior = invocation(readObservation(row, job));
          if (prior && prior !== current) fail("conflict", "Observation refers to a replacement service invocation");
        }
        const sequence = Number(db.prepare("SELECT COALESCE(MAX(ordinal),0)+1 AS value FROM job_observations").get()!.value); integer(sequence, 1);
        const digest = hash({ ...input, sequence });
        db.prepare("INSERT INTO job_observations VALUES(?,?,?,?,?)").run(input.observationId, input.jobId, sequence, encode(input), digest);
        return { ...input, digest, sequence };
      });
    },
    observations(jobId) {
      assertOpen(); identifier(jobId, "job ID", 512); const job = readDeclaration(jobId); if (!job) fail("missing", "No durable start intent exists for this job");
      return db.prepare("SELECT * FROM job_observations WHERE job_id=? ORDER BY ordinal").all(jobId).map(row => readObservation(row, job));
    },
    close() { if (closed) return; database.close(); closed = true; },
  };
  return journal;
}
