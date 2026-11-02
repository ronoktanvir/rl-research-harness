import { checkEvidenceIds, isEnumValue, isId, isRecord, isText, onlyKeys } from "./evidence.js";
import type { DeepReadonly, EvidencePacket, ObjectionState, ResearchReview, ReviewOutcome } from "./types.js";

export interface ReviewValidationContext {
  reviewerId: string;
  packet: EvidencePacket;
  round: number;
  objections: DeepReadonly<ObjectionState[]>;
}

/** Validates structure and reference integrity, not whether a cited source proves a claim. */
export function validateReview(raw: unknown, context: ReviewValidationContext): ReviewOutcome {
  const outcome: ReviewOutcome = { reviewerId: context.reviewerId, status: "malformed", issues: [] };
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) return { ...outcome, status: "missing", issues: ["Reviewer returned no assessment"] };
  let input: unknown = raw;
  if (typeof raw === "string") {
    try { input = JSON.parse(raw); }
    catch { return { ...outcome, issues: ["Review must be a JSON object; unparseable response"] }; }
  } else {
    // Validate the exact snapshot that will be retained. Caller mutation and accessors
    // must not make validation inspect different values from the saved review.
    try { input = structuredClone(raw); }
    catch { return { ...outcome, issues: ["Review must contain cloneable data"] }; }
  }
  const issues = outcome.issues;
  if (!isRecord(input)) return { ...outcome, issues: ["Review must be an object"] };
  onlyKeys(input, ["schemaVersion", "reviewerId", "packetDigest", "round", "recommendation", "observations", "interpretations", "criteria", "objections", "resolutions", "rationale"], "review", issues);
  if (input.schemaVersion !== 1) issues.push("review.schemaVersion: expected 1");
  if (input.reviewerId !== context.reviewerId) issues.push("review.reviewerId: does not match assignment");
  if (input.packetDigest !== context.packet.digest) issues.push("review.packetDigest: stale or mismatched evidence packet");
  if (input.round !== context.round) issues.push("review.round: does not match assignment");
  if (!isEnumValue(input.recommendation, ["approve", "revise", "reject", "abstain"])) issues.push("review.recommendation: invalid value");
  const evidenceIds = new Set(context.packet.evidence.map(item => item.id));
  const statement = (value: unknown, path: string, required: boolean): void => {
    if (!isRecord(value)) { issues.push(`${path}: expected statement`); return; }
    onlyKeys(value, ["text", "evidenceIds"], path, issues);
    if (!isText(value.text)) issues.push(`${path}.text: nonempty text required`);
    checkEvidenceIds(value.evidenceIds, evidenceIds, `${path}.evidenceIds`, issues, required);
  };
  for (const key of ["observations", "interpretations"]) {
    const values = input[key];
    if (!Array.isArray(values)) issues.push(`review.${key}: array required`);
    else values.forEach((item, index) => statement(item, `review.${key}[${index}]`, true));
  }
  if (input.recommendation === "approve" && Array.isArray(input.observations) && input.observations.length === 0) issues.push("review.observations: approval needs at least one evidence-linked observation");
  statement(input.rationale, "review.rationale", input.recommendation === "approve");

  const criterionIds = new Set<string>();
  if (!Array.isArray(input.criteria)) issues.push("review.criteria: array required");
  else for (const [index, item] of input.criteria.entries()) {
    const path = `review.criteria[${index}]`;
    if (!isRecord(item)) { issues.push(`${path}: expected object`); continue; }
    onlyKeys(item, ["criterionId", "status", "summary", "evidenceIds"], path, issues);
    if (typeof item.criterionId !== "string" || !context.packet.requiredCriteria.includes(item.criterionId)) issues.push(`${path}.criterionId: unknown criterion`);
    else if (criterionIds.has(item.criterionId)) issues.push(`${path}.criterionId: duplicate criterion`);
    else criterionIds.add(item.criterionId);
    if (!isEnumValue(item.status, ["satisfied", "unsatisfied", "uncertain"])) issues.push(`${path}.status: invalid value`);
    if (!isText(item.summary)) issues.push(`${path}.summary: nonempty text required`);
    checkEvidenceIds(item.evidenceIds, evidenceIds, `${path}.evidenceIds`, issues, item.status === "satisfied");
    if (input.recommendation === "approve" && item.status !== "satisfied") issues.push(`${path}: approval contradicts an unsatisfied or uncertain criterion`);
  }
  for (const id of context.packet.requiredCriteria) if (!criterionIds.has(id)) issues.push(`review.criteria: missing ${id}`);

  const objectionIds = new Set<string>();
  if (!Array.isArray(input.objections)) issues.push("review.objections: array required");
  else for (const [index, item] of input.objections.entries()) {
    const path = `review.objections[${index}]`;
    if (!isRecord(item)) { issues.push(`${path}: expected object`); continue; }
    onlyKeys(item, ["id", "category", "severity", "text", "evidenceIds", "requiredAction"], path, issues);
    if (!isId(item.id) || objectionIds.has(item.id)) issues.push(`${path}.id: unique ID required`);
    else objectionIds.add(item.id);
    if (!isEnumValue(item.category, ["validity", "feasibility", "scope", "presentation"])) issues.push(`${path}.category: invalid value`);
    if (!isEnumValue(item.severity, ["blocking", "material", "minor"])) issues.push(`${path}.severity: invalid value`);
    const prior = context.objections.find(objection => objection.key === `${context.reviewerId}/${String(item.id)}`);
    if (prior && (prior.category !== item.category || prior.severity !== item.severity)) issues.push(`${path}: changing category or severity requires explicit resolution and a new objection ID`);
    for (const key of ["text", "requiredAction"]) if (!isText(item[key])) issues.push(`${path}.${key}: nonempty text required`);
    checkEvidenceIds(item.evidenceIds, evidenceIds, `${path}.evidenceIds`, issues, false);
  }
  const resolutions = new Set<string>();
  if (!Array.isArray(input.resolutions)) issues.push("review.resolutions: array required");
  else for (const [index, item] of input.resolutions.entries()) {
    const path = `review.resolutions[${index}]`;
    if (!isRecord(item)) { issues.push(`${path}: expected object`); continue; }
    onlyKeys(item, ["objectionKey", "disposition", "explanation", "evidenceIds"], path, issues);
    const prior = context.objections.find(objection => objection.key === item.objectionKey);
    if (!prior || prior.reviewerId !== context.reviewerId) issues.push(`${path}.objectionKey: only the original reviewer may resolve an existing objection`);
    if (typeof item.objectionKey !== "string" || resolutions.has(item.objectionKey)) issues.push(`${path}.objectionKey: unique key required`);
    else resolutions.add(item.objectionKey);
    if (prior && objectionIds.has(prior.id)) issues.push(`${path}: cannot both restate and resolve the same objection in one review`);
    if (!isEnumValue(item.disposition, ["resolved", "unresolved", "withdrawn"])) issues.push(`${path}.disposition: invalid value`);
    if (!isText(item.explanation)) issues.push(`${path}.explanation: nonempty explanation required`);
    checkEvidenceIds(item.evidenceIds, evidenceIds, `${path}.evidenceIds`, issues, item.disposition !== "unresolved");
  }
  if (issues.length) return outcome;
  return { reviewerId: context.reviewerId, status: "valid", review: structuredClone(input) as unknown as ResearchReview, issues: [] };
}
