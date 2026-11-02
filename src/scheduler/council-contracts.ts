import type { ExperimentLedger } from "../ledger/types.js";
import type { CouncilRound, DeepReadonly, EvidencePacket, ObjectionState, Reviewer } from "../research/types.js";
import { encode, enumValue, hash, id, integer, keys, snapshot, text, timestamp } from "../ledger/validation.js";
import { freezeSnapshot, verifyEvidencePacket } from "../research/evidence.js";
import { validateReview } from "../research/validation.js";
import type { ObservationRecord } from "../ledger/types.js";
export const COUNCIL_PLAN_SOURCE = "durable-council-plan.v1";
export const COUNCIL_STAGE_SOURCE = "durable-council-stage.v1";
export interface CouncilReviewer extends Reviewer { backend: "codex" | "claude"; model: string | null }
export interface CouncilPlanRequest {
  projectId: string; campaignId: string; packet: EvidencePacket; reviewers: CouncilReviewer[];
  reviser: { backend: "codex" | "claude"; model: string | null } | null;
  maxRevisions: number; deadlineAt: string; notBefore: string;
}
export interface CouncilPlan {
  schemaVersion: 1; kind: typeof COUNCIL_PLAN_SOURCE; planObservationId: string;
  requestDigest: string; createdAt: string; request: CouncilPlanRequest; planDigest: string;
}
export interface CouncilReviewRequest {
  reviewer: Reviewer; round: number; packet: EvidencePacket; previousRounds: CouncilRound[]; objections: ObjectionState[];
}
export interface CouncilRevisionRequest {
  packet: EvidencePacket; completedRounds: CouncilRound[]; objections: ObjectionState[]; blockers: string[];
}
interface StageBase {
  schemaVersion: 1; kind: typeof COUNCIL_STAGE_SOURCE; stageObservationId: string; planObservationId: string;
  planDigest: string; projectId: string; round: number; backend: "codex" | "claude"; model: string | null;
  requestDigest: string; stageDigest: string;
}
export type CouncilStage = StageBase & (
  | { operation: "review"; request: CouncilReviewRequest }
  | { operation: "revision"; request: CouncilRevisionRequest }
);
export type CouncilArchive = Pick<ExperimentLedger, "getObservation">;

function selectedModel(value: unknown): asserts value is string | null {
  if (value !== null && (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(value))) throw new Error("Explicit model identifier or null required");
}
function boundedId(value: unknown): asserts value is string { id(value); if (value.length > 128) throw new Error("Council ID exceeds 128 characters"); }
export function validateCouncilPlanRequest(raw: unknown): CouncilPlanRequest {
  const value = snapshot(raw); keys(value, ["projectId", "campaignId", "packet", "reviewers", "reviser", "maxRevisions", "deadlineAt", "notBefore"]);
  boundedId(value.projectId); boundedId(value.campaignId); integer(value.maxRevisions);
  if (value.maxRevisions > 5) throw new Error("Council permits at most five revisions");
  timestamp(value.deadlineAt); timestamp(value.notBefore);
  if (Date.parse(value.notBefore) >= Date.parse(value.deadlineAt)) throw new Error("Council eligibility must precede deadline");
  const packet = verifyEvidencePacket(value.packet as EvidencePacket);
  if (!Array.isArray(value.reviewers) || value.reviewers.length < 1 || value.reviewers.length > 12) throw new Error("One to twelve reviewers required");
  const seen = new Set<string>();
  for (const reviewer of value.reviewers) {
    keys(reviewer, ["id", "role", "backend", "model"]); boundedId(reviewer.id); text(reviewer.role);
    if (reviewer.role.length > 4096 || seen.has(reviewer.id)) throw new Error("Reviewer roles must be bounded and IDs unique");
    seen.add(reviewer.id); enumValue(reviewer.backend, ["codex", "claude"]); selectedModel(reviewer.model);
  }
  if (value.reviser !== null) { keys(value.reviser, ["backend", "model"]); enumValue(value.reviser.backend, ["codex", "claude"]); selectedModel(value.reviser.model); }
  encode(value); return { ...value, packet } as unknown as CouncilPlanRequest;
}
function verifiedArchive(ledger: CouncilArchive, observationId: string, source: string): ObservationRecord {
  id(observationId); const raw = ledger.getObservation(observationId); if (!raw) throw new Error("Council archive is missing");
  const observed = snapshot(raw), { digest, ...content } = observed;
  if (observed.eventId !== observationId || observed.source !== source || observed.runId !== null || observed.actionId !== null || observed.jobId !== null || hash(content) !== digest) throw new Error("Council observation identity or digest is invalid");
  return observed;
}
function validatePlan(raw: unknown): CouncilPlan {
  const value = snapshot(raw); keys(value, ["schemaVersion", "kind", "planObservationId", "requestDigest", "createdAt", "request", "planDigest"]);
  if (value.schemaVersion !== 1 || value.kind !== COUNCIL_PLAN_SOURCE) throw new Error("Unsupported council plan schema");
  timestamp(value.createdAt); const request = validateCouncilPlanRequest(value.request);
  if (value.planObservationId !== `council-plan:${hash([request.projectId, request.campaignId])}` || value.requestDigest !== hash(request)) throw new Error("Council plan identity is inconsistent");
  const { planDigest, ...data } = value; if (hash(data) !== planDigest) throw new Error("Council plan digest is invalid");
  return { ...value, request } as unknown as CouncilPlan;
}
export function loadCouncilPlan(ledger: CouncilArchive, planObservationId: string): CouncilPlan {
  const observed = verifiedArchive(ledger, planObservationId, COUNCIL_PLAN_SOURCE), plan = validatePlan(observed.payload);
  if (observed.projectId !== plan.request.projectId || observed.observedAt !== plan.createdAt || observed.sequence !== 0 || plan.planObservationId !== planObservationId) throw new Error("Council plan archive binding is invalid");
  return freezeSnapshot(plan) as CouncilPlan;
}
function packetForRound(raw: EvidencePacket, plan: CouncilPlan, round: number): EvidencePacket {
  const packet = verifyEvidencePacket(raw), initial = plan.request.packet;
  if (packet.revision !== initial.revision + round) throw new Error("Council packet revision does not match round");
  const fixed = (p: EvidencePacket) => { const { proposal: _proposal, revision: _revision, createdAt: _createdAt, digest: _digest, ...rest } = p; return rest; };
  if (encode(fixed(packet)) !== encode(fixed(initial))) throw new Error("Council revisions cannot change evidence, checks, criteria or question");
  if (round === 0 && encode(packet) !== encode(initial)) throw new Error("Initial council packet must match the plan");
  return packet;
}
function validateObjections(raw: unknown, plan: CouncilPlan, maxRound: number): ObjectionState[] {
  if (!Array.isArray(raw) || raw.length > 1200) throw new Error("Invalid bounded council objections");
  const seen = new Set<string>(), evidenceIds = new Set(plan.request.packet.evidence.map(item => item.id));
  for (const item of raw) {
    keys(item, ["id", "category", "severity", "text", "evidenceIds", "requiredAction", "key", "reviewerId", "firstRound", "lastRound", "status", "resolution"], ["id", "category", "severity", "text", "evidenceIds", "requiredAction", "key", "reviewerId", "firstRound", "lastRound", "status"]);
    id(item.id); id(item.reviewerId); text(item.text); text(item.requiredAction);
    if (!plan.request.reviewers.some(reviewer => reviewer.id === item.reviewerId) || item.key !== `${item.reviewerId}/${item.id}` || seen.has(item.key as string)) throw new Error("Council objection identity is invalid");
    seen.add(item.key as string); enumValue(item.category, ["validity", "feasibility", "scope", "presentation"]); enumValue(item.severity, ["blocking", "material", "minor"]); enumValue(item.status, ["open", "resolved", "withdrawn"]);
    integer(item.firstRound); integer(item.lastRound);
    if (item.firstRound > item.lastRound || item.lastRound > maxRound) throw new Error("Objection history exceeds completed rounds");
    if (!Array.isArray(item.evidenceIds) || item.evidenceIds.some(value => typeof value !== "string" || !evidenceIds.has(value))) throw new Error("Objection has unknown evidence");
    if (item.resolution !== undefined) {
      keys(item.resolution, ["objectionKey", "disposition", "explanation", "evidenceIds"], ["disposition", "explanation", "evidenceIds"]); enumValue(item.resolution.disposition, ["resolved", "unresolved", "withdrawn"]); text(item.resolution.explanation);
      if (item.resolution.objectionKey !== undefined && item.resolution.objectionKey !== item.key) throw new Error("Resolution belongs to another objection");
      if (!Array.isArray(item.resolution.evidenceIds) || item.resolution.evidenceIds.some(value => typeof value !== "string" || !evidenceIds.has(value))) throw new Error("Resolution has unknown evidence");
    }
  }
  encode(raw); return raw as ObjectionState[];
}
function validateRounds(raw: unknown, plan: CouncilPlan, length: number, objections: ObjectionState[]): CouncilRound[] {
  if (!Array.isArray(raw) || raw.length !== length) throw new Error("Archived council history length does not match stage round");
  const reviewers = new Set(plan.request.reviewers.map(item => item.id));
  for (const [index, round] of raw.entries()) {
    keys(round, ["round", "packet", "reviews"]); if (round.round !== index) throw new Error("Council history must contain ordered rounds");
    const packet = packetForRound(round.packet as EvidencePacket, plan, index);
    if (!Array.isArray(round.reviews) || round.reviews.length !== reviewers.size) throw new Error("Council round must account for every reviewer");
    const seen = new Set<string>();
    for (const outcome of round.reviews) {
      keys(outcome, ["reviewerId", "status", "review", "issues"], ["reviewerId", "status", "issues"]); id(outcome.reviewerId);
      if (!reviewers.has(outcome.reviewerId) || seen.has(outcome.reviewerId)) throw new Error("Unexpected council history reviewer"); seen.add(outcome.reviewerId);
      enumValue(outcome.status, ["valid", "missing", "malformed", "error", "timeout"]);
      if (!Array.isArray(outcome.issues) || outcome.issues.length > 1000 || outcome.issues.some(issue => typeof issue !== "string" || issue.length > 100_000)) throw new Error("Invalid council issue history");
      if (outcome.status === "valid") {
        if (validateReview(outcome.review, { reviewerId: outcome.reviewerId, packet, round: index, objections }).status !== "valid") throw new Error("Invalid structured review in council history");
      } else if (outcome.review !== undefined) throw new Error("Invalid outcomes cannot supply authoritative reviews");
    }
  }
  return raw as CouncilRound[];
}
function validatedStage(raw: unknown, plan: CouncilPlan): CouncilStage {
  const value = snapshot(raw); keys(value, ["schemaVersion", "kind", "stageObservationId", "planObservationId", "planDigest", "projectId", "operation", "round", "backend", "model", "request", "requestDigest", "stageDigest"]);
  if (value.schemaVersion !== 1 || value.kind !== COUNCIL_STAGE_SOURCE || value.planObservationId !== plan.planObservationId || value.planDigest !== plan.planDigest || value.projectId !== plan.request.projectId) throw new Error("Council stage is bound to another plan or project");
  enumValue(value.operation, ["review", "revision"]); integer(value.round); enumValue(value.backend, ["codex", "claude"]); selectedModel(value.model);
  if (value.round > plan.request.maxRevisions || value.round > 5) throw new Error("Stage exceeds the council revision bound");
  let reviewerId = "reviser";
  if (value.operation === "review") {
    keys(value.request, ["reviewer", "round", "packet", "previousRounds", "objections"]); keys(value.request.reviewer, ["id", "role"]);
    const requestedReviewer = value.request.reviewer;
    const reviewer = plan.request.reviewers.find(item => item.id === requestedReviewer.id);
    if (!reviewer || reviewer.role !== value.request.reviewer.role || reviewer.backend !== value.backend || reviewer.model !== value.model || value.request.round !== value.round) throw new Error("Review stage assignment is inconsistent");
    reviewerId = reviewer.id;
    const objections = validateObjections(value.request.objections, plan, value.round - 1);
    validateRounds(value.request.previousRounds, plan, value.round, objections);
    packetForRound(value.request.packet as EvidencePacket, plan, value.round);
  } else {
    keys(value.request, ["packet", "completedRounds", "objections", "blockers"]);
    if (!plan.request.reviser || value.round >= plan.request.maxRevisions || plan.request.reviser.backend !== value.backend || plan.request.reviser.model !== value.model) throw new Error("Revision stage is not authorized by this plan");
    const objections = validateObjections(value.request.objections, plan, value.round);
    const rounds = validateRounds(value.request.completedRounds, plan, value.round + 1, objections);
    const packet = packetForRound(value.request.packet as EvidencePacket, plan, value.round);
    if (encode(rounds.at(-1)!.packet) !== encode(packet)) throw new Error("Revision packet differs from its last completed round");
    if (!Array.isArray(value.request.blockers) || value.request.blockers.length > 1000 || value.request.blockers.some(item => typeof item !== "string" || item.length > 100_000)) throw new Error("Invalid revision blockers");
  }
  if (value.stageObservationId !== `council-stage:${hash([plan.planDigest, value.operation, value.round, reviewerId])}` || value.requestDigest !== hash(value.request)) throw new Error("Council stage identity or request digest is invalid");
  const { stageDigest, ...data } = value; if (hash(data) !== stageDigest) throw new Error("Council stage content digest is invalid");
  return value as unknown as CouncilStage;
}
export function buildCouncilStage(planInput: CouncilPlan, operation: "review", round: number, request: DeepReadonly<CouncilReviewRequest>): CouncilStage;
export function buildCouncilStage(planInput: CouncilPlan, operation: "revision", round: number, request: DeepReadonly<CouncilRevisionRequest>): CouncilStage;
export function buildCouncilStage(planInput: CouncilPlan, operation: "review" | "revision", round: number, rawRequest: DeepReadonly<CouncilReviewRequest | CouncilRevisionRequest>): CouncilStage {
  const plan = validatePlan(planInput), request = snapshot(rawRequest);
  const assignment = operation === "review" ? plan.request.reviewers.find(item => item.id === (request as CouncilReviewRequest).reviewer.id) : plan.request.reviser;
  if (!assignment) throw new Error("Stage assignment is absent from plan");
  const reviewerId = operation === "review" ? (request as CouncilReviewRequest).reviewer.id : "reviser";
  const data = { schemaVersion: 1, kind: COUNCIL_STAGE_SOURCE, stageObservationId: `council-stage:${hash([plan.planDigest, operation, round, reviewerId])}`,
    planObservationId: plan.planObservationId, planDigest: plan.planDigest, projectId: plan.request.projectId,
    operation, round, backend: assignment.backend, model: assignment.model, request, requestDigest: hash(request) };
  return freezeSnapshot(validatedStage({ ...data, stageDigest: hash(data) }, plan)) as CouncilStage;
}
export function loadCouncilStage(ledger: CouncilArchive, stageObservationId: string): CouncilStage {
  const observed = verifiedArchive(ledger, stageObservationId, COUNCIL_STAGE_SOURCE);
  const stage = observed.payload; id(stage.planObservationId);
  const plan = loadCouncilPlan(ledger, stage.planObservationId), verified = validatedStage(stage, plan);
  if (observed.projectId !== verified.projectId || observed.sequence !== verified.round || verified.stageObservationId !== stageObservationId) throw new Error("Council stage archive identity is inconsistent");
  return freezeSnapshot(verified) as CouncilStage;
}
