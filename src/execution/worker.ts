import { randomUUID } from "node:crypto";
import { hash, id, keys, digestValue, timestamp, integer } from "../ledger/validation.ts";
import { JobJournalError } from "./journal.ts";
import type { HostIdentity, JobDeclaration, JobJournal, JobObservation, JobRecord, ServiceCommand,
  ServiceLimits, ServiceQueryRequest, ServiceQueryResult, ServiceSnapshot, SystemdTransport } from "./types.ts";

/** Deployment code prepares these declarations after verifying artifacts. This constructor
 * binds their identity; it does not attest bytes or confer execution authority. */
export interface JobDeclarationInput {
  actionId: string; backendKey: string; manifestDigest: string; planDigest: string; workerId: string;
  command: ServiceCommand; limits: ServiceLimits; deadlineAt: string; host: HostIdentity;
}

function copyData<T>(raw: T): T {
  let nodes = 0;
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 24) throw new Error("Worker input is too large or deeply nested");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) throw new Error("Worker input must be JSON data");
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length || Object.values(fields).some(field => !Object.hasOwn(field, "value"))) throw new Error("Worker input cannot contain accessors or symbols");
    if (Array.isArray(value)) {
      if (value.length > 20_000 || Object.keys(fields).length !== value.length + 1) throw new Error("Worker arrays must be dense");
      return Array.from({ length: value.length }, (_, index) => {
        if (!fields[index]) throw new Error("Worker arrays must be dense");
        return copy(fields[index]!.value, depth + 1);
      });
    }
    return Object.fromEntries(Object.entries(fields).map(([key, field]) => {
      if (!field.enumerable) throw new Error("Worker fields must be enumerable");
      return [key, copy(field.value, depth + 1)];
    }));
  };
  const result = copy(raw, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > 256_000) throw new Error("Worker input exceeds 256 KB");
  return result as T;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

export function createJobDeclaration(raw: JobDeclarationInput): JobDeclaration {
  const input = copyData(raw);
  keys(input, ["actionId", "backendKey", "manifestDigest", "planDigest", "workerId", "command", "limits", "deadlineAt", "host"]);
  for (const field of [input.actionId, input.backendKey, input.workerId]) id(field);
  digestValue(input.manifestDigest); digestValue(input.planDigest); timestamp(input.deadlineAt);
  keys(input.host, ["machineId", "bootId"]);
  if (!/^[a-f0-9]{32}$/.test(input.host.machineId) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.host.bootId)) throw new Error("Invalid host identity");
  keys(input.command, ["executable", "args", "cwd", "environment"]);
  keys(input.limits, ["runtimeMs", "startTimeoutMs", "stopTimeoutMs", "memoryMaxBytes", "tasksMax"]);
  for (const limit of Object.values(input.limits)) integer(limit, 1);
  const unitName = `rlh-${hash([input.workerId, input.backendKey])}.service`;
  const { host, command, limits, deadlineAt, ...binding } = input;
  const request = { command, limits, deadlineAt, expectedHost: host };
  const description = `rlh-v1:${hash({ ...binding, request })}`;
  return freeze({ ...binding, jobId: `${input.workerId}:${unitName}`, request: { ...request, identity: { unitName, description } } });
}

export interface WorkerResult {
  jobId: string;
  acceptance: "accepted" | "not_accepted" | "unknown";
  execution: "running" | "succeeded" | "failed" | "stopped" | "unknown";
  reason: string;
  observation: ServiceQueryResult | null;
}
export interface SupervisedWorker {
  launch(declaration: JobDeclaration, signal: AbortSignal): Promise<WorkerResult>;
  query(jobId: string, signal: AbortSignal): Promise<WorkerResult>;
  cancel(jobId: string, signal: AbortSignal): Promise<WorkerResult>;
}
export interface SupervisedWorkerOptions {
  journal: JobJournal;
  transport: SystemdTransport;
  workerId: string;
  /** Synchronous trusted authority check. Models cannot supply or replace it. */
  authorize: (declaration: Readonly<JobDeclaration>) => boolean;
  callTimeoutMs?: number;
  now?: () => Date;
}

/** Local wait bounds do not cancel a supervisor job; only explicit cancel targets it. */
async function bounded<T>(callback: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent: AbortSignal): Promise<T | { kind: "unknown"; reason: string }> {
  if (parent.aborted) return { kind: "unknown", reason: "caller_aborted" };
  const controller = new AbortController();
  let finish!: (value: T | { kind: "unknown"; reason: string }) => void;
  let settled = false;
  const result = new Promise<T | { kind: "unknown"; reason: string }>(resolve => { finish = value => {
    if (!settled) { settled = true; resolve(value); }
  }; });
  const stop = (reason: string) => { finish({ kind: "unknown", reason }); controller.abort(); };
  const abort = () => stop("caller_aborted");
  parent.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop("transport_timeout"), timeoutMs);
  try {
    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error("aborted");
      return callback(controller.signal);
    }).then(value => {
      try { finish(copyData(value)); }
      catch { finish({ kind: "unknown", reason: "malformed_transport_result" }); }
    }, () => finish({ kind: "unknown", reason: "transport_exception" }));
    return await result;
  } finally { clearTimeout(timer); parent.removeEventListener("abort", abort); }
}

function snapshotOf(observation: JobObservation): ServiceSnapshot | null {
  const query = observation.operation === "query" ? observation.result : observation.operation === "stop" ? observation.result.observation : null;
  return query?.kind === "present" ? query.snapshot : null;
}

/** A single journal owner serializes each job; no existing intent can authorize another
 * start, even after reboot, an empty manager listing, or a failed start invocation. */
export function createSupervisedWorker(options: SupervisedWorkerOptions): SupervisedWorker {
  const { journal, transport, workerId, authorize } = options;
  id(workerId);
  const timeoutMs = options.callTimeoutMs ?? 10_000, now = options.now ?? (() => new Date());
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("Worker call timeout must be 1–60,000 ms");
  const active = new Map<string, Promise<unknown>>();
  function serial<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    const prior = active.get(jobId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(operation);
    active.set(jobId, next);
    void next.finally(() => { if (active.get(jobId) === next) active.delete(jobId); }).catch(() => {});
    return next;
  }
  function time(): string {
    const date = now(); if (!Number.isFinite(date.getTime())) throw new Error("Invalid worker clock");
    return date.toISOString();
  }
  function read(jobId: string): JobRecord {
    const record = journal.read(jobId);
    if (!record || record.declaration.workerId !== workerId) throw new Error("Job is not owned by this worker");
    checkDeclaration(record.declaration);
    return record;
  }
  function checkDeclaration(declaration: JobDeclaration): void {
    const expected = createJobDeclaration({ actionId: declaration.actionId, backendKey: declaration.backendKey,
      manifestDigest: declaration.manifestDigest, planDigest: declaration.planDigest, workerId: declaration.workerId,
      command: declaration.request.command, limits: declaration.request.limits,
      deadlineAt: declaration.request.deadlineAt, host: declaration.request.expectedHost });
    if (hash(expected) !== hash(declaration)) throw new Error("Job identity does not match its declaration");
  }
  function queryRequest(record: JobRecord): ServiceQueryRequest {
    const invocations = journal.observations(record.declaration.jobId).map(({ observation }) => {
      if (observation.operation === "start" && observation.result.kind === "accepted") {
        const value = observation.result.evidence.invocationId;
        return typeof value === "string" ? value : null;
      }
      return snapshotOf(observation)?.invocationId;
    });
    const invocation = invocations.find(value => value);
    return { identity: record.declaration.request.identity, expectedHost: record.declaration.request.expectedHost,
      ...(invocation ? { expectedInvocationId: invocation } : {}) };
  }
  function persist(record: JobRecord, observation: JobObservation): JobObservation {
    const common = { observationId: randomUUID(), jobId: record.declaration.jobId, actionId: record.declaration.actionId,
      declarationDigest: record.digest, observedAt: time() };
    try {
      const copied = copyData(observation);
      return journal.recordObservation({ ...common, observation: copied }).observation;
    } catch (error) {
      if (!(error instanceof JobJournalError) || !["invalid", "conflict"].includes(error.code)) throw error;
      const unknown = { kind: "unknown" as const, reason: "malformed_or_mismatched_transport_result" };
      const fallback: JobObservation = observation.operation === "stop"
        ? { operation: "stop", result: { command: "unknown", observation: unknown } }
        : { operation: observation.operation, result: unknown };
      return journal.recordObservation({ ...common, observation: fallback }).observation;
    }
  }
  function summarize(record: JobRecord, observation: ServiceQueryResult | null, reason: string): WorkerResult {
    const history = journal.observations(record.declaration.jobId);
    const accepted = history.some(item => item.observation.operation === "start" && item.observation.result.kind === "accepted" || snapshotOf(item.observation) !== null);
    let execution: WorkerResult["execution"] = "unknown";
    let stopSent = false;
    // Cleanup and unit garbage collection cannot erase a confirmed terminal outcome.
    // A stop request is not proof that it caused a previously observed exit.
    for (const item of history) {
      if (item.observation.operation === "stop" && item.observation.result.command === "sent") stopSent = true;
      const s = snapshotOf(item.observation);
      if (!s || s.cgroupPopulated !== false || s.mainPid !== 0) continue;
      const terminal = s.activeState === "active" && s.subState === "exited"
        || s.activeState === "failed" && s.subState === "failed"
        || s.activeState === "inactive" && s.subState === "dead";
      if (!terminal) continue;
      if (s.execMainCode === 1 && s.execMainStatus === 0 && s.result === "success") execution = "succeeded";
      else if (stopSent && s.execMainCode === 2 && [9, 15].includes(s.execMainStatus) && ["signal", "success"].includes(s.result)) execution = "stopped";
      else if (s.result !== "success") execution = "failed";
      if (execution !== "unknown") break;
    }
    if (execution === "unknown" && observation?.kind === "present") {
      if (observation.snapshot.cgroupPopulated === true && observation.snapshot.activeState === "active") {
        execution = "running";
      }
    }
    return { jobId: record.declaration.jobId, acceptance: accepted ? "accepted" : "unknown", execution, reason, observation };
  }
  async function query(record: JobRecord, signal: AbortSignal): Promise<WorkerResult> {
    const result = await bounded(child => transport.query(queryRequest(record), child), timeoutMs, signal);
    const saved = persist(record, { operation: "query", result });
    if (saved.operation !== "query") throw new Error("Invalid journal query result");
    return summarize(record, saved.result, saved.result.kind === "unknown" ? saved.result.reason : "supervisor_observed");
  }
  return {
    launch(raw, signal) {
      const declaration = freeze(copyData(raw));
      checkDeclaration(declaration);
      return serial(declaration.jobId, async () => {
        if (declaration.workerId !== workerId) throw new Error("Job belongs to another worker");
        // Existing intent wins over current authorization: observe it, never start it again.
        const existing = journal.read(declaration.jobId) ?? journal.readByAction(declaration.actionId);
        if (existing) {
          if (existing.digest !== hash(declaration)) throw new Error("Job declaration conflicts with existing intent");
          return query(existing, signal);
        }
        const remaining = Date.parse(declaration.request.deadlineAt) - Date.parse(time());
        const lifecycle = declaration.request.limits.runtimeMs + declaration.request.limits.startTimeoutMs + declaration.request.limits.stopTimeoutMs;
        if (signal.aborted || !Number.isFinite(remaining) || remaining < lifecycle || authorize(declaration) !== true) {
          return { jobId: declaration.jobId, acceptance: "not_accepted", execution: "unknown", reason: "authority_or_deadline_denied_before_intent", observation: null };
        }
        const intent = journal.prepareIntent(declaration);
        if (!intent.created) return query(intent.record, signal);
        const result = await bounded(child => {
          const stillAuthorized = () => !child.aborted && authorize(declaration) === true
            && Date.parse(declaration.request.deadlineAt) - Date.parse(time()) >= lifecycle;
          if (!stillAuthorized()) return Promise.resolve({ kind: "unknown" as const, reason: "authority_revoked_before_start" });
          return transport.start(declaration.request, child, stillAuthorized);
        }, timeoutMs, signal);
        persist(intent.record, { operation: "start", result });
        return query(intent.record, signal);
      });
    },
    query(jobId, signal) { return serial(jobId, () => query(read(jobId), signal)); },
    cancel(jobId, signal) {
      return serial(jobId, async () => {
        const record = read(jobId);
        const raw = await bounded(child => transport.stop(queryRequest(record), child), timeoutMs, signal);
        const result = raw && typeof raw === "object" && "command" in raw ? raw
          : { command: "unknown" as const, observation: { kind: "unknown" as const, reason: "stop_result_unknown" } };
        const saved = persist(record, { operation: "stop", result });
        if (saved.operation !== "stop") throw new Error("Invalid journal stop result");
        return summarize(record, saved.result.observation, "stop_observed");
      });
    },
  };
}
