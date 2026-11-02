import { lstat } from "node:fs/promises";
import { parse, join } from "node:path";
import type { ExperimentLedger, JsonObject, ObservationRecord } from "../../ledger/types.ts";
import { digestValue, encode, hash, id, keys, policyScope, timestamp } from "../../ledger/validation.ts";
import { freezeSnapshot } from "../../research/evidence.ts";
import { loadObservedReplayArtifacts, validateObservedReplayBundle } from "./observed-replay-artifacts.ts";
import type { ObservedReplayBundle } from "./observed-replay-artifacts.ts";
import { replayAbsolute, replayError, replayJson, replayRelative, replayText } from "./replay-validation.ts";

export const COWORKER_REPLAY_EVIDENCE_SOURCE = "coworker-replay-evidence.v1";
export type ReplayEvidenceArchive = Pick<ExperimentLedger, "getObservation" | "appendObservation">;
export interface ReplayEvidenceRequest {
  projectId: string; evidenceId: string; bundlePath: string;
  expected: { requestDigest: string; executionDigest: string; receiptDigest: string };
  origin: { kind: "synthetic_fixture" | "saved_episode_unverified"; description: string;
    sourceReference: { locator: string; sha256: string } };
}
export interface ReplayEvidencePayload {
  schemaVersion: 1; kind: typeof COWORKER_REPLAY_EVIDENCE_SOURCE; request: ReplayEvidenceRequest; configuredRoot: string;
  bundle: ObservedReplayBundle; bundleDigest: string; scope: "current_v2_replay"; originStatus: "operator_declared";
  sourceCustody: "not_authenticated"; scientificEvaluation: "unassessed"; taskSuccess: "unassessed"; interventionAuthorized: false;
}
export type ReplayEvidenceRecord = Omit<ObservationRecord, "payload"> & { payload: ReplayEvidencePayload };
export function prepareReplayEvidenceRequest(raw: unknown): ReplayEvidenceRequest {
  const v = replayJson(raw, 32_768); keys(v, ["projectId", "evidenceId", "bundlePath", "expected", "origin"]);
  id(v.projectId); policyScope(`project:${v.projectId}`); id(v.evidenceId); replayRelative(v.bundlePath);
  keys(v.expected, ["requestDigest", "executionDigest", "receiptDigest"]); Object.values(v.expected).forEach(digestValue);
  keys(v.origin, ["kind", "description", "sourceReference"]);
  if (v.origin.kind !== "synthetic_fixture" && v.origin.kind !== "saved_episode_unverified") replayError("unsupported declared artifact origin");
  replayText(v.origin.description, 4096); keys(v.origin.sourceReference, ["locator", "sha256"]);
  replayText(v.origin.sourceReference.locator, 4096); digestValue(v.origin.sourceReference.sha256);
  return freezeSnapshot(v) as unknown as ReplayEvidenceRequest;
}
export function coworkerReplayEvidenceId(projectId: string, evidenceId: string): string {
  id(projectId); policyScope(`project:${projectId}`); id(evidenceId);
  return `coworker-replay-evidence:${hash([projectId, evidenceId])}`;
}
function payloadFor(request: ReplayEvidenceRequest, configuredRoot: string, rawBundle: unknown): ReplayEvidencePayload {
  replayAbsolute(configuredRoot); const bundle = validateObservedReplayBundle(rawBundle);
  if (request.expected.requestDigest !== bundle.intent.request.requestDigest || request.expected.executionDigest !== hash(bundle.execution)
    || request.expected.receiptDigest !== bundle.receipt.digest) replayError("selected bundle identity mismatch");
  const payload = { schemaVersion: 1 as const, kind: COWORKER_REPLAY_EVIDENCE_SOURCE, request, configuredRoot,
    bundle, bundleDigest: hash(bundle), scope: "current_v2_replay" as const, originStatus: "operator_declared" as const,
    sourceCustody: "not_authenticated" as const, scientificEvaluation: "unassessed" as const, taskSuccess: "unassessed" as const, interventionAuthorized: false as const };
  encode(payload); // The full private payload must fit the ledger's 2 MiB bound before a write.
  return freezeSnapshot(payload) as unknown as ReplayEvidencePayload;
}
/** Verifies the complete stored observation without touching the artifact root or original project. */
export function loadCoworkerReplayEvidence(archive: Pick<ExperimentLedger, "getObservation">, observationId: string): ReplayEvidenceRecord {
  id(observationId); const raw = archive.getObservation(observationId);
  if (!raw) replayError("replay evidence observation missing");
  const v = replayJson(raw, 2 * 1024 * 1024);
  keys(v, ["eventId", "projectId", "runId", "actionId", "jobId", "source", "sequence", "observedAt", "payload", "digest"]);
  const { digest, ...body } = v; digestValue(digest); timestamp(v.observedAt);
  if (v.eventId !== observationId || v.source !== COWORKER_REPLAY_EVIDENCE_SOURCE || v.sequence !== 0 || v.runId !== null || v.actionId !== null || v.jobId !== null || hash(body) !== digest) replayError("replay observation envelope mismatch");
  keys(v.payload, ["schemaVersion", "kind", "request", "configuredRoot", "bundle", "bundleDigest", "scope", "originStatus", "sourceCustody", "scientificEvaluation", "taskSuccess", "interventionAuthorized"]);
  const request = prepareReplayEvidenceRequest(v.payload.request); replayAbsolute(v.payload.configuredRoot);
  if (v.projectId !== request.projectId || observationId !== coworkerReplayEvidenceId(request.projectId, request.evidenceId)) replayError("replay project or event identity mismatch");
  const payload = payloadFor(request, v.payload.configuredRoot, v.payload.bundle);
  if (hash(v.payload) !== hash(payload)) replayError("replay evidence projection mismatch");
  return freezeSnapshot({ ...body, digest, payload }) as unknown as ReplayEvidenceRecord;
}

interface DirectoryIdentity { path: string; dev: number; ino: number }
/** Refuses links and ordinary ancestry changes. The operator-owned ancestors must stay nonmutable
 * during import; this is not an openat boundary against a malicious concurrent directory writer.
 */
async function directories(root: string, relative: string): Promise<DirectoryIdentity[]> {
  const path = join(root, relative), parts = path.slice(parse(path).root.length).split("/");
  const result: DirectoryIdentity[] = []; let current = parse(path).root;
  for (const part of parts) {
    current = join(current, part); const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) replayError("artifact ancestry must be regular directories without links");
    result.push({ path: current, dev: info.dev, ino: info.ino });
  }
  return result;
}

/** Import is observation-only: it neither launches native replay nor dispatches research work. */
export async function importCoworkerReplayEvidence(archive: ReplayEvidenceArchive, raw: unknown,
  options: { artifactRoot: string; now?: () => Date }): Promise<ReplayEvidenceRecord> {
  const request = prepareReplayEvidenceRequest(raw), configuredRoot = options.artifactRoot, now = options.now ?? (() => new Date());
  replayAbsolute(configuredRoot);
  const observationId = coworkerReplayEvidenceId(request.projectId, request.evidenceId);
  const cached = () => {
    if (!archive.getObservation(observationId)) return null;
    const previous = loadCoworkerReplayEvidence(archive, observationId);
    if (hash(previous.payload.request) !== hash(request) || previous.payload.configuredRoot !== configuredRoot) replayError("replay evidence identity conflict");
    return previous;
  };
  const previous = cached(); if (previous) return previous;
  const before = await directories(configuredRoot, request.bundlePath);
  const saved = await loadObservedReplayArtifacts(join(configuredRoot, request.bundlePath));
  const after = await directories(configuredRoot, request.bundlePath);
  if (hash(before) !== hash(after)) replayError("artifact ancestry changed during import");
  const { intent, execution, report, receipt } = saved;
  const payload = payloadFor(request, configuredRoot, { intent, execution, report, receipt });
  // Another import in this single-owner controller may have completed while files were read.
  const concurrent = cached(); if (concurrent) return concurrent;
  const observedAt = now().toISOString(); timestamp(observedAt);
  const event = { eventId: observationId, projectId: request.projectId, runId: null, actionId: null, jobId: null,
    source: COWORKER_REPLAY_EVIDENCE_SOURCE, sequence: 0, observedAt, payload: payload as unknown as JsonObject };
  encode(event);
  const stored = archive.appendObservation(event);
  if (hash(stored) !== hash({ ...event, digest: hash(event) })) replayError("archive returned mismatched replay observation");
  return loadCoworkerReplayEvidence(archive, observationId);
}

export function summarizeCoworkerReplayEvidence(record: ReplayEvidenceRecord) {
  const result = record.payload.bundle.execution.output?.result;
  return freezeSnapshot({ observationId: record.eventId, observationDigest: record.digest, projectId: record.projectId,
    declaredOrigin: record.payload.request.origin.kind, originStatus: record.payload.originStatus,
    executionStatus: record.payload.bundle.execution.status, executionReason: record.payload.bundle.execution.reason,
    requiredFacts: result?.requiredFactIds.length ?? null, worldFacts: result?.worldFacts.length ?? null,
    authorizedObservedFacts: result?.facts.filter(f => f.authorizedObserved).length ?? null,
    observedNumericCredits: result?.facts.filter(f => f.observedCredit === true).length ?? null,
    semanticEvaluation: "unassessed", taskSuccess: "unassessed", scientificEvaluation: "unassessed", interventionAuthorized: false });
}
