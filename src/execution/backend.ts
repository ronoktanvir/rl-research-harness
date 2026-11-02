import { randomUUID } from "node:crypto";
import type { BackendReply, BackendRequest, ExperimentBackend } from "../controller/dispatcher.ts";
import type { ActionRecord, DispatchClaim, ExperimentLedger, JsonObject, ObservationRecord } from "../ledger/types.ts";
import { LedgerError, encode, hash, id, jsonValue, keys, digestValue } from "../ledger/validation.ts";
import { createJobDeclaration, createSupervisedWorker } from "./worker.ts";
import type { WorkerResult } from "./worker.ts";
import type { JobDeclaration, JobJournal, JobRecord, SystemdTransport } from "./types.ts";

/** A trusted deployment integration, never model output. Preparation must be read-only.
 * Byte hashes alone do not establish immutability or native trainer qualification.
 * authorizeDeployment is checked again at the actual manager-call boundary.
 */
export interface PreparedLocalLaunch {
  declaration: JobDeclaration;
  evidence: JsonObject;
  authorizeDeployment: () => boolean;
}
export interface SupervisedBackendOptions {
  name: string;
  workerId: string;
  ledger: ExperimentLedger;
  journal: JobJournal;
  transport: SystemdTransport;
  prepareLaunch: (claim: Readonly<DispatchClaim>, signal: AbortSignal) => Promise<PreparedLocalLaunch | null>;
  now?: () => Date;
  callTimeoutMs?: number;
}
export interface SupervisedExperimentBackend extends ExperimentBackend {
  /** Observe a launch, retain evidence and project unambiguous execution only.
   * This never changes evaluation, allocation, charges or reservations.
   */
  observe(actionId: string, signal: AbortSignal): Promise<{
    result: WorkerResult; observation: ObservationRecord; executionProjected: boolean;
  }>;
}

function frozen<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
function boundedEvidence(value: JsonObject): JsonObject {
  const copy = jsonValue(structuredClone(value));
  if (!copy || typeof copy !== "object" || Array.isArray(copy) || Buffer.byteLength(encode(copy)) > 16_384) {
    throw new Error("Deployment evidence must be a JSON object of at most 16 KiB");
  }
  return copy;
}
function request(action: ActionRecord, attemptId: string): BackendRequest {
  return { actionId: action.actionId, attemptId, manifestDigest: action.manifestDigest,
    backend: action.backend, backendKey: action.backendKey };
}

/** One controller owns both stores. Durable operation intent prevents replay after
 * a crash between this bridge and the worker journal; reconciliation is query-only.
 * There is deliberately no default deployment resolver and no trainer CLI here.
 */
export function createSupervisedExperimentBackend(options: SupervisedBackendOptions): SupervisedExperimentBackend {
  const { name, workerId, ledger, journal, transport, prepareLaunch } = options;
  id(name); id(workerId);
  if (typeof prepareLaunch !== "function") throw new Error("A trusted deployment resolver is required");
  const now = options.now ?? (() => new Date());
  const callTimeoutMs = options.callTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(callTimeoutMs) || callTimeoutMs < 1 || callTimeoutMs > 300_000) throw new Error("Backend call timeout must be 1–300,000 milliseconds");
  const source = `supervised-backend:${hash([name, workerId]).slice(0, 32)}`;
  const active = new Map<string, { claim: DispatchClaim; authorizeDeployment: () => boolean }>();
  const tails = new Map<string, Promise<unknown>>();
  async function prepare(claim: DispatchClaim, parent: AbortSignal): Promise<PreparedLocalLaunch | null> {
    if (parent.aborted) return null;
    const child = new AbortController();
    let finish!: (value: PreparedLocalLaunch | null) => void;
    let fail!: (reason: unknown) => void;
    const result = new Promise<PreparedLocalLaunch | null>((resolve, reject) => { finish = resolve; fail = reject; });
    const abort = () => { finish(null); child.abort(); };
    const timer = setTimeout(abort, callTimeoutMs);
    parent.addEventListener("abort", abort, { once: true });
    // The resolver is read-only. Ending this wait cannot abandon a hidden launch.
    // A late resolution is discarded and cannot hold this action's queue forever.
    void Promise.resolve().then(() => child.signal.aborted ? null : prepareLaunch(claim, child.signal)).then(finish, fail);
    try { return await result; }
    finally { clearTimeout(timer); parent.removeEventListener("abort", abort); }
  }
  function serial<T>(actionId: string, callback: () => Promise<T>): Promise<T> {
    const result = (tails.get(actionId) ?? Promise.resolve()).catch(() => {}).then(callback);
    tails.set(actionId, result);
    void result.finally(() => { if (tails.get(actionId) === result) tails.delete(actionId); }).catch(() => {});
    return result;
  }
  const worker = createSupervisedWorker({ journal, transport, workerId, now,
    callTimeoutMs,
    authorize(declaration) {
      const admission = active.get(hash(declaration));
      try { return !!admission && ledger.isDispatchAuthorized(admission.claim) && admission.authorizeDeployment() === true; }
      catch { return false; }
    },
  });
  function getAction(identity: BackendRequest): ActionRecord {
    keys(identity, ["actionId", "attemptId", "manifestDigest", "backend", "backendKey"]);
    const action = ledger.getAction(identity.actionId);
    if (action.backend !== name || !action.attemptId || encode(identity) !== encode(request(action, action.attemptId))) {
      throw new Error("Backend request does not match the current ledger action and attempt");
    }
    return action;
  }
  function key(identity: BackendRequest, kind: string): string {
    return `supervised-${kind}:${hash([name, workerId, identity])}`;
  }
  function save(action: ActionRecord, eventId: string, payload: JsonObject): ObservationRecord {
    const run = ledger.getRun(action.runId);
    // Before dispatch acknowledgement the ledger has no job ID. Keep the actual
    // worker identity in the bound payload without inventing acknowledgement.
    return ledger.appendObservation({ eventId, projectId: run.projectId, runId: run.runId,
      actionId: action.actionId, jobId: null, source, sequence: 0, observedAt: now().toISOString(), payload });
  }
  function saved(action: ActionRecord, identity: BackendRequest, kind: string): ObservationRecord | null {
    const observation = ledger.getObservation(key(identity, kind));
    if (!observation) return null;
    if (observation.source !== source || observation.actionId !== action.actionId || observation.runId !== action.runId
      || observation.payload.payloadDigest !== action.payloadDigest || encode(observation.payload.request) !== encode(identity)
      || observation.payload.kind !== kind || observation.payload.workerId !== workerId) {
      throw new Error("Stored backend operation conflicts with this request");
    }
    return observation;
  }
  function reply(identity: BackendRequest, outcome: BackendReply["outcome"], reason: string,
    evidence: JsonObject = {}, jobId?: string): BackendReply {
    return { ...identity, outcome, ...(outcome === "accepted" ? { jobId: jobId! } : {}),
      evidence: { source, qualification: "local_supervisor_only", reason, ...evidence } };
  }
  function retain(action: ActionRecord, value: BackendReply): BackendReply {
    const payload: JsonObject = { kind: "receipt", workerId, payloadDigest: action.payloadDigest,
      request: jsonValue(request(action, value.attemptId)), reply: jsonValue(value) };
    // Unknown is not a permanent answer. Keep it, but allow later observations
    // to establish a conclusive receipt under the same original operation.
    save(action, value.outcome === "unknown" ? `supervised-observation:${randomUUID()}` : key(valueIdentity(value), "receipt"), payload);
    return value;
  }
  function valueIdentity(value: BackendReply): BackendRequest {
    const { actionId, attemptId, manifestDigest, backend, backendKey } = value;
    return { actionId, attemptId, manifestDigest, backend, backendKey };
  }
  function recover(action: ActionRecord, identity: BackendRequest): BackendReply | null {
    const receipt = saved(action, identity, "receipt");
    if (!receipt) return null;
    const value = receipt.payload.reply as unknown as BackendReply;
    if (!value || encode(valueIdentity(value)) !== encode(identity)
      || !["accepted", "not_accepted"].includes(value.outcome)) throw new Error("Malformed stored backend receipt");
    if (action.operation === "launch") {
      const record = ownedJob(action);
      if (record && (value.outcome === "not_accepted" || !matchesIntent(action, identity, record)
        || value.evidence.declarationDigest !== record.digest)) throw new Error("Launch receipt conflicts with the restored worker journal");
    } else if (action.operation === "cancel") {
      const original = target(action), record = ownedJob(original);
      if (record && (!original.attemptId || !matchesIntent(original, request(original, original.attemptId), record)
        || saved(action, identity, "intent") && !matchesIntent(action, identity, record))) throw new Error("Cancel receipt conflicts with the restored target journal");
    }
    return structuredClone(value);
  }
  function planDigest(action: ActionRecord): string {
    keys(action.payload, ["attemptPlanDigest"]); digestValue(action.payload.attemptPlanDigest);
    if (action.operation !== "launch" || action.cleanupTargetActionId !== null) throw new Error("Expected an original launch action");
    return action.payload.attemptPlanDigest;
  }
  function ownedJob(action: ActionRecord): JobRecord | null {
    const expectedPlan = planDigest(action);
    const record = journal.readByAction(action.actionId);
    if (!record) return null;
    const declaration = record.declaration;
    if (declaration.workerId !== workerId || declaration.actionId !== action.actionId
      || declaration.backendKey !== action.backendKey || declaration.manifestDigest !== action.manifestDigest
      || declaration.planDigest !== expectedPlan || record.digest !== hash(declaration)
      || action.jobId !== null && action.jobId !== declaration.jobId) throw new Error("Journal job binding conflicts with the launch action");
    return record;
  }
  function matchesIntent(action: ActionRecord, identity: BackendRequest, record: JobRecord): boolean {
    const operation = saved(action, identity, "intent");
    if (!operation) return false;
    if (operation.payload.jobId !== record.declaration.jobId || operation.payload.declarationDigest !== record.digest
      || operation.payload.targetActionId !== record.declaration.actionId) throw new Error("Operation intent conflicts with the restored worker declaration");
    return true;
  }
  function boundJob(action: ActionRecord): JobRecord | null {
    const record = ownedJob(action);
    return record && action.attemptId && matchesIntent(action, request(action, action.attemptId), record) ? record : null;
  }
  function target(action: ActionRecord): ActionRecord {
    if (action.operation !== "cancel" || !action.cleanupTargetActionId) throw new Error("Expected admitted targeted cancellation");
    const original = ledger.getAction(action.cleanupTargetActionId);
    if (original.backend !== name || original.runId !== action.runId || original.manifestDigest !== action.manifestDigest
      || encode(action.payload) !== encode({ targetActionId: original.actionId, targetBackendKey: original.backendKey,
        targetManifestDigest: original.manifestDigest, cleanup: "cancel" })) throw new Error("Cancellation target binding conflicts with the ledger");
    planDigest(original);
    return original;
  }
  function summary(result: WorkerResult, record: Pick<JobRecord, "digest">): JsonObject {
    return { jobId: result.jobId, declarationDigest: record.digest, acceptance: result.acceptance,
      execution: result.execution, workerReason: result.reason, observationId: result.observationId,
      observationSequence: result.observationSequence, observation: jsonValue(result.observation) };
  }
  async function queryLaunch(action: ActionRecord, identity: BackendRequest, signal: AbortSignal): Promise<BackendReply> {
    const record = boundJob(action);
    if (!record) return reply(identity, "unknown", "launch_journal_or_binding_unavailable");
    const result = await worker.query(record.declaration.jobId, signal);
    return reply(identity, result.acceptance, "queried_existing_launch", summary(result, record), result.jobId);
  }
  function intent(action: ActionRecord, identity: BackendRequest, record: JobDeclaration, deploymentEvidence: JsonObject | null = null): void {
    save(action, key(identity, "intent"), { kind: "intent", workerId, payloadDigest: action.payloadDigest,
      request: jsonValue(identity), targetActionId: record.actionId, jobId: record.jobId, declarationDigest: hash(record), deploymentEvidence });
  }
  async function recoverUncertain(action: ActionRecord, identity: BackendRequest, signal: AbortSignal): Promise<BackendReply> {
    if (action.operation === "launch") return queryLaunch(action, identity, signal);
    if (action.operation !== "cancel") return reply(identity, "unknown", "no_conclusive_operation_receipt");
    const original = target(action), record = boundJob(original);
    if (!record) return reply(identity, "unknown", "cancel_target_journal_unavailable");
    if (saved(action, identity, "intent")) matchesIntent(action, identity, record);
    const observed = await worker.query(record.declaration.jobId, signal);
    // Launch acceptance or a dead process cannot prove that this cancel was sent.
    return reply(identity, "unknown", "cancel_receipt_unavailable", summary(observed, record));
  }
  async function submit(claim: DispatchClaim, signal: AbortSignal): Promise<BackendReply> {
    const identity = request(claim.action, claim.attemptId), action = getAction(identity);
    if (claim.workerId !== workerId) throw new Error("Dispatch claim belongs to another local worker");
    const recovered = recover(action, identity);
    if (recovered) return recovered;
    if (saved(action, identity, "intent")) return retain(action, await recoverUncertain(action, identity, signal));
    if (action.operation === "launch" && ownedJob(action)) return retain(action, await queryLaunch(action, identity, signal));
    const authorized = () => !signal.aborted && ledger.isDispatchAuthorized(claim);
    if (!authorized()) return retain(action, reply(identity, "not_accepted", "authority_denied_before_intent"));
    if (action.operation === "cancel") {
      const original = target(action), record = boundJob(original);
      if (!record) return retain(action, reply(identity, "not_accepted", "cancel_target_not_locally_known"));
      intent(action, identity, record.declaration);
      const result = await worker.cancel(record.declaration.jobId, signal, authorized);
      const outcome = result.stopCommand === "sent" ? "accepted" : result.stopCommand === "not_sent" ? "not_accepted" : "unknown";
      return retain(action, reply(identity, outcome, "cancel_command_observed", { ...summary(result, record),
        stopCommand: result.stopCommand, stopObservationId: result.stopObservationId }, result.jobId));
    }
    if (action.operation !== "launch") return retain(action, reply(identity, "not_accepted", "operation_unsupported"));
    const expectedPlan = planDigest(action), run = ledger.getRun(action.runId);
    // A run denotes one execution. Replication/resume needs a separately registered run.
    if (ledger.listActions(run.projectId).some(other => other.runId === action.runId && other.operation === "launch"
      && other.actionId !== action.actionId && other.state !== "confirmed_not_accepted")) {
      return retain(action, reply(identity, "not_accepted", "multiple_launch_actions_for_run"));
    }
    const prepared = await prepare(claim, signal);
    if (!authorized() || !prepared) return retain(action, reply(identity, "not_accepted", prepared ? "authority_changed_during_preparation" : "deployment_not_ready"));
    const declaration = frozen(structuredClone(prepared.declaration));
    const evidence = boundedEvidence(prepared.evidence);
    const rebuilt = createJobDeclaration({ actionId: declaration.actionId, backendKey: declaration.backendKey,
      manifestDigest: declaration.manifestDigest, planDigest: declaration.planDigest, workerId: declaration.workerId,
      command: declaration.request.command, limits: declaration.request.limits,
      deadlineAt: declaration.request.deadlineAt, host: declaration.request.expectedHost });
    if (hash(declaration) !== hash(rebuilt) || declaration.actionId !== action.actionId || declaration.backendKey !== action.backendKey
      || declaration.manifestDigest !== action.manifestDigest || declaration.planDigest !== expectedPlan || declaration.workerId !== workerId
      || declaration.request.deadlineAt !== claim.deadlineAt || typeof prepared.authorizeDeployment !== "function") {
      throw new Error("Prepared deployment does not bind the admitted action, plan, worker and deadline");
    }
    const { runtimeMs, startTimeoutMs, stopTimeoutMs } = declaration.request.limits;
    if (runtimeMs + startTimeoutMs + stopTimeoutMs > ledger.getManifest(action.manifestDigest).manifest.resources.maxDurationSeconds * 1000) {
      throw new Error("Deployment lifecycle exceeds the manifest duration");
    }
    const declarationDigest = hash(declaration);
    active.set(declarationDigest, { claim, authorizeDeployment: prepared.authorizeDeployment });
    try {
      intent(action, identity, declaration, evidence);
      const result = await worker.launch(declaration, signal);
      return retain(action, reply(identity, result.acceptance, "launch_observed", { ...summary(result, { digest: declarationDigest }), deploymentEvidence: evidence }, result.jobId));
    } finally { active.delete(declarationDigest); }
  }
  return {
    name,
    submit(raw, signal) {
      const claim = frozen(structuredClone(raw));
      return serial(claim.action.actionId, () => submit(claim, signal));
    },
    reconcile(raw, signal) {
      const identity = frozen(structuredClone(raw));
      return serial(identity.actionId, async () => {
        const action = getAction(identity), receipt = recover(action, identity);
        return receipt ?? retain(action, await recoverUncertain(action, identity, signal));
      });
    },
    observe(actionId, signal) {
      return serial(actionId, async () => {
        const action = ledger.getAction(actionId);
        if (action.backend !== name) throw new Error("Action belongs to another backend");
        const record = boundJob(action);
        if (!record) throw new Error("Launch has no local journal identity");
        const result = await worker.query(record.declaration.jobId, signal);
        const latest = journal.observations(record.declaration.jobId).find(item => item.observationId === result.observationId);
        if (!latest || latest.sequence !== result.observationSequence || latest.declarationDigest !== record.digest) {
          throw new Error("Worker result has no matching journal observation");
        }
        const observation = save(action, `supervised-status:${latest.observationId}`, summary(result, record));
        let executionProjected = false;
        const run = ledger.getRun(action.runId);
        const competing = ledger.listActions(run.projectId).some(other => other.runId === run.runId && other.operation === "launch"
          && other.actionId !== actionId && ["dispatching", "unknown", "acknowledged"].includes(other.state));
        if (!competing && action.state === "acknowledged" && action.jobId === result.jobId && result.execution !== "unknown") {
          try {
            ledger.recordExecution({ eventId: `supervised-execution:${latest.observationId}`, runId: action.runId,
              source, sequence: latest.sequence, state: result.execution === "stopped" ? "cancelled" : result.execution,
              evidence: { observationId: observation.eventId, observationDigest: observation.digest, declarationDigest: record.digest } });
            executionProjected = ledger.getRun(action.runId).execution === (result.execution === "stopped" ? "cancelled" : result.execution);
          } catch (error) {
            // Preserve conflicting authoritative streams as observations, never overwrite them.
            if (!(error instanceof LedgerError) || error.code !== "conflict") throw error;
          }
        }
        return { result, observation, executionProjected };
      });
    },
  };
}
