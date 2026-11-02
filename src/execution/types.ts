import type { JsonObject } from "../ledger/types.ts";
import type { DeadlineGateConfig } from "./deadline-gate.ts";

export interface HostIdentity { machineId: string; bootId: string }
export interface UnitIdentity { unitName: string; description: string }
export interface ServiceCommand {
  executable: string;
  args: string[];
  cwd: string;
  /** Nonsecret values only. Declarations are persisted, never credential storage. */
  environment: Record<string, string>;
}
export interface ServiceLimits {
  runtimeMs: number;
  startTimeoutMs: number;
  stopTimeoutMs: number;
  memoryMaxBytes: number;
  tasksMax: number;
}
/** Trusted deployment policy, never supplied by a model or an individual job. */
export interface SystemdProfile {
  userId: number;
  groupId: number;
  executables: string[];
  readOnlyPaths: string[];
  writableRoot: string;
  allowedEnvironment: string[];
  maxima: ServiceLimits;
  /** Fixed sudo -n prefix for the system manager; never escalates the trainer UID. */
  useSudo: boolean;
  /** Trusted gate code must be immutable to the trainer and in a read-only root. */
  deadlineGate: DeadlineGateConfig;
}
export interface ServiceLaunchRequest {
  identity: UnitIdentity;
  expectedHost: HostIdentity;
  command: ServiceCommand;
  limits: ServiceLimits;
  /** Latest allowed completion, including start and stop grace. */
  deadlineAt: string;
}
export interface ServiceQueryRequest {
  identity: UnitIdentity;
  expectedHost: HostIdentity;
  /** Once observed, a replacement invocation must not be mistaken for this job. */
  expectedInvocationId?: string;
}
export interface ServiceCleanupEvidence {
  kind: "cgroup_v2_empty" | "cgroup_v2_absent";
  /** Exact owned path inspected in the host cgroup2 hierarchy, not a manager field. */
  controlGroup: string;
  invocationId: string;
  /** Kernel observation, bracketed by matching loaded terminal manager snapshots. */
  observedAt: string;
  confirmedAt: string;
}
export interface ServiceSnapshot {
  identity: UnitIdentity;
  host: HostIdentity;
  observedAt: string;
  invocationId: string;
  loadState: string;
  activeState: string;
  subState: string;
  result: string;
  mainPid: number;
  execMainCode: number;
  execMainStatus: number;
  controlGroup: string;
  /** null means not established; absence of a MainPID is insufficient. */
  cgroupPopulated: boolean | null;
  /** Optional for historical snapshots. Native terminal cleanup now carries this proof. */
  cleanupEvidence?: ServiceCleanupEvidence;
}
export type ServiceQueryResult =
  | { kind: "present"; snapshot: ServiceSnapshot }
  | { kind: "absent"; host: HostIdentity; observedAt: string }
  | { kind: "unknown"; reason: string };
export type ServiceStartResult =
  | { kind: "accepted"; evidence: JsonObject }
  | { kind: "unknown"; reason: string };
export interface ServiceStopResult {
  /** A successful stop command is not proof of an empty cgroup. */
  command: "sent" | "not_sent" | "unknown";
  observation: ServiceQueryResult;
}
export interface SystemdTransport {
  hostIdentity(): Promise<HostIdentity>;
  start(request: ServiceLaunchRequest, signal: AbortSignal, authorize: () => boolean): Promise<ServiceStartResult>;
  query(request: ServiceQueryRequest, signal: AbortSignal): Promise<ServiceQueryResult>;
  stop(request: ServiceQueryRequest, signal: AbortSignal, authorize: () => boolean): Promise<ServiceStopResult>;
}

/** One immutable declaration is journaled before the first manager start call. */
export interface JobDeclaration {
  jobId: string;
  actionId: string;
  backendKey: string;
  manifestDigest: string;
  planDigest: string;
  workerId: string;
  request: ServiceLaunchRequest;
}
export type JobObservation =
  | { operation: "start"; result: ServiceStartResult }
  | { operation: "query"; result: ServiceQueryResult }
  | { operation: "stop"; result: ServiceStopResult };
export interface JobObservationInput {
  observationId: string;
  jobId: string;
  actionId: string;
  declarationDigest: string;
  observedAt: string;
  observation: JobObservation;
}
export interface JobObservationRecord extends JobObservationInput { digest: string; sequence: number }
export interface JobRecord {
  declaration: JobDeclaration;
  digest: string;
  intentCreatedAt: string;
  latestObservation: JobObservationRecord | null;
}
export interface JobJournal {
  /** created:false is NEVER authority to start again. */
  prepareIntent(declaration: JobDeclaration): { record: JobRecord; created: boolean };
  read(jobId: string): JobRecord | null;
  readByAction(actionId: string): JobRecord | null;
  recordObservation(input: JobObservationInput): JobObservationRecord;
  observations(jobId: string): JobObservationRecord[];
  close(): void;
}
