import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { hash } from "../../src/ledger/validation.ts";
import { archiveCoworkerAssessment } from "../../src/integrations/coworker/assessment.ts";
import { captureCoworkerReport } from "../../src/integrations/coworker/capture.ts";
import { assessCoworkerInvestigationEvidence } from "../../src/integrations/coworker/evidence-assessment.ts";
import { runCoworkerInvestigation } from "../../src/integrations/coworker/investigation.ts";
import { buildCoworkerPlanningPacket } from "../../src/integrations/coworker/planning-packet.ts";
import type { CoworkerInvestigationExecution } from "../../src/integrations/coworker/investigation-worker.ts";
import { investigationArchiveFixture, syntheticInvestigationExecution, SYNTHETIC_WORKER, INVESTIGATION_TIME } from "./coworker-investigation-fixtures.ts";

async function fixture(t: TestContext, declaredAdapter?: string) {
  let f = await investigationArchiveFixture(t);
  if (declaredAdapter !== undefined) {
    const reportPath = (f.capture.payload.requestIdentity as { reportPath: string }).reportPath;
    const report = JSON.parse(await readFile(join(f.root, reportPath), "utf8"));
    report.steps[0].checkpoint = { adapter_sha256: declaredAdapter };
    await writeFile(join(f.root, reportPath), JSON.stringify(report));
    const capture = await captureCoworkerReport(f.ledger(), { projectId: "study", captureId: "capture-with-checkpoint", root: f.root, reportPath, observedAt: INVESTIGATION_TIME });
    f = { ...f, capture, request: { ...f.request, captureId: capture.eventId, captureDigest: capture.digest } };
  }
  const assessment = archiveCoworkerAssessment(f.ledger(), { projectId: "study", captureId: f.capture.eventId, captureDigest: f.capture.digest });
  async function archive(investigationId: string, alter: (execution: CoworkerInvestigationExecution) => void = () => {}) {
    const record = await runCoworkerInvestigation(f.ledger(), { ...f.request, investigationId }, { root: f.root, now: f.now,
      worker: { descriptor: SYNTHETIC_WORKER, async run(request) {
        const execution = structuredClone(syntheticInvestigationExecution(request));
        // Align this synthetic output with the capture's existing full base pin.
        for (const cell of Object.values(execution.result!.cells)) cell.baseModelRevision = "c".repeat(40);
        alter(execution);
        if (execution.result) execution.resultSha256 = hash(execution.result);
        return execution;
      } } });
    const binding = { projectId: "study", assessmentObservationId: assessment.eventId, assessmentObservationDigest: assessment.digest,
      investigationObservationId: record.eventId, investigationObservationDigest: record.digest };
    return { record, binding, assess: () => assessCoworkerInvestigationEvidence(f.ledger(), binding) };
  }
  return { ...f, assessment, archive };
}

test("every incomplete prefix credits only its verified subquestions and never invents comparison values", async t => {
  const f = await fixture(t);
  const stages = ["report", "source", "adapter", "trained_evaluation", "baseline_evaluation", "comparison"] as const;
  const criteria = ["report-manifest-correspondence", "python-source-correspondence", "adapter-byte-correspondence", "trained-record-joins", "baseline-record-joins"];
  for (let failedStage = 0; failedStage < stages.length; failedStage++) {
    const inspection = await f.archive(`prefix-${failedStage}`, execution => {
      execution.observations = execution.observations.slice(0, failedStage);
      execution.observations.push({ check: stages[failedStage]!, status: "failed", reason: "missing_file", files: [] });
      execution.status = "incomplete"; execution.reason = "missing_file"; execution.result = null; execution.resultSha256 = null;
    });
    const assessment = inspection.assess();
    criteria.forEach((criterionId, index) => assert.equal(assessment.criteria.find(item => item.id === criterionId)!.status,
      index < failedStage ? "supported" : "not_established", `${failedStage}: ${criterionId}`));
    for (const criterion of assessment.criteria.filter(item => item.category === "producer_measurement")) {
      assert.equal(criterion.status, "not_established");
    }
    assert.ok(assessment.nextActions.some(action => action.kind === "repair-selected-evidence"));
    assert.ok(assessment.requestUpdates.every(update => update.originalRequestUnresolved));
    const source = assessment.criteria.find(item => item.id === "python-source-correspondence")!;
    if (failedStage > 1) assert.match(source.observation, /only its bounded file references/);
    assert.equal(assessment.scientificEvaluation, "unassessed");
  }
});

test("adverse producer counts remain visible without becoming extra replications or scientific approval", async t => {
  const f = await fixture(t), inspection = await f.archive("adverse-counts", execution => {
    for (const [name, cell] of Object.entries(execution.result!.cells)) {
      const trained = name === "trained";
      cell.rows = cell.uniqueWorlds = cell.uniqueTraceIds = cell.uniqueResultIds = cell.summaryScoredTotal = 384;
      cell.summaryRan = 376; cell.summaryResumedFrom = 8;
      cell.producerCompleteCount = trained ? 380 : 384;
      cell.producerStatusOkCount = trained ? 381 : 384; cell.producerStatusOtherCount = trained ? 3 : 0;
      cell.producerErrorCount = trained ? 2 : 0;
      cell.producerCreditHistogram = trained ? [363, 19, 2] : [367, 17, 0];
      cell.producerTargetsCredited = trained ? 23 : 17; cell.producerCleanSuccessCount = trained ? 1 : 0;
      cell.storedFunnelDenominator = 768; cell.storedFunnelRate = trained ? 0.0299 : 0.0221;
    }
    execution.result!.producerCreditedDifference = 6;
  });
  const assessment = inspection.assess(), count = f.ledger().listObservations("study").length;
  const accounting = assessment.criteria.find(item => item.id === "producer-failure-accounting")!;
  assert.equal(accounting.status, "supported"); assert.match(accounting.observation, /380\/384 producer-complete/);
  assert.match(accounting.observation, /3 other statuses, 2 errors/);
  assert.ok(assessment.nextActions.some(item => item.kind === "account-producer-failures"));
  assert.match(assessment.criteria.find(item => item.id === "training-replication-scope")!.observation, /1 trained-policy replica/);
  for (const criterion of assessment.criteria.filter(item => item.category === "scientific_requirement")) assert.equal(criterion.status, "not_established");
  assert.equal(assessment.criteria.find(item => item.id === "bare-base-comparator-observed")!.status, "supported");
  assert.equal(assessment.criteria.find(item => item.id === "matched-training-control")!.status, "not_established");
  const packet = buildCoworkerPlanningPacket(f.ledger(), inspection.binding, INVESTIGATION_TIME);
  assert.ok(packet.checks.every(check => check.id.startsWith("planning-")));
  const scope = JSON.parse(packet.evidence.find(item => item.id === "planning:scope")!.summary);
  assert.equal(scope.scientificEvaluation, "unassessed"); assert.equal(scope.executionAuthorized, false);
  assert.ok(assessment.nextActions.every(action => !action.executionAuthorized));
  assert.equal(f.ledger().listRuns().length, 0); assert.equal(f.ledger().listActions().length, 0);
  assert.equal(f.ledger().listObservations("study").length, count);
});

test("a reported source digest or base declaration contradicting the bound capture cannot receive support", async t => {
  const f = await fixture(t);
  for (const field of ["source", "base"] as const) {
    const inspection = await f.archive(`contradictory-${field}`, execution => {
      if (field === "source") execution.result!.source.pythonSourceSha256 = "0".repeat(64);
      else for (const cell of Object.values(execution.result!.cells)) cell.baseModelRevision = "0".repeat(40);
    });
    assert.throws(() => inspection.assess(), /source|capture|base|binding|correspondence/i);
  }
});

test("adapter correspondence cannot contradict an available captured final checkpoint even in a partial receipt", async t => {
  const f = await fixture(t, "0".repeat(64));
  for (const partial of [false, true]) {
    const inspection = await f.archive(`adapter-conflict-${partial}`, execution => {
      if (partial) {
        execution.observations = execution.observations.slice(0, 3);
        execution.observations.push({ check: "trained_evaluation", status: "failed", reason: "missing_file", files: [] });
        execution.status = "incomplete"; execution.reason = "missing_file"; execution.result = null; execution.resultSha256 = null;
      }
    });
    assert.throws(() => inspection.assess(), /adapter.*captured final checkpoint/i);
  }
});

test("derived answers survive source deletion and every evidence pointer resolves within its bound observation", async t => {
  const f = await fixture(t), inspection = await f.archive("recovery"), assessment = inspection.assess();
  const before = f.ledger().listObservations("study");
  for (const criterion of assessment.criteria) for (const reference of criterion.evidence) {
    const record = f.ledger().getObservation(reference.observationId)!;
    assert.equal(record.digest, reference.digest);
    const value = reference.pointer.split("/").slice(1).reduce<unknown>((current, part) => {
      const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
      assert.ok(current !== null && typeof current === "object" && Object.hasOwn(current, key));
      return (current as Record<string, unknown>)[key];
    }, record);
    assert.notEqual(value, undefined);
  }
  await rm(f.root, { recursive: true }); f.reopen();
  assert.deepEqual(inspection.assess(), assessment);
  assert.deepEqual(f.ledger().listObservations("study"), before);
  assert.ok(Object.isFrozen(assessment.criteria)); assert.ok(Object.isFrozen(assessment.nextActions));
});
