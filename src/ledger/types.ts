/** JSON payloads cross the durable boundary. Monetary JSON fields are decimal strings. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type ChargeCategory = "model" | "compute" | "storage" | "other";
export type DispatchState = "queued" | "dispatching" | "unknown" | "acknowledged" | "confirmed_not_accepted";
export type ExecutionState = "unknown" | "running" | "succeeded" | "failed" | "cancelled";
export type AllocationState = "unknown" | "active" | "released";
export type EvaluationState = "unassessed" | "valid" | "invalid" | "inconclusive";

export interface ExperimentManifest {
  schemaVersion: 1;
  code: { revision: string; dirtyPatchSha256: string | null };
  /** Image uses sha256:<64 lowercase hex>; dependencies uses 64 lowercase hex. */
  environment: { imageDigest: string; dependenciesDigest: string };
  adapter: { kind: "conventional_rl" | "llm_posttraining"; name: string; config: JsonObject };
  /** Split identity uses a 64-character lowercase SHA-256 digest. */
  data: { version: string; splitsDigest: string };
  model: { version: string };
  reward: { version: string };
  evaluator: { version: string };
  seeds: number[];
  resources: { maxDurationSeconds: number; maxCostMicrodollars: string };
  evaluationPolicy: JsonObject;
}
export interface ManifestRecord { digest: string; manifest: ExperimentManifest }
export interface CreateRunInput {
  runId: string; projectId: string; manifestDigest: string; replicaId: string;
  lineage?: { parentRunId: string; checkpointDigest: string };
}
export interface RunRecord extends CreateRunInput { execution: ExecutionState; evaluation: EvaluationState }

/** Every project scope has global as parent; optional child scopes inherit all ancestors. */
export interface BudgetInput { scopeId: string; parentScopeId: string | null; expectedRevision: number; limitMicrodollars: bigint }
export interface BudgetRecord { scopeId: string; parentScopeId: string | null; revision: number; limitMicrodollars: bigint; chargedMicrodollars: bigint; outstandingMicrodollars: bigint; availableMicrodollars: bigint }
export interface PolicyInput {
  scopeId: string; expectedVersion: number; allowedBackends: string[]; allowedOperations: string[]; requiredChecks: string[];
}
export interface PolicyRecord extends Omit<PolicyInput, "expectedVersion"> { version: number }
export interface ScopeState { scopeId: string; stopped: boolean; epoch: number; reason: string }
export interface StopInput { scopeId: string; expectedEpoch: number; reason: string }
export interface ValidationInput { validationId: string; manifestDigest: string; check: string; source: string; sequence: number; status: "passed" | "failed"; evidence: JsonObject }

export interface AdmitActionInput {
  runId: string; operation: string; operationRevision: number; backend: string; payload: JsonObject;
  reservation: { amountMicrodollars: bigint; category: ChargeCategory; basis: string };
  /** Defaults to project:<projectId>. A child must descend from that project. */
  budgetScopeId?: string;
}
/** Cleanup identity binds a previously admitted target; callers cannot replace its payload/backend. */
export interface AdmitCleanupInput {
  targetActionId: string; operation: "cancel" | "release"; operationRevision: number;
  reservation: AdmitActionInput["reservation"];
}
export interface ActionRecord {
  actionId: string; runId: string; manifestDigest: string; operation: string; operationRevision: number;
  backend: string; backendKey: string; payload: JsonObject; payloadDigest: string;
  state: DispatchState; attemptId: string | null; jobId: string | null;
  reservation: { amountMicrodollars: bigint; category: ChargeCategory; basis: string; scopeIds: string[]; outstandingMicrodollars: bigint; chargedMicrodollars: bigint; finalized: boolean };
  allocation: AllocationState;
  cleanupTargetActionId: string | null;
}
export interface ClaimDispatchInput { workerId: string; deadlineAt: string }
export interface DispatchClaim {
  action: ActionRecord; attemptId: string; workerId: string; deadlineAt: string;
  authority: { globalEpoch: number; projectEpoch: number };
}
export interface DispatchOutcomeInput {
  receiptId: string; actionId: string; attemptId: string; manifestDigest: string; backend: string;
  outcome: "accepted" | "not_accepted" | "unknown"; jobId?: string; evidence: JsonObject;
}
export interface ObservationInput {
  eventId: string; projectId: string; runId: string | null; actionId: string | null; jobId: string | null;
  source: string; sequence: number; observedAt: string; payload: JsonObject;
}
export interface ObservationRecord extends ObservationInput { digest: string }
export interface FactInput { eventId: string; source: string; sequence: number; evidence: JsonObject }
export interface ExecutionInput extends FactInput { runId: string; state: Exclude<ExecutionState, "unknown"> }
export interface AllocationInput extends FactInput { actionId: string; state: Exclude<AllocationState, "unknown"> }
export interface EvaluationInput extends FactInput { runId: string; evaluatorVersion: string; state: Exclude<EvaluationState, "unassessed"> }
export interface ChargeInput { chargeId: string; actionId: string; amountMicrodollars: bigint; source: string; evidence: JsonObject }
export interface FinalizeReservationInput {
  settlementId: string; actionId: string; finalChargeMicrodollars: bigint; source: string;
  /** Trusted controller assertion backed by evidence; the ledger cannot verify an invoice. */
  exposureEnded: true; evidence: JsonObject;
}
export interface LedgerEvent { sequence: number; kind: string; entityId: string; payload: JsonObject; createdAt: string }
export interface LedgerOptions { path: string; now?: () => Date }

/** A synchronous trusted-controller API. No method performs external dispatch. */
export interface ExperimentLedger {
  registerManifest(input: ExperimentManifest): ManifestRecord;
  getManifest(digest: string): ManifestRecord;
  createRun(input: CreateRunInput): RunRecord;
  getRun(runId: string): RunRecord;
  listRuns(projectId?: string): RunRecord[];
  configureBudget(input: BudgetInput): BudgetRecord;
  getBudget(scopeId: string): BudgetRecord;
  configurePolicy(input: PolicyInput): PolicyRecord;
  getScope(scopeId: string): ScopeState;
  stopScope(input: StopInput): ScopeState;
  resumeScope(input: StopInput): ScopeState;
  recordValidation(input: ValidationInput): void;
  admitAction(input: AdmitActionInput): ActionRecord;
  admitCleanup(input: AdmitCleanupInput): ActionRecord;
  getAction(actionId: string): ActionRecord;
  listActions(projectId?: string): ActionRecord[];
  claimDispatch(input: ClaimDispatchInput): DispatchClaim | null;
  isDispatchAuthorized(claim: DispatchClaim): boolean;
  recordDispatchOutcome(input: DispatchOutcomeInput): ActionRecord;
  requeueAction(actionId: string): ActionRecord;
  appendObservation(input: ObservationInput): ObservationRecord;
  getObservation(eventId: string): ObservationRecord | null;
  listObservations(projectId: string): ObservationRecord[];
  recordExecution(input: ExecutionInput): void;
  recordAllocation(input: AllocationInput): void;
  recordEvaluation(input: EvaluationInput): void;
  recordCharge(input: ChargeInput): ActionRecord;
  finalizeReservation(input: FinalizeReservationInput): ActionRecord;
  events(afterSequence?: number): LedgerEvent[];
  close(): void;
}
