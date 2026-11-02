import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import { archiveCoworkerAssessment } from "../../src/integrations/coworker/assessment.ts";
import { runCoworkerInvestigation } from "../../src/integrations/coworker/investigation.ts";
import { buildCoworkerPlanningPacket, COWORKER_PLANNING_REVIEW_CRITERIA, COWORKER_PLANNING_SCOPE } from "../../src/integrations/coworker/planning-packet.ts";
import { assessCoworkerInvestigationEvidence } from "../../src/integrations/coworker/evidence-assessment.ts";
import type { CoworkerEvidenceAssessmentBinding } from "../../src/integrations/coworker/evidence-assessment.ts";
import { runCouncil } from "../../src/research/council.ts";
import { verifyEvidencePacket } from "../../src/research/evidence.ts";
import { investigationArchiveFixture, INVESTIGATION_TIME, syntheticInvestigationExecution, SYNTHETIC_WORKER } from "./coworker-investigation-fixtures.ts";

async function fixture(t: TestContext, complete = true) {
  const f = await investigationArchiveFixture(t);
  const assessment = archiveCoworkerAssessment(f.ledger(), { projectId: "study", captureId: f.capture.eventId, captureDigest: f.capture.digest });
  const investigation = await runCoworkerInvestigation(f.ledger(), f.request, { root: f.root, now: f.now,
    worker: { descriptor: SYNTHETIC_WORKER, run: async request => syntheticInvestigationExecution(request, SYNTHETIC_WORKER, complete) } });
  const binding: CoworkerEvidenceAssessmentBinding = { projectId: "study", assessmentObservationId: assessment.eventId,
    assessmentObservationDigest: assessment.digest, investigationObservationId: investigation.eventId, investigationObservationDigest: investigation.digest };
  return { ...f, binding, assessment, investigation, packet: () => buildCoworkerPlanningPacket(f.ledger(), binding, INVESTIGATION_TIME) };
}

test("planning packet retains answered subcriteria and unresolved science without stale capture-only absence", async t => {
  const f = await fixture(t), assessment = assessCoworkerInvestigationEvidence(f.ledger(), f.binding), packet = f.packet();
  assert.equal(verifyEvidencePacket(packet).digest, packet.digest);
  assert.equal(packet.packetId, `coworker-planning:${assessment.digest}`);
  assert.deepEqual(packet.requiredCriteria, COWORKER_PLANNING_REVIEW_CRITERIA);
  assert.ok(assessment.criteria.some(c => c.category === "byte_correspondence" && c.status === "supported"));
  assert.ok(assessment.criteria.some(c => c.category === "scientific_requirement" && c.status === "not_established"));
  for (const criterion of assessment.criteria) {
    const item = packet.evidence.find(e => e.id === `planning:criterion:${criterion.id}`)!;
    const projected = JSON.parse(item.summary);
    assert.equal(projected.status, criterion.status); assert.deepEqual(projected.evidence, criterion.evidence);
    assert.deepEqual(projected.limitations, criterion.limitations);
    assert.equal(item.locator, `derived-assessment:${assessment.digest}`);
    assert.equal(item.version, assessment.rulesDigest); assert.equal(item.sha256, assessment.digest);
  }
  for (const item of packet.evidence.filter(item => !item.id.startsWith("planning:prior:"))) {
    assert.equal(item.locator, `derived-assessment:${assessment.digest}`);
    assert.equal(item.version, assessment.rulesDigest); assert.equal(item.sha256, assessment.digest);
  }
  const derivation = JSON.parse(packet.evidence.find(item => item.id === "planning:derivation")!.summary);
  assert.deepEqual(derivation.binding, assessment.binding);
  const requestProgress = JSON.parse(packet.evidence.find(item => item.id === "planning:request-progress")!.summary);
  assert.deepEqual(requestProgress.sourceReference, { observationId: assessment.binding.assessmentObservationId, digest: assessment.binding.assessmentObservationDigest, pointer: "/payload/requests" });
  for (const action of assessment.nextActions) {
    assert.deepEqual(JSON.parse(packet.evidence.find(e => e.id === `planning:alternative:${action.actionId}`)!.summary), action);
  }
  const scope = JSON.parse(packet.evidence.find(e => e.id === "planning:scope")!.summary);
  assert.equal(scope.decisionScope, COWORKER_PLANNING_SCOPE); assert.equal(scope.executionAuthorized, false);
  assert.equal(scope.scientificEvaluation, "unassessed");
  assert.ok(packet.checks.every(check => check.id.startsWith("planning-") && check.status === "passed"));
  assert.ok(assessment.criteria.filter(c => c.category === "scientific_requirement").every(c => !packet.checks.some(check => check.id === c.id)));
  assert.ok(!packet.evidence.some(e => e.id === "planning:prior:scientific-comparison"));
  assert.ok(!JSON.stringify(packet).includes("This capture has no independent task-success evaluation, matched baseline or complete original manifest."));
  assert.ok(packet.evidence.some(e => e.id === "planning:prior:numerical-integrity"));
  assert.ok(Object.isFrozen(packet.evidence));
  const summary = JSON.stringify(packet); assert.ok(!summary.includes("endpoint_base_url")); assert.ok(!summary.includes('"turns"')); assert.ok(!summary.includes('"transcript"'));
});

test("partial inspection remains usable for planning without promoting unavailable evidence", async t => {
  const f = await fixture(t, false), assessment = assessCoworkerInvestigationEvidence(f.ledger(), f.binding), packet = f.packet();
  for (const criterion of assessment.criteria) {
    const stored = JSON.parse(packet.evidence.find(item => item.id === `planning:criterion:${criterion.id}`)!.summary);
    assert.equal(stored.status, criterion.status);
  }
  assert.ok(assessment.criteria.some(c => c.category === "byte_correspondence" && c.status === "not_established"));
  assert.ok(packet.evidence.some(item => item.id === "planning:recommendation"));
  assert.equal(JSON.parse(packet.evidence.find(item => item.id === "planning:scope")!.summary).executionAuthorized, false);
});

test("archive bindings reject digest/project substitution and recover without source files", async t => {
  const f = await fixture(t), original = f.packet(), count = f.ledger().listObservations("study").length;
  assert.throws(() => buildCoworkerPlanningPacket(f.ledger(), { ...f.binding, investigationObservationDigest: "0".repeat(64) }, INVESTIGATION_TIME));
  assert.throws(() => buildCoworkerPlanningPacket(f.ledger(), { ...f.binding, projectId: "other" }, INVESTIGATION_TIME));
  const archive = { getObservation(eventId: string) {
    const record = f.ledger().getObservation(eventId);
    return record && eventId === f.assessment.eventId ? { ...record, digest: "0".repeat(64) } : record;
  } };
  assert.throws(() => buildCoworkerPlanningPacket(archive, f.binding, INVESTIGATION_TIME));
  await rm(f.root, { recursive: true }); f.reopen();
  assert.deepEqual(f.packet(), original);
  assert.equal(f.ledger().listObservations("study").length, count);
});

test("offline planning approval preserves immutable no-authority and unassessed science boundaries", async t => {
  const f = await fixture(t), packet = f.packet(), count = f.ledger().listObservations("study").length;
  const council = await runCouncil({ councilId: "planning-only-fixture", packet, reviewers: [{ id: "methods", role: "Prospective methods planning" }], maxRevisions: 0,
    review: async request => ({ schemaVersion: 1, reviewerId: request.reviewer.id, packetDigest: request.packet.digest,
      round: request.round, recommendation: "approve", observations: [{ text: "The fixed planning scope explicitly preserves unassessed science.", evidenceIds: ["planning:scope"] }],
      interpretations: [{ text: "The proposed evidence work can be endorsed as a plan without authorizing execution.", evidenceIds: ["planning:scope", "planning:recommendation"] }],
      criteria: request.packet.requiredCriteria.map(criterionId => ({ criterionId, status: "satisfied", summary: "This synthetic review endorses prospective planning within the declared limits.", evidenceIds: ["planning:scope", "planning:request-progress"] })),
      objections: [], resolutions: [], rationale: { text: "Planning endorsement only; scientific requirements and execution authority remain unchanged.", evidenceIds: ["planning:scope"] } }) });
  assert.equal(council.status, "approved");
  const scoped = JSON.parse(council.rounds[0]!.packet.evidence.find(item => item.id === "planning:scope")!.summary);
  assert.equal(scoped.executionAuthorized, false); assert.equal(scoped.interventionAuthorized, false);
  assert.equal(scoped.scientificEvaluation, "unassessed"); assert.match(council.rounds[0]!.packet.proposal, /approval endorses planning only/u);
  assert.equal(f.ledger().listObservations("study").length, count);
  assert.equal(f.ledger().listRuns("study").length, 0); assert.equal(f.ledger().listActions("study").length, 0);
});
