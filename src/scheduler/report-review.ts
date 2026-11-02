import { createHash } from "node:crypto";
import type { ExperimentLedger, JsonObject, ObservationRecord } from "../ledger/types.ts";
import { digestValue, encode, enumValue, hash, id, integer, keys, object, snapshot, text, timestamp } from "../ledger/validation.ts";
import { createEvidencePacket, freezeSnapshot } from "../research/evidence.ts";
import { runCouncil } from "../research/council.ts";
import type { CouncilResult, DeepReadonly, EvidencePacket } from "../research/types.ts";
import type { ResearchTaskHandler } from "./handlers.ts";
import type { EnqueueTaskInput, HandlerPolicy, TaskQueue, TaskRecord, TaskState } from "./types.ts";

const CAPTURE_SOURCE = "coworker-report-capture.v1";
const PLAN_SOURCE = "report-review-plan.v1";
const HANDLER_VERSION = "1";
const PENDING = new Set<TaskState>(["queued", "running", "waiting_quota", "waiting_auth", "uncertain"]);

export interface ReportReviewer { id: string; role: string; backend: "codex" | "claude"; model: string | null }
export interface ReportReviewRequest {
  projectId: string; campaignId: string; captureId: string; reviewers: ReportReviewer[];
  deadlineAt: string; notBefore: string;
}
interface PlannedReviewTask extends Omit<EnqueueTaskInput, "input"> {
  input: { packet: EvidencePacket; reviewer: { id: string; role: string }; model: string | null };
}
interface PlannedReviewer { reviewer: ReportReviewer; task: PlannedReviewTask; handler: HandlerPolicy }
interface PlanData {
  schemaVersion: 1; kind: typeof PLAN_SOURCE; planObservationId: string; request: ReportReviewRequest;
  requestDigest: string; captureDigest: string; createdAt: string; packet: EvidencePacket; reviews: PlannedReviewer[];
}
export type ReportReviewPlan = DeepReadonly<PlanData & { planDigest: string }>;
export type ReportReviewAggregation =
  | { status: "pending"; planObservationId: string; tasks: { taskId: string; state: TaskState | "missing" }[] }
  | { status: "complete"; planObservationId: string; decision: CouncilResult };

function request(raw: ReportReviewRequest): ReportReviewRequest {
  const input = snapshot(raw);
  keys(input, ["projectId", "campaignId", "captureId", "reviewers", "deadlineAt", "notBefore"]);
  for (const value of [input.projectId, input.campaignId, input.captureId]) { id(value); if (value.length > 128) throw new Error("Report-review IDs must not exceed 128 characters"); }
  timestamp(input.deadlineAt); timestamp(input.notBefore);
  if (Date.parse(input.notBefore) >= Date.parse(input.deadlineAt)) throw new Error("Review eligibility must precede its deadline");
  if (!Array.isArray(input.reviewers) || input.reviewers.length < 1 || input.reviewers.length > 12) throw new Error("One to twelve explicit reviewers are required");
  const seen = new Set<string>();
  for (const reviewer of input.reviewers) {
    keys(reviewer, ["id", "role", "backend", "model"]); id(reviewer.id); text(reviewer.role);
    if (reviewer.id.length > 128 || reviewer.role.length > 4096 || seen.has(reviewer.id)) throw new Error("Reviewer IDs must be unique and roles bounded");
    enumValue(reviewer.backend, ["codex", "claude"]);
    if (reviewer.model !== null && (typeof reviewer.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(reviewer.model))) throw new Error("Explicit model selector or null required");
    seen.add(reviewer.id);
  }
  encode(input); return input;
}

function verifiedObservation(record: ObservationRecord | null): ObservationRecord {
  if (!record) throw new Error("Required archived observation is missing");
  const copy = snapshot(record), { digest, ...data } = copy;
  digestValue(digest);
  if (hash(data) !== digest) throw new Error("Archived observation digest does not match its content");
  return copy;
}

function capture(ledger: ExperimentLedger, input: ReportReviewRequest): ObservationRecord {
  const record = verifiedObservation(ledger.getObservation(input.captureId));
  if (record.eventId !== input.captureId || record.projectId !== input.projectId || record.source !== CAPTURE_SOURCE
    || record.runId !== null || record.actionId !== null || record.jobId !== null) throw new Error("Capture identity or provenance does not match this review");
  const payload = record.payload;
  if (payload.schemaVersion !== 1 || payload.kind !== CAPTURE_SOURCE || payload.ordering !== "unordered_file_snapshot"
    || payload.consistency !== "per_file_observations_not_an_atomic_project_snapshot") throw new Error("Unsupported capture projection");
  object(payload.requestIdentity);
  const identity = payload.requestIdentity;
  if (identity.projectId !== input.projectId) throw new Error("Capture request belongs to another project");
  text(identity.canonicalRoot); text(identity.reportPath);
  // The capture reader hashes this explicit insertion order, before ledger canonicalization.
  const expectedRequestDigest = createHash("sha256").update(JSON.stringify({ projectId: identity.projectId,
    canonicalRoot: identity.canonicalRoot, reportPath: identity.reportPath })).digest("hex");
  if (payload.requestDigest !== expectedRequestDigest) throw new Error("Capture request digest is inconsistent");
  object(payload.originalRun); object(payload.reportObservation); object(payload.currentCheckout); object(payload.reader);
  if (payload.originalRun.registration !== "unregistered" || payload.originalRun.manifestDigest !== null
    || payload.originalRun.execution !== "unknown" || payload.originalRun.scientificEvaluation !== "unassessed") throw new Error("Capture claims unsupported original-run authority");
  if (payload.reader.version !== CAPTURE_SOURCE) throw new Error("Unrecognized capture reader version");
  digestValue(payload.reader.sourceDigest);
  return record;
}

function booleanOrNull(value: unknown): void { if (value !== null && typeof value !== "boolean") throw new Error("Invalid report flag projection"); }
function diagnostics(value: unknown): { count: number; countsBySeverity: Record<string, number>; countsByCode: Record<string, number>; selection: string; sample: unknown[] } {
  if (!Array.isArray(value) || value.length > 20_000) throw new Error("Invalid diagnostics projection");
  const countsBySeverity = new Map<string, number>(), countsByCode = new Map<string, number>();
  const samples: Record<"error" | "warning" | "info", unknown[]> = { error: [], warning: [], info: [] };
  for (const item of value) {
    object(item); text(item.code); enumValue(item.severity, ["info", "warning", "error"]);
    if (typeof item.field !== "string" || typeof item.message !== "string" || item.message.length > 4096) throw new Error("Invalid diagnostic text");
    countsBySeverity.set(item.severity, (countsBySeverity.get(item.severity) ?? 0) + 1);
    countsByCode.set(item.code, (countsByCode.get(item.code) ?? 0) + 1);
    if (samples[item.severity].length < 20) samples[item.severity].push(item);
  }
  return { count: value.length, countsBySeverity: Object.fromEntries(countsBySeverity), countsByCode: Object.fromEntries(countsByCode),
    selection: "Counts include all diagnostics. At most twenty examples, errors before warnings before information; archived order within severity. Counts preserve issue types omitted from examples.",
    sample: [...samples.error, ...samples.warning, ...samples.info].slice(0, 20) };
}

function evidencePacket(record: ObservationRecord, campaignId: string, createdAt: string): EvidencePacket {
  const payload = record.payload, inspected = payload.reportObservation;
  object(inspected); object(payload.originalRun); object(payload.currentCheckout);
  const issues = diagnostics(inspected.diagnostics);
  const report = inspected.report;
  let metrics: unknown = { reportAvailable: false, observedStepEntries: 0 };
  let producer: unknown = null;
  if (report !== null) {
    object(report); enumValue(report.format, ["coworkerl-fit-loop", "unsupported"]);
    if (report.executionState !== "unknown" || !Array.isArray(report.steps) || report.steps.length > 20_000) throw new Error("Invalid report state or step projection");
    if (typeof report.reportedAborted !== "boolean") throw new Error("Invalid producer abort flag");
    for (const step of report.steps) {
      object(step); integer(step.stepIndex); object(step.metrics);
      if (Object.keys(step.metrics).length > 128 || Object.entries(step.metrics).some(([key, value]) => key.length > 128 || typeof value !== "number" || !Number.isFinite(value))) throw new Error("Invalid metric projection");
      booleanOrNull(step.optimizerStepApplied); booleanOrNull(step.postUpdateServeOk);
      object(step.checkpointReported); booleanOrNull(step.checkpointReported.fullTrainingState); booleanOrNull(step.checkpointReported.roundTripVerified);
      // This is an imported producer assertion; the capture reader preserves hex case.
      const adapterHash = step.checkpointReported.adapterSha256;
      if (adapterHash !== null && (typeof adapterHash !== "string" || !/^[a-f0-9]{64}$/iu.test(adapterHash))) throw new Error("Invalid producer checkpoint hash projection");
    }
    object(report.source); object(report.configuration);
    producer = { source: report.source, partialConfiguration: report.configuration, spendMeaning: report.spendMeaning };
    const selected = report.steps.length <= 16 ? report.steps : [...report.steps.slice(0, 8), ...report.steps.slice(-8)];
    metrics = { reportAvailable: true, format: report.format, observedStepEntries: report.steps.length,
      shownStepEntries: selected.length, selection: "All entries up to 16; otherwise first eight and last eight in archived order. No monotonicity or completion is inferred.",
      producerReportedAborted: report.reportedAborted, steps: selected };
  }
  const missing = payload.originalRun.missingManifestFields;
  if (!Array.isArray(missing) || missing.length === 0 || missing.length > 100) throw new Error("Missing-manifest projection is unavailable");
  for (const field of missing) { object(field); text(field.field); text(field.reason); if (field.status !== "not_established") throw new Error("Invalid missing-manifest status"); }
  const provenance = { captureId: record.eventId, captureDigest: record.digest, observedAt: record.observedAt,
    reportReference: inspected.reportReference, reader: payload.reader, producer,
    currentCheckoutRevision: payload.currentCheckout.revision,
    distinction: "The current checkout was observed at capture time; it is not established as the code that produced this historical report. Raw report/checkpoint bytes are not included." };
  const limits = { originalManifest: "not_established", missingManifestFields: missing,
    independentEvaluation: "not_observed", baselineComparison: "not_observed", liveExecution: "unknown",
    allocationAndBilling: "unknown", diagnosticScope: "Training diagnostics and producer assertions do not establish held-out capability, causal learning gains, checkpoint validity, novelty, or conference readiness.",
    requiredNextEvidence: ["Recover original configuration and data/split provenance.", "Specify a fixed independent evaluator and baseline/control comparison.", "Validate reward/verifier behavior and distinguish infrastructure errors.", "Predefine replication, uncertainty analysis and bounded follow-up stopping rules."] };
  const summaries = [provenance, metrics, limits, issues].map(value => encode(value));
  if (summaries.some(value => value.length > 90_000)) throw new Error("Archived projection is too large for a bounded reviewer packet");
  return createEvidencePacket({ schemaVersion: 1, packetId: `report:${hash([record.projectId, campaignId]).slice(0, 40)}`, revision: 1, createdAt,
    question: "Which claims are supported by this archived Coworker report, and what minimum additional evidence is needed before a controlled follow-up?",
    proposal: "Audit evidence sufficiency and propose falsifiable next tests. Separate observations from producer assertions and interpretations. Do not authorize training, infer current liveness, claim learning gains, or certify research/publication quality.",
    requiredCriteria: ["provenance-and-limitations", "reward-evaluator-separation", "comparisons-and-uncertainty", "falsifiable-next-tests"],
    evidence: summaries.map((summary, index) => ({ id: ["capture:provenance", "capture:metrics", "capture:limits", "capture:diagnostics"][index]!, kind: "artifact",
      locator: `ledger-observation:${record.eventId}`, version: record.digest, summary })),
    checks: [{ id: "independent-evaluation-available", status: "unknown", evidenceIds: ["capture:limits"] },
      { id: "baseline-comparison-available", status: "unknown", evidenceIds: ["capture:limits"] }] });
}

function buildPlan(input: ReportReviewRequest, archived: ObservationRecord, createdAt: string): ReportReviewPlan {
  timestamp(createdAt);
  const packet = evidencePacket(archived, input.campaignId, createdAt);
  const planObservationId = `report-plan:${hash([input.projectId, input.campaignId])}`;
  const reviews = input.reviewers.map(reviewer => {
    const handler: HandlerPolicy = { kind: `cli-review-${reviewer.backend}`, version: HANDLER_VERSION, replay: "never", callUnits: 1, resourceKey: `${reviewer.backend}:default` };
    const task: PlannedReviewTask = { taskId: `report-task:${hash([input.projectId, input.campaignId, reviewer.id])}`, projectId: input.projectId,
      kind: handler.kind, handlerVersion: handler.version,
      input: { packet, reviewer: { id: reviewer.id, role: reviewer.role }, model: reviewer.model },
      dependencies: [], maxAttempts: 2, deadlineAt: input.deadlineAt, notBefore: input.notBefore };
    return { reviewer, handler, task };
  });
  const data: PlanData = { schemaVersion: 1, kind: PLAN_SOURCE, planObservationId, request: input,
    requestDigest: hash(input), captureDigest: archived.digest, createdAt, packet, reviews };
  return freezeSnapshot({ ...data, planDigest: hash(data) });
}

/** Read the authoritative plan and regenerate its projection from the immutable capture. */
export function loadReportReviewPlan(ledger: ExperimentLedger, planObservationId: string): ReportReviewPlan {
  id(planObservationId);
  const record = verifiedObservation(ledger.getObservation(planObservationId));
  if (record.eventId !== planObservationId || record.source !== PLAN_SOURCE || record.runId !== null || record.actionId !== null || record.jobId !== null) throw new Error("Observation is not a report-review plan");
  const saved = record.payload;
  keys(saved, ["schemaVersion", "kind", "planObservationId", "request", "requestDigest", "captureDigest", "createdAt", "packet", "reviews", "planDigest"]);
  const input = request(saved.request as unknown as ReportReviewRequest);
  if (record.projectId !== input.projectId || saved.createdAt !== record.observedAt) throw new Error("Plan archive identity is inconsistent");
  const expected = buildPlan(input, capture(ledger, input), saved.createdAt as string);
  if (expected.planObservationId !== planObservationId || encode(saved) !== encode(expected)) throw new Error("Archived review plan does not match its bound capture and request");
  return expected;
}

/** Archive intent before queue writes. A retry repairs missing enqueues, never replaces work. */
export function prepareReportReviews(ledger: ExperimentLedger, queue: TaskQueue, handlers: readonly ResearchTaskHandler[], raw: ReportReviewRequest): ReportReviewPlan {
  const input = request(raw), observationId = `report-plan:${hash([input.projectId, input.campaignId])}`;
  const existing = ledger.getObservation(observationId);
  const plan = existing ? loadReportReviewPlan(ledger, observationId) : buildPlan(input, capture(ledger, input), new Date().toISOString());
  if (plan.requestDigest !== hash(input)) throw new Error("Campaign identity already belongs to a different review request");
  // Validate every contract before recording new intent or partially enqueuing reviewers.
  for (const review of plan.reviews) {
    const installed = handlers.find(handler => handler.policy.kind === review.handler.kind && handler.policy.version === review.handler.version);
    if (!installed || encode(installed.policy) !== encode(review.handler)) throw new Error("Required fixed reviewer handler is unavailable");
    installed.validate(review.task.input, input.projectId);
  }
  for (const review of plan.reviews) queue.registerHandler(snapshot(review.handler));
  if (!existing) ledger.appendObservation({ eventId: plan.planObservationId, projectId: input.projectId,
    runId: null, actionId: null, jobId: null, source: PLAN_SOURCE, sequence: 0, observedAt: plan.createdAt,
    payload: plan as unknown as JsonObject });
  for (const review of plan.reviews) {
    const task = queue.enqueue(snapshot<unknown>(review.task) as EnqueueTaskInput);
    assertTask(task, review);
  }
  return plan;
}

function assertTask(task: TaskRecord, planned: DeepReadonly<PlannedReviewer>): void {
  const { taskId, projectId, kind, handlerVersion, input, dependencies, maxAttempts, deadlineAt, notBefore } = task;
  if (encode({ taskId, projectId, kind, handlerVersion, input, dependencies, maxAttempts, deadlineAt, notBefore }) !== encode(planned.task)
    || encode(task.handler) !== encode(planned.handler) || task.inputDigest !== hash(input)) throw new Error("Queued reviewer no longer matches the archived plan");
}

/** Aggregate cached records only; this function cannot invoke clients or launch experiments. */
export async function aggregateReportReviews(ledger: ExperimentLedger, queue: TaskQueue, rawPlan: ReportReviewPlan): Promise<ReportReviewAggregation> {
  const supplied = snapshot(rawPlan), plan = loadReportReviewPlan(ledger, supplied.planObservationId);
  if (encode(supplied) !== encode(plan)) throw new Error("Supplied review plan differs from its authoritative archive");
  const states: { taskId: string; state: TaskState | "missing" }[] = [];
  const records = new Map<string, TaskRecord>();
  for (const review of plan.reviews) {
    let task: TaskRecord;
    try { task = queue.getTask(review.task.taskId); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "missing") { states.push({ taskId: review.task.taskId, state: "missing" }); continue; }
      throw error;
    }
    assertTask(task, review); records.set(review.reviewer.id, snapshot(task)); states.push({ taskId: task.taskId, state: task.state });
  }
  if (states.some(task => task.state === "missing" || PENDING.has(task.state))) return { status: "pending", planObservationId: plan.planObservationId, tasks: states };
  const ids = new Set(states.map(task => task.taskId));
  const recordedAt = queue.events().filter(event => event.taskId !== null && ids.has(event.taskId)).at(-1)?.createdAt ?? plan.createdAt;
  timestamp(recordedAt);
  const decision = await runCouncil({ councilId: `report-council:${hash([plan.request.projectId, plan.request.campaignId]).slice(0, 40)}`,
    packet: plan.packet, reviewers: plan.reviews.map(item => ({ id: item.reviewer.id, role: item.reviewer.role })), maxRevisions: 0,
    now: () => new Date(recordedAt),
    review: async assignment => {
      const task = records.get(assignment.reviewer.id)!;
      const planned = plan.reviews.find(item => item.reviewer.id === assignment.reviewer.id)!;
      const result = task.result;
      if (task.state !== "completed" || !result) {
        if (result && typeof result.reviewOutcome === "object" && result.reviewOutcome !== null && !Array.isArray(result.reviewOutcome)) {
          if (result.reviewOutcome.status === "missing") return null;
          if (result.reviewOutcome.status === "malformed") return { malformedCachedReview: true };
        }
        throw new Error(`Reviewer task ${task.taskId} ended ${task.state}; no complete validated review is available`);
      }
      object(result.client); object(result.reviewOutcome);
      if (result.backend !== planned.reviewer.backend || result.client.backend !== planned.reviewer.backend || result.client.status !== "succeeded"
        || result.modelSelector !== planned.reviewer.model || result.packetDigest !== plan.packet.digest || result.reviewerId !== assignment.reviewer.id
        || result.round !== 0 || result.reviewOutcome.status !== "valid") throw new Error("Cached review provenance does not match its planned reviewer, client and evidence");
      return result.reviewOutcome.review;
    } });
  decision.limitations.push("This council audits an archived report and proposes next tests. Unknown independent evaluation/baseline checks prevent scientific-readiness approval; no new experiment or literature search was performed.");
  return { status: "complete", planObservationId: plan.planObservationId, decision };
}
