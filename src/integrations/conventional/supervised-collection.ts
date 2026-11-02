import { createHash } from "node:crypto";
import type { ExperimentLedger, JsonObject, ObservationRecord } from "../../ledger/types.ts";
import { digestValue, encode, hash, id, integer, keys } from "../../ledger/validation.ts";
import type { JobJournal, JobObservationRecord, ServiceSnapshot } from "../../execution/types.ts";
import { createJobDeclaration } from "../../execution/worker.ts";
import { freezeSnapshot } from "../../research/evidence.ts";
// Shared low-level descriptor-relative file reader; no Coworker trainer logic.
import { readProjectFile } from "../coworker/files.ts";
import type { FileReference } from "../coworker/files.ts";
import { CONVENTIONAL_OUTPUT_BYTES, validateConventionalResult } from "./protocol.ts";
import type { ConventionalResult } from "./protocol.ts";
import { CONVENTIONAL_SUPERVISED_BACKEND, verifyConventionalAttempt } from "./supervised.ts";
import type { ConventionalAttemptPlan } from "./supervised.ts";

export const CONVENTIONAL_COLLECTION_SOURCE = "conventional-supervised-collection.v1";
export interface ConventionalCollectionRequest {
  collectionId: string; actionId: string; plan: ConventionalAttemptPlan; observationId: string; observationDigest: string;
}
export interface ConventionalCollectionStores {
  ledger: Pick<ExperimentLedger, "getAction" | "getRun" | "getManifest" | "getObservation" | "appendObservation">;
  journal: Pick<JobJournal, "readByAction" | "observations">;
}
interface CollectionIdentity { actionId: string; planDigest: string; observationId: string; observationDigest: string }

function invalid(reason: string): never { throw new Error(`Invalid conventional collection: ${reason}`); }
function same(actual: unknown, expected: unknown, label: string): void { if (encode(actual) !== encode(expected)) invalid(label); }
function request(raw: ConventionalCollectionRequest): ConventionalCollectionRequest {
  if (!raw || typeof raw !== "object" || Object.getPrototypeOf(raw) !== Object.prototype || Object.getOwnPropertySymbols(raw).length) invalid("plain request required");
  const fields = Object.getOwnPropertyDescriptors(raw);
  if (Object.values(fields).some(field => !Object.hasOwn(field, "value") || !field.enumerable)) invalid("request accessors/hidden fields");
  const value = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]));
  keys(value, ["collectionId", "actionId", "plan", "observationId", "observationDigest"]);
  id(value.collectionId); id(value.actionId); id(value.observationId); digestValue(value.observationDigest);
  const plan = verifyConventionalAttempt(value.plan);
  if (value.actionId !== plan.binding.actionId) invalid("action/plan mismatch");
  return { collectionId: value.collectionId, actionId: value.actionId, observationId: value.observationId, observationDigest: value.observationDigest, plan };
}
function recover(existing: ObservationRecord, input: ConventionalCollectionRequest, identity: CollectionIdentity): ObservationRecord {
  const { digest, ...body } = existing;
  if (hash(body) !== digest || existing.source !== CONVENTIONAL_COLLECTION_SOURCE || existing.eventId !== input.collectionId
    || existing.projectId !== input.plan.binding.projectId || existing.runId !== input.plan.binding.runId || existing.actionId !== input.actionId) invalid("stored collection identity mismatch");
  same(existing.payload.requestIdentity, identity, "collection identity already belongs to different evidence");
  const payload = existing.payload, plan = input.plan;
  keys(payload, ["schemaVersion", "kind", "requestIdentity", "status", "statusMeaning", "reason", "planDigest", "manifestDigest", "requestDigest", "jobId",
    "declarationDigest", "bridgeIntentId", "bridgeIntentDigest", "workerObservation", "artifacts", "summary", "scientificEvaluation", "scientificReplicationCount", "limitations"]);
  const expectedJob = `${plan.declarations.deployment.workerId}:rlh-${hash([plan.declarations.deployment.workerId, plan.binding.backendKey])}.service`;
  if (existing.sequence !== 0 || existing.jobId !== null && existing.jobId !== expectedJob || payload.schemaVersion !== 1
    || payload.kind !== CONVENTIONAL_COLLECTION_SOURCE || payload.statusMeaning !== "artifact_collection_not_scientific_validation"
    || payload.scientificEvaluation !== "unassessed" || payload.scientificReplicationCount !== 1
    || payload.planDigest !== plan.digest || payload.manifestDigest !== plan.binding.manifestDigest
    || payload.requestDigest !== plan.request.requestDigest || payload.jobId !== expectedJob) invalid("cached collection schema or binding mismatch");
  digestValue(payload.declarationDigest); digestValue(payload.bridgeIntentDigest);
  if (typeof payload.bridgeIntentId !== "string" || !/^supervised-intent:[a-f0-9]{64}$/.test(payload.bridgeIntentId)) invalid("cached bridge reference mismatch");
  keys(payload.workerObservation, ["observationId", "digest", "sequence", "observedAt", "invocationId", "successfulTerminalCleanupObserved"]);
  const worker = payload.workerObservation;
  if (worker.observationId !== input.observationId || worker.digest !== input.observationDigest
    || typeof worker.successfulTerminalCleanupObserved !== "boolean") invalid("cached worker reference mismatch");
  integer(worker.sequence, 1);
  if (payload.status === "completed") {
    if (payload.reason !== "bound_artifacts_collected" || existing.jobId !== expectedJob || worker.successfulTerminalCleanupObserved !== true) invalid("cached completion evidence mismatch");
    validateCachedSummary(payload.summary, plan);
    keys(payload.artifacts, ["intent", "receipt", "result"]);
  } else if (payload.status !== "incomplete" || payload.summary !== null || typeof payload.reason !== "string"
    || !["collection_cancelled", "dispatch_acknowledgement_missing", "successful_terminal_cleanup_not_established", "artifact_unavailable_or_unsafe", "artifact_identity_or_result_invalid"].includes(payload.reason)) {
    invalid("cached collection status/summary mismatch");
  }
  return freezeSnapshot<unknown>(existing) as ObservationRecord;
}
function validateCachedSummary(raw: unknown, plan: ConventionalAttemptPlan): void {
  keys(raw, ["versions", "totalTransitions", "scientificReplicationCount", "sharedRandomBaseline", "replicate", "resumeSupported"]);
  if (raw.scientificReplicationCount !== 1 || raw.resumeSupported !== false) invalid("cached summary capability/count mismatch");
  keys(raw.versions, ["python", "gymnasium", "numpy"]);
  if (typeof raw.versions.python !== "string" || !/^3\.11\.\d+$/.test(raw.versions.python)
    || raw.versions.gymnasium !== "1.4.0" || raw.versions.numpy !== "2.3.5") invalid("cached runtime pins mismatch");
  keys(raw.replicate, ["replicateId", "policyDigest", "training", "evaluation", "successRateDeltaFromBaseline"]);
  if (raw.replicate.replicateId !== plan.binding.replicaId) invalid("cached replica identity mismatch"); digestValue(raw.replicate.policyDigest);
  function batch(value: unknown, episodes: number): { successes: number; total: number } {
    keys(value, ["episodes", "successes", "successRate", "meanReturn", "totalTransitions", "terminated", "truncated", "harnessCutoffs"]);
    for (const key of ["episodes", "successes", "totalTransitions", "terminated", "truncated", "harnessCutoffs"]) integer(value[key]);
    if (value.episodes !== episodes || Number(value.successes) > episodes || value.successRate !== Number(value.successes) / episodes
      || value.meanReturn !== value.successRate || Number(value.totalTransitions) < episodes
      || Number(value.totalTransitions) > episodes * Math.min(plan.request.environment.maxEpisodeSteps, plan.request.limits.maxEpisodeTransitions)
      || ["terminated", "truncated", "harnessCutoffs"].some(key => Number(value[key]) > episodes)
      || Number(value.successes) > Number(value.terminated)) invalid("cached episode summary mismatch");
    return { successes: Number(value.successes), total: Number(value.totalTransitions) };
  }
  const count = plan.request.evaluation.episodeSeeds.length;
  const baseline = batch(raw.sharedRandomBaseline, count), evaluation = batch(raw.replicate.evaluation, count);
  const training = batch(raw.replicate.training, plan.request.replicates[0]!.trainingEpisodeSeeds.length);
  if (raw.totalTransitions !== baseline.total + evaluation.total + training.total
    || raw.replicate.successRateDeltaFromBaseline !== evaluation.successes / count - baseline.successes / count) invalid("cached aggregate summary mismatch");
}
function snapshotOf(record: JobObservationRecord): ServiceSnapshot | null {
  const observation = record.observation;
  const result = observation.operation === "query" ? observation.result : observation.operation === "stop" ? observation.result.observation : null;
  return result?.kind === "present" ? result.snapshot : null;
}
function terminalSuccess(snapshot: ServiceSnapshot | null): boolean {
  if (!snapshot || snapshot.mainPid !== 0 || snapshot.cgroupPopulated !== false || snapshot.execMainCode !== 1
    || snapshot.execMainStatus !== 0 || snapshot.result !== "success" || !snapshot.cleanupEvidence) return false;
  return snapshot.activeState === "active" && snapshot.subState === "exited" || snapshot.activeState === "inactive" && snapshot.subState === "dead";
}
function firstTerminalSucceeded(history: JobObservationRecord[]): boolean | null {
  // Match the worker's first-confirmed-outcome rule: a later cleanup snapshot
  // cannot replace a previously failed process with an apparently successful one.
  let stopSent = false;
  for (const record of history) {
    if (record.observation.operation === "stop" && record.observation.result.command === "sent") stopSent = true;
    const value = snapshotOf(record);
    if (!value || value.mainPid !== 0 || value.cgroupPopulated !== false
      || !(value.activeState === "active" && value.subState === "exited" || value.activeState === "inactive" && value.subState === "dead"
        || value.activeState === "failed" && value.subState === "failed")) continue;
    if (value.execMainCode === 1 && value.execMainStatus === 0 && value.result === "success") return true;
    if (value.result !== "success" || stopSent && value.execMainCode === 2 && [9, 15].includes(value.execMainStatus)) return false;
  }
  return null;
}
function strictJson(raw: string): unknown {
  const parsed: unknown = JSON.parse(raw);
  const stack: { object: boolean; keys: Set<string>; expectingKey: boolean }[] = [];
  for (const match of raw.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/gu)) {
    const token = match[0];
    if (token === "{" || token === "[") stack.push({ object: token === "{", keys: new Set(), expectingKey: token === "{" });
    else if (token === "}" || token === "]") stack.pop();
    else {
      const parent = stack.at(-1);
      if (token === "," && parent?.object) parent.expectingKey = true;
      else if (token.startsWith('"') && parent?.object && parent.expectingKey) {
        const key = JSON.parse(token) as string;
        if (parent.keys.has(key)) invalid("duplicate artifact JSON key");
        parent.keys.add(key); parent.expectingKey = false;
      }
    }
  }
  return parsed;
}
function projection(result: ConventionalResult): JsonObject {
  const replica = result.replicates[0]!;
  return { versions: { ...result.versions }, totalTransitions: result.totalTransitions, scientificReplicationCount: 1,
    sharedRandomBaseline: { ...result.randomBaseline.summary }, replicate: { replicateId: replica.replicateId, policyDigest: hash(replica.qTable),
      training: { ...replica.training.summary }, evaluation: { ...replica.evaluation.summary },
      successRateDeltaFromBaseline: replica.evaluation.summary.successRate - result.randomBaseline.summary.successRate }, resumeSupported: false };
}

/** Collect observations only: no supervisor query, retry, execution/evaluation fact,
 * reservation settlement or allocation claim. A new ID explicitly requests a fresh read. */
export async function collectConventionalSupervised(stores: ConventionalCollectionStores, raw: ConventionalCollectionRequest,
  options: { now?: () => Date; signal?: AbortSignal } = {}): Promise<ObservationRecord> {
  const input = request(raw), { plan } = input, ledger = stores.ledger, journal = stores.journal;
  const now = options.now ?? (() => new Date()), signal = options.signal;
  const identity: CollectionIdentity = { actionId: input.actionId, planDigest: plan.digest, observationId: input.observationId, observationDigest: input.observationDigest };
  const existing = ledger.getObservation(input.collectionId);
  if (existing) return recover(existing, input, identity);
  const action = ledger.getAction(input.actionId), run = ledger.getRun(action.runId), manifest = ledger.getManifest(action.manifestDigest);
  same(manifest, plan.declarations.manifest, "registered manifest differs from plan");
  const { execution: _execution, evaluation: _evaluation, ...registration } = run;
  same(registration, plan.declarations.run, "registered run differs from plan");
  if (action.backend !== CONVENTIONAL_SUPERVISED_BACKEND || action.operation !== "launch" || action.cleanupTargetActionId !== null
    || action.backendKey !== plan.binding.backendKey || action.operationRevision !== plan.binding.operationRevision || !action.attemptId) invalid("action is not the bound attempted launch");
  same(action.payload, { attemptPlanDigest: plan.digest }, "admitted payload differs from plan");
  const job = journal.readByAction(input.actionId);
  if (!job) invalid("owned worker journal is missing");
  const expected = createJobDeclaration({ actionId: input.actionId, backendKey: action.backendKey, manifestDigest: manifest.digest,
    planDigest: plan.digest, workerId: plan.declarations.deployment.workerId, command: plan.command, limits: plan.limits,
    deadlineAt: job.declaration.request.deadlineAt, host: plan.declarations.deployment.host });
  same(job.declaration, expected, "worker declaration differs from admitted plan");
  if (job.digest !== hash(expected) || action.jobId !== null && action.jobId !== expected.jobId) invalid("worker declaration/job digest mismatch");
  const backendRequest = { actionId: action.actionId, attemptId: action.attemptId, manifestDigest: action.manifestDigest, backend: action.backend, backendKey: action.backendKey };
  const workerId = expected.workerId;
  const intentId = `supervised-intent:${hash([CONVENTIONAL_SUPERVISED_BACKEND, workerId, backendRequest])}`;
  const bridgeIntent = ledger.getObservation(intentId);
  if (!bridgeIntent) invalid("ledger launch intent is missing");
  const { digest: bridgeDigest, ...bridgeBody } = bridgeIntent;
  if (hash(bridgeBody) !== bridgeDigest || bridgeIntent.eventId !== intentId || bridgeIntent.sequence !== 0 || bridgeIntent.jobId !== null
    || bridgeIntent.source !== `supervised-backend:${hash([CONVENTIONAL_SUPERVISED_BACKEND, workerId]).slice(0, 32)}`
    || bridgeIntent.projectId !== run.projectId || bridgeIntent.runId !== run.runId || bridgeIntent.actionId !== action.actionId
    || bridgeIntent.payload.kind !== "intent" || bridgeIntent.payload.workerId !== workerId || bridgeIntent.payload.jobId !== expected.jobId
    || bridgeIntent.payload.targetActionId !== action.actionId || bridgeIntent.payload.declarationDigest !== job.digest
    || bridgeIntent.payload.payloadDigest !== action.payloadDigest) invalid("ledger and worker intent are not joined");
  same(bridgeIntent.payload.request, backendRequest, "bridge intent attempt mismatch");
  const history = journal.observations(expected.jobId);
  const record = history.find(item => item.observationId === input.observationId);
  if (!record || record.digest !== input.observationDigest || record.declarationDigest !== job.digest
    || record.actionId !== action.actionId || record.jobId !== expected.jobId) invalid("exact worker observation is missing or changed");
  const { digest: observationDigest, ...observationBody } = record;
  if (hash(observationBody) !== observationDigest) invalid("worker observation digest mismatch");
  const snapshot = snapshotOf(record);
  const ownedSuccess = terminalSuccess(snapshot) && firstTerminalSucceeded(history) === true;
  let reason = signal?.aborted ? "collection_cancelled" : action.state !== "acknowledged" || action.jobId !== expected.jobId
    ? "dispatch_acknowledgement_missing" : !ownedSuccess ? "successful_terminal_cleanup_not_established" : "artifacts_not_collected";
  const references: Record<string, FileReference> = {};
  let result: ConventionalResult | null = null;
  if (reason === "artifacts_not_collected") {
    const outputs = await Promise.all([
      readProjectFile(plan.outputs.root, `${plan.outputs.directoryName}/intent.json`, 96_000),
      readProjectFile(plan.outputs.root, `${plan.outputs.directoryName}/receipt.json`, 32_000),
      readProjectFile(plan.outputs.root, `${plan.outputs.directoryName}/result.json`, CONVENTIONAL_OUTPUT_BYTES),
    ]);
    for (const [index, output] of outputs.entries()) if (output.ok) references[["intent", "receipt", "result"][index]!] = output.reference;
    const [intentRead, receiptRead, resultRead] = outputs;
    if (signal?.aborted) reason = "collection_cancelled";
    else if (!intentRead?.ok || !receiptRead?.ok || !resultRead?.ok) reason = "artifact_unavailable_or_unsafe";
    else {
      try {
        const envelopeBytes = Buffer.from(plan.command.args.slice(5).join(""), "base64");
        if (createHash("sha256").update(envelopeBytes).digest("hex") !== plan.envelopeSha256) invalid("derived envelope mismatch");
        const envelope = JSON.parse(envelopeBytes.toString("utf8"));
        same(strictJson(intentRead.text), { schemaVersion: 1, kind: "conventional-supervised-intent", envelope,
          envelopeSha256: plan.envelopeSha256, replaySupported: false }, "worker intent artifact mismatch");
        const receipt = strictJson(receiptRead.text);
        same(receipt, { schemaVersion: 1, kind: "conventional-supervised-receipt", binding: plan.binding,
          requestDigest: plan.request.requestDigest, requestBytesSha256: plan.requestBytesSha256, envelopeSha256: plan.envelopeSha256,
          source: envelope.source, resultSha256: resultRead.reference.sha256, resultBytes: resultRead.reference.bytes, runnerExitCode: 0,
          meaning: "worker_output_receipt_requires_owned_terminal_supervisor_observation" }, "worker receipt artifact mismatch");
        result = validateConventionalResult(strictJson(resultRead.text), plan.request);
        reason = "bound_artifacts_collected";
      } catch { reason = "artifact_identity_or_result_invalid"; }
    }
  }
  const observedAt = now().toISOString();
  const payload: JsonObject = { schemaVersion: 1, kind: CONVENTIONAL_COLLECTION_SOURCE, requestIdentity: { ...identity },
    status: result ? "completed" : "incomplete", statusMeaning: "artifact_collection_not_scientific_validation", reason,
    planDigest: plan.digest, manifestDigest: manifest.digest, requestDigest: plan.request.requestDigest,
    jobId: expected.jobId, declarationDigest: job.digest, bridgeIntentId: bridgeIntent.eventId, bridgeIntentDigest: bridgeIntent.digest,
    workerObservation: { observationId: record.observationId, digest: record.digest, sequence: record.sequence, observedAt: record.observedAt,
      invocationId: snapshot?.invocationId ?? null, successfulTerminalCleanupObserved: ownedSuccess },
    artifacts: Object.fromEntries(Object.entries(references).map(([key, value]) => [key, { ...value }])),
    summary: result ? projection(result) : null, scientificEvaluation: "unassessed", scientificReplicationCount: 1,
    limitations: ["Collection preserves observed bytes and an owned supervisor receipt; it does not attest immutable deployment or OCI image identity.",
      "Raw episode/policy data remains in the declared result artifact; this compact observation does not replace its retention.",
      "The fixed-map comparison is not held-out-task generalization, significance, intervention authority, allocation release or billing settlement."] };
  // The reader is asynchronous; preserve a first identical request committed by
  // another same-owner caller rather than creating a conflicting timestamp.
  const raced = ledger.getObservation(input.collectionId);
  if (raced) return recover(raced, input, identity);
  return freezeSnapshot<unknown>(ledger.appendObservation({ eventId: input.collectionId, projectId: run.projectId, runId: run.runId,
    actionId: action.actionId, jobId: action.jobId, source: CONVENTIONAL_COLLECTION_SOURCE, sequence: 0, observedAt, payload })) as ObservationRecord;
}
