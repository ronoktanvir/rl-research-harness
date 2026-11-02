import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { openDatabase } from "./database.js";
import { validateManifest } from "./manifest.js";
import { decimalMoney, digestValue, encode, enumValue, fail, hash, id, ids, integer, jsonObject, jsonValue, keys, money, parse, policyScope, snapshot, text, timestamp } from "./validation.js";
import type * as T from "./types.js";

type Row = Record<string, string | number | bigint | null | Uint8Array>;
type StoredAction = Omit<T.AdmitActionInput, "reservation"> & {
  manifestDigest: string; backendKey: string; payloadDigest: string; scopeIds: string[]; cleanupTargetActionId?: string;
  reservation: { amountMicrodollars: string; category: T.ChargeCategory; basis: string };
};

/** All mutations are synchronous transactions. External work must happen after these methods return. */
export class LocalExperimentLedger implements T.ExperimentLedger {
  private readonly storage;
  private closed = false;
  private readonly now: () => Date;
  constructor(options: T.LedgerOptions) {
    const path = options.path;
    this.now = options.now ?? (() => new Date());
    this.storage = openDatabase(path);
    try {
      this.transaction(() => {
        this.run("INSERT OR IGNORE INTO scopes(id) VALUES('global')");
        const epoch = this.getScope("global").epoch + 1; integer(epoch);
        this.run("UPDATE scopes SET epoch=? WHERE id='global'", epoch);
        this.event("controller_opened", "global", { epoch: this.getScope("global").epoch });
        // The previous process may have sent each request. Restart never proves nonacceptance.
        for (const row of this.all("SELECT id FROM actions WHERE state='dispatching'")) {
          this.run("UPDATE actions SET state='unknown' WHERE id=?", row.id as string);
          this.run("UPDATE outbox SET state='done' WHERE action_id=?", row.id as string);
          this.event("dispatch_recovered_unknown", row.id as string, {});
        }
      });
    } catch (error) { this.storage.close(); throw error; }
  }
  private assertOpen(): void { if (this.closed) fail("closed", "Ledger is closed"); }
  private get(sql: string, ...values: SQLInputValue[]): Row | undefined { this.assertOpen(); return this.storage.db.prepare(sql).get(...values) as Row | undefined; }
  private all(sql: string, ...values: SQLInputValue[]): Row[] { this.assertOpen(); return this.storage.db.prepare(sql).all(...values) as Row[]; }
  private run(sql: string, ...values: SQLInputValue[]): void { this.assertOpen(); this.storage.db.prepare(sql).run(...values); }
  private transaction<R>(fn: () => R): R {
    this.assertOpen(); this.storage.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.storage.db.exec("COMMIT"); return value; }
    catch (error) { this.storage.db.exec("ROLLBACK"); throw error; }
  }
  private clock(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail("invalid", "Controller clock is invalid");
    return value.toISOString();
  }
  private event(kind: string, entity: string, payload: T.JsonObject): void {
    this.run("INSERT INTO events(kind,entity,payload,created_at) VALUES(?,?,?,?)", kind, entity, encode(payload), this.clock());
  }
  private requireRow(sql: string, ...values: SQLInputValue[]): Row { return this.get(sql, ...values) ?? fail("missing", "Referenced ledger record does not exist"); }
  private same(row: Row, digest: string): void { if (row.digest !== digest) fail("conflict", "Identity is already bound to different content"); }
  private ensureScope(scope: string): void { this.run("INSERT OR IGNORE INTO scopes(id) VALUES(?)", scope); }

  registerManifest(raw: T.ExperimentManifest): T.ManifestRecord {
    const input = snapshot(raw); validateManifest(input); const data = encode(input), digest = hash(input);
    return this.transaction(() => {
      if (!this.get("SELECT digest FROM manifests WHERE digest=?", digest)) {
        this.run("INSERT INTO manifests VALUES(?,?)", digest, data);
        this.event("manifest_registered", digest, { digest });
      }
      return this.getManifest(digest);
    });
  }
  getManifest(digest: string): T.ManifestRecord { digestValue(digest); return { digest, manifest: parse<T.ExperimentManifest>(this.requireRow("SELECT data FROM manifests WHERE digest=?", digest).data) }; }
  createRun(raw: T.CreateRunInput): T.RunRecord {
    const input = snapshot(raw);
    keys(input, ["runId", "projectId", "manifestDigest", "replicaId", "lineage"], ["runId", "projectId", "manifestDigest", "replicaId"]);
    id(input.runId); id(input.projectId); policyScope(`project:${input.projectId}`); id(input.replicaId); digestValue(input.manifestDigest);
    if (input.lineage !== undefined) { keys(input.lineage, ["parentRunId", "checkpointDigest"]); id(input.lineage.parentRunId); digestValue(input.lineage.checkpointDigest); }
    const digest = hash(input);
    return this.transaction(() => {
      const existing = this.get("SELECT digest FROM runs WHERE id=?", input.runId);
      if (existing) { this.same(existing, digest); return this.getRun(input.runId); }
      this.getManifest(input.manifestDigest);
      if (this.get("SELECT id FROM runs WHERE project=? AND manifest=? AND replica=?", input.projectId, input.manifestDigest, input.replicaId)) fail("conflict", "Replica identity is already registered under another run ID");
      if (input.lineage && this.getRun(input.lineage.parentRunId).projectId !== input.projectId) fail("invalid", "Lineage must stay within its project");
      this.ensureScope(`project:${input.projectId}`);
      this.run("INSERT INTO runs VALUES(?,?,?,?,?,?)", input.runId, input.projectId, input.manifestDigest, input.replicaId, encode(input), digest);
      this.event("run_created", input.runId, { manifestDigest: input.manifestDigest, projectId: input.projectId });
      return this.getRun(input.runId);
    });
  }
  private latestFact(dimension: string, entity: string): Row | undefined { return this.get("SELECT * FROM facts WHERE dimension=? AND entity=? ORDER BY sequence DESC LIMIT 1", dimension, entity); }
  getRun(runId: string): T.RunRecord {
    id(runId); const input = parse<T.CreateRunInput>(this.requireRow("SELECT data FROM runs WHERE id=?", runId).data);
    return { ...input, execution: (this.latestFact("execution", runId)?.state ?? "unknown") as T.ExecutionState, evaluation: (this.latestFact("evaluation", runId)?.state ?? "unassessed") as T.EvaluationState };
  }

  listRuns(projectId?: string): T.RunRecord[] {
    if (projectId !== undefined) id(projectId);
    const rows = projectId === undefined ? this.all("SELECT id FROM runs ORDER BY rowid") : this.all("SELECT id FROM runs WHERE project=? ORDER BY rowid", projectId);
    return rows.map(row => this.getRun(row.id as string));
  }

  configureBudget(raw: T.BudgetInput): T.BudgetRecord {
    const input = snapshot(raw); keys(input, ["scopeId", "parentScopeId", "expectedRevision", "limitMicrodollars"]);
    id(input.scopeId); integer(input.expectedRevision); integer(input.expectedRevision + 1); money(input.limitMicrodollars);
    if (input.parentScopeId !== null) id(input.parentScopeId);
    if (input.scopeId === "global" ? input.parentScopeId !== null : input.parentScopeId === null) fail("invalid", "Only global may be the root budget");
    if (input.scopeId.startsWith("project:") && input.parentScopeId !== "global") fail("invalid", "Project budgets must descend directly from global");
    return this.transaction(() => {
      const existing = this.get("SELECT * FROM budgets WHERE id=?", input.scopeId);
      if (existing && existing.parent !== input.parentScopeId) fail("conflict", "Budget ancestry is immutable");
      if (Number(existing?.revision ?? 0) !== input.expectedRevision) fail("conflict", "Budget revision changed");
      if (input.parentScopeId !== null) this.requireRow("SELECT id FROM budgets WHERE id=?", input.parentScopeId);
      if (input.parentScopeId === input.scopeId) fail("invalid", "Budget cannot parent itself");
      this.run("INSERT INTO budgets VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,limit_amount=excluded.limit_amount", input.scopeId, input.parentScopeId, input.expectedRevision + 1, input.limitMicrodollars.toString());
      this.event("budget_configured", input.scopeId, { parentScopeId: input.parentScopeId, revision: input.expectedRevision + 1, limitMicrodollars: input.limitMicrodollars.toString() });
      return this.getBudget(input.scopeId);
    });
  }
  getBudget(scopeId: string): T.BudgetRecord {
    id(scopeId); const row = this.requireRow("SELECT * FROM budgets WHERE id=?", scopeId);
    let charged = 0n, outstanding = 0n;
    for (const item of this.all("SELECT action_id FROM action_scopes WHERE scope=?", scopeId)) {
      const reservation = this.getAction(item.action_id as string).reservation;
      charged += reservation.chargedMicrodollars; outstanding += reservation.outstandingMicrodollars;
    }
    const limit = BigInt(row.limit_amount as string);
    return { scopeId, parentScopeId: row.parent as string | null, revision: row.revision as number, limitMicrodollars: limit, chargedMicrodollars: charged, outstandingMicrodollars: outstanding, availableMicrodollars: limit - charged - outstanding };
  }
  configurePolicy(raw: T.PolicyInput): T.PolicyRecord {
    const input = snapshot(raw); keys(input, ["scopeId", "expectedVersion", "allowedBackends", "allowedOperations", "requiredChecks"]);
    policyScope(input.scopeId); integer(input.expectedVersion); integer(input.expectedVersion + 1); ids(input.allowedBackends); ids(input.allowedOperations); ids(input.requiredChecks);
    return this.transaction(() => {
      const old = this.get("SELECT version FROM policies WHERE scope=?", input.scopeId);
      if (Number(old?.version ?? 0) !== input.expectedVersion) fail("conflict", "Policy version changed");
      this.ensureScope(input.scopeId);
      const policy = { scopeId: input.scopeId, version: input.expectedVersion + 1, allowedBackends: input.allowedBackends, allowedOperations: input.allowedOperations, requiredChecks: input.requiredChecks };
      this.run("INSERT INTO policies VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET version=excluded.version,data=excluded.data", input.scopeId, policy.version, encode(policy));
      // Any policy change revokes claims issued under the previous authority.
      const nextEpoch = this.getScope(input.scopeId).epoch + 1; integer(nextEpoch);
      this.run("UPDATE scopes SET epoch=? WHERE id=?", nextEpoch, input.scopeId);
      this.event("policy_configured", input.scopeId, policy);
      return policy;
    });
  }
  getScope(scopeId: string): T.ScopeState {
    policyScope(scopeId); const row = this.requireRow("SELECT * FROM scopes WHERE id=?", scopeId);
    return { scopeId, stopped: row.stopped === 1, epoch: row.epoch as number, reason: row.reason as string };
  }
  private changeStop(raw: T.StopInput, stopped: boolean): T.ScopeState {
    const input = snapshot(raw); keys(input, ["scopeId", "expectedEpoch", "reason"]); policyScope(input.scopeId); integer(input.expectedEpoch); text(input.reason);
    return this.transaction(() => {
      if (!this.get("SELECT id FROM scopes WHERE id=?", input.scopeId) && stopped && input.expectedEpoch === 0) this.ensureScope(input.scopeId);
      const old = this.getScope(input.scopeId);
      if (old.epoch !== input.expectedEpoch) fail("conflict", "Authority epoch changed");
      integer(old.epoch + 1);
      this.run("UPDATE scopes SET stopped=?,epoch=epoch+1,reason=? WHERE id=?", stopped ? 1 : 0, input.reason, input.scopeId);
      this.event(stopped ? "scope_stopped" : "scope_resumed", input.scopeId, { reason: input.reason, epoch: old.epoch + 1 });
      return this.getScope(input.scopeId);
    });
  }
  stopScope(input: T.StopInput): T.ScopeState { return this.changeStop(input, true); }
  resumeScope(input: T.StopInput): T.ScopeState { return this.changeStop(input, false); }

  recordValidation(raw: T.ValidationInput): void {
    const input = snapshot(raw); keys(input, ["validationId", "manifestDigest", "check", "source", "sequence", "status", "evidence"]);
    id(input.validationId); digestValue(input.manifestDigest); id(input.check); id(input.source); integer(input.sequence); enumValue(input.status, ["passed", "failed"]); jsonObject(input.evidence);
    const digest = hash(input);
    this.transaction(() => {
      const existing = this.get("SELECT digest FROM validations WHERE id=?", input.validationId);
      if (existing) { this.same(existing, digest); return; }
      this.getManifest(input.manifestDigest);
      const latest = this.get("SELECT * FROM validations WHERE manifest=? AND check_name=? ORDER BY sequence DESC LIMIT 1", input.manifestDigest, input.check);
      if (latest && latest.source !== input.source) fail("conflict", "Validation stream source is immutable");
      if (this.get("SELECT id FROM validations WHERE manifest=? AND check_name=? AND sequence=?", input.manifestDigest, input.check, input.sequence)) fail("conflict", "Validation sequence already recorded");
      this.run("INSERT INTO validations VALUES(?,?,?,?,?,?,?,?)", input.validationId, input.manifestDigest, input.check, input.source, input.sequence, input.status, encode(input), digest);
      this.event("validation_recorded", input.validationId, { manifestDigest: input.manifestDigest, check: input.check, sequence: input.sequence, status: input.status });
    });
  }
  private ancestry(scopeId: string, projectId: string): string[] {
    const result: string[] = []; let next: string | null = scopeId;
    while (next !== null) {
      if (result.includes(next) || result.length >= 100) fail("invalid", "Invalid budget ancestry");
      result.push(next); next = this.requireRow("SELECT parent FROM budgets WHERE id=?", next).parent as string | null;
    }
    if (!result.includes(`project:${projectId}`) || result.at(-1) !== "global") fail("denied", "Budget does not descend from this project's allowance");
    return result;
  }
  private assertPolicy(run: T.RunRecord, backend: string, operation: string, cleanup = false): void {
    for (const scopeId of ["global", `project:${run.projectId}`]) {
      if (this.getScope(scopeId).stopped && !cleanup) fail("denied", `Scope ${scopeId} is stopped`);
      const policy = parse<T.PolicyRecord>(this.requireRow("SELECT data FROM policies WHERE scope=?", scopeId).data);
      if (!policy.allowedBackends.includes(backend) || !policy.allowedOperations.includes(operation)) fail("denied", "Backend or operation is not allowed");
      for (const check of cleanup ? [] : policy.requiredChecks) {
        const validation = this.get("SELECT status FROM validations WHERE manifest=? AND check_name=? ORDER BY sequence DESC LIMIT 1", run.manifestDigest, check);
        if (validation?.status !== "passed") fail("denied", `Manifest check ${check} has not passed`);
      }
    }
  }
  private assertAllowance(run: T.RunRecord, scopes: string[], additional: bigint, cleanup = false, zeroCostCleanup = false): void {
    // Cleanup with no additional liability must remain possible when a cap is already exceeded.
    if (cleanup && zeroCostCleanup) return;
    for (const scope of scopes) {
      if (!cleanup) for (const row of this.all("SELECT action_id FROM action_scopes WHERE scope=?", scope)) {
        const reservation = this.getAction(row.action_id as string).reservation;
        if (!reservation.finalized && reservation.chargedMicrodollars > 0n && reservation.chargedMicrodollars >= reservation.amountMicrodollars) fail("denied", "An unsettled action exhausted its bound; remaining liability requires reconciliation");
      }
      if (this.getBudget(scope).availableMicrodollars < additional) fail("denied", `Budget ${scope} has insufficient headroom`);
    }
    let committed = additional;
    for (const row of this.all("SELECT id FROM actions WHERE run_id=?", run.runId)) {
      const reservation = this.getAction(row.id as string).reservation;
      committed += reservation.chargedMicrodollars + reservation.outstandingMicrodollars;
    }
    if (committed > BigInt(this.getManifest(run.manifestDigest).manifest.resources.maxCostMicrodollars)) fail("denied", "Manifest run-cost allowance is exhausted");
  }
  admitAction(raw: T.AdmitActionInput): T.ActionRecord { return this.admit(snapshot(raw)); }
  admitCleanup(raw: T.AdmitCleanupInput): T.ActionRecord {
    const input = snapshot(raw); keys(input, ["targetActionId", "operation", "operationRevision", "reservation"]);
    id(input.targetActionId); enumValue(input.operation, ["cancel", "release"]); integer(input.operationRevision, 1);
    const target = this.getAction(input.targetActionId);
    return this.admit({ runId: target.runId, operation: input.operation, operationRevision: input.operationRevision, backend: target.backend,
      payload: { targetActionId: target.actionId, targetBackendKey: target.backendKey, targetManifestDigest: target.manifestDigest, cleanup: input.operation },
      reservation: input.reservation, budgetScopeId: target.reservation.scopeIds[0]! }, target.actionId);
  }
  private admit(input: T.AdmitActionInput, cleanupTargetActionId?: string): T.ActionRecord { keys(input, ["runId", "operation", "operationRevision", "backend", "payload", "reservation", "budgetScopeId"], ["runId", "operation", "operationRevision", "backend", "payload", "reservation"]);
    id(input.runId); id(input.operation); integer(input.operationRevision, 1); id(input.backend); jsonObject(input.payload);
    keys(input.reservation, ["amountMicrodollars", "category", "basis"]); money(input.reservation.amountMicrodollars); enumValue(input.reservation.category, ["model", "compute", "storage", "other"]); text(input.reservation.basis);
    if (input.budgetScopeId !== undefined) id(input.budgetScopeId);
    return this.transaction(() => {
      const run = this.getRun(input.runId);
      const scopeId = input.budgetScopeId ?? `project:${run.projectId}`;
      const actionId = `action:${hash([input.runId, input.operation, input.operationRevision])}`;
      const stored: StoredAction = { ...input, budgetScopeId: scopeId, manifestDigest: run.manifestDigest, backendKey: actionId, payloadDigest: hash(input.payload), scopeIds: this.ancestry(scopeId, run.projectId), ...(cleanupTargetActionId ? { cleanupTargetActionId } : {}), reservation: { ...input.reservation, amountMicrodollars: input.reservation.amountMicrodollars.toString() } };
      const digest = hash(stored), existing = this.get("SELECT digest FROM actions WHERE id=?", actionId);
      if (existing) { this.same(existing, digest); return this.getAction(actionId); }
      if (cleanupTargetActionId !== undefined) {
        const target = this.getAction(cleanupTargetActionId);
        if (!["dispatching", "unknown", "acknowledged"].includes(target.state) || target.cleanupTargetActionId !== null) fail("denied", "Cleanup must target an original possibly accepted action");
      }
      this.assertPolicy(run, input.backend, input.operation, cleanupTargetActionId !== undefined); this.assertAllowance(run, stored.scopeIds, input.reservation.amountMicrodollars, cleanupTargetActionId !== undefined, input.reservation.amountMicrodollars === 0n);
      this.run("INSERT INTO actions(id,run_id,operation,revision,data,digest,state) VALUES(?,?,?,?,?,?,'queued')", actionId, input.runId, input.operation, input.operationRevision, encode(stored), digest);
      for (const scope of stored.scopeIds) this.run("INSERT INTO action_scopes VALUES(?,?)", actionId, scope);
      this.run("INSERT INTO outbox VALUES(?,'queued')", actionId);
      this.event("action_admitted", actionId, { runId: run.runId, amountMicrodollars: input.reservation.amountMicrodollars.toString(), scopeIds: stored.scopeIds });
      return this.getAction(actionId);
    });
  }
  getAction(actionId: string): T.ActionRecord {
    id(actionId); const row = this.requireRow("SELECT * FROM actions WHERE id=?", actionId), data = parse<StoredAction>(row.data);
    const amount = BigInt(data.reservation.amountMicrodollars);
    let charged = 0n; for (const item of this.all("SELECT amount FROM charges WHERE action_id=?", actionId)) charged += BigInt(item.amount as string);
    return { actionId, runId: data.runId, manifestDigest: data.manifestDigest, operation: data.operation, operationRevision: data.operationRevision, backend: data.backend, backendKey: data.backendKey, payload: data.payload, payloadDigest: data.payloadDigest, state: row.state as T.DispatchState, attemptId: row.attempt as string | null, jobId: row.job as string | null,
      reservation: { amountMicrodollars: amount, category: data.reservation.category, basis: data.reservation.basis, scopeIds: data.scopeIds, chargedMicrodollars: charged, outstandingMicrodollars: row.finalized === 1 || charged > amount ? 0n : amount - charged, finalized: row.finalized === 1 },
      allocation: (this.latestFact("allocation", actionId)?.state ?? "unknown") as T.AllocationState, cleanupTargetActionId: data.cleanupTargetActionId ?? null };
  }
  listActions(projectId?: string): T.ActionRecord[] {
    if (projectId !== undefined) id(projectId);
    const rows = projectId === undefined ? this.all("SELECT id FROM actions ORDER BY rowid") : this.all("SELECT actions.id FROM actions JOIN runs ON runs.id=actions.run_id WHERE runs.project=? ORDER BY actions.rowid", projectId);
    return rows.map(row => this.getAction(row.id as string));
  }

  claimDispatch(raw: T.ClaimDispatchInput): T.DispatchClaim | null {
    const input = snapshot(raw); keys(input, ["workerId", "deadlineAt"]); id(input.workerId); timestamp(input.deadlineAt);
    const now = Date.parse(this.clock()), deadline = Date.parse(input.deadlineAt);
    if (deadline <= now) fail("invalid", "Dispatch deadline must be in the future");
    return this.transaction(() => {
      for (const row of this.all("SELECT action_id FROM outbox WHERE state='queued' ORDER BY rowid")) {
        const action = this.getAction(row.action_id as string), run = this.getRun(action.runId);
        try { this.assertPolicy(run, action.backend, action.operation, action.cleanupTargetActionId !== null); this.assertAllowance(run, action.reservation.scopeIds, 0n, action.cleanupTargetActionId !== null, action.reservation.amountMicrodollars === 0n && action.reservation.chargedMicrodollars === 0n); }
        catch (error) { if (error instanceof Error && "code" in error && (error.code === "denied" || error.code === "missing")) continue; throw error; }
        const manifest = this.getManifest(run.manifestDigest).manifest;
        if (deadline - now > manifest.resources.maxDurationSeconds * 1000) fail("invalid", "Dispatch deadline exceeds the manifest duration bound");
        const attemptId = `attempt:${randomUUID()}`;
        this.run("UPDATE actions SET state='dispatching',attempt=?,job=NULL WHERE id=?", attemptId, action.actionId);
        this.run("UPDATE outbox SET state='claimed' WHERE action_id=?", action.actionId);
        const claim: T.DispatchClaim = { action: this.getAction(action.actionId), attemptId, workerId: input.workerId, deadlineAt: input.deadlineAt, authority: { globalEpoch: this.getScope("global").epoch, projectEpoch: this.getScope(`project:${run.projectId}`).epoch } };
        this.run("INSERT INTO attempts VALUES(?,?,?)", attemptId, action.actionId, serializeClaim(claim));
        this.event("dispatch_claimed", action.actionId, { attemptId, workerId: input.workerId, deadlineAt: input.deadlineAt, authority: claim.authority });
        return claim;
      }
      return null;
    });
  }
  isDispatchAuthorized(raw: T.DispatchClaim): boolean {
    this.assertOpen();
    try {
      const claim = snapshot(raw), attempt = this.get("SELECT data,action_id FROM attempts WHERE id=?", claim.attemptId);
      if (!attempt || serializeClaim(claim) !== attempt.data) return false;
      const action = this.getAction(attempt.action_id as string), run = this.getRun(action.runId);
      if (action.state !== "dispatching" || action.attemptId !== claim.attemptId || Date.parse(claim.deadlineAt) <= Date.parse(this.clock())) return false;
      const global = this.getScope("global"), project = this.getScope(`project:${run.projectId}`);
      if (global.epoch !== claim.authority.globalEpoch || project.epoch !== claim.authority.projectEpoch || ((global.stopped || project.stopped) && action.cleanupTargetActionId === null)) return false;
      this.assertPolicy(run, action.backend, action.operation, action.cleanupTargetActionId !== null); this.assertAllowance(run, action.reservation.scopeIds, 0n, action.cleanupTargetActionId !== null, action.reservation.amountMicrodollars === 0n && action.reservation.chargedMicrodollars === 0n);
      return true;
    } catch { return false; }
  }
  recordDispatchOutcome(raw: T.DispatchOutcomeInput): T.ActionRecord {
    const input = snapshot(raw); keys(input, ["receiptId", "actionId", "attemptId", "manifestDigest", "backend", "outcome", "jobId", "evidence"], ["receiptId", "actionId", "attemptId", "manifestDigest", "backend", "outcome", "evidence"]);
    for (const value of [input.receiptId, input.actionId, input.attemptId, input.backend]) id(value);
    digestValue(input.manifestDigest); enumValue(input.outcome, ["accepted", "not_accepted", "unknown"]); jsonObject(input.evidence);
    if (input.outcome === "accepted") text(input.jobId, "backend job ID");
    else if (input.jobId !== undefined) fail("invalid", "Only accepted outcomes may carry a job ID");
    const digest = hash(input);
    return this.transaction(() => {
      const existing = this.get("SELECT digest FROM receipts WHERE id=?", input.receiptId);
      if (existing) { this.same(existing, digest); return this.getAction(input.actionId); }
      const action = this.getAction(input.actionId);
      if (action.attemptId !== input.attemptId || action.manifestDigest !== input.manifestDigest || action.backend !== input.backend) fail("conflict", "Receipt does not match action, manifest, backend and current attempt");
      const state: T.DispatchState = input.outcome === "accepted" ? "acknowledged" : input.outcome === "not_accepted" ? "confirmed_not_accepted" : "unknown";
      if (!["dispatching", "unknown"].includes(action.state) && (action.state !== state || action.jobId !== (input.jobId ?? null))) fail("conflict", "Receipt contradicts an already confirmed dispatch outcome");
      if (action.state === "queued") fail("conflict", "Cannot acknowledge an unclaimed action");
      this.run("INSERT INTO receipts VALUES(?,?,?,?)", input.receiptId, input.actionId, encode(input), digest);
      this.run("UPDATE actions SET state=?,job=? WHERE id=?", state, input.jobId ?? null, input.actionId);
      this.run("UPDATE outbox SET state='done' WHERE action_id=?", input.actionId);
      this.event("dispatch_outcome", input.actionId, { receiptId: input.receiptId, attemptId: input.attemptId, outcome: input.outcome, jobId: input.jobId ?? null });
      return this.getAction(input.actionId);
    });
  }
  requeueAction(actionId: string): T.ActionRecord {
    id(actionId);
    return this.transaction(() => {
      const action = this.getAction(actionId);
      if (action.state !== "confirmed_not_accepted" || action.reservation.finalized || action.reservation.chargedMicrodollars !== 0n) fail("denied", "Only confirmed nonacceptance with an unused, retained bound can be requeued");
      const run = this.getRun(action.runId); this.assertPolicy(run, action.backend, action.operation, action.cleanupTargetActionId !== null); this.assertAllowance(run, action.reservation.scopeIds, 0n, action.cleanupTargetActionId !== null, action.reservation.amountMicrodollars === 0n && action.reservation.chargedMicrodollars === 0n);
      this.run("UPDATE actions SET state='queued' WHERE id=?", actionId);
      this.run("UPDATE outbox SET state='queued' WHERE action_id=?", actionId);
      this.event("action_requeued", actionId, { previousAttemptId: action.attemptId });
      return this.getAction(actionId);
    });
  }

  appendObservation(raw: T.ObservationInput): T.ObservationRecord {
    const input = snapshot(raw); keys(input, ["eventId", "projectId", "runId", "actionId", "jobId", "source", "sequence", "observedAt", "payload"]);
    for (const value of [input.eventId, input.projectId, input.source]) id(value);
    integer(input.sequence); timestamp(input.observedAt); jsonObject(input.payload);
    if (input.runId !== null) id(input.runId); if (input.actionId !== null) id(input.actionId); if (input.jobId !== null) text(input.jobId);
    const digest = hash(input);
    return this.transaction(() => {
      const existing = this.get("SELECT digest FROM observations WHERE id=?", input.eventId);
      if (existing) { this.same(existing, digest); return this.getObservation(input.eventId)!; }
      if (input.runId !== null && this.getRun(input.runId).projectId !== input.projectId) fail("conflict", "Observation refers to a different project");
      if (input.actionId !== null) {
        const action = this.getAction(input.actionId);
        if (input.runId !== action.runId || (input.jobId !== null && input.jobId !== action.jobId)) fail("conflict", "Observation action/run/job identities disagree");
      } else if (input.jobId !== null) fail("invalid", "A backend job reference requires its action identity");
      this.run("INSERT INTO observations VALUES(?,?,?,?)", input.eventId, input.projectId, encode(input), digest);
      this.event("observation_appended", input.eventId, { projectId: input.projectId, digest, runId: input.runId });
      return { ...input, digest };
    });
  }
  getObservation(eventId: string): T.ObservationRecord | null {
    id(eventId); const row = this.get("SELECT data,digest FROM observations WHERE id=?", eventId);
    return row ? { ...parse<T.ObservationInput>(row.data), digest: row.digest as string } : null;
  }
  listObservations(projectId: string): T.ObservationRecord[] {
    id(projectId); return this.all("SELECT id FROM observations WHERE project=? ORDER BY rowid", projectId).map(row => this.getObservation(row.id as string)!);
  }

  private recordFact(input: T.FactInput & { state: string }, dimension: string, entity: string, full: T.JsonObject): void {
    id(input.eventId); id(input.source); integer(input.sequence); jsonObject(input.evidence);
    const digest = hash(full), existing = this.get("SELECT digest FROM facts WHERE id=?", input.eventId);
    if (existing) { this.same(existing, digest); return; }
    const latest = this.latestFact(dimension, entity);
    if (latest && latest.source !== input.source) fail("conflict", "Confirmed fact stream source is immutable; preserve other sources as observations");
    if (this.get("SELECT id FROM facts WHERE dimension=? AND entity=? AND sequence=?", dimension, entity, input.sequence)) fail("conflict", "Fact sequence is already occupied");
    if (latest && input.sequence > Number(latest.sequence)) {
      if (dimension === "execution" && ["succeeded", "failed", "cancelled"].includes(latest.state as string) && input.state !== latest.state) fail("conflict", "Terminal execution is immutable; create a linked run for further execution");
      if (dimension === "allocation" && latest.state === "released" && input.state !== "released") fail("conflict", "Released allocation cannot be reactivated under the same action");
    }
    this.run("INSERT INTO facts VALUES(?,?,?,?,?,?,?,?)", input.eventId, dimension, entity, input.source, input.sequence, input.state, encode(full), digest);
    this.event(`${dimension}_confirmed`, entity, { eventId: input.eventId, source: input.source, sequence: input.sequence, state: input.state, applied: !latest || input.sequence > Number(latest.sequence) });
  }
  recordExecution(raw: T.ExecutionInput): void {
    const input = snapshot(raw); keys(input, ["eventId", "source", "sequence", "evidence", "runId", "state"]); id(input.runId); enumValue(input.state, ["running", "succeeded", "failed", "cancelled"]);
    this.transaction(() => { this.getRun(input.runId); this.recordFact(input, "execution", input.runId, jsonValue(input) as T.JsonObject); });
  }
  recordAllocation(raw: T.AllocationInput): void {
    const input = snapshot(raw); keys(input, ["eventId", "source", "sequence", "evidence", "actionId", "state"]); id(input.actionId); enumValue(input.state, ["active", "released"]);
    this.transaction(() => { this.getAction(input.actionId); this.recordFact(input, "allocation", input.actionId, jsonValue(input) as T.JsonObject); });
  }
  recordEvaluation(raw: T.EvaluationInput): void {
    const input = snapshot(raw); keys(input, ["eventId", "source", "sequence", "evidence", "runId", "evaluatorVersion", "state"]); id(input.runId); text(input.evaluatorVersion); enumValue(input.state, ["valid", "invalid", "inconclusive"]);
    this.transaction(() => {
      const run = this.getRun(input.runId);
      if (this.getManifest(run.manifestDigest).manifest.evaluator.version !== input.evaluatorVersion) fail("conflict", "Evaluation version does not match the manifest");
      this.recordFact(input, "evaluation", input.runId, jsonValue(input) as T.JsonObject);
    });
  }
  recordCharge(raw: T.ChargeInput): T.ActionRecord {
    const input = snapshot(raw); keys(input, ["chargeId", "actionId", "amountMicrodollars", "source", "evidence"]);
    id(input.chargeId); id(input.actionId); money(input.amountMicrodollars); id(input.source); jsonObject(input.evidence);
    const normalized = { ...input, amountMicrodollars: input.amountMicrodollars.toString() }, digest = hash(normalized);
    return this.transaction(() => {
      const existing = this.get("SELECT digest FROM charges WHERE id=?", input.chargeId);
      if (existing) { this.same(existing, digest); return this.getAction(input.actionId); }
      this.getAction(input.actionId);
      this.run("INSERT INTO charges VALUES(?,?,?,?,?)", input.chargeId, input.actionId, input.amountMicrodollars.toString(), encode(normalized), digest);
      // Late charges are facts even after settlement. Reopen uncertainty until re-settled.
      this.run("UPDATE actions SET finalized=0 WHERE id=?", input.actionId);
      this.event("charge_recorded", input.actionId, { chargeId: input.chargeId, amountMicrodollars: input.amountMicrodollars.toString(), source: input.source });
      return this.getAction(input.actionId);
    });
  }
  finalizeReservation(raw: T.FinalizeReservationInput): T.ActionRecord {
    const input = snapshot(raw); keys(input, ["settlementId", "actionId", "finalChargeMicrodollars", "source", "exposureEnded", "evidence"]);
    id(input.settlementId); id(input.actionId); id(input.source); totalMoney(input.finalChargeMicrodollars); jsonObject(input.evidence);
    if (input.exposureEnded !== true || Object.keys(input.evidence).length === 0) fail("invalid", "Settlement requires evidence that exposure ended");
    const normalized = { ...input, finalChargeMicrodollars: input.finalChargeMicrodollars.toString() }, digest = hash(normalized);
    return this.transaction(() => {
      const existing = this.get("SELECT digest FROM settlements WHERE id=?", input.settlementId);
      if (existing) { this.same(existing, digest); return this.getAction(input.actionId); }
      const action = this.getAction(input.actionId);
      if (!["acknowledged", "confirmed_not_accepted"].includes(action.state)) fail("denied", "Unknown or undispatched exposure cannot be finalized");
      if (input.finalChargeMicrodollars !== action.reservation.chargedMicrodollars) fail("conflict", "Final charge total does not match recorded charges");
      if (action.state === "acknowledged" && ["compute", "storage"].includes(action.reservation.category) && action.allocation !== "released") fail("denied", "Paid allocation release is unconfirmed");
      this.run("INSERT INTO settlements VALUES(?,?,?,?)", input.settlementId, input.actionId, encode(normalized), digest);
      this.run("UPDATE actions SET finalized=1 WHERE id=?", input.actionId);
      this.event("reservation_finalized", input.actionId, { settlementId: input.settlementId, finalChargeMicrodollars: input.finalChargeMicrodollars.toString() });
      return this.getAction(input.actionId);
    });
  }
  events(afterSequence = 0): T.LedgerEvent[] {
    integer(afterSequence); return this.all("SELECT * FROM events WHERE sequence>? ORDER BY sequence", afterSequence).map(row => ({ sequence: row.sequence as number, kind: row.kind as string, entityId: row.entity as string, payload: parse<T.JsonObject>(row.payload), createdAt: row.created_at as string }));
  }
  close(): void { if (!this.closed) { this.storage.close(); this.closed = true; } }
}

/** Only declared monetary fields use BigInt conversion; payload types must stay identical. */
function serializeClaim(claim: T.DispatchClaim): string {
  const reservation = claim.action.reservation;
  money(reservation.amountMicrodollars);
  totalMoney(reservation.chargedMicrodollars); totalMoney(reservation.outstandingMicrodollars);
  return encode({ ...claim, action: { ...claim.action, reservation: { ...reservation,
    amountMicrodollars: reservation.amountMicrodollars.toString(),
    chargedMicrodollars: reservation.chargedMicrodollars.toString(),
    outstandingMicrodollars: reservation.outstandingMicrodollars.toString(),
  } } });
}
function totalMoney(value: unknown): asserts value is bigint {
  if (typeof value !== "bigint" || value < 0n) fail("invalid", "Accounting total must be nonnegative bigint microdollars");
}
