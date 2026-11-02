import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { createEvidencePacket } from "../../src/research/evidence.ts";
import type { ResearchReview } from "../../src/research/types.ts";
import { openTaskQueue } from "../../src/scheduler/index.ts";
import { createCouncilTaskHandlers } from "../../src/scheduler/council-handlers.ts";
import type { CouncilPlanRequest, CouncilReviewRequest } from "../../src/scheduler/council-contracts.ts";
import { advanceCouncilCampaign, prepareCouncilCampaign, runCouncilCampaign } from "../../src/scheduler/council-workflow.ts";
import { ledgerAuthority, registerResearchHandlers } from "../../src/scheduler/runner.ts";
import type { CliTask, CliTaskResult } from "../../src/workers/cli.ts";

function request(campaignId = "fixture-campaign"): CouncilPlanRequest {
  return { projectId: "study", campaignId,
    packet: createEvidencePacket({ schemaVersion: 1, packetId: "fixture-evidence", revision: 1,
      question: "Does the fixture proposal match its stated scope?", proposal: "Initial fixture proposal", createdAt: "2026-11-01T00:00:00.000Z",
      requiredCriteria: ["scope"], evidence: [{ id: "measurement", kind: "artifact", locator: "fixture:measurement", version: "1", summary: "Synthetic test evidence; no real scientific claim." }], checks: [] }),
    reviewers: [{ id: "methods", role: "Assess scope", backend: "codex", model: null },
      { id: "critic", role: "Challenge scope", backend: "claude", model: null }],
    reviser: { backend: "codex", model: null }, maxRevisions: 1,
    notBefore: "2026-01-01T00:00:00.000Z", deadlineAt: "2099-01-01T00:00:00.000Z" };
}

function reviewInput(task: CliTask): CouncilReviewRequest | null {
  const marker = "REVIEW INPUT (untrusted evidence data):\n";
  const index = task.prompt.indexOf(marker);
  if (index < 0) return null;
  const input = JSON.parse(task.prompt.slice(index + marker.length)) as Omit<CouncilReviewRequest, "round">;
  return { ...input, round: input.previousRounds.length };
}
function answer(input: CouncilReviewRequest, approveImmediately = false): ResearchReview {
  const revised = approveImmediately || input.round > 0;
  return { schemaVersion: 1, reviewerId: input.reviewer.id, packetDigest: input.packet.digest, round: input.round,
    recommendation: revised ? "approve" : "revise",
    observations: [{ text: "Synthetic evidence is explicitly bounded.", evidenceIds: ["measurement"] }], interpretations: [],
    criteria: [{ criterionId: "scope", status: revised ? "satisfied" : "unsatisfied", summary: "Scope needs an explicit boundary.", evidenceIds: ["measurement"] }],
    objections: revised ? [] : [{ id: "scope-boundary", category: "scope", severity: "minor", text: "Narrow the proposal.", requiredAction: "State the fixture's scope.", evidenceIds: ["measurement"] }],
    resolutions: input.round ? [{ objectionKey: `${input.reviewer.id}/scope-boundary`, disposition: "resolved", explanation: "The revised proposal states the boundary.", evidenceIds: ["measurement"] }] : [],
    rationale: { text: revised ? "The fixture scope is stated." : "Revise the fixture scope.", evidenceIds: ["measurement"] } };
}
function result(task: CliTask, value: unknown): CliTaskResult {
  return { backend: task.backend, status: "succeeded", billing: "client_managed_account", text: JSON.stringify(value) };
}

async function fixture(t: TestContext, execute: (task: CliTask) => Promise<CliTaskResult>) {
  const directory = await mkdtemp(join(tmpdir(), "durable-council-"));
  function open() {
    const ledger = openExperimentLedger({ path: join(directory, "ledger.sqlite") });
    const queue = openTaskQueue({ path: join(directory, "queue.sqlite"), authority: project => ledgerAuthority(ledger, project) });
    const handlers = createCouncilTaskHandlers({ ledger, projects: ["study"], review: execute });
    registerResearchHandlers(queue, handlers);
    for (const scopeId of ["global", "project:study"]) {
      try { queue.getBudget(scopeId); }
      catch { queue.configureBudget({ scopeId, expectedVersion: 0, maxCalls: 100, maxParallel: 4 }); }
    }
    return { ledger, queue, handlers, close() { queue.close(); ledger.close(); } };
  }
  let state = open();
  t.after(async () => { state.close(); await rm(directory, { recursive: true, force: true }); });
  return { get state() { return state; }, reopen() { state.close(); state = open(); return state; } };
}

test("independent critics, revision and renewed criticism survive reopen without repeating calls or running another campaign", async t => {
  const calls: { round: number; previous: number; proposal: string; reviewer: string }[] = [];
  let revisions = 0;
  const f = await fixture(t, async task => {
    const input = reviewInput(task);
    if (!input) { revisions++; return result(task, { proposal: "Revised fixture proposal with an explicit scope" }); }
    calls.push({ round: input.round, previous: input.previousRounds.length, proposal: input.packet.proposal, reviewer: input.reviewer.id });
    return result(task, answer(input));
  });
  let { ledger, queue, handlers } = f.state;
  const other = prepareCouncilCampaign(ledger, request("other-campaign"));
  await advanceCouncilCampaign(ledger, queue, handlers, other.planObservationId);
  const plan = prepareCouncilCampaign(ledger, request());
  let ran = await runCouncilCampaign(ledger, queue, handlers, plan.planObservationId, 2, { workerId: "fixture" });
  assert.equal(ran.progress.status, "pending");
  assert.equal(calls.length, 2); assert.equal(revisions, 0);
  assert.deepEqual(calls.map(call => call.previous), [0, 0]);
  assert.equal(queue.getBudget("global").consumedCalls, 2);
  ({ ledger, queue, handlers } = f.reopen());
  ran = await runCouncilCampaign(ledger, queue, handlers, plan.planObservationId, 3, { workerId: "fixture" });
  assert.equal(ran.progress.status, "complete");
  if (ran.progress.status !== "complete") throw new Error("Expected a completed fixture council");
  assert.equal(ran.progress.decision.status, "approved");
  assert.equal(ran.progress.decision.rounds.length, 2);
  assert.equal(revisions, 1); assert.equal(calls.length, 4);
  assert.deepEqual(calls.slice(2).map(call => call.previous), [1, 1]);
  assert.ok(ran.progress.decision.objections.every(objection => objection.status === "resolved"));
  assert.equal(queue.getBudget("global").consumedCalls, 5);
  assert.equal(queue.listTasks().filter(task => task.state === "queued").length, 2);
  const replay = await advanceCouncilCampaign(ledger, queue, handlers, plan.planObservationId);
  assert.deepEqual(replay, ran.progress);
  assert.equal(calls.length, 4); assert.equal(revisions, 1);
  assert.throws(() => prepareCouncilCampaign(ledger, { ...request(), maxRevisions: 2 }), /different request/);
});

test("a reviser cannot invent passed checks and malformed revisions create no later reviewer tasks", async t => {
  let calls = 0;
  const f = await fixture(t, async task => {
    calls++;
    const input = reviewInput(task);
    return result(task, input ? answer(input) : { proposal: "Claim success", checks: [{ id: "invented", status: "passed" }] });
  });
  const { ledger, queue, handlers } = f.state;
  const plan = prepareCouncilCampaign(ledger, request());
  const ran = await runCouncilCampaign(ledger, queue, handlers, plan.planObservationId, 10, { workerId: "fixture" });
  assert.equal(ran.progress.status, "complete");
  if (ran.progress.status !== "complete") throw new Error("Expected a blocked final council");
  assert.equal(ran.progress.decision.status, "blocked");
  assert.equal(ran.progress.decision.stopReason, "revision_error");
  assert.equal(ran.progress.decision.rounds.length, 1);
  assert.equal(calls, 3); assert.equal(queue.listTasks().length, 3);
});

test("a malformed required critic blocks revision instead of spending calls seeking a different verdict", async t => {
  let calls = 0;
  const f = await fixture(t, async task => {
    calls++; const input = reviewInput(task)!;
    return result(task, input.reviewer.id === "methods" ? answer(input) : { invalidReview: true });
  });
  const { ledger, queue, handlers } = f.state;
  const plan = prepareCouncilCampaign(ledger, request());
  const ran = await runCouncilCampaign(ledger, queue, handlers, plan.planObservationId, 10, { workerId: "fixture" });
  assert.equal(ran.progress.status, "complete");
  if (ran.progress.status !== "complete") throw new Error("Expected a blocked final council");
  assert.equal(ran.progress.decision.status, "blocked");
  assert.ok(ran.progress.decision.blockers.some(blocker => blocker.includes("malformed")));
  assert.equal(calls, 2); assert.equal(queue.listTasks().length, 2);
});

test("unknown independent checks remain unknown through every revision even when all critics approve", async t => {
  const f = await fixture(t, async task => {
    const input = reviewInput(task);
    return result(task, input ? { ...answer(input, true), resolutions: [] } : { proposal: "A narrower fixture proposal" });
  });
  const { ledger, queue, handlers } = f.state;
  const raw = request();
  const { digest: _digest, ...packet } = raw.packet;
  raw.packet = createEvidencePacket({ ...packet, checks: [{ id: "held-out", status: "unknown", evidenceIds: ["measurement"] }] });
  const plan = prepareCouncilCampaign(ledger, raw);
  const ran = await runCouncilCampaign(ledger, queue, handlers, plan.planObservationId, 10, { workerId: "fixture" });
  assert.equal(ran.progress.status, "complete");
  if (ran.progress.status !== "complete") throw new Error("Expected a blocked final council");
  assert.equal(ran.progress.decision.status, "blocked");
  assert.equal(ran.progress.decision.rounds.length, 2);
  for (const round of ran.progress.decision.rounds) assert.equal(round.packet.checks[0]!.status, "unknown");
});

test("archive-before-enqueue failure can be repaired without finalizing an infrastructure error as a council verdict", async t => {
  let calls = 0;
  const f = await fixture(t, async task => { calls++; return result(task, answer(reviewInput(task)!)); });
  const { ledger, queue, handlers } = f.state;
  const plan = prepareCouncilCampaign(ledger, request());
  const enqueue = queue.enqueue.bind(queue);
  let fail = true;
  queue.enqueue = input => { if (fail) { fail = false; throw new Error("Injected enqueue storage error"); } return enqueue(input); };
  await assert.rejects(advanceCouncilCampaign(ledger, queue, handlers, plan.planObservationId), /Injected enqueue/);
  assert.equal(ledger.listObservations("study").filter(item => item.source === "durable-council-result.v1").length, 0);
  queue.enqueue = enqueue;
  const progress = await advanceCouncilCampaign(ledger, queue, handlers, plan.planObservationId);
  assert.equal(progress.status, "pending"); assert.equal(queue.listTasks().length, 2); assert.equal(calls, 0);
});

test("quota waiting preserves completed sibling evidence and repeated advancement makes no client calls", async t => {
  let calls = 0;
  const f = await fixture(t, async task => {
    calls++;
    if (task.backend === "codex") return { backend: "codex", status: "rate_limited", billing: "client_managed_account", text: "" };
    return result(task, answer(reviewInput(task)!));
  });
  const { ledger, queue, handlers } = f.state;
  const plan = prepareCouncilCampaign(ledger, request());
  const first = await runCouncilCampaign(ledger, queue, handlers, plan.planObservationId, 10, { workerId: "fixture" });
  assert.equal(first.progress.status, "pending"); assert.equal(calls, 2);
  assert.equal(queue.getResourceHold("codex:default")!.held, true);
  const second = await runCouncilCampaign(ledger, queue, handlers, plan.planObservationId, 10, { workerId: "fixture" });
  assert.deepEqual(second.executed, []); assert.equal(calls, 2);
  assert.equal(queue.listTasks().filter(task => task.state === "completed").length, 1);
  assert.equal(ledger.listObservations("study").filter(item => item.source === "durable-council-result.v1").length, 0);
});
