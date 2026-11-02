import type { ExperimentLedger, JsonObject, ObservationRecord } from "../../ledger/types.ts";
import { digestValue, enumValue, hash, id, keys, timestamp } from "../../ledger/validation.ts";
import { freezeSnapshot } from "../../research/evidence.ts";
import { loadCoworkerReplayEvidence } from "./replay-evidence.ts";
import type { ReplayEvidencePayload } from "./replay-evidence.ts";
import { replayArray, replayError, replayJson, replayText, replayUnique } from "./replay-validation.ts";

export type ReplayAssessmentArchive = Pick<ExperimentLedger, "getObservation">;
export type ReplayAnnotationArchive = Pick<ExperimentLedger, "getObservation" | "appendObservation">;
export const COWORKER_REPLAY_ANNOTATION_SOURCE = "coworker-replay-semantic-annotations.v1";
export interface CoworkerReplayAnnotationBinding {
  projectId: string; replayObservationId: string; replayObservationDigest: string;
  memoSha256: string; requiredFactsSha256: string;
}
export interface ReplayAnnotator {
  id: string; kind: "human" | "model" | "committee" | "unspecified"; method: string; authoredAt: string;
  declaredTiming: "before_native_result" | "after_native_result" | "unknown";
  declaredResultExposure: "not_seen" | "seen" | "unknown";
}
export interface CoworkerReplayAnnotations {
  schemaVersion: 1; kind: typeof COWORKER_REPLAY_ANNOTATION_SOURCE;
  binding: CoworkerReplayAnnotationBinding; annotator: ReplayAnnotator;
  labels: { factId: string; expected: boolean | "unknown"; rationale: string }[]; digest: string;
}
export interface CoworkerReplayAssessmentBinding {
  projectId: string; replayObservationId: string; replayObservationDigest: string;
  annotationObservationId: string | null; annotationObservationDigest: string | null;
}
export interface ReplayEvidenceReference { observationId: string; digest: string; pointer: string }
export interface ReplayFactAssessment {
  factId: string; nativeCredit: boolean | null; nativeError: null | "scorer_exception" | "invalid_verdict";
  authorizedObserved: boolean; witnessMessageIds: string[]; observedCredit: boolean | null;
  annotation: { status: "provided" | "omitted"; expected: boolean | "unknown"; rationale: string | null };
  comparison: "agrees_with_annotation" | "credit_against_negative_annotation" |
    "no_credit_against_positive_annotation" | "annotation_unknown" | "scorer_error";
}
export interface ReplayAssessmentCounts {
  requiredFacts: number; providedAnnotations: number; knownExpectations: number; unknownExpectations: number;
  nativeScorerErrors: number; comparableLabelledFacts: number; agreesWithAnnotation: number;
  creditAgainstNegativeAnnotation: number; noCreditAgainstPositiveAnnotation: number;
  nativeCredits: number; authorizedObservedFacts: number; observedNumericCredits: number;
  creditWithoutAuthorizedObservation: number;
}
export interface ReplayNextAction {
  actionId: string; rank: number; mode: "read_only_investigation" | "protocol_design";
  title: string; reason: string; method: string[]; requiredEvidence: string[];
  dependsOn: string[]; executionAuthorized: false;
}
export interface CoworkerReplayAssessment {
  schemaVersion: 1; kind: "coworker-replay-assessment.v1"; rulesVersion: 1; rulesDigest: string; digest: string;
  binding: CoworkerReplayAssessmentBinding;
  scope: "current_v2_replay"; origin: ReplayEvidencePayload["request"]["origin"];
  originStatus: "operator_declared"; sourceCustody: "not_authenticated";
  replay: { status: "completed" | "incomplete"; reason: string; requestDigest: string; executionDigest: string;
    terminalStatus: "valid" | "invalid_policy" | null; memoSha256: string | null; requiredFactsSha256: string | null };
  annotation: { annotationDigest: string; annotator: ReplayAnnotator; archivedAt: string;
    authorshipVerification: "not_established"; timingVerification: "not_established";
    blindnessVerification: "not_established"; semanticTruthVerification: "not_established" } | null;
  requiredFactIds: string[]; facts: ReplayFactAssessment[]; counts: ReplayAssessmentCounts | null;
  evidence: ReplayEvidenceReference[]; nextActions: ReplayNextAction[];
  recommendation: { actionId: string; reason: string; changesIf: string[] };
  openScientificRequirements: string[]; historicalRequestUpdates: never[];
  semanticEvaluation: "unassessed"; taskSuccess: "unassessed"; scientificEvaluation: "unassessed";
  executionAuthorized: false; limitations: string[];
}

const RULES = [
  "Revalidate exact archived native replay and optional annotation observations, including project, memo and complete required fact definitions.",
  "Every native required fact remains represented. Omitted or explicitly unknown annotations remain unknown independently of acquisition status.",
  "Compare native text credit only with known annotation claims when the scorer returned a Boolean. Errors and unknown labels do not enter that denominator.",
  "Annotation identity, method, authored time, exposure and timing are declarations; archival time does not establish blinded or prewritten judgment or semantic truth.",
  "Completed replay is a mechanical evidence result. Invalid-policy termination, incomplete replay, task success and scientific validity remain separate.",
  "Prioritize incomplete replay or terminal evidence, scorer exceptions and annotation discrepancies, missing labels and provenance, then protected controls and replication design.",
  "All actions are prospective planning. Current-v2 synthetic or unauthenticated saved episodes cannot resolve historical Run-1 requests or authorize execution.",
] as const;
export const COWORKER_REPLAY_ASSESSMENT_RULES = freezeSnapshot({ version: 1, definitions: RULES, digest: hash(RULES) });

function prose(raw: unknown, maximum: number): asserts raw is string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) replayError("invalid annotation prose");
}
function annotationBinding(raw: unknown): asserts raw is CoworkerReplayAnnotationBinding & Record<string, unknown> {
  keys(raw, ["projectId", "replayObservationId", "replayObservationDigest", "memoSha256", "requiredFactsSha256"]);
  id(raw.projectId); id(raw.replayObservationId); digestValue(raw.replayObservationDigest);
  digestValue(raw.memoSha256); digestValue(raw.requiredFactsSha256);
}

/** Validates declarations without promoting them to independently verified labels. */
export function prepareCoworkerReplayAnnotations(raw: unknown): CoworkerReplayAnnotations {
  const value = replayJson(raw, 300_000);
  keys(value, ["schemaVersion", "kind", "binding", "annotator", "labels", "digest"],
    ["schemaVersion", "kind", "binding", "annotator", "labels"]);
  if (value.schemaVersion !== 1 || value.kind !== COWORKER_REPLAY_ANNOTATION_SOURCE) replayError("unsupported annotations");
  annotationBinding(value.binding);
  keys(value.annotator, ["id", "kind", "method", "authoredAt", "declaredTiming", "declaredResultExposure"]);
  replayText(value.annotator.id, 256); enumValue(value.annotator.kind, ["human", "model", "committee", "unspecified"]);
  prose(value.annotator.method, 8000); timestamp(value.annotator.authoredAt);
  enumValue(value.annotator.declaredTiming, ["before_native_result", "after_native_result", "unknown"]);
  enumValue(value.annotator.declaredResultExposure, ["not_seen", "seen", "unknown"]);
  replayArray(value.labels, 64);
  for (const label of value.labels) {
    keys(label, ["factId", "expected", "rationale"]); replayText(label.factId, 512); prose(label.rationale, 4000);
    if (typeof label.expected !== "boolean" && label.expected !== "unknown") replayError("invalid semantic expectation");
  }
  const labels = value.labels as CoworkerReplayAnnotations["labels"];
  replayUnique(labels.map(label => label.factId));
  const { digest: supplied, ...body } = value;
  const digest = hash(body);
  if (supplied !== undefined && supplied !== digest) replayError("annotation digest mismatch");
  return freezeSnapshot({ ...body, digest }) as unknown as CoworkerReplayAnnotations;
}

function replayFor(archive: ReplayAssessmentArchive, projectId: string, observationId: string, digest: string) {
  const record = loadCoworkerReplayEvidence(archive, observationId);
  if (record.projectId !== projectId || record.digest !== digest) replayError("replay observation binding mismatch");
  return { record, payload: record.payload as unknown as ReplayEvidencePayload };
}
function validateAnnotationReplay(archive: ReplayAssessmentArchive, annotation: CoworkerReplayAnnotations) {
  const binding = annotation.binding;
  const replay = replayFor(archive, binding.projectId, binding.replayObservationId, binding.replayObservationDigest);
  const result = replay.payload.bundle.execution.output?.result;
  if (replay.payload.bundle.execution.status !== "completed" || !result
      || result.memoSha256 !== binding.memoSha256 || result.requiredFactsSha256 !== binding.requiredFactsSha256) {
    replayError("annotations require the exact completed native memo and fact definitions");
  }
  const required = new Set(result.requiredFactIds);
  if (annotation.labels.some(label => !required.has(label.factId))) replayError("annotation refers to a nonrequired or unknown fact");
  return replay;
}

export function loadCoworkerReplayAnnotations(archive: ReplayAssessmentArchive, observationId: string): ObservationRecord {
  id(observationId);
  const saved = archive.getObservation(observationId);
  if (!saved) replayError("annotation observation missing");
  const value = replayJson(saved, 320_000);
  keys(value, ["eventId", "projectId", "runId", "actionId", "jobId", "source", "sequence", "observedAt", "payload", "digest"]);
  const { digest, ...body } = value; digestValue(digest); timestamp(value.observedAt);
  if (hash(body) !== digest || value.eventId !== observationId || value.source !== COWORKER_REPLAY_ANNOTATION_SOURCE
      || value.runId !== null || value.actionId !== null || value.jobId !== null || value.sequence !== 0) replayError("invalid annotation observation envelope");
  const annotation = prepareCoworkerReplayAnnotations(value.payload);
  if (hash(value.payload) !== hash(annotation) || value.eventId !== `coworker-replay-annotations:${annotation.digest}`
      || value.projectId !== annotation.binding.projectId) replayError("annotation observation identity mismatch");
  validateAnnotationReplay(archive, annotation);
  return freezeSnapshot(value) as unknown as ObservationRecord;
}

/** Archival time records this write. It does not authenticate claimed authorship or timing. */
export function archiveCoworkerReplayAnnotations(archive: ReplayAnnotationArchive, raw: unknown,
  options: { now?: () => Date } = {}): ObservationRecord {
  const now = options.now ?? (() => new Date());
  const annotation = prepareCoworkerReplayAnnotations(raw);
  validateAnnotationReplay(archive, annotation);
  const eventId = `coworker-replay-annotations:${annotation.digest}`;
  if (archive.getObservation(eventId)) return loadCoworkerReplayAnnotations(archive, eventId);
  const observedAt = now().toISOString(); timestamp(observedAt);
  archive.appendObservation({ eventId, projectId: annotation.binding.projectId, runId: null, actionId: null, jobId: null,
    source: COWORKER_REPLAY_ANNOTATION_SOURCE, sequence: 0, observedAt, payload: annotation as unknown as JsonObject });
  return loadCoworkerReplayAnnotations(archive, eventId);
}

export function prepareCoworkerReplayAssessmentBinding(raw: unknown): CoworkerReplayAssessmentBinding {
  const value = replayJson(raw, 8192);
  keys(value, ["projectId", "replayObservationId", "replayObservationDigest", "annotationObservationId", "annotationObservationDigest"]);
  id(value.projectId); id(value.replayObservationId); digestValue(value.replayObservationDigest);
  if (value.annotationObservationId === null) {
    if (value.annotationObservationDigest !== null) replayError("annotation binding must be complete");
  } else { id(value.annotationObservationId); digestValue(value.annotationObservationDigest); }
  return freezeSnapshot(value) as unknown as CoworkerReplayAssessmentBinding;
}

/** Pure comparison against annotation claims, never independent semantic adjudication. */
export function assessCoworkerReplayEvidence(archive: ReplayAssessmentArchive,
  raw: CoworkerReplayAssessmentBinding): CoworkerReplayAssessment {
  const binding = prepareCoworkerReplayAssessmentBinding(raw);
  const { record, payload } = replayFor(archive, binding.projectId, binding.replayObservationId, binding.replayObservationDigest);
  const execution = payload.bundle.execution, result = execution.output?.result ?? null;
  const annotationRecord = binding.annotationObservationId === null ? null : loadCoworkerReplayAnnotations(archive, binding.annotationObservationId);
  const annotation = annotationRecord ? prepareCoworkerReplayAnnotations(annotationRecord.payload) : null;
  if (annotationRecord && (annotationRecord.digest !== binding.annotationObservationDigest
      || annotation!.binding.projectId !== binding.projectId || annotation!.binding.replayObservationId !== record.eventId
      || annotation!.binding.replayObservationDigest !== record.digest)) replayError("assessment annotation binding mismatch");
  const labels = new Map(annotation?.labels.map(label => [label.factId, label]) ?? []);
  const facts: ReplayFactAssessment[] = (result?.facts ?? []).map(fact => {
    const label = labels.get(fact.id), expected = label?.expected ?? "unknown";
    const comparison: ReplayFactAssessment["comparison"] = fact.error !== null ? "scorer_error" : expected === "unknown" ? "annotation_unknown"
      : fact.nativeCredit === expected ? "agrees_with_annotation" : fact.nativeCredit ? "credit_against_negative_annotation" : "no_credit_against_positive_annotation";
    return { factId: fact.id, nativeCredit: fact.nativeCredit, nativeError: fact.error,
      authorizedObserved: fact.authorizedObserved, witnessMessageIds: [...fact.witnessMessageIds], observedCredit: fact.observedCredit,
      annotation: { status: label ? "provided" : "omitted", expected, rationale: label?.rationale ?? null }, comparison };
  });
  const count = (predicate: (fact: ReplayFactAssessment) => boolean) => facts.filter(predicate).length;
  const counts: ReplayAssessmentCounts | null = result ? {
    requiredFacts: facts.length, providedAnnotations: count(f => f.annotation.status === "provided"),
    knownExpectations: count(f => f.annotation.expected !== "unknown"), unknownExpectations: count(f => f.annotation.expected === "unknown"),
    nativeScorerErrors: count(f => f.nativeError !== null), comparableLabelledFacts: count(f => f.nativeError === null && f.annotation.expected !== "unknown"),
    agreesWithAnnotation: count(f => f.comparison === "agrees_with_annotation"),
    creditAgainstNegativeAnnotation: count(f => f.comparison === "credit_against_negative_annotation"),
    noCreditAgainstPositiveAnnotation: count(f => f.comparison === "no_credit_against_positive_annotation"),
    nativeCredits: count(f => f.nativeCredit === true), authorizedObservedFacts: count(f => f.authorizedObserved),
    observedNumericCredits: count(f => f.observedCredit === true), creditWithoutAuthorizedObservation: count(f => f.nativeCredit === true && !f.authorizedObserved),
  } : null;
  const nextActions: ReplayNextAction[] = [];
  const action = (actionId: string, mode: ReplayNextAction["mode"], title: string, reason: string,
    method: string[], requiredEvidence: string[], dependsOn: string[] = []) => {
    nextActions.push({ actionId, rank: nextActions.length + 1, mode, title, reason, method, requiredEvidence, dependsOn, executionAuthorized: false });
  };
  if (!result) action("recover-native-evidence", "read_only_investigation", "Resolve the incomplete replay evidence.",
    `The archived attempt is incomplete (${execution.reason}); no required-fact performance denominator was established.`,
    ["Inspect the bound failure and input provenance without replacing the saved attempt.", "Recover missing evidence or correct declarations, then use a new explicit replay identity; do not infer zero task performance."],
    ["A new bound receipt that explains the failure or completes native replay, retaining the original incomplete attempt."]);
  else if (!result.terminal.valid) action("inspect-policy-termination", "read_only_investigation", "Explain the terminal-invalid policy episode.",
    "Native reconstruction completed but the policy did not submit a valid memo; mechanical fact rows are not task success.",
    ["Inspect the exact call cap and terminal evidence before comparing submitted-memo outcomes.", "Specify how invalid-policy episodes enter any future evaluation denominator without deleting the original record."],
    ["A versioned termination and failure-accounting rule supported by the retained trace."]);
  if (counts?.nativeScorerErrors) action("inspect-native-scorer-errors", "read_only_investigation", "Review native scorer exceptions without converting them to negative credit.",
    `${counts.nativeScorerErrors} required facts have unassessable native verdicts.`,
    ["Inspect the exact memo and same-episode fact definitions against the pinned scorer contract.", "Classify unsupported inputs separately from policy mistakes; any evaluator repair needs a new version and regression qualification."],
    ["A source-bound error classification and a separately qualified evaluator correction or narrower supported domain."]);
  if (counts && counts.creditAgainstNegativeAnnotation + counts.noCreditAgainstPositiveAnnotation > 0) action("review-evaluator-discrepancy", "read_only_investigation", "Review native credit disagreements with the semantic annotation claims.",
    "At least one known annotation and Boolean native verdict disagree. This identifies a reference-relative discrepancy, not independently established semantic truth.",
    ["Inspect the exact retained memo, complete world definitions, observed context and annotation rationale.", "Review both the annotation and the evaluator against a declared semantic criterion; preserve dissent and original labels rather than relabelling to fit the scorer.", "If the discrepancy is confirmed, propose a versioned repair and fixed counterexample regressions before reuse."],
    ["An independently justified adjudication or explicit unresolved disagreement, with source/input/annotation identities and any qualified repair."]);
  if (counts?.creditWithoutAuthorizedObservation) action("review-acquisition-credit-boundary", "read_only_investigation", "Keep numerical credit separate from authorized observation.",
    "Some credited facts have no native authorized observation witness. Numerical credit alone does not establish acquisition, even when the memo's claim is correct.",
    ["Specify whether the intended capability is numerical assertion, authorized acquisition or semantic use of acquired evidence.", "Use the retained message and page witnesses to assess that contract; do not reinterpret the numeric predicate as an acquisition measure."],
    ["An explicit capability/measurement definition retaining the separate numerical, acquisition and semantic observations."]);
  if (counts?.unknownExpectations) action("complete-semantic-annotations", "read_only_investigation", "Obtain explicit semantic annotations for the remaining required facts.",
    `${counts.unknownExpectations} required facts remain semantically unknown; absent acquisition does not supply a semantic label.`,
    ["Bind new annotations to this exact replay observation, memo and complete required fact definitions.", "Record annotator identity, method, rationale and actual result exposure; acknowledge posthoc work instead of claiming retrospective blindness.", "Retain ambiguous labels and disagreement without narrowing the native required-fact universe."],
    ["A new immutable annotation observation with justified labels or explicit unknowns for every selected fact."]);
  action("establish-annotation-provenance", "protocol_design", "Design independently reviewable semantic labeling and provenance.",
    "Authorship, method, timing and exposure declarations do not independently establish blinded or prewritten labels, or semantic truth.",
    ["Define the semantic criterion, independent review and disagreement process before drawing evaluator-validity claims.", "For prospective blind or prewritten evaluation, retain enforceable access/timing evidence; distinguish that evidence from supplied timestamps and declarations."],
    ["A versioned labeling/adjudication protocol and independently checkable provenance, with remaining uncertainties explicit."]);
  action("design-protected-controls", "protocol_design", "Specify protected evaluation and matched controls for the intended research claim.",
    "A selected current-v2 replay does not establish holdout protection, checkpoint-selection discipline or a matched training control.",
    ["Freeze training/development/final evaluation roles, access and checkpoint selection rules.", "Specify matched initialization, data, tuning, compute, helper/tool and inference conditions; retain unavoidable mismatches."],
    ["A prospective evaluation and control protocol, separate from this replay's mechanical evidence."]);
  action("design-replication", "protocol_design", "Define the estimand and independent replication before claiming training benefit.",
    "Required facts and evaluation episodes are not independent trained-policy replicas; this receipt does not establish the training replication count.",
    ["State the target effect and what observation would refute it.", "Choose the appropriate independent training or experimental unit and uncertainty analysis; retain failed runs and predefined selection/stopping rules."],
    ["A claim-specific replication, uncertainty and stopping plan with unresolved resource requirements."]);
  const evidence: ReplayEvidenceReference[] = [{ observationId: record.eventId, digest: record.digest, pointer: "/payload/bundle/execution" }];
  if (annotationRecord) evidence.push({ observationId: annotationRecord.eventId, digest: annotationRecord.digest, pointer: "/payload" });
  const first = nextActions[0]!;
  const body = { schemaVersion: 1 as const, kind: "coworker-replay-assessment.v1" as const, rulesVersion: 1 as const,
    rulesDigest: COWORKER_REPLAY_ASSESSMENT_RULES.digest, binding, scope: "current_v2_replay" as const,
    origin: payload.request.origin, originStatus: "operator_declared" as const, sourceCustody: "not_authenticated" as const,
    replay: { status: execution.status, reason: execution.reason, requestDigest: execution.requestDigest,
      executionDigest: payload.request.expected.executionDigest, terminalStatus: result?.terminal.status ?? null,
      memoSha256: result?.memoSha256 ?? null, requiredFactsSha256: result?.requiredFactsSha256 ?? null },
    annotation: annotation && annotationRecord ? { annotationDigest: annotation.digest, annotator: annotation.annotator,
      archivedAt: annotationRecord.observedAt, authorshipVerification: "not_established" as const, timingVerification: "not_established" as const,
      blindnessVerification: "not_established" as const, semanticTruthVerification: "not_established" as const } : null,
    requiredFactIds: [...(result?.requiredFactIds ?? [])], facts, counts, evidence, nextActions,
    recommendation: { actionId: first.actionId, reason: first.reason, changesIf: ["A new verified replay or annotation observation changes the discrepancy or evidence coverage.",
      "Independent adjudication changes the status of a disputed label while preserving prior records.", "A separately specified research question requires a different discriminating control."] },
    openScientificRequirements: ["Independent semantic/evaluator validity", "Authenticated execution and annotation provenance",
      "Protected evaluation and selection policy", "Matched controls", "Claim-specific independent replication and uncertainty"],
    historicalRequestUpdates: [] as never[], semanticEvaluation: "unassessed" as const, taskSuccess: "unassessed" as const,
    scientificEvaluation: "unassessed" as const, executionAuthorized: false as const,
    limitations: ["Comparison is relative to recorded annotation claims, not independent semantic adjudication or a measured population error rate.",
      "A selected or constructed episode and its facts do not establish independent training replication, causal benefit or generalization.",
      "Archive hashes bind retained content; origin, authorship and exposure declarations do not authenticate historical custody or blindness.",
      "Current-v2 evidence cannot be transferred to historical Run-1 requests; no historical request is changed or closed.",
      "Recommendations and council planning approval carry no experiment, provider, service or intervention authority."] };
  return freezeSnapshot({ ...body, digest: hash(body) }) as unknown as CoworkerReplayAssessment;
}
