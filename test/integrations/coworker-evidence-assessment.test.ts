import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { rm } from "node:fs/promises";
import { archiveCoworkerAssessment } from "../../src/integrations/coworker/assessment.ts";
import { runCoworkerInvestigation } from "../../src/integrations/coworker/investigation.ts";
import { assessCoworkerInvestigationEvidence, COWORKER_EVIDENCE_ASSESSMENT_RULES } from "../../src/integrations/coworker/evidence-assessment.ts";
import type { CoworkerEvidenceAssessmentBinding } from "../../src/integrations/coworker/evidence-assessment.ts";
import { syntheticInvestigationExecution, SYNTHETIC_WORKER, investigationArchiveFixture } from "./coworker-investigation-fixtures.ts";

async function fixture(t: TestContext, failedStage?: number) {
  const f = await investigationArchiveFixture(t);
  const prior = archiveCoworkerAssessment(f.ledger(), { projectId: "study", captureId: f.capture.eventId, captureDigest: f.capture.digest });
  const receipt = await runCoworkerInvestigation(f.ledger(), f.request, { root: f.root, now: f.now, worker: { descriptor: SYNTHETIC_WORKER,
    async run(request) {
      const execution = structuredClone(syntheticInvestigationExecution(request));
      if (failedStage !== undefined) {
        const failed = execution.observations[failedStage]!;
        execution.observations = [...execution.observations.slice(0, failedStage), { ...failed, status: "failed", reason: "evidence_mismatch", files: [] }];
        execution.status = "incomplete"; execution.reason = "evidence_mismatch"; execution.result = null; execution.resultSha256 = null;
      }
      return execution;
    } } });
  const binding: CoworkerEvidenceAssessmentBinding = { projectId: "study", assessmentObservationId: prior.eventId,
    assessmentObservationDigest: prior.digest, investigationObservationId: receipt.eventId, investigationObservationDigest: receipt.digest };
  return { ...f, prior, receipt, binding, derive: () => assessCoworkerInvestigationEvidence(f.ledger(), binding) };
}

test("verified subquestions advance while broad scientific requests remain open", async t => {
  const f = await fixture(t), result = f.derive();
  assert.equal(result.rulesDigest, COWORKER_EVIDENCE_ASSESSMENT_RULES.digest);
  assert.equal(result.criteria.filter(item => item.status === "supported").length, 10);
  assert.ok(result.criteria.filter(item => item.category === "scientific_requirement").every(item => item.status === "not_established"));
  const broad = result.requestUpdates.filter(item => ["recover_manifest", "collect_independent_evaluation", "design_matched_baseline"].includes(item.kind));
  assert.equal(broad.length, 3);
  assert.ok(broad.every(item => item.disposition === "partially_supported" && item.originalRequestUnresolved));
  assert.ok(broad.every(item => item.answeredCriterionIds.length > 0 && item.unresolvedCriterionIds.length > 0));
  assert.equal(result.recommendation.actionId, result.nextActions[0]!.actionId);
  for (const request of result.requestUpdates.filter(item => item.disposition === "not_updated")) {
    assert.ok(result.nextActions.some(item => item.kind === `original-${request.kind}`));
  }
  assert.ok(result.nextActions.every(item => item.executionAuthorized === false && item.requiredEvidence.length > 0));
  assert.ok(result.nextActions.find(item => item.kind === "audit-semantic-success")!.method.some(item => item.includes("do not estimate population error rates")));
  assert.equal(result.scientificEvaluation, "unassessed"); assert.equal(result.interventionAuthorized, false);
  assert.ok(Object.isFrozen(result.criteria)); assert.deepEqual(f.ledger().getObservation(f.prior.eventId), f.prior);
});

test("every partial prefix credits only verified stages and never invents a comparison payload", async t => {
  const ids = ["report-manifest-correspondence", "python-source-correspondence", "adapter-byte-correspondence", "trained-record-joins", "baseline-record-joins"];
  for (let failedStage = 0; failedStage < 6; failedStage++) {
    const f = await fixture(t, failedStage), result = f.derive();
    for (const [index, id] of ids.entries()) assert.equal(result.criteria.find(item => item.id === id)!.status, index < failedStage ? "supported" : "not_established");
    for (const criterion of result.criteria.filter(item => item.category !== "byte_correspondence")) assert.equal(criterion.status, "not_established");
    assert.equal(result.recommendation.actionId, "next:repair-selected-evidence");
    assert.ok(result.nextActions.some(item => item.kind === "design-matched-replication"));
    assert.ok(!result.criteria.some(item => item.observation.includes("Producer-credited facts: trained")));
    assert.ok(!result.criteria.some(item => item.observation.includes("configuration IDs with zero overlap")));
  }
});

test("evidence assessment recovers from archive without files and makes no ledger changes", async t => {
  const f = await fixture(t), first = f.derive(), records = f.ledger().listObservations("study");
  await rm(f.root, { recursive: true }); f.reopen();
  assert.deepEqual(f.derive(), first); assert.deepEqual(f.ledger().listObservations("study"), records);
  assert.equal(f.ledger().listRuns().length, 0); assert.equal(f.ledger().listActions().length, 0);
});

test("evidence binding rejects wrong record hashes, projects and input accessors", async t => {
  const f = await fixture(t);
  for (const change of [{ projectId: "other" }, { assessmentObservationDigest: "f".repeat(64) }, { investigationObservationDigest: "f".repeat(64) }]) {
    assert.throws(() => assessCoworkerInvestigationEvidence(f.ledger(), { ...f.binding, ...change }), /binding|assessment|capture|source/u);
  }
  let reads = 0;
  const input = { ...f.binding, get investigationObservationDigest() { reads++; return f.receipt.digest; } };
  assert.throws(() => assessCoworkerInvestigationEvidence(f.ledger(), input), /accessors/u); assert.equal(reads, 0);
});
