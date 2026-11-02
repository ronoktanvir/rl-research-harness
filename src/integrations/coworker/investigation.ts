import { posix } from "node:path";
import type { ExperimentLedger, JsonObject, ObservationRecord } from "../../ledger/types.ts";
import { digestValue, encode, hash, id, keys, policyScope, timestamp } from "../../ledger/validation.ts";
import { freezeSnapshot } from "../../research/evidence.ts";
import { assessCoworkerCapture } from "./assessment.ts";
import { COWORKER_INVESTIGATION_SUPPORTED_SOURCE, prepareCoworkerInvestigationRequest, validateCoworkerInvestigationDescriptor, validateCoworkerInvestigationExecution } from "./investigation-worker.ts";
import type { CoworkerInvestigationRequest as WorkerRequest, CoworkerInvestigationWorker, CoworkerInvestigationWorkerDescriptor } from "./investigation-worker.ts";

export const COWORKER_INVESTIGATION_SOURCE = "coworker-investigation.v1";
const INTENT = "coworker-investigation-intent.v1", ATTEMPT = "coworker-investigation-attempt.v1", OUTPUT = "coworker-investigation-output.v1";
export const COWORKER_INVESTIGATION_MAX_ATTEMPTS = 3;
export interface CoworkerInvestigationRequest {
  projectId: string; investigationId: string; captureId: string; captureDigest: string;
  localArtifacts: WorkerRequest["localArtifacts"];
}
export type CoworkerInvestigationArchive = Pick<ExperimentLedger, "getObservation" | "appendObservation">;
export interface CoworkerInvestigationPreparationOptions {
  /** Trusted operator configuration; never supplied through queued task input. */
  root: string; worker: CoworkerInvestigationWorkerDescriptor; now?: () => Date;
}
export interface CoworkerInvestigationOptions extends Omit<CoworkerInvestigationPreparationOptions, "worker"> {
  worker: CoworkerInvestigationWorker; signal?: AbortSignal;
}
const running = new Set<string>();
function invalid(reason: string): never { throw new Error(`Invalid Coworker investigation: ${reason}`); }
function same(a: unknown, b: unknown, reason: string): void { if (encode(a) !== encode(b)) invalid(reason); }
/** Bounded inert JSON copy for controller request boundaries; never invokes getters. */
export function copyCoworkerInvestigationData(raw: unknown): unknown {
  let nodes = 0, bytes = 0;
  function visit(value: unknown, depth: number): unknown {
    if (++nodes > 100_000 || depth > 32) invalid("structural bounds");
    if (typeof value === "string") { bytes += Buffer.byteLength(value); if (bytes > 1_500_000) invalid("byte bound"); return value; }
    if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype)) invalid("inert JSON required");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length || Object.values(descriptors).some(field => !Object.hasOwn(field, "value"))) invalid("accessors unsupported");
    if (Array.isArray(value)) {
      if (value.length > 30_000 || Object.keys(descriptors).length !== value.length + 1) invalid("dense bounded arrays required");
      return Array.from({ length: value.length }, (_, index) => {
        if (!descriptors[index]?.enumerable) invalid("dense arrays required"); return visit(descriptors[index]!.value, depth + 1);
      });
    }
    return Object.fromEntries(Object.entries(descriptors).map(([key, field]) => {
      bytes += Buffer.byteLength(key); if (!field.enumerable || bytes > 1_500_000) invalid("object bounds"); return [key, visit(field.value, depth + 1)];
    }));
  }
  const result = visit(raw, 0); encode(result); return result;
}
function relative(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 2048 || !value || posix.isAbsolute(value) || posix.normalize(value) !== value
    || value.split("/").some(part => !part || part === "." || part === "..") || /[\x00-\x1f\x7f\\]/u.test(value)) invalid("safe relative artifact path required");
}
export function normalizeCoworkerInvestigationRequest(raw: unknown): CoworkerInvestigationRequest {
  const value = copyCoworkerInvestigationData(raw); keys(value, ["projectId", "investigationId", "captureId", "captureDigest", "localArtifacts"]);
  id(value.projectId); policyScope(`project:${value.projectId}`); id(value.investigationId); id(value.captureId); digestValue(value.captureDigest);
  keys(value.localArtifacts, ["adapterPath", "trainedTracePath", "baselineTracePath", "trainedEvaluationDirectory", "baselineEvaluationDirectory"]);
  for (const selected of Object.values(value.localArtifacts)) relative(selected);
  return freezeSnapshot(value) as unknown as CoworkerInvestigationRequest;
}
export function coworkerInvestigationObservationId(projectId: string, investigationId: string): string {
  id(projectId); policyScope(`project:${projectId}`); id(investigationId);
  return `coworker-investigation:${hash([projectId, investigationId])}`;
}
function identifiers(request: CoworkerInvestigationRequest) {
  const result = coworkerInvestigationObservationId(request.projectId, request.investigationId), suffix = result.split(":")[1]!;
  return { result, intent: `coworker-investigation-intent:${suffix}`, attempt: (index: number) => `coworker-investigation-attempt:${suffix}:${index}`,
    output: (index: number) => `coworker-investigation-output:${suffix}:${index}` };
}
function record(archive: CoworkerInvestigationArchive, eventId: string, source: string, projectId?: string): ObservationRecord | null {
  const raw = archive.getObservation(eventId); if (!raw) return null;
  const value = copyCoworkerInvestigationData(raw); keys(value, ["eventId", "projectId", "runId", "actionId", "jobId", "source", "sequence", "observedAt", "payload", "digest"]);
  const { digest, ...body } = value; timestamp(value.observedAt); digestValue(digest);
  if (hash(body) !== digest || value.eventId !== eventId || value.source !== source || projectId !== undefined && value.projectId !== projectId
    || value.runId !== null || value.actionId !== null || value.jobId !== null) invalid("archive identity mismatch");
  return freezeSnapshot(value) as unknown as ObservationRecord;
}
function append(archive: CoworkerInvestigationArchive, eventId: string, projectId: string, source: string, sequence: number, observedAt: string, payload: unknown) {
  timestamp(observedAt);
  return archive.appendObservation({ eventId, projectId, runId: null, actionId: null, jobId: null, source, sequence, observedAt, payload: payload as JsonObject });
}
function intentPayload(archive: CoworkerInvestigationArchive, input: CoworkerInvestigationRequest, root: string, rawDescriptor: CoworkerInvestigationWorkerDescriptor) {
  const descriptor = validateCoworkerInvestigationDescriptor(rawDescriptor);
  const capture = archive.getObservation(input.captureId); if (!capture) invalid("capture missing");
  // The existing validator verifies the complete capture envelope and sanitized
  // projection without reading files or archiving an assessment.
  assessCoworkerCapture(capture, { projectId: input.projectId, captureId: input.captureId, captureDigest: input.captureDigest });
  const payload = copyCoworkerInvestigationData(capture.payload) as JsonObject, identity = payload.requestIdentity as JsonObject;
  const observation = payload.reportObservation as JsonObject, reference = observation.reportReference;
  if (identity.canonicalRoot !== root || !reference || typeof reference !== "object" || Array.isArray(reference)) invalid("capture root/report binding mismatch");
  const report = observation.report as JsonObject;
  if (report.format !== "coworkerl-fit-loop") invalid("unsupported capture report format");
  const source = report.source as JsonObject;
  if (source.runtimeRevision !== COWORKER_INVESTIGATION_SUPPORTED_SOURCE) invalid("unsupported capture source; labels do not establish run identity");
  const workerRequest = prepareCoworkerInvestigationRequest({ schemaVersion: 1, kind: "coworker-run1-investigation", root,
    report: { path: reference.path, sha256: reference.sha256, bytes: reference.bytes }, localArtifacts: input.localArtifacts });
  return { schemaVersion: 1, kind: INTENT, request: input, requestDigest: hash(input), root,
    capture: { observationId: capture.eventId, digest: capture.digest, report: workerRequest.report }, worker: descriptor, workerRequest,
    inputDigest: workerRequest.requestDigest, inputBytesSha256: hash(workerRequest), replayPolicy: "same_request_read_only_after_unrecorded_outcome", maxAttempts: COWORKER_INVESTIGATION_MAX_ATTEMPTS,
    scientificEvaluation: "unassessed", followupDisposition: "unresolved" };
}
function preparation(archive: CoworkerInvestigationArchive, raw: unknown,
  options: Pick<CoworkerInvestigationPreparationOptions, "root" | "worker">) {
  const input = normalizeCoworkerInvestigationRequest(raw), root = options.root, descriptor = validateCoworkerInvestigationDescriptor(options.worker);
  const payload = intentPayload(archive, input, root, descriptor), identity = identifiers(input), existing = record(archive, identity.intent, INTENT, input.projectId);
  if (existing) { if (existing.sequence !== 0) invalid("intent sequence mismatch"); same(existing.payload, payload, "investigation identity already belongs to another request/worker"); }
  else if (archive.getObservation(identity.result)) invalid("investigation result has no immutable intent");
  return { input, payload, identity, existing };
}
/** Pure pre-admission check. Reads saved observations only; no append or source-file access. */
export function validateCoworkerInvestigationPreparation(archive: CoworkerInvestigationArchive, raw: unknown,
  options: Pick<CoworkerInvestigationPreparationOptions, "root" | "worker">): void {
  preparation(archive, raw, options);
}
/** Writes only immutable intent. No project file or subprocess is accessed. */
export function prepareCoworkerInvestigation(archive: CoworkerInvestigationArchive, raw: CoworkerInvestigationRequest,
  options: CoworkerInvestigationPreparationOptions): ObservationRecord {
  const { input, payload, identity, existing } = preparation(archive, raw, options), now = options.now ?? (() => new Date());
  if (existing) return existing;
  return freezeSnapshot<unknown>(append(archive, identity.intent, input.projectId, INTENT, 0, now().toISOString(), payload)) as ObservationRecord;
}
function loadIntent(archive: CoworkerInvestigationArchive, resultId: string) {
  if (!/^coworker-investigation:[a-f0-9]{64}$/u.test(resultId)) invalid("result identity format");
  const intent = record(archive, resultId.replace("coworker-investigation:", "coworker-investigation-intent:"), INTENT);
  if (!intent || intent.sequence !== 0) invalid("intent missing or invalid");
  const payload = intent.payload;
  const input = normalizeCoworkerInvestigationRequest(payload.request);
  if (identifiers(input).result !== resultId || intent.projectId !== input.projectId || typeof payload.root !== "string") invalid("intent request mismatch");
  const expected = intentPayload(archive, input, payload.root, validateCoworkerInvestigationDescriptor(payload.worker));
  same(payload, expected, "intent payload mismatch");
  return { intent, input, payload: expected, identity: identifiers(input) };
}
type IntentContext = ReturnType<typeof loadIntent>;
function attempts(archive: CoworkerInvestigationArchive, context: IntentContext) {
  let count = 0; let output: ObservationRecord | null = null;
  for (let index = 1; index <= COWORKER_INVESTIGATION_MAX_ATTEMPTS; index++) {
    const attempt = record(archive, context.identity.attempt(index), ATTEMPT, context.input.projectId);
    const receipt = record(archive, context.identity.output(index), OUTPUT, context.input.projectId);
    if (!attempt) { if (receipt) invalid("output without attempt"); continue; }
    if (index !== count + 1 || output || attempt.sequence !== index) invalid("attempt sequence mismatch");
    same(attempt.payload, { schemaVersion: 1, kind: ATTEMPT, intentId: context.intent.eventId, intentDigest: context.intent.digest,
      inputDigest: context.payload.inputDigest, attempt: index, replayMeaning: index === 1 ? "initial_read" : "previous_outcome_unrecorded_read_only_reinspection" }, "attempt binding mismatch");
    count = index;
    if (receipt) {
      if (receipt.sequence !== index) invalid("output sequence mismatch");
      const body = receipt.payload;
      keys(body, ["schemaVersion", "kind", "intentId", "intentDigest", "attemptId", "attemptDigest", "outcome", "executionDigest", "execution"]);
      if (body.schemaVersion !== 1 || body.kind !== OUTPUT || body.intentId !== context.intent.eventId || body.intentDigest !== context.intent.digest
        || body.attemptId !== attempt.eventId || body.attemptDigest !== attempt.digest) invalid("output binding mismatch");
      if (body.outcome === "execution") {
        const execution = validateCoworkerInvestigationExecution(body.execution, context.payload.workerRequest, context.payload.worker);
        if (body.executionDigest !== hash(execution)) invalid("execution digest mismatch");
      } else if (typeof body.outcome !== "string" || !["worker_exception", "invalid_worker_output"].includes(body.outcome) || body.execution !== null || body.executionDigest !== null) invalid("unsupported output disposition");
      output = receipt;
    }
  }
  return { count, output };
}
function resultPayload(context: IntentContext, output: ObservationRecord) {
  const execution = output.payload.execution === null ? null : validateCoworkerInvestigationExecution(output.payload.execution, context.payload.workerRequest, context.payload.worker);
  return { schemaVersion: 1, kind: COWORKER_INVESTIGATION_SOURCE, requestIdentity: context.input,
    intentId: context.intent.eventId, intentDigest: context.intent.digest, capture: context.payload.capture,
    worker: context.payload.worker, inputDigest: context.payload.inputDigest, inputBytesSha256: context.payload.inputBytesSha256,
    output: { observationId: output.eventId, digest: output.digest, attempt: output.sequence, observedAt: output.observedAt },
    executionDigest: output.payload.executionDigest, execution, status: execution?.status ?? "incomplete", reason: execution?.reason ?? output.payload.outcome,
    scientificEvaluation: "unassessed", historicalExecution: "unverified", followupDisposition: "unresolved", interventionAuthorized: false,
    limitations: ["Read-only file observations are not an atomic project snapshot or historical execution attestation.",
      "Producer counts and byte correspondence do not establish scorer validity, causal benefit or a matched training control.",
      "Completed investigation means the selected bounded checks finished; all scientific follow-up requests remain unresolved."] };
}
function recoverResult(archive: CoworkerInvestigationArchive, context: IntentContext, repair: boolean): ObservationRecord | null {
  const saved = record(archive, context.identity.result, COWORKER_INVESTIGATION_SOURCE, context.input.projectId), state = attempts(archive, context);
  if (!state.output) { if (saved) invalid("result without durable output"); return null; }
  const payload = resultPayload(context, state.output);
  if (saved) { if (saved.sequence !== 0 || saved.observedAt !== state.output.observedAt) invalid("result receipt mismatch"); same(saved.payload, payload, "result projection mismatch"); return saved; }
  if (!repair) return null;
  return freezeSnapshot<unknown>(append(archive, context.identity.result, context.input.projectId, COWORKER_INVESTIGATION_SOURCE, 0, state.output.observedAt, payload)) as ObservationRecord;
}
/** Offline verification only. A committed output with missing projection is repaired by run(). */
export function loadCoworkerInvestigation(archive: CoworkerInvestigationArchive, resultObservationId: string): ObservationRecord {
  const result = recoverResult(archive, loadIntent(archive, resultObservationId), false);
  if (!result) invalid("investigation outcome not archived"); return result;
}
/** Read-only inspection may repeat only after a prior attempt has no durable output.
 * Any archived output, including incomplete evidence, is final for this identity.
 */
export async function runCoworkerInvestigation(archive: CoworkerInvestigationArchive, raw: CoworkerInvestigationRequest,
  options: CoworkerInvestigationOptions): Promise<ObservationRecord> {
  const input = normalizeCoworkerInvestigationRequest(raw), root = options.root, descriptor = validateCoworkerInvestigationDescriptor(options.worker.descriptor);
  const execute = options.worker.run.bind(options.worker), signal = options.signal, now = options.now ?? (() => new Date());
  const intent = prepareCoworkerInvestigation(archive, input, { root, worker: descriptor, now });
  const context = loadIntent(archive, identifiers(input).result), cached = recoverResult(archive, context, true);
  if (cached) return cached;
  if (signal?.aborted) invalid("cancelled before inspection");
  const lock = `${intent.eventId}:${intent.digest}`;
  if (running.has(lock)) invalid("investigation already running");
  const state = attempts(archive, context), index = state.count + 1;
  if (index > COWORKER_INVESTIGATION_MAX_ATTEMPTS) invalid("interrupted inspection attempt limit reached");
  running.add(lock);
  try {
    const attempt = append(archive, context.identity.attempt(index), input.projectId, ATTEMPT, index, now().toISOString(), {
      schemaVersion: 1, kind: ATTEMPT, intentId: intent.eventId, intentDigest: intent.digest, inputDigest: context.payload.inputDigest,
      attempt: index, replayMeaning: index === 1 ? "initial_read" : "previous_outcome_unrecorded_read_only_reinspection" });
    let execution = null, outcome = "execution";
    try {
      const rawOutput = await execute(context.payload.workerRequest, signal);
      try { execution = validateCoworkerInvestigationExecution(rawOutput, context.payload.workerRequest, descriptor); }
      catch { outcome = "invalid_worker_output"; }
    } catch { outcome = "worker_exception"; }
    // Persistence errors are outside the worker-error catch. A committed output
    // must remain recoverable rather than be replaced by a conflicting failure.
    append(archive, context.identity.output(index), input.projectId, OUTPUT, index, now().toISOString(), {
      schemaVersion: 1, kind: OUTPUT, intentId: intent.eventId, intentDigest: intent.digest, attemptId: attempt.eventId, attemptDigest: attempt.digest,
      outcome, executionDigest: execution ? hash(execution) : null, execution });
    return recoverResult(archive, context, true)!;
  } finally { running.delete(lock); }
}
