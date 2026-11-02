import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import type { JsonObject, ObservationRecord } from "../../src/ledger/types.ts";
import { hash } from "../../src/ledger/validation.ts";
import { createEvidencePacket } from "../../src/research/evidence.ts";
import type { CouncilRound, ObjectionState, ResearchReview } from "../../src/research/types.ts";
import { validateReview } from "../../src/research/validation.ts";
import { buildCouncilStage, COUNCIL_PLAN_SOURCE, COUNCIL_STAGE_SOURCE, createCouncilTaskHandlers,
  loadCouncilPlan, loadCouncilStage, validateCouncilPlanRequest } from "../../src/scheduler/council-handlers.ts";
import type { CouncilArchive, CouncilPlan, CouncilPlanRequest, CouncilStage } from "../../src/scheduler/council-contracts.ts";
import type { ResearchTaskHandler } from "../../src/scheduler/handlers.ts";
import type { TaskClaim } from "../../src/scheduler/types.ts";
import type { CliTask, CliTaskResult } from "../../src/workers/cli.ts";
import { reviewJsonSchema, revisionJsonSchema } from "../../src/workers/output-schema.ts";

const at = "2026-11-02T01:00:00.000Z", deadlineAt = "2026-11-02T02:00:00.000Z";
const signal = () => new AbortController().signal;
function request(): CouncilPlanRequest {
  return { projectId: "study", campaignId: "methods", packet: createEvidencePacket({ schemaVersion: 1, packetId: "packet", revision: 1,
    question: "Does this snapshot establish improvement?", proposal: "Test improvement on held-out data.", createdAt: at,
    requiredCriteria: ["validity"], evidence: [{ id: "snapshot", kind: "artifact", locator: "report.json", version: "capture-v1", summary: "Loss decreased; independent evaluation is missing." }],
    checks: [{ id: "held-out", status: "unknown", evidenceIds: [] }] }),
    reviewers: [{ id: "methods", role: "Assess validity", backend: "codex", model: null }],
    reviser: { backend: "claude", model: "fixture-model" }, maxRevisions: 2, deadlineAt, notBefore: at };
}
function plan(input = request()): CouncilPlan {
  const data: Omit<CouncilPlan, "planDigest"> = { schemaVersion: 1, kind: COUNCIL_PLAN_SOURCE, planObservationId: `council-plan:${hash([input.projectId, input.campaignId])}`,
    requestDigest: hash(input), createdAt: at, request: input };
  return { ...data, planDigest: hash(data) };
}
function observation(payload: CouncilPlan | CouncilStage): ObservationRecord {
  const data = { eventId: "planObservationId" in payload && payload.kind === COUNCIL_PLAN_SOURCE ? payload.planObservationId : (payload as CouncilStage).stageObservationId,
    projectId: payload.kind === COUNCIL_PLAN_SOURCE ? (payload as CouncilPlan).request.projectId : (payload as CouncilStage).projectId,
    runId: null, actionId: null, jobId: null, source: payload.kind, sequence: "round" in payload ? payload.round : 0,
    observedAt: at, payload: payload as unknown as JsonObject };
  return { ...data, digest: hash(data) };
}
function fixture() {
  const p = plan(), initial = buildCouncilStage(p, "review", 0, { reviewer: { id: "methods", role: "Assess validity" }, round: 0,
    packet: p.request.packet, previousRounds: [], objections: [] });
  const records = new Map<string, ObservationRecord>();
  const save = (item: CouncilPlan | CouncilStage) => { const record = observation(item); records.set(record.eventId, record); };
  save(p); save(initial);
  const archive: CouncilArchive = { getObservation: id => structuredClone(records.get(id) ?? null) };
  return { p, initial, records, save, archive };
}
function review(stage: CouncilStage, round = stage.round): ResearchReview {
  return { schemaVersion: 1, reviewerId: "methods", packetDigest: stage.request.packet.digest, round, recommendation: "revise",
    observations: [{ text: "A loss snapshot is present.", evidenceIds: ["snapshot"] }], interpretations: [],
    criteria: [{ criterionId: "validity", status: "uncertain", summary: "Independent evaluation is absent.", evidenceIds: ["snapshot"] }],
    objections: [{ id: "evaluation", category: "validity", severity: "blocking", text: "Evaluation is missing.", evidenceIds: ["snapshot"], requiredAction: "Run held-out evaluation." }],
    resolutions: [], rationale: { text: "Restrict claims to the observed snapshot.", evidenceIds: ["snapshot"] } };
}
function later(f = fixture()) {
  const r = review(f.initial), objections: ObjectionState[] = [{ ...r.objections[0]!, key: "methods/evaluation", reviewerId: "methods", firstRound: 0, lastRound: 0, status: "open" }];
  const rounds: CouncilRound[] = [{ round: 0, packet: f.p.request.packet, reviews: [validateReview(r, { reviewerId: "methods", packet: f.p.request.packet, round: 0, objections: [] })] }];
  const revision = buildCouncilStage(f.p, "revision", 0, { packet: f.p.request.packet, completedRounds: rounds, objections, blockers: ["Independent evaluation is missing."] });
  f.save(revision);
  const { digest: _digest, ...base } = f.p.request.packet;
  const revised = createEvidencePacket({ ...base, revision: 2, proposal: "Report only the observed diagnostics; defer improvement claims." });
  const second = buildCouncilStage(f.p, "review", 1, { reviewer: { id: "methods", role: "Assess validity" }, round: 1, packet: revised, previousRounds: rounds, objections });
  f.save(second); return { ...f, revision, second, objections, rounds };
}
function claim(handler: ResearchTaskHandler, stage: CouncilStage): TaskClaim {
  const input = { stageObservationId: stage.stageObservationId };
  return { task: { taskId: `council-task:${hash(stage.stageObservationId)}`, projectId: "study", kind: handler.policy.kind,
    handlerVersion: "1", input, inputDigest: hash(input), handler: handler.policy, dependencies: [], maxAttempts: 2,
    deadlineAt, notBefore: at, eligibleAt: at, state: "running", attempts: 1, currentAttemptId: "attempt", result: null,
    waitingUntil: null, cancelRequested: false }, attemptId: "attempt", workerId: "worker", authority: { globalEpoch: 0, projectEpoch: null, stopped: false }, claimedAt: at };
}
function client(task: CliTask, body: unknown, status: CliTaskResult["status"] = "succeeded"): CliTaskResult {
  return { backend: task.backend, billing: "client_managed_account", status, text: typeof body === "string" ? body : JSON.stringify(body) };
}
function handler(f: ReturnType<typeof fixture>, kind: string, execute: (task: CliTask) => Promise<CliTaskResult>, clock = at) {
  return createCouncilTaskHandlers({ ledger: f.archive, projects: ["study"], review: execute, now: () => new Date(clock) }).find(item => item.policy.kind === kind)!;
}

test("archived later-round context drives one fixed reviewer invocation and structured output", async () => {
  const f = later(); const calls: CliTask[] = [];
  const h = handler(f, "council-review-codex", async task => { calls.push(task); return client(task, review(f.second)); });
  h.validate({ stageObservationId: f.second.stageObservationId }, "study");
  const output = await h.execute(claim(h, f.second), signal());
  assert.equal(output.status, "completed"); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.outputSchema, reviewJsonSchema({ reviewerId: "methods", packetDigest: f.second.request.packet.digest, round: 1 }));
  assert.match(calls[0]!.prompt, /"previousRounds":\[\{"round":0/u); assert.match(calls[0]!.prompt, /methods\/evaluation/u);
  assert.equal(Object.hasOwn(calls[0]!, "model"), false);
  assert.equal(output.result.stageDigest, f.second.stageDigest); assert.equal(output.result.planDigest, f.p.planDigest);
  assert.equal(output.result.modelSelector, null); assert.equal(output.result.round, 1);
  assert.equal(h.policy.replay, "never"); assert.equal(h.policy.callUnits, 1); assert.equal(h.policy.resourceKey, "codex:default");
});

test("proposal-only revision is accepted but evidence/check/round replacements are rejected", async () => {
  const f = later(); let calls = 0;
  for (const [body, expected] of [[{ proposal: "Narrow the conclusion." }, "completed"], [{ proposal: "Changed", checks: [] }, "failed"],
    [{ proposal: "Changed", evidence: [] }, "failed"], [{ proposal: "Changed", revision: 8 }, "failed"], [{ proposal: "" }, "failed"], ["not JSON", "failed"]] as const) {
    const h = handler(f, "council-revise-claude", async task => { calls++; assert.deepEqual(task.outputSchema, revisionJsonSchema()); assert.equal(task.model, "fixture-model"); return client(task, body); });
    const result = await h.execute(claim(h, f.revision), signal()); assert.equal(result.status, expected);
    assert.equal(Object.hasOwn(result.result, "checks"), false); assert.equal(Object.hasOwn(result.result, "evidence"), false);
  }
  assert.equal(calls, 6);
});

test("task input, project, handler metadata, digest, identity and schedule cannot replace archived authority", async () => {
  const f = fixture(); let calls = 0;
  const h = handler(f, "council-review-codex", async task => { calls++; return client(task, review(f.initial)); });
  assert.throws(() => h.validate({ stageObservationId: f.initial.stageObservationId, packet: f.p.request.packet }, "study"));
  assert.throws(() => h.validate({ stageObservationId: f.initial.stageObservationId }, "other"));
  const mutations = [(c: TaskClaim) => { c.task.taskId = "forged"; }, (c: TaskClaim) => { c.task.inputDigest = "a".repeat(64); },
    (c: TaskClaim) => { c.task.handler.callUnits = 0; }, (c: TaskClaim) => { c.task.deadlineAt = "2099-01-01T00:00:00.000Z"; },
    (c: TaskClaim) => { c.task.projectId = "other"; }];
  for (const mutate of mutations) { const c = structuredClone(claim(h, f.initial)); mutate(c); assert.equal((await h.execute(c, signal())).status, "rejected"); }
  assert.equal(calls, 0);
});

test("archive verifies content digests, null execution links and immutable plan/stage assignment", () => {
  const f = fixture();
  const bad = structuredClone(f.records.get(f.initial.stageObservationId)!); bad.payload.projectId = "other";
  f.records.set(bad.eventId, bad); assert.throws(() => loadCouncilStage(f.archive, bad.eventId), /digest/u);
  f.save(f.initial); const linked = structuredClone(f.records.get(f.initial.stageObservationId)!); linked.runId = "invented-run";
  const { digest: _digest, ...linkedData } = linked; linked.digest = hash(linkedData); f.records.set(linked.eventId, linked);
  assert.throws(() => loadCouncilStage(f.archive, linked.eventId), /identity/u);
  const wrong = structuredClone(f.initial); wrong.backend = "claude"; const { stageDigest: _stageDigest, ...data } = wrong; wrong.stageDigest = hash(data); f.save(wrong);
  assert.throws(() => loadCouncilStage(f.archive, wrong.stageObservationId), /assignment/u);
});

test("stage builder rejects forged rounds, context injection and changed fixed evidence", () => {
  const f = later();
  assert.throws(() => buildCouncilStage(f.p, "review", 1, { reviewer: { id: "methods", role: "Assess validity" }, round: 1,
    packet: f.second.request.packet, previousRounds: [], objections: f.objections }), /history/u);
  const { digest: _digest, ...base } = f.second.request.packet;
  const changed = createEvidencePacket({ ...base, checks: [{ id: "held-out", status: "passed", evidenceIds: ["snapshot"] }] });
  assert.throws(() => buildCouncilStage(f.p, "review", 1, { reviewer: { id: "methods", role: "Assess validity" }, round: 1,
    packet: changed, previousRounds: f.rounds, objections: f.objections }), /cannot change/u);
  assert.throws(() => buildCouncilStage(f.p, "review", 0, { reviewer: { id: "methods", role: "Assess validity" }, round: 0,
    packet: f.p.request.packet, previousRounds: [], objections: f.objections }), /exceeds/u);
  const bad = structuredClone(f.rounds); bad[0]!.reviews[0]!.review!.reviewerId = "invented";
  assert.throws(() => buildCouncilStage(f.p, "revision", 0, { packet: f.p.request.packet, completedRounds: bad, objections: f.objections, blockers: [] }), /structured review/u);
});

test("plan request snapshots getters and rejects enum coercion, duplicate reviewers and unbounded revisions", () => {
  const original = request(); let reads = 0;
  const raw = { ...original, get projectId() { reads++; return reads === 1 ? "study" : "forged"; } };
  assert.equal(validateCouncilPlanRequest(raw).projectId, "study"); assert.equal(reads, 1);
  for (const invalid of [{ ...request(), maxRevisions: 6 }, { ...request(), reviewers: [request().reviewers[0], request().reviewers[0]] },
    { ...request(), reviser: { backend: ["codex"], model: null } }]) assert.throws(() => validateCouncilPlanRequest(invalid));
});

test("quota/auth hold, ambiguous completion and malformed scientific output preserve different outcomes", async () => {
  const f = fixture();
  for (const [status, expected] of [["rate_limited", "waiting_quota"], ["auth_required", "waiting_auth"], ["timed_out", "uncertain"], ["cancelled", "uncertain"], ["failed", "uncertain"], ["succeeded", "failed"]] as const) {
    let calls = 0; const h = handler(f, "council-review-codex", async task => { calls++; return client(task, "not JSON", status); });
    const result = await h.execute(claim(h, f.initial), signal()); assert.equal(result.status, expected); assert.equal(calls, 1);
    if (expected === "waiting_quota" || expected === "waiting_auth") assert.equal(result.retryAt, null);
  }
  for (const run of [async () => { throw new Error("crashed"); }, async (task: CliTask) => ({ ...client(task, ""), backend: "claude" as const })]) {
    const h = handler(f, "council-review-codex", run); assert.equal((await h.execute(claim(h, f.initial), signal())).status, "uncertain");
  }
});

test("pre-cancellation and elapsed plan deadline invoke no client", async () => {
  const f = fixture(); let calls = 0;
  const execute = async (task: CliTask) => { calls++; return client(task, ""); };
  const h = handler(f, "council-review-codex", execute), control = new AbortController(); control.abort();
  assert.equal((await h.execute(claim(h, f.initial), control.signal)).status, "cancelled");
  const expired = handler(f, "council-review-codex", execute, deadlineAt);
  assert.equal((await expired.execute(claim(expired, f.initial), signal())).status, "rejected"); assert.equal(calls, 0);
});

test("persisted council archives reopen unchanged without reading a live source or calling a model", async t => {
  const directory = await mkdtemp(join(tmpdir(), "council-archive-")), path = join(directory, "ledger.sqlite"), f = later();
  let ledger = openExperimentLedger({ path });
  t.after(async () => { ledger.close(); await rm(directory, { recursive: true, force: true }); });
  for (const record of f.records.values()) { const { digest: _digest, ...input } = record; ledger.appendObservation(input); }
  ledger.close(); ledger = openExperimentLedger({ path });
  assert.deepEqual(loadCouncilPlan(ledger, f.p.planObservationId), f.p);
  assert.deepEqual(loadCouncilStage(ledger, f.second.stageObservationId), f.second);
  assert.ok(Object.isFrozen(loadCouncilStage(ledger, f.second.stageObservationId).request));
});
