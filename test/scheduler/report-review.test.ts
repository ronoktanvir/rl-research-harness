import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import type { ExperimentLedger, JsonObject, ObservationRecord } from "../../src/ledger/types.ts";
import { hash } from "../../src/ledger/validation.ts";
import { captureCoworkerReport } from "../../src/integrations/coworker/capture.ts";
import type { ResearchReview } from "../../src/research/types.ts";
import { createResearchTaskHandlers } from "../../src/scheduler/handlers.ts";
import { openTaskQueue } from "../../src/scheduler/index.ts";
import { aggregateReportReviews, loadReportReviewPlan, prepareReportReviews } from "../../src/scheduler/report-review.ts";
import type { ReportReviewPlan, ReportReviewRequest } from "../../src/scheduler/report-review.ts";
import type { TaskClaim, TaskOutcomeInput, TaskQueue } from "../../src/scheduler/types.ts";

const now = "2026-11-02T12:00:00.000Z";
function request(): ReportReviewRequest {
  return { projectId: "study", campaignId: "historical-audit", captureId: "historical",
    reviewers: [
      { id: "methods", role: "Assess evidence sufficiency, causal comparisons and falsifiable next tests.", backend: "codex", model: "fixture-model" },
      { id: "reward", role: "Assess reward/verifier validity and separation from independent evaluation.", backend: "claude", model: null },
    ], notBefore: now, deadlineAt: "2099-01-01T00:00:00.000Z" };
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "report-review-"));
  const root = join(directory, "project"); await mkdir(root);
  await writeFile(join(root, "report.json"), JSON.stringify({ config: { steps: 2, training_seed: 7 },
    steps: [{ step_index: 0, loss: 0.5, grad_norm: 1, optimizer_step_applied: true, post_update_serve_ok: true }] }));
  const ledger = openExperimentLedger({ path: join(directory, "ledger.sqlite"), now: () => new Date(now) });
  const queue = openTaskQueue({ path: join(directory, "queue.sqlite"), now: () => new Date(now),
    authority: () => ({ globalEpoch: ledger.getScope("global").epoch, projectEpoch: null, stopped: ledger.getScope("global").stopped }) });
  t.after(async () => { queue.close(); ledger.close(); await rm(directory, { recursive: true, force: true }); });
  for (const scopeId of ["global", "project:study"]) queue.configureBudget({ scopeId, expectedVersion: 0, maxCalls: 8, maxParallel: 2 });
  const archived = await captureCoworkerReport(ledger, { captureId: "historical", projectId: "study", root, reportPath: "report.json", observedAt: now });
  let calls = 0;
  const handlers = createResearchTaskHandlers({ ledger, projects: { study: { root, summaryDirectory: join(directory, "summary") } },
    review: async () => { calls++; throw new Error("Preparation and aggregation must not invoke a client"); } });
  return { directory, root, ledger, queue, archived, handlers, calls: () => calls };
}
function cached(plan: ReportReviewPlan, claim: TaskClaim, recommendation: "approve" | "reject" = "approve"): JsonObject {
  const item = plan.reviews.find(item => item.task.taskId === claim.task.taskId)!;
  const review: ResearchReview = { schemaVersion: 1, reviewerId: item.reviewer.id, packetDigest: plan.packet.digest, round: 0, recommendation,
    observations: [{ text: "One archived training diagnostic is present; independent evaluation is absent.", evidenceIds: ["capture:metrics", "capture:limits"] }],
    interpretations: [{ text: "The observation alone cannot isolate learning benefit.", evidenceIds: ["capture:limits"] }],
    criteria: plan.packet.requiredCriteria.map(criterionId => ({ criterionId, status: recommendation === "approve" ? "satisfied" : "unsatisfied",
      summary: "Documented limits require independent controls.", evidenceIds: ["capture:limits"] })),
    objections: recommendation === "reject" ? [{ id: "control", category: "validity", severity: "material", text: "There is no independent baseline comparison.",
      evidenceIds: ["capture:limits"], requiredAction: "Pre-register a frozen evaluator and matched baseline comparison." }] : [],
    resolutions: [], rationale: { text: "Review scope is evidence sufficiency and the next discriminating test.", evidenceIds: ["capture:limits"] } };
  return { backend: item.reviewer.backend, modelSelector: item.reviewer.model,
    client: { backend: item.reviewer.backend, status: "succeeded", billing: "client_managed_account" },
    packetDigest: plan.packet.digest, reviewerId: item.reviewer.id, round: 0,
    reviewOutcome: { reviewerId: item.reviewer.id, status: "valid", review: review as unknown as JsonObject, issues: [] } };
}
function finish(queue: TaskQueue, claim: TaskClaim, result: JsonObject, status: TaskOutcomeInput["status"] = "completed") {
  queue.recordOutcome({ resultId: `result:${claim.attemptId}`, taskId: claim.task.taskId, attemptId: claim.attemptId, status, result,
    ...(status === "waiting_quota" || status === "waiting_auth" ? { retryAt: null } : {}) });
}
function replaceObservation(ledger: ExperimentLedger, selected: ObservationRecord): ExperimentLedger {
  return new Proxy(ledger, { get(target, property) {
    if (property === "getObservation") return (eventId: string) => eventId === selected.eventId ? structuredClone(selected) : target.getObservation(eventId);
    const value: unknown = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
}

test("preparation freezes an evidence-only plan and queues independent methods/verifier reviewers without calls", async t => {
  const f = await fixture(t), input = request();
  const plan = prepareReportReviews(f.ledger, f.queue, f.handlers, input);
  input.reviewers[0]!.model = "changed";
  assert.equal(plan.request.reviewers[0]!.model, "fixture-model");
  assert.ok(Object.isFrozen(plan.packet.evidence));
  assert.deepEqual(plan.packet.checks.map(item => item.status), ["unknown", "unknown"]);
  const metrics = JSON.parse(plan.packet.evidence.find(item => item.id === "capture:metrics")!.summary);
  assert.equal(metrics.observedStepEntries, 1); assert.equal(metrics.steps[0].metrics.loss, 0.5);
  assert.match(plan.packet.evidence[0]!.summary, /not established as the code/u);
  assert.match(plan.packet.evidence[2]!.summary, /held-out capability/u);
  assert.equal(plan.reviews.length, 2);
  for (const item of plan.reviews) {
    assert.deepEqual(item.task.dependencies, []); assert.equal(item.task.maxAttempts, 2);
    assert.equal(item.handler.replay, "never"); assert.equal(item.handler.callUnits, 1);
    assert.equal(Object.hasOwn(item.task.input, "previousRounds"), false);
    assert.equal(item.task.input.packet.digest, plan.packet.digest);
  }
  const archived = f.ledger.getObservation(plan.planObservationId)!;
  assert.equal(archived.runId, null); assert.equal(archived.source, "report-review-plan.v1");
  assert.deepEqual(loadReportReviewPlan(f.ledger, plan.planObservationId), plan);
  assert.equal(f.queue.getBudget("global").consumedCalls, 0); assert.equal(f.calls(), 0);
});

test("a partial enqueue recovers archived time and identities without replacing completed work or rereading files", async t => {
  const f = await fixture(t);
  const enqueue = f.queue.enqueue.bind(f.queue); let enqueues = 0;
  f.queue.enqueue = input => {
    assert.equal(f.ledger.listObservations("study").filter(item => item.source === "report-review-plan.v1").length, 1);
    if (++enqueues === 2) throw new Error("simulated queue write failure");
    return enqueue(input);
  };
  assert.throws(() => prepareReportReviews(f.ledger, f.queue, f.handlers, request()), /queue write failure/u);
  const saved = f.ledger.listObservations("study").find(item => item.source === "report-review-plan.v1")!;
  const before = loadReportReviewPlan(f.ledger, saved.eventId);
  const incomplete = await aggregateReportReviews(f.ledger, f.queue, before);
  assert.equal(incomplete.status, "pending");
  if (incomplete.status === "pending") assert.ok(incomplete.tasks.some(item => item.state === "missing"));
  const claim = f.queue.claim({ workerId: "fixture" })!; finish(f.queue, claim, cached(before, claim));
  await rm(join(f.root, "report.json"));
  f.queue.enqueue = enqueue;
  const recovered = prepareReportReviews(f.ledger, f.queue, f.handlers, request());
  assert.deepEqual(recovered, before); assert.equal(f.queue.listTasks().length, 2);
  assert.equal(f.queue.getTask(claim.task.taskId).state, "completed");
  assert.equal(f.queue.getBudget("global").consumedCalls, 1); assert.equal(f.calls(), 0);
});

test("reopening stores recovers the same plan and retains interrupted reviewer uncertainty", async t => {
  const f = await fixture(t), plan = prepareReportReviews(f.ledger, f.queue, f.handlers, request());
  const interrupted = f.queue.claim({ workerId: "interrupted" })!;
  f.queue.close(); f.ledger.close();
  const ledger = openExperimentLedger({ path: join(f.directory, "ledger.sqlite") });
  const queue = openTaskQueue({ path: join(f.directory, "queue.sqlite"), now: () => new Date(now),
    authority: () => ({ globalEpoch: ledger.getScope("global").epoch, projectEpoch: null, stopped: false }) });
  try {
    assert.deepEqual(loadReportReviewPlan(ledger, plan.planObservationId), plan);
    assert.deepEqual(prepareReportReviews(ledger, queue, f.handlers, request()), plan);
    assert.equal(queue.getTask(interrupted.task.taskId).state, "uncertain");
    assert.equal(queue.getBudget("global").consumedCalls, 1);
    assert.equal(queue.getBudget("global").activeAttempts, 1);
    assert.equal((await aggregateReportReviews(ledger, queue, plan)).status, "pending");
    assert.equal(f.calls(), 0);
  } finally { queue.close(); ledger.close(); }
});

test("same campaign rejects changed reviewer, client, source or timing identity", async t => {
  const f = await fixture(t); prepareReportReviews(f.ledger, f.queue, f.handlers, request());
  const mutations = [
    (r: ReportReviewRequest) => { r.reviewers[0]!.role = "A different question"; },
    (r: ReportReviewRequest) => { r.reviewers[0]!.model = null; },
    (r: ReportReviewRequest) => { r.reviewers[0]!.backend = "claude"; },
    (r: ReportReviewRequest) => { r.captureId = "another-capture"; },
    (r: ReportReviewRequest) => { r.deadlineAt = "2098-01-01T00:00:00.000Z"; },
  ];
  for (const mutate of mutations) { const changed = request(); mutate(changed); assert.throws(() => prepareReportReviews(f.ledger, f.queue, f.handlers, changed), /different review request/u); }
  assert.equal(f.queue.listTasks().length, 2); assert.equal(f.calls(), 0);
});

test("bad request and unavailable handler fail before archiving a plan or enqueueing any reviewer", async t => {
  const f = await fixture(t);
  const invalid = request(); invalid.reviewers[1]!.backend = ["claude"] as unknown as "claude";
  assert.throws(() => prepareReportReviews(f.ledger, f.queue, f.handlers, invalid));
  assert.throws(() => prepareReportReviews(f.ledger, f.queue, f.handlers.slice(0, 1), request()), /handler is unavailable/u);
  assert.equal(f.ledger.listObservations("study").length, 1); assert.equal(f.queue.listTasks().length, 0);
});

test("wrong capture source, altered digest and unsupported projection cannot become reviewer evidence", async t => {
  const f = await fixture(t);
  const tampered = structuredClone(f.archived); tampered.payload.kind = "pretend-capture";
  assert.throws(() => prepareReportReviews(replaceObservation(f.ledger, tampered), f.queue, f.handlers, request()), /digest/u);
  for (const mutate of [
    (o: ObservationRecord) => { o.source = "untrusted-import"; },
    (o: ObservationRecord) => { o.payload.consistency = "atomic-and-scientifically-valid"; },
    (o: ObservationRecord) => { (o.payload.originalRun as JsonObject).registration = "registered"; },
    (o: ObservationRecord) => { o.payload.requestDigest = "0".repeat(64); },
  ]) {
    const changed = structuredClone(f.archived); mutate(changed);
    const { digest: _digest, ...data } = changed; changed.digest = hash(data);
    assert.throws(() => prepareReportReviews(replaceObservation(f.ledger, changed), f.queue, f.handlers, request()));
  }
  assert.equal(f.ledger.listObservations("study").length, 1); assert.equal(f.queue.listTasks().length, 0);
});

test("unfinished, waiting and uncertain reviews stay pending without a synthesized final decision", async t => {
  const f = await fixture(t), plan = prepareReportReviews(f.ledger, f.queue, f.handlers, request());
  assert.equal((await aggregateReportReviews(f.ledger, f.queue, plan)).status, "pending");
  const first = f.queue.claim({ workerId: "first" })!;
  assert.equal((await aggregateReportReviews(f.ledger, f.queue, plan)).status, "pending");
  const second = f.queue.claim({ workerId: "second" })!;
  finish(f.queue, first, { reason: "unknown reset" }, "waiting_quota");
  finish(f.queue, second, { reason: "lost completion receipt" }, "uncertain");
  const result = await aggregateReportReviews(f.ledger, f.queue, plan);
  assert.equal(result.status, "pending");
  if (result.status === "pending") assert.deepEqual(new Set(result.tasks.map(item => item.state)), new Set(["waiting_quota", "uncertain"]));
  assert.equal(f.calls(), 0); assert.equal(f.queue.claim({ workerId: "cannot-replay" }), null);
});

test("cached approval cannot override unknown independent evaluation and baseline checks", async t => {
  const f = await fixture(t), plan = prepareReportReviews(f.ledger, f.queue, f.handlers, request());
  for (let i = 0; i < 2; i++) { const claim = f.queue.claim({ workerId: "fixture" })!; finish(f.queue, claim, cached(plan, claim)); }
  const result = await aggregateReportReviews(f.ledger, f.queue, plan);
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(result.decision.status, "blocked"); assert.equal(result.decision.maxRevisions, 0);
  assert.equal(result.decision.rounds.length, 1);
  assert.ok(result.decision.blockers.some(item => item.includes("independent-evaluation-available")));
  assert.ok(result.decision.blockers.some(item => item.includes("baseline-comparison-available")));
  assert.ok(result.decision.rounds[0]!.reviews.every(item => item.status === "valid"));
  assert.deepEqual(await aggregateReportReviews(f.ledger, f.queue, plan), result);
  assert.equal(f.calls(), 0); assert.equal(f.queue.getBudget("global").consumedCalls, 2);
});

test("valid negative findings retain dissent and required next tests", async t => {
  const f = await fixture(t), plan = prepareReportReviews(f.ledger, f.queue, f.handlers, request());
  for (let i = 0; i < 2; i++) { const claim = f.queue.claim({ workerId: "fixture" })!; finish(f.queue, claim, cached(plan, claim, i === 0 ? "reject" : "approve")); }
  const result = await aggregateReportReviews(f.ledger, f.queue, plan);
  assert.equal(result.status, "complete"); if (result.status !== "complete") return;
  assert.equal(result.decision.status, "blocked"); assert.equal(result.decision.objections[0]?.status, "open");
  assert.match(result.decision.objections[0]!.requiredAction, /frozen evaluator/u);
  assert.ok(result.decision.dissent.some(item => item.includes("reject")));
});

test("missing and malformed completed-client output remains blocked and distinguishable", async t => {
  const f = await fixture(t), plan = prepareReportReviews(f.ledger, f.queue, f.handlers, request());
  for (const status of ["missing", "malformed"]) {
    const claim = f.queue.claim({ workerId: "fixture" })!;
    finish(f.queue, claim, { client: { status: "succeeded" }, reviewOutcome: { status } }, "failed");
  }
  const result = await aggregateReportReviews(f.ledger, f.queue, plan);
  assert.equal(result.status, "complete"); if (result.status !== "complete") return;
  assert.equal(result.decision.status, "blocked");
  assert.deepEqual(new Set(result.decision.rounds[0]!.reviews.map(item => item.status)), new Set(["missing", "malformed"]));
  assert.equal(f.calls(), 0);
});

test("cached review provenance and citation IDs are revalidated before council use", async t => {
  const f = await fixture(t), plan = prepareReportReviews(f.ledger, f.queue, f.handlers, request());
  const first = f.queue.claim({ workerId: "fixture" })!, firstResult = cached(plan, first);
  firstResult.modelSelector = "substituted-model"; finish(f.queue, first, firstResult);
  const second = f.queue.claim({ workerId: "fixture" })!, secondResult = cached(plan, second);
  const review = (secondResult.reviewOutcome as JsonObject).review as JsonObject;
  review.rationale = { text: "Unsupported approval", evidenceIds: ["invented-source"] }; finish(f.queue, second, secondResult);
  const result = await aggregateReportReviews(f.ledger, f.queue, plan);
  assert.equal(result.status, "complete"); if (result.status !== "complete") return;
  assert.deepEqual(new Set(result.decision.rounds[0]!.reviews.map(item => item.status)), new Set(["error", "malformed"]));
  assert.equal(result.decision.status, "blocked"); assert.equal(f.calls(), 0);
});

test("caller cannot substitute a packet or queued task under an authoritative plan identity", async t => {
  const f = await fixture(t), plan = prepareReportReviews(f.ledger, f.queue, f.handlers, request());
  const forged = structuredClone(plan) as unknown as { packet: { question: string } }; forged.packet.question = "Different question";
  await assert.rejects(aggregateReportReviews(f.ledger, f.queue, forged as unknown as ReportReviewPlan), /differs from its authoritative archive/u);
  const getTask = f.queue.getTask.bind(f.queue);
  f.queue.getTask = id => { const task = getTask(id); task.input.model = "substituted"; return task; };
  await assert.rejects(aggregateReportReviews(f.ledger, f.queue, plan), /no longer matches/u);
  assert.equal(f.calls(), 0);
});

test("explicit quota resume consumes a second allowance without changing the frozen plan", async t => {
  const f = await fixture(t), input = request(); input.reviewers = input.reviewers.slice(0, 1);
  const plan = prepareReportReviews(f.ledger, f.queue, f.handlers, input), first = f.queue.claim({ workerId: "fixture" })!;
  finish(f.queue, first, { reason: "quota without reset" }, "waiting_quota");
  assert.equal(f.queue.claim({ workerId: "fixture" }), null);
  f.queue.resumeTask({ commandId: "operator-resume", taskId: first.task.taskId, evidence: { operator: "allowance checked" }, notBefore: now });
  const hold = f.queue.getResourceHold("codex:default")!;
  f.queue.releaseResource({ resourceKey: hold.resourceKey, expectedVersion: hold.version, evidence: { operator: "account available" } });
  const second = f.queue.claim({ workerId: "fixture" })!;
  assert.equal(second.task.attempts, 2); assert.equal(second.task.taskId, first.task.taskId);
  finish(f.queue, second, cached(plan, second));
  assert.deepEqual(prepareReportReviews(f.ledger, f.queue, f.handlers, input), plan);
  assert.equal((await aggregateReportReviews(f.ledger, f.queue, plan)).status, "complete");
  assert.equal(f.queue.getBudget("global").consumedCalls, 2); assert.equal(f.calls(), 0);
});
