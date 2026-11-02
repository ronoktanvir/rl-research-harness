import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { openQueueDatabase } from "./database.js";
import { encode, enumValue, evidence, fail, hash, id, ids, integer, json, keys, parse, scope, snap, text, timestamp } from "./validation.js";
import type * as T from "./types.js";
type Row = Record<string, string | number | null>;
type StoredTask = T.EnqueueTaskInput & { handler: T.HandlerPolicy; inputDigest: string };

export class LocalTaskQueue implements T.TaskQueue {
  private readonly storage;
  private readonly now;
  private readonly authority;
  private closed = false;
  constructor(options: T.QueueOptions) {
    this.now = options.now ?? (() => new Date()); this.authority = options.authority;
    if (typeof this.authority !== "function") fail("invalid", "A ledger authority reader is required");
    this.storage = openQueueDatabase(options.path);
    try { this.tx(() => {
      for (const row of this.all("SELECT id,current_attempt FROM tasks WHERE state='running'")) {
        this.run("UPDATE tasks SET state='uncertain' WHERE id=?", row.id!);
        this.run("UPDATE attempts SET state='uncertain' WHERE id=?", row.current_attempt!);
        this.event("recovered_uncertain", row.id as string, { attemptId: row.current_attempt as string });
      }
    }); } catch (error) { this.storage.close(); throw error; }
  }
  private check(): void { if (this.closed) fail("closed", "Task queue is closed"); }
  private get(sql: string, ...params: SQLInputValue[]): Row | undefined { this.check(); return this.storage.db.prepare(sql).get(...params) as Row | undefined; }
  private all(sql: string, ...params: SQLInputValue[]): Row[] { this.check(); return this.storage.db.prepare(sql).all(...params) as Row[]; }
  private run(sql: string, ...params: SQLInputValue[]): void { this.check(); this.storage.db.prepare(sql).run(...params); }
  private required(sql: string, ...params: SQLInputValue[]): Row { return this.get(sql, ...params) ?? fail("missing", "Referenced queue record is missing"); }
  private tx<R>(fn: () => R): R { this.check(); this.storage.db.exec("BEGIN IMMEDIATE"); try { const value = fn(); this.storage.db.exec("COMMIT"); return value; } catch (error) { this.storage.db.exec("ROLLBACK"); throw error; } }
  private clock(): string { const value = this.now(); if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail("invalid", "Invalid controller clock"); return value.toISOString(); }
  private event(kind: string, taskId: string | null, data: T.JsonObject): void { this.run("INSERT INTO queue_events(kind,task_id,data,created_at) VALUES(?,?,?,?)", kind, taskId, encode(data), this.clock()); }
  private same(row: Row, digest: string): void { if (row.digest !== digest) fail("conflict", "Identity already binds different content"); }
  private readAuthority(projectId: string): T.QueueAuthority {
    const value = snap(this.authority(projectId)); keys(value, ["globalEpoch", "projectEpoch", "stopped"]); integer(value.globalEpoch);
    if (value.projectEpoch !== null) integer(value.projectEpoch); if (typeof value.stopped !== "boolean") fail("invalid", "Invalid stop authority"); return value;
  }
  registerHandler(raw: T.HandlerPolicy): T.HandlerPolicy {
    const input = snap(raw); keys(input, ["kind", "version", "replay", "callUnits", "resourceKey"]); id(input.kind); id(input.version); enumValue(input.replay, ["never", "reconcile_safe"]); integer(input.callUnits);
    if (input.resourceKey !== null) id(input.resourceKey);
    if (input.callUnits > 0 && input.resourceKey === null) fail("invalid", "Call-consuming handlers require a shared resource key");
    const digest = hash(input);
    return this.tx(() => { const old = this.get("SELECT digest FROM handlers WHERE kind=? AND version=?", input.kind, input.version);
      if (old) this.same(old, digest); else { this.run("INSERT INTO handlers VALUES(?,?,?,?)", input.kind, input.version, encode(input), digest); this.event("handler_registered", null, { kind: input.kind, version: input.version, replay: input.replay, callUnits: input.callUnits, resourceKey: input.resourceKey }); } return input; });
  }
  configureBudget(raw: T.QueueBudgetInput): T.QueueBudget {
    const input = snap(raw); keys(input, ["scopeId", "expectedVersion", "maxCalls", "maxParallel"]); scope(input.scopeId); integer(input.expectedVersion); integer(input.expectedVersion + 1); integer(input.maxCalls); integer(input.maxParallel, 1);
    return this.tx(() => { const old = this.get("SELECT version FROM budgets WHERE scope=?", input.scopeId); if ((old?.version ?? 0) !== input.expectedVersion) fail("conflict", "Budget version changed");
      this.run("INSERT INTO budgets VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET version=excluded.version,max_calls=excluded.max_calls,max_parallel=excluded.max_parallel", input.scopeId, input.expectedVersion + 1, input.maxCalls, input.maxParallel);
      this.event("budget_configured", null, { ...input, version: input.expectedVersion + 1 }); return this.getBudget(input.scopeId); });
  }
  getBudget(scopeId: string): T.QueueBudget {
    scope(scopeId); const row = this.required("SELECT * FROM budgets WHERE scope=?", scopeId);
    const attempts = scopeId === "global" ? this.all("SELECT call_units,state FROM attempts") : this.all("SELECT attempts.call_units,attempts.state FROM attempts JOIN tasks ON tasks.id=attempts.task_id WHERE tasks.project=?", scopeId.slice(8));
    let consumedCalls = 0, activeAttempts = 0;
    for (const attempt of attempts) { consumedCalls += Number(attempt.call_units); integer(consumedCalls); if (["running", "uncertain"].includes(attempt.state as string)) activeAttempts++; }
    return { scopeId, version: row.version as number, maxCalls: row.max_calls as number, maxParallel: row.max_parallel as number, consumedCalls, activeAttempts };
  }
  getResourceHold(resourceKey: string): T.ResourceHold | null {
    id(resourceKey); const row = this.get("SELECT * FROM resource_holds WHERE resource=?", resourceKey);
    return row ? { resourceKey, version: row.version as number, held: row.held === 1, reason: row.reason as T.ResourceHold["reason"], retryAt: row.retry_at as string | null, notBefore: row.not_before as string | null } : null;
  }
  listResourceHolds(): T.ResourceHold[] { return this.all("SELECT resource FROM resource_holds ORDER BY resource").map(row => this.getResourceHold(row.resource as string)!); }
  releaseResource(raw: T.ReleaseResourceInput): T.ResourceHold {
    const input = snap(raw); keys(input, ["resourceKey", "expectedVersion", "evidence", "notBefore"], ["resourceKey", "expectedVersion", "evidence"]); id(input.resourceKey); integer(input.expectedVersion); integer(input.expectedVersion + 1); evidence(input.evidence); if (input.notBefore !== undefined) timestamp(input.notBefore);
    return this.tx(() => { const old = this.getResourceHold(input.resourceKey) ?? fail("missing", "Resource hold does not exist"); if (old.version !== input.expectedVersion) fail("conflict", "Resource hold version changed");
      const notBefore = input.notBefore ?? this.clock();
      if (old.retryAt !== null && Date.parse(notBefore) < Date.parse(old.retryAt)) fail("denied", "Resource release cannot precede its authoritative reset");
      this.run("UPDATE resource_holds SET version=?,held=0,reason=NULL,not_before=? WHERE resource=?", old.version + 1, notBefore, input.resourceKey);
      this.event("resource_released", null, { resourceKey: input.resourceKey, version: old.version + 1, notBefore, evidence: input.evidence }); return this.getResourceHold(input.resourceKey)!; });
  }
  private resourceAvailable(handler: T.HandlerPolicy, now: string): boolean {
    if (handler.resourceKey === null) return true; const hold = this.getResourceHold(handler.resourceKey);
    return !hold || (!hold.held && (hold.notBefore === null || Date.parse(hold.notBefore) <= Date.parse(now)));
  }
  enqueue(raw: T.EnqueueTaskInput): T.TaskRecord {
    const input = snap(raw); keys(input, ["taskId", "projectId", "kind", "handlerVersion", "input", "dependencies", "maxAttempts", "deadlineAt", "notBefore"]);
    for (const value of [input.taskId, input.projectId, input.kind, input.handlerVersion]) id(value); scope(`project:${input.projectId}`); json(input.input); ids(input.dependencies); integer(input.maxAttempts, 1); timestamp(input.deadlineAt); timestamp(input.notBefore);
    if (Date.parse(input.notBefore) >= Date.parse(input.deadlineAt)) fail("invalid", "notBefore must precede deadline");
    const handler = parse<T.HandlerPolicy>(this.required("SELECT data FROM handlers WHERE kind=? AND version=?", input.kind, input.handlerVersion).data);
    const stored: StoredTask = { ...input, handler, inputDigest: hash(input.input) }, digest = hash(stored);
    return this.tx(() => { const existing = this.get("SELECT digest FROM tasks WHERE id=?", input.taskId); if (existing) { this.same(existing, digest); return this.getTask(input.taskId); }
      for (const dependency of input.dependencies) { if (dependency === input.taskId) fail("invalid", "Task cannot depend on itself"); if (this.getTask(dependency).projectId !== input.projectId) fail("denied", "Dependencies must belong to the same project"); }
      this.run("INSERT INTO tasks(id,project,kind,data,digest,state,not_before) VALUES(?,?,?,?,?,'queued',?)", input.taskId, input.projectId, input.kind, encode(stored), digest, input.notBefore);
      for (const dependency of input.dependencies) this.run("INSERT INTO dependencies VALUES(?,?)", input.taskId, dependency);
      this.event("task_enqueued", input.taskId, { inputDigest: stored.inputDigest, projectId: input.projectId, kind: input.kind }); return this.getTask(input.taskId); });
  }
  getTask(taskId: string): T.TaskRecord {
    id(taskId); const row = this.required("SELECT * FROM tasks WHERE id=?", taskId), stored = parse<StoredTask>(row.data);
    return { ...stored, state: row.state as T.TaskState, attempts: row.attempts as number, currentAttemptId: row.current_attempt as string | null, eligibleAt: row.not_before as string, result: row.result === null ? null : parse<T.JsonObject>(row.result), waitingUntil: row.waiting_until as string | null, cancelRequested: row.cancel_requested === 1 };
  }
  listTasks(projectId?: string): T.TaskRecord[] { if (projectId !== undefined) id(projectId); return (projectId === undefined ? this.all("SELECT id FROM tasks ORDER BY rowid") : this.all("SELECT id FROM tasks WHERE project=? ORDER BY rowid", projectId)).map(row => this.getTask(row.id as string)); }
  private capacity(task: T.TaskRecord, addCalls: number, addParallel: number): boolean {
    for (const scopeId of ["global", `project:${task.projectId}`]) { const budget = this.getBudget(scopeId); if (task.handler.callUnits > 0 && (budget.consumedCalls > budget.maxCalls - addCalls)) return false; if (budget.activeAttempts + addParallel > budget.maxParallel) return false; }
    return true;
  }
  claim(raw: T.ClaimTaskInput): T.TaskClaim | null {
    const input = snap(raw); keys(input, ["workerId", "kinds", "taskIds"], ["workerId"]); id(input.workerId); if (input.kinds !== undefined) ids(input.kinds);
    if (input.taskIds !== undefined) { ids(input.taskIds); if (input.taskIds.length > 1000) fail("invalid", "At most 1,000 task IDs may be selected"); }
    return this.tx(() => { const now = this.clock();
      for (const row of this.all("SELECT id,not_before FROM tasks WHERE state='queued' ORDER BY rowid")) {
        if (input.taskIds && !input.taskIds.includes(row.id as string)) continue;
        const task = this.getTask(row.id as string);
        if (Date.parse(task.deadlineAt) <= Date.parse(now)) { this.run("UPDATE tasks SET state='expired' WHERE id=?", task.taskId); this.event("task_expired", task.taskId, {}); continue; }
        if (task.attempts >= task.maxAttempts || Date.parse(row.not_before as string) > Date.parse(now) || (input.kinds && !input.kinds.includes(task.kind)) || task.cancelRequested) continue;
        if (task.dependencies.some(dependency => this.getTask(dependency).state !== "completed")) continue;
        const authority = this.readAuthority(task.projectId);
        if (authority.stopped || !this.resourceAvailable(task.handler, now) || !this.capacity(task, task.handler.callUnits, 1)) continue;
        const attemptId = `task-attempt:${randomUUID()}`, number = task.attempts + 1; integer(number);
        this.run("UPDATE tasks SET state='running',attempts=?,current_attempt=?,result=NULL,waiting_until=NULL WHERE id=?", number, attemptId, task.taskId);
        const claim: T.TaskClaim = { task: this.getTask(task.taskId), attemptId, workerId: input.workerId, authority, claimedAt: now };
        this.run("INSERT INTO attempts VALUES(?,?,?,?,'running',?,NULL)", attemptId, task.taskId, number, task.handler.callUnits, encode(claim));
        this.event("task_claimed", task.taskId, { attemptId, number, callUnits: task.handler.callUnits, authority: { ...authority } }); return claim;
      } return null;
    });
  }
  isAuthorized(raw: T.TaskClaim): boolean {
    this.check(); try { const claim = snap(raw), attempt = this.get("SELECT claim,state FROM attempts WHERE id=?", claim.attemptId); if (!attempt || attempt.state !== "running" || attempt.claim !== encode(claim)) return false;
      const task = this.getTask(claim.task.taskId); if (task.currentAttemptId !== claim.attemptId || task.state !== "running" || task.cancelRequested || Date.parse(task.deadlineAt) <= Date.parse(this.clock())) return false;
      const authority = this.readAuthority(task.projectId); return !authority.stopped && encode(authority) === encode(claim.authority) && this.resourceAvailable(task.handler, this.clock()) && this.capacity(task, 0, 0);
    } catch { return false; }
  }
  recordOutcome(raw: T.TaskOutcomeInput): T.TaskRecord {
    const input = snap(raw); keys(input, ["resultId", "taskId", "attemptId", "status", "result", "retryAt"], ["resultId", "taskId", "attemptId", "status", "result"]);
    for (const value of [input.resultId, input.taskId, input.attemptId]) id(value); enumValue(input.status, ["completed", "rejected", "failed", "cancelled", "waiting_quota", "waiting_auth", "uncertain"]); json(input.result);
    if (input.retryAt !== undefined && input.retryAt !== null) timestamp(input.retryAt);
    if (input.status !== "waiting_quota" && input.retryAt != null) fail("invalid", "Only quota outcomes may declare a reset");
    const digest = hash(input);
    return this.tx(() => { const prior = this.get("SELECT digest FROM results WHERE id=?", input.resultId); if (prior) { this.same(prior, digest); return this.getTask(input.taskId); }
      const task = this.getTask(input.taskId);
      if (task.currentAttemptId !== input.attemptId || !["running", "uncertain"].includes(task.state)) fail("conflict", "Outcome does not match the current active or uncertain attempt");
      if (["waiting_quota", "waiting_auth"].includes(input.status)) {
        const resource = task.handler.resourceKey ?? fail("invalid", "Quota/auth outcomes require a shared resource key");
        if (input.retryAt != null && Date.parse(input.retryAt) <= Date.parse(this.clock())) fail("invalid", "A newly reported quota reset must be in the future");
        const old = this.getResourceHold(resource), version = (old?.version ?? 0) + 1; integer(version);
        const reason = input.status === "waiting_auth" || (old?.held && old.reason === "auth") ? "auth" : "quota";
        let retryAt = input.retryAt ?? null;
        if (reason === "auth" || (old?.held && old.retryAt === null)) retryAt = null;
        else if (old?.held && old.retryAt && retryAt) retryAt = Date.parse(old.retryAt) > Date.parse(retryAt) ? old.retryAt : retryAt;
        this.run("INSERT INTO resource_holds VALUES(?,?,1,?,?,NULL) ON CONFLICT(resource) DO UPDATE SET version=excluded.version,held=1,reason=excluded.reason,retry_at=excluded.retry_at,not_before=NULL", resource, version, reason, retryAt);
        this.event("resource_held", input.taskId, { resourceKey: resource, version, reason, retryAt, attemptId: input.attemptId });
      }
      this.run("INSERT INTO results VALUES(?,?,?,?,?)", input.resultId, input.taskId, input.attemptId, encode(input), digest);
      this.run("UPDATE attempts SET state=?,result=? WHERE id=?", input.status, encode(input.result), input.attemptId);
      this.run("UPDATE tasks SET state=?,result=?,waiting_until=? WHERE id=?", input.status, encode(input.result), input.retryAt ?? null, input.taskId);
      this.event("task_outcome", input.taskId, { attemptId: input.attemptId, resultId: input.resultId, status: input.status }); return this.getTask(input.taskId);
    });
  }
  private command(commandId: string, data: T.JsonObject): boolean {
    const digest = hash(data), old = this.get("SELECT digest FROM commands WHERE id=?", commandId);
    if (old) { this.same(old, digest); return false; }
    this.run("INSERT INTO commands VALUES(?,?,?)", commandId, encode(data), digest); return true;
  }
  private resumable(task: T.TaskRecord, notBefore: string): void {
    if (task.cancelRequested) fail("denied", "Cancellation was requested");
    if (task.attempts >= task.maxAttempts) fail("denied", "Task attempt limit is exhausted");
    if (Date.parse(task.deadlineAt) <= Date.parse(this.clock()) || Date.parse(notBefore) >= Date.parse(task.deadlineAt)) fail("denied", "Task deadline has no remaining attempt window");
  }
  resumeTask(raw: T.ResumeTaskInput): T.TaskRecord {
    const input = snap(raw); keys(input, ["commandId", "taskId", "evidence", "notBefore"]); id(input.commandId); id(input.taskId); evidence(input.evidence); timestamp(input.notBefore);
    return this.tx(() => { if (!this.command(input.commandId, { ...input, operation: "resume" })) return this.getTask(input.taskId);
      const task = this.getTask(input.taskId); if (!["waiting_quota", "waiting_auth"].includes(task.state)) fail("denied", "Only quota/auth waits may be resumed"); this.resumable(task, input.notBefore);
      if (task.waitingUntil !== null && Date.parse(input.notBefore) < Date.parse(task.waitingUntil)) fail("denied", "Task resume cannot precede the recorded quota reset");
      this.run("UPDATE tasks SET state='queued',not_before=?,waiting_until=NULL WHERE id=?", input.notBefore, input.taskId);
      this.event("task_resumed", input.taskId, { commandId: input.commandId, notBefore: input.notBefore, evidence: input.evidence }); return this.getTask(input.taskId); });
  }
  requeueUncertain(raw: T.RequeueUncertainInput): T.TaskRecord {
    const input = snap(raw); keys(input, ["commandId", "taskId", "attemptId", "evidence", "notBefore"]); id(input.commandId); id(input.taskId); id(input.attemptId); evidence(input.evidence); timestamp(input.notBefore);
    return this.tx(() => { if (!this.command(input.commandId, { ...input, operation: "requeue_uncertain" })) return this.getTask(input.taskId);
      const task = this.getTask(input.taskId); if (task.state !== "uncertain" || task.currentAttemptId !== input.attemptId) fail("conflict", "Reconciliation must target the current uncertain attempt");
      if (task.handler.replay !== "reconcile_safe") fail("denied", "Handler does not permit reconciled replay"); this.resumable(task, input.notBefore);
      this.run("UPDATE attempts SET state='reconciled',result=? WHERE id=?", encode({ reconciledForReplay: true, evidence: input.evidence }), input.attemptId);
      this.run("UPDATE tasks SET state='queued',not_before=?,result=NULL WHERE id=?", input.notBefore, input.taskId);
      this.event("uncertain_reconciled_for_replay", input.taskId, { commandId: input.commandId, attemptId: input.attemptId, notBefore: input.notBefore, evidence: input.evidence }); return this.getTask(input.taskId); });
  }
  cancelTask(raw: T.CancelTaskInput): T.TaskRecord {
    const input = snap(raw); keys(input, ["commandId", "taskId", "reason"]); id(input.commandId); id(input.taskId); text(input.reason);
    return this.tx(() => { if (!this.command(input.commandId, { ...input, operation: "cancel" })) return this.getTask(input.taskId);
      const task = this.getTask(input.taskId);
      if (["completed", "rejected", "failed", "cancelled", "expired"].includes(task.state)) fail("denied", "Task is already terminal");
      const state = ["running", "uncertain"].includes(task.state) ? task.state : "cancelled";
      this.run("UPDATE tasks SET cancel_requested=1,state=? WHERE id=?", state, input.taskId);
      this.event("task_cancel_requested", input.taskId, { commandId: input.commandId, reason: input.reason, state }); return this.getTask(input.taskId); });
  }
  attempts(taskId: string): T.TaskAttempt[] { id(taskId); this.getTask(taskId); return this.all("SELECT * FROM attempts WHERE task_id=? ORDER BY number", taskId).map(row => ({ attemptId: row.id as string, taskId, number: row.number as number, status: row.state as T.TaskAttempt["status"], claim: parse<T.TaskClaim>(row.claim), result: row.result === null ? null : parse<T.JsonObject>(row.result) })); }
  events(afterSequence = 0): T.QueueEvent[] { integer(afterSequence); return this.all("SELECT * FROM queue_events WHERE sequence>? ORDER BY sequence", afterSequence).map(row => ({ sequence: row.sequence as number, kind: row.kind as string, taskId: row.task_id as string | null, data: parse<T.JsonObject>(row.data), createdAt: row.created_at as string })); }
  close(): void { if (!this.closed) { this.storage.close(); this.closed = true; } }
}
