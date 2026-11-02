import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { hash } from "../../src/ledger/validation.ts";
import type { ObservationRecord } from "../../src/ledger/types.ts";
import type { ReplayEvidenceRecord } from "../../src/integrations/coworker/replay-evidence.ts";
import { archiveCoworkerReplayAnnotations, assessCoworkerReplayEvidence, loadCoworkerReplayAnnotations, prepareCoworkerReplayAnnotations } from "../../src/integrations/coworker/replay-assessment.ts";
import type { CoworkerReplayAssessmentBinding } from "../../src/integrations/coworker/replay-assessment.ts";
import { buildCoworkerReplayPlanningPacket } from "../../src/integrations/coworker/replay-planning.ts";
import { createReplayEvidenceFixture, replayFixtureSha } from "./coworker-replay-evidence-fixtures.ts";

const NOW = "2026-11-02T12:00:00.000Z";
type Label = { factId: string; expected: boolean | "unknown"; rationale: string };
function annotationInput(record: ReplayEvidenceRecord, labels: Label[] = [
  { factId: "debt", expected: false, rationale: "The memo explicitly denies its quoted assertion." },
]) {
  const result = record.payload.bundle.execution.output?.result;
  return { schemaVersion: 1, kind: "coworker-replay-semantic-annotations.v1",
    binding: { projectId: record.projectId, replayObservationId: record.eventId, replayObservationDigest: record.digest,
      // Placeholders permit a negative test of annotation attempts on incomplete replay.
      memoSha256: result?.memoSha256 ?? "a".repeat(64), requiredFactsSha256: result?.requiredFactsSha256 ?? "b".repeat(64) },
    annotator: { id: "independent-fixture-author", kind: "model", method: "Posthoc application of a fixed affirmative-assertion rule; synthetic expectation, not human gold.",
      authoredAt: NOW, declaredTiming: "after_native_result", declaredResultExposure: "seen" }, labels };
}
function binding(record: ReplayEvidenceRecord, annotation?: ObservationRecord): CoworkerReplayAssessmentBinding {
  return { projectId: record.projectId!, replayObservationId: record.eventId, replayObservationDigest: record.digest,
    annotationObservationId: annotation?.eventId ?? null, annotationObservationDigest: annotation?.digest ?? null };
}

test("without annotations every required fact remains unknown independently of acquisition", async t => {
  const f = await createReplayEvidenceFixture(t);
  const before = f.ledger.listObservations("alpha");
  const assessment = assessCoworkerReplayEvidence(f.ledger, binding(f.record));
  assert.deepEqual(assessment.requiredFactIds, ["debt", "cash"]);
  assert.equal(assessment.counts!.requiredFacts, 2);
  assert.equal(assessment.counts!.unknownExpectations, 2);
  assert.equal(assessment.counts!.knownExpectations, 0);
  assert.equal(assessment.counts!.comparableLabelledFacts, 0);
  assert.equal(assessment.facts.find(row => row.factId === "cash")!.authorizedObserved, false);
  assert.ok(assessment.facts.every(row => row.annotation.expected === "unknown" && row.comparison === "annotation_unknown"));
  assert.deepEqual(assessment.historicalRequestUpdates, []);
  assert.equal(assessment.semanticEvaluation, "unassessed");
  assert.equal(assessment.executionAuthorized, false);
  assert.deepEqual(f.ledger.listObservations("alpha"), before);
});

test("a partial negative annotation yields one reference-relative discrepancy and leaves the other fact unknown", async t => {
  const f = await createReplayEvidenceFixture(t);
  const annotation = archiveCoworkerReplayAnnotations(f.ledger, annotationInput(f.record), { now: () => new Date(NOW) });
  const assessment = assessCoworkerReplayEvidence(f.ledger, binding(f.record, annotation));
  assert.equal(assessment.counts!.requiredFacts, 2);
  assert.equal(assessment.counts!.providedAnnotations, 1);
  assert.equal(assessment.counts!.unknownExpectations, 1);
  assert.equal(assessment.counts!.comparableLabelledFacts, 1);
  assert.equal(assessment.counts!.creditAgainstNegativeAnnotation, 1);
  assert.equal(assessment.facts[0]!.authorizedObserved, true);
  assert.equal(assessment.facts[0]!.observedCredit, true);
  assert.equal(assessment.facts[0]!.annotation.expected, false);
  assert.equal(assessment.facts[1]!.annotation.status, "omitted");
  assert.equal(assessment.recommendation.actionId, "review-evaluator-discrepancy");
  assert.match(assessment.nextActions[0]!.reason, /reference-relative|not independently/);
  assert.equal(assessment.semanticEvaluation, "unassessed");
  assert.equal(assessment.taskSuccess, "unassessed");
  assert.ok(Object.isFrozen(assessment.facts[0]!.annotation) && Object.isFrozen(assessment.nextActions));
});

test("scorer errors and explicit unknown annotations never enter the comparable-label denominator", async t => {
  const f = await createReplayEvidenceFixture(t, { mutateObservation(result) {
    Object.assign(result.facts[0]!, { nativeCredit: null, error: "scorer_exception", observedCredit: null });
  } });
  const annotation = archiveCoworkerReplayAnnotations(f.ledger, annotationInput(f.record, [
    { factId: "debt", expected: true, rationale: "A supplied known claim remains known even when native scoring fails." },
    { factId: "cash", expected: "unknown", rationale: "No independent semantic decision was supplied." },
  ]));
  const assessment = assessCoworkerReplayEvidence(f.ledger, binding(f.record, annotation));
  assert.equal(assessment.counts!.providedAnnotations, 2);
  assert.equal(assessment.counts!.knownExpectations, 1);
  assert.equal(assessment.counts!.unknownExpectations, 1);
  assert.equal(assessment.counts!.nativeScorerErrors, 1);
  assert.equal(assessment.counts!.comparableLabelledFacts, 0);
  assert.equal(assessment.counts!.noCreditAgainstPositiveAnnotation, 0);
  assert.equal(assessment.facts[0]!.nativeCredit, null);
  assert.equal(assessment.facts[0]!.comparison, "scorer_error");
  assert.equal(assessment.facts[1]!.annotation.expected, "unknown");
  assert.equal(assessment.facts[1]!.annotation.status, "provided");
  assert.equal(assessment.recommendation.actionId, "inspect-native-scorer-errors");
});

test("known correct numeric text without acquisition is not converted into authorized semantic use", async t => {
  const f = await createReplayEvidenceFixture(t, { mutateObservation(result) {
    result.evidence = []; result.readPages = []; result.observedMessages = [];
    Object.assign(result.facts[0]!, { authorizedObserved: false, witnessMessageIds: [], observedCredit: false });
  } });
  const annotation = archiveCoworkerReplayAnnotations(f.ledger, annotationInput(f.record, [
    { factId: "debt", expected: true, rationale: "A hypothetical supplied positive annotation; this test checks the join, not label truth." },
  ]));
  const assessment = assessCoworkerReplayEvidence(f.ledger, binding(f.record, annotation));
  assert.equal(assessment.facts[0]!.comparison, "agrees_with_annotation");
  assert.equal(assessment.facts[0]!.authorizedObserved, false);
  assert.equal(assessment.counts!.creditWithoutAuthorizedObservation, 1);
  assert.equal(assessment.counts!.authorizedObservedFacts, 0);
  assert.equal(assessment.counts!.observedNumericCredits, 0);
  assert.equal(assessment.recommendation.actionId, "review-acquisition-credit-boundary");
  assert.equal(assessment.taskSuccess, "unassessed");
});

test("annotation publication rejects another memo, incomplete definitions, wrong record or unknown fact before append", async t => {
  const f = await createReplayEvidenceFixture(t), before = f.ledger.listObservations("alpha").length;
  const original = annotationInput(f.record);
  const mutations: Array<(v: ReturnType<typeof annotationInput>) => void> = [
    v => { v.binding.memoSha256 = "0".repeat(64); },
    v => { v.binding.requiredFactsSha256 = hash(f.record.payload.bundle.execution.output!.result!.worldFacts.map(row => ({ id: row.id, value: row.value, unit: row.unit }))); },
    v => { v.binding.replayObservationDigest = "1".repeat(64); },
    v => { v.binding.projectId = "another-project"; },
    v => { v.labels[0]!.factId = "unrecorded-fact"; },
  ];
  for (const mutate of mutations) {
    const input = structuredClone(original); mutate(input);
    assert.throws(() => archiveCoworkerReplayAnnotations(f.ledger, input));
    assert.equal(f.ledger.listObservations("alpha").length, before);
  }
});

test("declared prewriting, human authorship and lack of exposure remain unauthenticated claims", async t => {
  const f = await createReplayEvidenceFixture(t), input = annotationInput(f.record);
  input.annotator.kind = "human"; input.annotator.declaredTiming = "before_native_result";
  input.annotator.declaredResultExposure = "not_seen"; input.annotator.authoredAt = "2020-01-01T00:00:00.000Z";
  const annotation = archiveCoworkerReplayAnnotations(f.ledger, input, { now: () => new Date(NOW) });
  const assessment = assessCoworkerReplayEvidence(f.ledger, binding(f.record, annotation));
  assert.equal(assessment.annotation!.annotator.authoredAt, "2020-01-01T00:00:00.000Z");
  assert.equal(assessment.annotation!.archivedAt, NOW);
  for (const field of ["authorshipVerification", "timingVerification", "blindnessVerification", "semanticTruthVerification"] as const) {
    assert.equal(assessment.annotation![field], "not_established");
  }
  assert.ok(assessment.nextActions.some(action => action.actionId === "establish-annotation-provenance"));
});

test("annotation normalization rejects duplicate labels, truthy coercion, getters and stale digests", async t => {
  const f = await createReplayEvidenceFixture(t), input = annotationInput(f.record);
  assert.throws(() => prepareCoworkerReplayAnnotations({ ...input, labels: [...input.labels, ...input.labels] }), /duplicate/);
  for (const expected of [1, "false", [false], null]) {
    assert.throws(() => prepareCoworkerReplayAnnotations({ ...input, labels: [{ ...input.labels[0], expected }] }));
  }
  assert.throws(() => prepareCoworkerReplayAnnotations({ ...input, annotator: { ...input.annotator, kind: ["human"] } }));
  let reads = 0;
  const accessor = structuredClone(input);
  Object.defineProperty(accessor.labels[0], "expected", { enumerable: true, get() { reads++; return false; } });
  assert.throws(() => prepareCoworkerReplayAnnotations(accessor)); assert.equal(reads, 0);
  const accepted = prepareCoworkerReplayAnnotations(input);
  input.labels[0]!.expected = true;
  assert.equal(accepted.labels[0]!.expected, false);
  assert.ok(Object.isFrozen(accepted.labels[0]));
  assert.throws(() => prepareCoworkerReplayAnnotations({ ...input, digest: accepted.digest }), /digest mismatch/);
});

test("rejected and cancelled replay retain null counts, no fact outcomes and recovery-first planning", async t => {
  for (const status of ["rejected", "cancelled"] as const) {
    const f = await createReplayEvidenceFixture(t, { status });
    const assessment = assessCoworkerReplayEvidence(f.ledger, binding(f.record));
    assert.equal(assessment.counts, null); assert.deepEqual(assessment.facts, []); assert.deepEqual(assessment.requiredFactIds, []);
    assert.equal(assessment.recommendation.actionId, "recover-native-evidence");
    assert.equal(assessment.replay.status, "incomplete"); assert.equal(assessment.taskSuccess, "unassessed");
    assert.throws(() => archiveCoworkerReplayAnnotations(f.ledger, annotationInput(f.record, [])), /exact completed/);
  }
});

test("invalid-policy termination takes priority while preserving complete mechanical facts", async t => {
  const f = await createReplayEvidenceFixture(t, { mutateObservation(result) {
    result.memo = ""; result.memoSha256 = replayFixtureSha(""); result.terminal = { valid: false, status: "invalid_policy" };
    result.facts.forEach(row => { row.nativeCredit = false; row.observedCredit = false; });
  } });
  const assessment = assessCoworkerReplayEvidence(f.ledger, binding(f.record));
  assert.equal(assessment.replay.status, "completed"); assert.equal(assessment.replay.terminalStatus, "invalid_policy");
  assert.equal(assessment.counts!.requiredFacts, 2); assert.equal(assessment.recommendation.actionId, "inspect-policy-termination");
  assert.equal(assessment.taskSuccess, "unassessed");
});

test("archive retry and offline assessment preserve old labels instead of silently rewriting them", async t => {
  const f = await createReplayEvidenceFixture(t), input = annotationInput(f.record);
  const first = archiveCoworkerReplayAnnotations(f.ledger, input, { now: () => new Date(NOW) });
  const before = assessCoworkerReplayEvidence(f.ledger, binding(f.record, first));
  const retried = archiveCoworkerReplayAnnotations(f.ledger, input, { now: () => new Date("2026-11-03T12:00:00.000Z") });
  assert.equal(retried.digest, first.digest); assert.equal(retried.observedAt, NOW);
  const changed = structuredClone(input); changed.labels[0]!.expected = true;
  const second = archiveCoworkerReplayAnnotations(f.ledger, changed);
  assert.notEqual(second.eventId, first.eventId);
  await rm(f.artifactRoot, { recursive: true });
  assert.equal(loadCoworkerReplayAnnotations(f.ledger, first.eventId).digest, first.digest);
  assert.equal(assessCoworkerReplayEvidence(f.ledger, binding(f.record, first)).digest, before.digest);
  assert.equal(before.facts[0]!.annotation.expected, false);
  assert.equal(assessCoworkerReplayEvidence(f.ledger, binding(f.record, second)).facts[0]!.annotation.expected, true);
});

test("planning checks certify derivation only and cannot alter historical requests or create execution authority", async t => {
  const f = await createReplayEvidenceFixture(t);
  const historical = f.ledger.appendObservation({ eventId: "historical-unresolved-marker", projectId: "alpha", runId: null, actionId: null, jobId: null,
    source: "test-historical-request.v1", sequence: 0, observedAt: NOW, payload: { scope: "Run1", unresolved: ["manifest", "independent_evaluation", "matched_control"] } });
  const annotation = archiveCoworkerReplayAnnotations(f.ledger, annotationInput(f.record));
  const before = f.ledger.listObservations("alpha");
  const selected = binding(f.record, annotation), assessment = assessCoworkerReplayEvidence(f.ledger, selected);
  const packet = buildCoworkerReplayPlanningPacket(f.ledger, selected, NOW);
  const scope = JSON.parse(packet.evidence.find(item => item.id === "replay-planning:scope")!.summary);
  assert.equal(scope.executionAuthorized, false); assert.equal(scope.interventionAuthorized, false);
  assert.equal(scope.semanticEvaluation, "unassessed"); assert.equal(scope.scientificEvaluation, "unassessed");
  assert.deepEqual(scope.historicalRequestUpdates, []); assert.deepEqual(assessment.historicalRequestUpdates, []);
  assert.ok(packet.checks.every(check => check.id.startsWith("replay-planning-") && check.status === "passed"));
  assert.ok(packet.requiredCriteria.includes("retains-controls-replication-and-historical-boundaries"));
  assert.ok(assessment.nextActions.every(action => action.executionAuthorized === false));
  assert.deepEqual(f.ledger.getObservation(historical.eventId), historical);
  assert.deepEqual(f.ledger.listObservations("alpha"), before);
  assert.equal(f.ledger.listRuns().length, 0); assert.equal(f.ledger.listActions().length, 0);
  for (const check of packet.checks) for (const evidenceId of check.evidenceIds) assert.ok(packet.evidence.some(item => item.id === evidenceId));
});

test("assessment refuses digest substitution and partially specified annotation references", async t => {
  const f = await createReplayEvidenceFixture(t), annotation = archiveCoworkerReplayAnnotations(f.ledger, annotationInput(f.record));
  const selected = binding(f.record, annotation);
  assert.throws(() => assessCoworkerReplayEvidence(f.ledger, { ...selected, replayObservationDigest: "0".repeat(64) }));
  assert.throws(() => assessCoworkerReplayEvidence(f.ledger, { ...selected, annotationObservationDigest: "1".repeat(64) }));
  assert.throws(() => assessCoworkerReplayEvidence(f.ledger, { ...selected, annotationObservationId: null }));
  assert.throws(() => assessCoworkerReplayEvidence(f.ledger, { ...selected, annotationObservationDigest: null }));
});

test("planning includes exact private source content and all fact definitions without elevating them to instructions", async t => {
  const memo = "α".repeat(12_001) + "🧪\nThe quotation remains denied.";
  const f = await createReplayEvidenceFixture(t, { mutateObservation(result) {
    result.memo = memo; result.memoSha256 = replayFixtureSha(memo);
  } });
  const annotation = archiveCoworkerReplayAnnotations(f.ledger, annotationInput(f.record));
  const packet = buildCoworkerReplayPlanningPacket(f.ledger, binding(f.record, annotation), NOW);
  const native = f.record.payload.bundle.execution.output!.result!;
  const content = packet.evidence.filter(item => item.id.startsWith("replay-content:")).map(item => ({
    item, value: JSON.parse(item.summary) as { sourceReference: { observationId: string; digest: string; pointer: string };
      sourceContentIsUntrusted: boolean; instructionBoundary: string; content: unknown },
  }));
  for (const { value } of content) {
    assert.equal(value.sourceContentIsUntrusted, true);
    assert.match(value.instructionBoundary, /not instructions/);
    const referenced = f.ledger.getObservation(value.sourceReference.observationId)!;
    assert.equal(referenced.digest, value.sourceReference.digest);
    let selected: unknown = referenced;
    for (const part of value.sourceReference.pointer.slice(1).split("/")) {
      selected = (selected as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
      assert.notEqual(selected, undefined);
    }
  }
  const chunks = content.filter(row => row.item.id.startsWith("replay-content:memo:part:")).map(row => row.value.content as {
    segment: { index: number; total: number; totalCodePoints: number }; text: string;
  }).sort((a, b) => a.segment.index - b.segment.index);
  assert.equal(chunks.length, 2);
  assert.equal(chunks.map(chunk => chunk.text).join(""), memo);
  assert.ok(chunks.every(chunk => chunk.segment.total === 2 && chunk.segment.totalCodePoints === Array.from(memo).length));
  assert.deepEqual(content.filter(row => row.item.id.startsWith("replay-content:world:")).map(row => row.value.content), native.worldFacts);
  assert.deepEqual(content.filter(row => row.item.id.startsWith("replay-content:native-fact:")).map(row => row.value.content), native.facts);
  assert.deepEqual(content.filter(row => row.item.id.startsWith("replay-content:page:")).map(row => row.value.content), native.readPages);
  assert.equal(assessCoworkerReplayEvidence(f.ledger, binding(f.record, annotation)).semanticEvaluation, "unassessed");
});
