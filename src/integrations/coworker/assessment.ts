import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { ExperimentLedger, ObservationRecord, JsonObject } from "../../ledger/types.ts";
import { digestValue, encode, enumValue, hash, id, integer, keys, object, timestamp } from "../../ledger/validation.ts";
import { createEvidencePacket, freezeSnapshot } from "../../research/evidence.ts";
import type { DeepReadonly, EvidencePacket, EvidenceCheck } from "../../research/types.ts";

const CAPTURE = "coworker-report-capture.v1";
export const COWORKER_ASSESSMENT_SOURCE = "coworker-capture-assessment.v1";
const READER_FILES = ["capture.ts", "index.ts", "files.ts", "read_file.py", "report.ts"];
const METRICS = new Set(["loss", "grad_norm", "rows", "optimizer_updates", "spend_usd", "elapsed_seconds",
  "helper_provider_attempts", "judge_provider_attempts", "rollout_wall_s", "judge_wall_s", "train_wall_s", "masking_episodes",
  "shuffled_control_permutations", ...["groups_formed", "groups_discarded", "groups_zero_variance", "degenerate_group_rate",
    "episodes_excluded_dropped", "episodes_excluded_no_exact_tokens", "episodes_trained", "episodes_per_hour"].map(key => `groups.${key}`),
  ...["surrogate", "entropy", "approx_kl", "clipfrac"].map(key => `loss_decomposition.${key}`)]);
const RULES = [
  { id: "report-readable", definition: "Missing or unsupported report requires source inspection; no step observations are not assessable." },
  { id: "step-integrity", definition: "Inspect every retained index and structural diagnostic, including rejected step_index numeric fields; duplicate, decreasing or invalid indices invalidate ordered analysis." },
  { id: "numerical-integrity", definition: "Recorded nonfinite or invalid numeric fields trigger inspection; absent loss/gradient coverage remains unknown." },
  { id: "serving-consistency", definition: "Any explicit post-update serving failure triggers inspection; null flags are unknown." },
  { id: "optimizer-activity", definition: "Explicit skipped optimizer updates trigger a diagnostic request, not a claim that skipping is erroneous." },
  { id: "checkpoint-assertions", definition: "Explicit negative producer checkpoint flags trigger byte/native verification; positive flags are not verification." },
  { id: "producer-abort", definition: "A reported abort triggers investigation; neither abort nor its absence establishes current execution." },
  { id: "scientific-comparison", definition: "This capture schema supplies no independent evaluation, comparable baseline or complete manifest." },
] as const;
export const COWORKER_ASSESSMENT_RULES = freezeSnapshot({ version: 1, definitions: RULES, digest: hash(RULES) });
type RuleId = typeof RULES[number]["id"];
export interface CoworkerAssessmentRequest { projectId: string; captureId: string; captureDigest: string }
export interface AssessmentFinding {
  ruleId: RuleId; status: "triggered" | "not_triggered" | "not_assessable";
  severity: "error" | "warning" | "information"; observation: string;
  evidenceId: string;
  references: { count: number; sample: string[]; selection: "first_20_in_archived_order" };
}
export interface CoworkerDiagnosticRequest {
  id: string; rank: number; priority: "integrity" | "diagnostic" | "evidence";
  kind: "inspect_report" | "inspect_step_order" | "inspect_numerics" | "inspect_serving" | "inspect_optimizer"
    | "verify_checkpoint" | "inspect_abort" | "recover_manifest" | "collect_independent_evaluation" | "design_matched_baseline";
  action: string; completionEvidence: string; findingIds: RuleId[]; evidenceIds: string[];
  authority: "diagnostic_request_only";
}
export type CoworkerAssessment = DeepReadonly<{
  schemaVersion: 1; kind: typeof COWORKER_ASSESSMENT_SOURCE; assessmentId: string; digest: string;
  binding: CoworkerAssessmentRequest; rulesVersion: 1; rulesDigest: string; observedAt: string;
  interpretation: "retrospective_capture_assessment"; interventionAuthorized: false;
  outcome: "integrity_issues_observed" | "diagnostic_review_requested" | "additional_evidence_required";
  coverage: { stepEntries: number; diagnosticEntries: number; diagnosticCounts: Record<string, number>;
    metrics: Record<string, { observedCount: number; min: number; max: number }>; reportSha256: string | null };
  findings: AssessmentFinding[]; requests: CoworkerDiagnosticRequest[]; packet: EvidencePacket; limitations: string[];
}>;
interface Diagnostic { code: string; severity: string; field: string; message: string }
interface Step { stepIndex: number; metrics: Record<string, number>; optimizerStepApplied: boolean | null;
  postUpdateServeOk: boolean | null; checkpointReported: { fullTrainingState: boolean | null; roundTripVerified: boolean | null; adapterSha256: string | null } }

function invalid(message: string): never { throw new TypeError(`Invalid Coworker assessment: ${message}`); }
function copy(raw: unknown): unknown {
  const budget = { nodes: 250_000, bytes: 2 * 1024 * 1024 };
  const visit = (value: unknown, depth: number): unknown => {
    if (--budget.nodes < 0 || depth > 32) invalid("structural bound exceeded");
    budget.bytes -= typeof value === "string" ? Buffer.byteLength(value) + 2 : 2;
    if (budget.bytes < 0) invalid("byte bound exceeded");
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype)) invalid("inert JSON required");
    if (Array.isArray(value) && value.length > 20_000) invalid("array bound exceeded");
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length || Object.values(fields).some(field => !Object.hasOwn(field, "value"))) invalid("accessors and symbols are unsupported");
    if (Array.isArray(value)) {
      if (Object.keys(fields).length !== value.length + 1) invalid("dense arrays required");
      return Array.from({ length: value.length }, (_, index) => {
        if (!fields[index]?.enumerable) invalid("dense arrays required");
        return visit(fields[index]!.value, depth + 1);
      });
    }
    return Object.fromEntries(Object.entries(fields).map(([key, field]) => {
      if (!field.enumerable) invalid("non-enumerable field");
      budget.bytes -= Buffer.byteLength(key) + 3;
      if (budget.bytes < 0) invalid("byte bound exceeded");
      return [key, visit(field.value, depth + 1)];
    }));
  };
  const result = visit(raw, 0); encode(result); return result;
}
function text(value: unknown, maximum = 4096): asserts value is string {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) invalid("bounded text required");
}
function bool(value: unknown): void { if (value !== null && typeof value !== "boolean") invalid("boolean or null required"); }
function hex(value: unknown, lengths = [40, 64]): void {
  if (value !== null && (typeof value !== "string" || !lengths.includes(value.length) || !/^[a-f0-9]+$/iu.test(value))) invalid("invalid reported source/hash");
}
function diagnostics(raw: unknown): Diagnostic[] {
  if (!Array.isArray(raw) || raw.length > 20_000) invalid("diagnostic bounds");
  for (const item of raw) {
    keys(item, ["code", "severity", "field", "message"]);
    if (typeof item.code !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(item.code)) invalid("diagnostic code");
    enumValue(item.severity, ["info", "warning", "error"]); text(item.field, 256); text(item.message);
  }
  return raw as Diagnostic[];
}
function validateCapture(raw: ObservationRecord, request: CoworkerAssessmentRequest) {
  const record = copy(raw); keys(record, ["eventId", "projectId", "runId", "actionId", "jobId", "source", "sequence", "observedAt", "payload", "digest"]);
  const { digest, ...body } = record;
  digestValue(digest); timestamp(record.observedAt);
  if (hash(body) !== digest || digest !== request.captureDigest || record.eventId !== request.captureId || record.projectId !== request.projectId
    || record.source !== CAPTURE || record.sequence !== 0 || record.runId !== null || record.actionId !== null || record.jobId !== null) invalid("capture identity or digest mismatch");
  const payload = record.payload; keys(payload, ["schemaVersion", "kind", "requestIdentity", "requestDigest", "reader", "ordering", "consistency", "currentCheckout", "reportObservation", "originalRun", "limits"]);
  if (payload.schemaVersion !== 1 || payload.kind !== CAPTURE || payload.ordering !== "unordered_file_snapshot"
    || payload.consistency !== "per_file_observations_not_an_atomic_project_snapshot") invalid("unsupported capture schema");
  const identity = payload.requestIdentity; keys(identity, ["projectId", "canonicalRoot", "reportPath"]);
  if (identity.projectId !== request.projectId) invalid("capture project mismatch");
  text(identity.canonicalRoot, 4096); text(identity.reportPath, 1024);
  if (!identity.canonicalRoot.startsWith("/") || posix.normalize(identity.canonicalRoot) !== identity.canonicalRoot
    || identity.reportPath.split("/").some(part => !part || part === "." || part === "..")
    || identity.reportPath.includes("\\") || posix.basename(identity.reportPath) !== "report.json") invalid("invalid capture paths");
  const expected = createHash("sha256").update(JSON.stringify({ projectId: identity.projectId, canonicalRoot: identity.canonicalRoot, reportPath: identity.reportPath })).digest("hex");
  if (payload.requestDigest !== expected) invalid("request reference mismatch");
  const reader = payload.reader; keys(reader, ["version", "sourceFiles", "sourceDigest", "meaning"]);
  if (reader.version !== CAPTURE || !Array.isArray(reader.sourceFiles) || reader.sourceFiles.length !== READER_FILES.length) invalid("unsupported reader identity");
  const sourceFiles = reader.sourceFiles.map((file, index) => {
    keys(file, ["path", "sha256"]); if (file.path !== READER_FILES[index]) invalid("reader file inventory mismatch"); digestValue(file.sha256);
    return { path: file.path, sha256: file.sha256 };
  });
  if (reader.sourceDigest !== createHash("sha256").update(JSON.stringify(sourceFiles)).digest("hex")) invalid("reader inventory digest mismatch");
  const original = payload.originalRun; object(original);
  if (original.registration !== "unregistered" || original.manifestDigest !== null || original.execution !== "unknown"
    || original.allocation !== "unknown" || original.billingSettlement !== "unknown" || original.scientificEvaluation !== "unassessed") invalid("unsupported original-run authority");
  if (!Array.isArray(original.missingManifestFields) || original.missingManifestFields.length < 1 || original.missingManifestFields.length > 100) invalid("missing provenance inventory");
  for (const field of original.missingManifestFields) {
    keys(field, ["field", "status", "reason"]); text(field.field, 128); text(field.reason);
    if (field.status !== "not_established") invalid("unsupported manifest claim");
  }
  const observed = payload.reportObservation; keys(observed, ["root", "reportReference", "observationAgeMs", "report", "diagnostics"]);
  if (observed.root !== identity.canonicalRoot) invalid("report root mismatch");
  if (observed.observationAgeMs !== null && (typeof observed.observationAgeMs !== "number" || !Number.isFinite(observed.observationAgeMs))) invalid("observation age");
  const issues = diagnostics(observed.diagnostics);
  let reportSha256: string | null = null;
  if (observed.reportReference !== null) {
    const ref = observed.reportReference; keys(ref, ["path", "sha256", "bytes", "modifiedAt"]);
    if (ref.path !== identity.reportPath) invalid("report reference path mismatch"); digestValue(ref.sha256); integer(ref.bytes); timestamp(ref.modifiedAt);
    if (ref.bytes > 16 * 1024 * 1024) invalid("report reference size"); reportSha256 = ref.sha256;
  }
  const parsed = observed.report;
  if ((parsed === null) !== (observed.reportReference === null)) invalid("report/reference availability mismatch");
  if (parsed !== null) {
    keys(parsed, ["format", "source", "configuration", "steps", "reportedAborted", "executionState", "spendMeaning", "diagnostics"]);
    enumValue(parsed.format, ["coworkerl-fit-loop", "unsupported"]);
    if (parsed.executionState !== "unknown" || typeof parsed.reportedAborted !== "boolean") invalid("report execution projection");
    enumValue(parsed.spendMeaning, ["producer_declared_training_process_gpu_estimate", "unspecified"]);
    keys(parsed.source, ["runtimeRevision", "sourceTreeDigest", "baseRevision"]);
    hex(parsed.source.runtimeRevision); hex(parsed.source.sourceTreeDigest, [64]); hex(parsed.source.baseRevision);
    keys(parsed.configuration, ["plannedSteps", "firstStepIndex", "trainingSeed"]);
    for (const value of Object.values(parsed.configuration)) if (value !== null) integer(value);
    if (encode(original.producerReportedSource) !== encode(parsed.source) || encode(original.partialProducerConfiguration) !== encode(parsed.configuration)
      || original.costMeaning !== parsed.spendMeaning) invalid("original-run projection mismatch");
    if (!Array.isArray(parsed.steps) || parsed.steps.length > 20_000) invalid("step bounds");
    for (const step of parsed.steps) {
      keys(step, ["stepIndex", "metrics", "optimizerStepApplied", "postUpdateServeOk", "checkpointReported"]); integer(step.stepIndex);
      bool(step.optimizerStepApplied); bool(step.postUpdateServeOk); object(step.metrics);
      for (const [metric, value] of Object.entries(step.metrics)) if (!METRICS.has(metric) || typeof value !== "number" || !Number.isFinite(value)) invalid("metric outside safe projection");
      keys(step.checkpointReported, ["fullTrainingState", "roundTripVerified", "adapterSha256"]);
      bool(step.checkpointReported.fullTrainingState); bool(step.checkpointReported.roundTripVerified); hex(step.checkpointReported.adapterSha256, [64]);
    }
    const remaining = new Map<string, number>();
    for (const issue of issues) { const key = hash(issue); remaining.set(key, (remaining.get(key) ?? 0) + 1); }
    for (const issue of diagnostics(parsed.diagnostics)) {
      const key = hash(issue), count = remaining.get(key) ?? 0;
      if (!count) invalid("report diagnostics omitted from capture"); remaining.set(key, count - 1);
    }
    if (parsed.format === "unsupported" && parsed.steps.length) invalid("unsupported report supplied steps");
  } else if (original.producerReportedSource !== null || original.partialProducerConfiguration !== null || original.costMeaning !== "unspecified") invalid("missing report claims producer evidence");
  return { record: record as unknown as ObservationRecord, payload, observed, parsed, issues, reportSha256 };
}

/** Pure retrospective assessment. No provider, file, queue, execution or ledger effects. */
export function assessCoworkerCapture(raw: ObservationRecord, rawRequest: CoworkerAssessmentRequest): CoworkerAssessment {
  const request = copy(rawRequest); keys(request, ["projectId", "captureId", "captureDigest"]);
  id(request.projectId); id(request.captureId); digestValue(request.captureDigest);
  const binding = request as unknown as CoworkerAssessmentRequest;
  const { record, parsed, issues, reportSha256 } = validateCapture(raw, binding);
  const steps = (parsed?.steps ?? []) as Step[];
  const usable = parsed?.format === "coworkerl-fit-loop" && steps.length > 0;
  const findings: AssessmentFinding[] = [], requests: CoworkerDiagnosticRequest[] = [];
  const metrics: Record<string, { observedCount: number; min: number; max: number }> = {};
  const diagnosticCounts: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const issue of issues) diagnosticCounts[issue.code] = (diagnosticCounts[issue.code] ?? 0) + 1;
  for (const step of steps) for (const [metric, value] of Object.entries(step.metrics)) {
    const prior = metrics[metric]; metrics[metric] = prior ? { observedCount: prior.observedCount + 1, min: Math.min(prior.min, value), max: Math.max(prior.max, value) }
      : { observedCount: 1, min: value, max: value };
  }
  const refs = (codes: string[]) => issues.flatMap((issue, index) => codes.includes(issue.code) ? [`/payload/reportObservation/diagnostics/${index}`] : []);
  const stepRefs = (predicate: (step: Step) => boolean, field: string) => steps.flatMap((step, index) => predicate(step) ? [`/payload/reportObservation/report/steps/${index}/${field}`] : []);
  const add = (ruleId: RuleId, status: AssessmentFinding["status"], severity: AssessmentFinding["severity"], observation: string, references: string[]) => {
    const result: AssessmentFinding = { ruleId, status, severity, observation, evidenceId: `assessment:${ruleId}`,
      references: { count: references.length, sample: references.slice(0, 20), selection: "first_20_in_archived_order" } };
    findings.push(result); return result;
  };
  const ask = (finding: AssessmentFinding, kind: CoworkerDiagnosticRequest["kind"], priority: CoworkerDiagnosticRequest["priority"], action: string, completionEvidence: string) => {
    requests.push({ id: `request:${kind}`, rank: 0, priority, kind, action, completionEvidence,
      findingIds: [finding.ruleId], evidenceIds: [finding.evidenceId], authority: "diagnostic_request_only" });
  };
  const readable = add("report-readable", usable ? "not_triggered" : parsed?.format === "unsupported" ? "triggered" : "not_assessable",
    parsed?.format === "unsupported" ? "error" : "information", usable ? "A recognized projection contains step observations." : "The capture cannot supply a usable step series.", ["/payload/reportObservation"]);
  if (!usable) ask(readable, "inspect_report", readable.status === "triggered" ? "integrity" : "evidence", "Inspect report availability, schema and capture diagnostics before metric analysis.", "A new separately identified capture with a readable report and explicit step observations, or a documented producer failure.");
  // The reader omits a step whose index cannot be parsed. Its numeric diagnostic
  // therefore remains the only structural evidence for that rejected entry.
  const orderRefs = [...refs(["duplicate_step", "out_of_order_step", "invalid_step"]), ...issues.flatMap((issue, index) =>
    ["invalid_metric", "nonfinite_metric"].includes(issue.code) && /^steps\[\d+\]\.step_index$/u.test(issue.field)
      ? [`/payload/reportObservation/diagnostics/${index}`] : [])], seen = new Set<number>(); let previous = -1;
  steps.forEach((step, index) => { if (seen.has(step.stepIndex) || step.stepIndex < previous) orderRefs.push(`/payload/reportObservation/report/steps/${index}/stepIndex`); seen.add(step.stepIndex); previous = step.stepIndex; });
  const order = add("step-integrity", orderRefs.length ? "triggered" : usable ? "not_triggered" : "not_assessable",
    orderRefs.length ? "error" : "information", "Check covers all archived step entries; capture times do not establish cross-capture producer ordering.", orderRefs);
  if (orderRefs.length) ask(order, "inspect_step_order", "integrity", "Resolve duplicated, decreasing or structurally invalid step records before fitting a trajectory.", "Producer sequence/attempt provenance and a corrected new capture; retain the conflicting capture.");
  const numericRefs = refs(["nonfinite_metric", "invalid_metric"]);
  const completeNumerics = usable && steps.every(step => Object.hasOwn(step.metrics, "loss") && Object.hasOwn(step.metrics, "grad_norm")) && !issues.some(issue => issue.code === "missing_metric");
  const numeric = add("numerical-integrity", numericRefs.length ? "triggered" : completeNumerics ? "not_triggered" : "not_assessable",
    numericRefs.length ? "error" : "information", "Checks finite/typed numeric observations and explicit loss/gradient coverage; no universal loss, KL, entropy or gradient threshold is applied.", numericRefs);
  if (numeric.status !== "not_triggered") ask(numeric, "inspect_numerics", numericRefs.length ? "integrity" : "evidence", "Inspect the cited invalid numeric fields or recover missing loss/gradient observations.", "A bounded numerical reproduction or corrected producer instrumentation tied to the original configuration; missing values must not be replaced with zero.");
  const servingRefs = [...refs(["serving_check_failed"]), ...stepRefs(step => step.postUpdateServeOk === false, "postUpdateServeOk")];
  const serving = add("serving-consistency", servingRefs.length ? "triggered" : usable && steps.every(step => step.postUpdateServeOk === true) ? "not_triggered" : "not_assessable",
    servingRefs.length ? "error" : "information", "Serving flags are producer reports, not independent endpoint tests; absent flags remain unknown.", servingRefs);
  if (serving.status !== "not_triggered") ask(serving, "inspect_serving", servingRefs.length ? "integrity" : "evidence", "Verify which adapter/checkpoint the serving endpoint used at the cited updates.", "Version-bound serving/reload evidence and independent response checks; no live endpoint is called by this assessment.");
  const skipped = stepRefs(step => step.optimizerStepApplied === false, "optimizerStepApplied");
  const optimizer = add("optimizer-activity", skipped.length ? "triggered" : usable && steps.every(step => step.optimizerStepApplied === true) ? "not_triggered" : "not_assessable",
    skipped.length ? "warning" : "information", "Explicit skipped updates warrant checking group filtering/degeneracy; this does not establish erroneous skipping, stagnation or failed training.", skipped);
  if (skipped.length) ask(optimizer, "inspect_optimizer", "diagnostic", "Inspect skip reasons, group variance and exclusion counts for the cited steps.", "Per-step explanations consistent with the declared optimizer/degeneracy policy; no post-hoc universal stopping threshold.");
  const checkpointRefs = stepRefs(step => step.checkpointReported.fullTrainingState === false || step.checkpointReported.roundTripVerified === false, "checkpointReported");
  const checkpoint = add("checkpoint-assertions", checkpointRefs.length ? "triggered" : "not_assessable", checkpointRefs.length ? "warning" : "information",
    "Neither positive checkpoint flags nor a reported fingerprint verify artifact bytes, optimizer state or a valid resume boundary.", checkpointRefs);
  if (checkpointRefs.length) ask(checkpoint, "verify_checkpoint", "diagnostic", "Inspect the cited checkpoint capability/round-trip failures before proposing resume.", "Native checkpoint inventory, state and resume-boundary verification; metadata assertions alone are insufficient.");
  const aborted = add("producer-abort", parsed?.reportedAborted === true ? "triggered" : parsed ? "not_triggered" : "not_assessable",
    parsed?.reportedAborted === true ? "warning" : "information", "Producer abort presence is historical evidence; absence and presence both leave current liveness unknown.", parsed?.reportedAborted === true ? ["/payload/reportObservation/report/reportedAborted"] : []);
  if (aborted.status === "triggered") ask(aborted, "inspect_abort", "diagnostic", "Recover the producer's abort reason and separately reconcile any claimed live job.", "Origin-bound abort evidence and authenticated worker observation before proposing recovery; never replay from this report alone.");
  const science = add("scientific-comparison", "not_assessable", "information", "This capture has no independent task-success evaluation, matched baseline or complete original manifest. Loss changes do not establish learning benefit.", ["/payload/originalRun/missingManifestFields"]);
  ask(science, "recover_manifest", "evidence", "Recover original code, model/data/split, reward/evaluator and selection identities.", "A verified provenance record linked to the producer; the current checkout and a training seed are insufficient.");
  ask(science, "collect_independent_evaluation", "evidence", "Specify and obtain independent task-success measurements, separate from training reward, on a fixed evaluation policy.", "Evaluator/split/checkpoint identities, per-task outcomes and failure accounting; actual evaluation needs separately authorized execution.");
  ask(science, "design_matched_baseline", "evidence", "Define a matched baseline and replication unit before interpreting improvement.", "Comparable baseline artifacts and seed/run-level comparison; episodes from one run must not be relabeled independent training replicas.");
  const priority = { integrity: 0, diagnostic: 1, evidence: 2 };
  requests.sort((a, b) => priority[a.priority] - priority[b.priority]); requests.forEach((item, index) => { item.rank = index + 1; });
  const rulesDigest = COWORKER_ASSESSMENT_RULES.digest;
  const assessmentId = `coworker-assessment:${hash([binding.captureDigest, rulesDigest])}`;
  const limitations = ["Retrospective diagnostic requests are not execution, stop/retry authority, run registration, evaluator approval or billing settlement.",
    "The capture contains a sanitized projection and hashes, not raw reports, tensor contents or an atomic project snapshot.",
    "All archived steps and diagnostics were inspected; reference examples are bounded to twenty per rule, with total counts retained.",
    "Not-triggered means no trigger in this rule's observed scope, not a healthy trainer or valid research result.",
    "Rules are retrospective and versioned; they are not an original preregistered stopping policy. Threshold-dependent scientific claims require separate evidence."];
  const coverage = { stepEntries: steps.length, diagnosticEntries: issues.length, diagnosticCounts: { ...diagnosticCounts }, metrics, reportSha256 };
  const checks: EvidenceCheck[] = [readable, order, numeric, serving].map(finding => ({ id: finding.ruleId,
    status: finding.status === "triggered" ? "failed" : finding.status === "not_triggered" ? "passed" : "unknown", evidenceIds: [finding.evidenceId] }));
  checks.push({ id: "independent-evaluation-available", status: "unknown", evidenceIds: [science.evidenceId] },
    { id: "baseline-comparison-available", status: "unknown", evidenceIds: [science.evidenceId] });
  const packet = createEvidencePacket({ schemaVersion: 1, packetId: `capture-assessment:${hash([binding.captureDigest, rulesDigest]).slice(0, 40)}`, revision: 1,
    createdAt: record.observedAt, question: "Which concrete diagnostic checks and additional evidence should precede a controlled follow-up to this captured run?",
    proposal: "Review the deterministic findings and ranked diagnostic requests. Preserve missing evidence and producer-assertion limits; do not infer live health, learning benefit, conference validity or authority to intervene.",
    requiredCriteria: ["diagnostic-evidence", "falsifiable-next-tests", "independent-evaluation-and-baselines"],
    evidence: [{ id: "capture:assessment-scope", kind: "artifact", locator: `ledger-observation:${record.eventId}`, version: record.digest,
      summary: encode({ binding, rulesVersion: 1, rulesDigest, coverage, limitations, requests }) },
    ...findings.map(finding => ({ id: finding.evidenceId, kind: "artifact" as const, locator: `ledger-observation:${record.eventId}`, version: record.digest, summary: encode(finding) }))], checks });
  const body = { schemaVersion: 1 as const, kind: COWORKER_ASSESSMENT_SOURCE as typeof COWORKER_ASSESSMENT_SOURCE, assessmentId, binding, rulesVersion: 1 as const, rulesDigest,
    observedAt: record.observedAt, interpretation: "retrospective_capture_assessment" as const, interventionAuthorized: false as const,
    outcome: findings.some(finding => finding.status === "triggered" && finding.severity === "error") ? "integrity_issues_observed" as const
      : findings.some(finding => finding.status === "triggered") ? "diagnostic_review_requested" as const : "additional_evidence_required" as const,
    coverage, findings, requests, packet, limitations };
  return freezeSnapshot({ ...body, digest: hash(body) });
}

/** One immutable derived observation. Repeats verify exact content; no execution facts change. */
export function archiveCoworkerAssessment(archive: Pick<ExperimentLedger, "getObservation" | "appendObservation">,
  request: CoworkerAssessmentRequest): ObservationRecord {
  const input = copy(request) as CoworkerAssessmentRequest;
  const capture = archive.getObservation(input.captureId);
  if (!capture) invalid("capture is missing");
  const assessment = assessCoworkerCapture(capture, input);
  const event = { eventId: assessment.assessmentId, projectId: input.projectId, runId: null, actionId: null, jobId: null,
    source: COWORKER_ASSESSMENT_SOURCE, sequence: 0, observedAt: assessment.observedAt, payload: assessment as unknown as JsonObject };
  const expected = { ...event, digest: hash(event) };
  const existing = archive.getObservation(event.eventId);
  if (existing) { if (encode(copy(existing)) !== encode(expected)) invalid("assessment identity conflicts with archived content"); return freezeSnapshot<unknown>(existing) as ObservationRecord; }
  const saved = archive.appendObservation(event);
  if (encode(copy(saved)) !== encode(expected)) invalid("archive returned inconsistent assessment");
  return freezeSnapshot<unknown>(saved) as ObservationRecord;
}
