import { randomUUID } from "node:crypto";
import type { ActionRecord, DispatchClaim, ExperimentLedger, JsonObject, JsonValue } from "../ledger/types.ts";

/** Backend identity is discoverable without relying on a possibly lost submit response. */
export interface BackendRequest {
  actionId: string;
  attemptId: string;
  manifestDigest: string;
  backend: string;
  backendKey: string;
}

export interface BackendReply extends BackendRequest {
  outcome: "accepted" | "not_accepted" | "unknown";
  jobId?: string;
  evidence: JsonObject;
}

/** Implementations must enforce authority/deadlines at the execution boundary.
 * A local check cannot revoke a remote request already in flight. The separate
 * execution/backend.ts adapter is scoped to one trusted local supervisor host.
 */
export interface ExperimentBackend {
  readonly name: string;
  submit(claim: DispatchClaim, signal: AbortSignal): Promise<unknown>;
  reconcile(request: BackendRequest, signal: AbortSignal): Promise<unknown>;
}

export interface DispatchOptions {
  workerId: string;
  deadlineAt: string;
  /** Bounds this RPC wait, independently of the worker-enforced action deadline. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

type CallResult = { kind: "reply"; value: unknown } | { kind: "unknown"; reason: string };

function timeout(value: number | undefined): number {
  const milliseconds = value ?? 30_000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 300_000) {
    throw new RangeError("Backend call timeout must be 1–300,000 milliseconds");
  }
  return milliseconds;
}

function identity(action: ActionRecord, attemptId: string): BackendRequest {
  return { actionId: action.actionId, attemptId, manifestDigest: action.manifestDigest,
    backend: action.backend, backendKey: action.backendKey };
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function json(value: unknown, depth = 0): value is JsonValue {
  if (depth > 24) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index) || !json(value[index], depth + 1)) return false;
    }
    return true;
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every(item => json(item, depth + 1));
}

function parseReply(raw: unknown, expected: BackendRequest): BackendReply | null {
  try {
    // One snapshot prevents a callback-owned object changing between checks and persistence.
    const value: unknown = structuredClone(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const result = value as Record<string, unknown>;
    const allowed = ["actionId", "attemptId", "manifestDigest", "backend", "backendKey", "outcome", "jobId", "evidence"];
    if (Object.keys(result).some(key => !allowed.includes(key))) return null;
    for (const [key, text] of Object.entries(expected)) if (result[key] !== text) return null;
    if (result.outcome !== "accepted" && result.outcome !== "not_accepted" && result.outcome !== "unknown") return null;
    if (result.outcome === "accepted") {
      if (typeof result.jobId !== "string" || !result.jobId.trim() || result.jobId.length > 512) return null;
    } else if (result.jobId !== undefined) return null;
    if (!result.evidence || typeof result.evidence !== "object" || Array.isArray(result.evidence)
      || !Object.keys(result.evidence).length || !json(result.evidence)) return null;
    if (JSON.stringify(value).length > 64_000) return null;
    return value as BackendReply;
  } catch { return null; }
}

/** Ending the wait does not assert that a remote side effect stopped. Late replies are
 * discarded here; the durable unknown action must be reconciled by its original key.
 */
async function callBackend(callback: (signal: AbortSignal) => Promise<unknown>, milliseconds: number,
  parent: AbortSignal | undefined): Promise<CallResult> {
  if (parent?.aborted) return { kind: "unknown", reason: "cancelled" };
  const controller = new AbortController();
  let finish!: (value: CallResult) => void;
  let settled = false;
  const completed = new Promise<CallResult>(resolve => { finish = value => {
    if (!settled) { settled = true; resolve(value); }
  }; });
  const stop = (reason: string) => {
    // Settle unknown before notifying the backend, whose abort handler may resolve immediately.
    finish({ kind: "unknown", reason });
    controller.abort();
  };
  const cancelled = () => stop("cancelled");
  const timer = setTimeout(() => stop("timeout"), milliseconds);
  parent?.addEventListener("abort", cancelled, { once: true });
  try {
    Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      return callback(controller.signal);
    }).then(value => finish({ kind: "reply", value }), () => finish({ kind: "unknown", reason: "backend_exception" }));
    return await completed;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancelled);
  }
}

function record(ledger: ExperimentLedger, expected: BackendRequest, result: CallResult, operation: string): ActionRecord {
  const reply = result.kind === "reply" ? parseReply(result.value, expected) : null;
  const reason = result.kind === "unknown" ? result.reason : "malformed_or_mismatched_reply";
  return ledger.recordDispatchOutcome({ receiptId: `${operation}-${randomUUID()}`,
    actionId: expected.actionId, attemptId: expected.attemptId, manifestDigest: expected.manifestDigest, backend: expected.backend,
    outcome: reply?.outcome ?? "unknown", ...(reply?.jobId ? { jobId: reply.jobId } : {}),
    evidence: reply?.evidence ?? { source: "controller", reason } });
}

/** One durable queue claim, then at most one external submission. No retry loop. */
export async function dispatchNext(ledger: ExperimentLedger, backends: readonly ExperimentBackend[],
  options: DispatchOptions): Promise<ActionRecord | null> {
  const milliseconds = timeout(options.timeoutMs);
  if (new Set(backends.map(item => item.name)).size !== backends.length) throw new Error("Backend names must be unique");
  if (options.signal?.aborted) return null;
  const claim = ledger.claimDispatch({ workerId: options.workerId, deadlineAt: options.deadlineAt });
  if (!claim) return null;
  const expected = identity(claim.action, claim.attemptId);
  const backend = backends.find(item => item.name === claim.action.backend);
  if (!backend || !ledger.isDispatchAuthorized(claim)) {
    return record(ledger, expected, { kind: "reply", value: { ...expected, outcome: "not_accepted",
      evidence: { source: "controller", requestSent: false, reason: backend ? "authority_revoked" : "backend_unavailable" } } }, "dispatch");
  }
  const snapshot = freeze(structuredClone(claim));
  const result = await callBackend(signal => {
    if (!ledger.isDispatchAuthorized(snapshot)) return Promise.resolve({ ...expected, outcome: "not_accepted",
      evidence: { source: "controller", requestSent: false, reason: "authority_revoked" } });
    return backend.submit(snapshot, signal);
  }, milliseconds, options.signal);
  return record(ledger, expected, result, "dispatch");
}

/** Reconciliation queries the existing identity. Even a confirmed nonacceptance result
 * does not requeue or submit automatically; admission/dispatch is a separate operation.
 */
export async function reconcileAction(ledger: ExperimentLedger, backend: ExperimentBackend, actionId: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ActionRecord> {
  const milliseconds = timeout(options.timeoutMs);
  const action = ledger.getAction(actionId);
  if (action.state !== "unknown" || !action.attemptId) throw new Error("Only an unknown dispatched action can be reconciled");
  if (backend.name !== action.backend) throw new Error("Reconciliation backend does not match the action");
  const expected = identity(action, action.attemptId);
  const request = freeze(structuredClone(expected));
  const result = await callBackend(signal => backend.reconcile(request, signal), milliseconds, options.signal);
  return record(ledger, expected, result, "reconcile");
}
