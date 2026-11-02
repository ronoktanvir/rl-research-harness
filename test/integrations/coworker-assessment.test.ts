import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { hash } from "../../src/ledger/validation.ts";
import type { JsonObject, ObservationRecord } from "../../src/ledger/types.ts";
import { captureCoworkerReport } from "../../src/integrations/coworker/capture.ts";
import { assessCoworkerCapture, archiveCoworkerAssessment, COWORKER_ASSESSMENT_RULES } from "../../src/integrations/coworker/assessment.ts";
import { verifyEvidencePacket } from "../../src/research/evidence.ts";
import { runCouncil } from "../../src/research/council.ts";

const time = "2026-11-02T12:00:00.000Z";
function step(step_index: number, patch: Record<string, unknown> = {}) {
  return { step_index, loss: 1 / (step_index + 1), grad_norm: 0.5, optimizer_step_applied: true,
    post_update_serve_ok: true, checkpoint: { full_training_state: true, round_trip_verified: true, adapter_sha256: "a".repeat(64) }, ...patch };
}
function report(steps = [step(0), step(1)]) {
  return { runtime_source_sha: "a".repeat(40), source_tree_digest: "b".repeat(64), base_revision: "c".repeat(40),
    config: { steps: 100, training_seed: 7, api_key: "private-fixture-must-not-appear" }, steps };
}
async function fixture(t: TestContext, raw: unknown = report()) {
  const directory = await mkdtemp(join(tmpdir(), "coworker-assessment-")), root = join(directory, "source");
  await mkdir(root); await writeFile(join(root, "report.json"), typeof raw === "string" ? raw : JSON.stringify(raw));
  const path = join(directory, "ledger.sqlite");
  let ledger = openExperimentLedger({ path, now: () => new Date(time) });
  t.after(async () => { ledger.close(); await rm(directory, { recursive: true, force: true }); });
  const capture = await captureCoworkerReport(ledger, { captureId: "capture-one", projectId: "study", root, reportPath: "report.json", observedAt: time });
  const request = { projectId: "study", captureId: capture.eventId, captureDigest: capture.digest };
  return { root, capture, request, ledger: () => ledger,
    reopen() { ledger.close(); ledger = openExperimentLedger({ path, now: () => new Date(time) }); } };
}
function object(value: unknown): Record<string, any> { assert.ok(value && typeof value === "object"); return value as Record<string, any>; }
function resign(value: ObservationRecord): ObservationRecord {
  const { digest: _digest, ...body } = value; return { ...body, digest: hash(body) };
}

test("assessment computes scoped checks but never certifies health or learning from a clean loss curve", async t => {
  const f = await fixture(t); const result = assessCoworkerCapture(f.capture, f.request);
  assert.equal(result.outcome, "additional_evidence_required"); assert.equal(result.interventionAuthorized, false);
  assert.equal(result.observedAt, time); assert.equal(result.coverage.stepEntries, 2);
  assert.deepEqual(result.coverage.metrics.loss, { observedCount: 2, min: 0.5, max: 1 });
  assert.equal(result.coverage.metrics.reward, undefined);
  assert.equal(result.findings.find(item => item.ruleId === "checkpoint-assertions")?.status, "not_assessable");
  assert.deepEqual(result.packet.checks.slice(-2).map(check => check.status), ["unknown", "unknown"]);
  assert.ok(result.requests.some(item => item.kind === "collect_independent_evaluation"));
  assert.ok(result.requests.every(item => item.authority === "diagnostic_request_only"));
  assert.equal(verifyEvidencePacket(result.packet).digest, result.packet.digest);
  assert.ok(Object.isFrozen(result.requests[0])); assert.ok(Object.isFrozen(result.packet.evidence));
  const { digest, ...body } = result; assert.equal(hash(body), digest);
  assert.equal(result.rulesDigest, COWORKER_ASSESSMENT_RULES.digest);
  assert.doesNotMatch(JSON.stringify(result), /private-fixture-must-not-appear/u);
});

test("a late numeric defect is examined beyond summary windows and all counts survive sample bounds", async t => {
  const steps = Array.from({ length: 100 }, (_, index) => step(index, index >= 40 && index < 70 ? { loss: 999 } : {}));
  const f = await fixture(t, JSON.stringify(report(steps)).replaceAll('"loss":999', '"loss":NaN'));
  const result = assessCoworkerCapture(f.capture, f.request);
  assert.equal(result.outcome, "integrity_issues_observed");
  assert.equal(result.coverage.diagnosticCounts.nonfinite_metric, 30);
  assert.equal(result.coverage.metrics.loss?.observedCount, 70);
  const numeric = result.findings.find(item => item.ruleId === "numerical-integrity")!;
  assert.equal(numeric.status, "triggered"); assert.equal(numeric.references.count, 30); assert.equal(numeric.references.sample.length, 20);
  assert.equal(result.requests[0]?.kind, "inspect_numerics");
  assert.equal(result.packet.checks.find(check => check.id === "numerical-integrity")?.status, "failed");
});

test("duplicate and decreasing indices are detected directly even without producer diagnostic labels", async t => {
  const f = await fixture(t, report([step(4), step(4), step(2)]));
  const modified = structuredClone(f.capture), observed = object(modified.payload.reportObservation);
  observed.diagnostics = []; observed.report.diagnostics = [];
  const capture = resign(modified), result = assessCoworkerCapture(capture, { ...f.request, captureDigest: capture.digest });
  const finding = result.findings.find(item => item.ruleId === "step-integrity")!;
  assert.equal(finding.status, "triggered"); assert.equal(finding.references.count, 2);
  assert.ok(result.requests.some(item => item.kind === "inspect_step_order"));
});

test("serving failures, skipped updates, checkpoint negatives and aborts become different diagnostic requests", async t => {
  const data = { ...report([step(0, { optimizer_step_applied: false, post_update_serve_ok: false,
    checkpoint: { full_training_state: true, round_trip_verified: false } })]), aborted: { reason: "private producer detail" } };
  const f = await fixture(t, data), result = assessCoworkerCapture(f.capture, f.request);
  assert.deepEqual(result.requests.filter(item => item.priority !== "evidence").map(item => item.kind),
    ["inspect_serving", "inspect_optimizer", "verify_checkpoint", "inspect_abort"]);
  assert.equal(result.findings.find(item => item.ruleId === "optimizer-activity")?.severity, "warning");
  assert.doesNotMatch(JSON.stringify(result), /private producer detail/u);
  assert.equal(result.interventionAuthorized, false); assert.equal(f.ledger().listRuns().length, 0);
});

test("missing fields and reports remain unassessable rather than zero, healthy or completed", async t => {
  const f = await fixture(t, report([{ step_index: 0 } as ReturnType<typeof step>]));
  const result = assessCoworkerCapture(f.capture, f.request);
  for (const ruleId of ["numerical-integrity", "serving-consistency", "optimizer-activity"]) {
    assert.equal(result.findings.find(item => item.ruleId === ruleId)?.status, "not_assessable");
  }
  assert.deepEqual(result.coverage.metrics, {});
  assert.equal(result.outcome, "additional_evidence_required");
  const missing = await captureCoworkerReport(f.ledger(), { captureId: "missing", projectId: "study", root: f.root, reportPath: "missing/report.json", observedAt: time });
  const absent = assessCoworkerCapture(missing, { projectId: "study", captureId: "missing", captureDigest: missing.digest });
  assert.equal(absent.coverage.reportSha256, null); assert.equal(absent.requests[0]?.kind, "inspect_report");
  assert.equal(absent.outcome, "additional_evidence_required");
  assert.equal(absent.packet.checks.find(check => check.id === "report-readable")?.status, "unknown");
});

test("a malformed report produces a source-inspection request rather than fabricated metrics", async t => {
  const f = await fixture(t, '{"config":{},"steps":['), result = assessCoworkerCapture(f.capture, f.request);
  assert.equal(result.coverage.stepEntries, 0); assert.equal(result.coverage.diagnosticCounts.invalid_json, 1);
  assert.equal(result.packet.checks.find(check => check.id === "report-readable")?.status, "failed");
});

test("old timestamps cannot trigger cancellation or claim a stalled current worker", async t => {
  const f = await fixture(t); const altered = structuredClone(f.capture), observed = object(altered.payload.reportObservation);
  const previousWarnings = observed.diagnostics.filter((item: { code: string }) => item.code === "stale_report_observation").length;
  observed.observationAgeMs = 10_000_000;
  observed.diagnostics.push({ code: "stale_report_observation", field: "report.json", severity: "warning", message: "Old historical source" });
  const capture = resign(altered), result = assessCoworkerCapture(capture, { ...f.request, captureDigest: capture.digest });
  assert.equal(result.outcome, "additional_evidence_required");
  assert.ok(result.requests.every(item => !/cancel|restart|retry/u.test(item.kind)));
  assert.equal(result.coverage.diagnosticCounts.stale_report_observation, previousWarnings + 1);
});

test("exact capture identity and digest are required", async t => {
  const f = await fixture(t);
  for (const patch of [{ projectId: "other" }, { captureId: "other" }, { captureDigest: "0".repeat(64) }]) {
    assert.throws(() => assessCoworkerCapture(f.capture, { ...f.request, ...patch }));
  }
  const modified = structuredClone(f.capture); modified.observedAt = "2026-11-03T12:00:00.000Z";
  assert.throws(() => assessCoworkerCapture(modified, f.request), /digest/u);
});

test("rehashed records still cannot substitute reader inventory, report path or original-run authority", async t => {
  const f = await fixture(t);
  const patches: Array<(payload: Record<string, any>) => void> = [
    payload => { payload.reader.sourceFiles[0].sha256 = "0".repeat(64); },
    payload => { payload.reportObservation.reportReference.path = "other/report.json"; },
    payload => { payload.originalRun.execution = "running"; },
    payload => { payload.originalRun.partialProducerConfiguration = { ...payload.originalRun.partialProducerConfiguration, trainingSeed: 999 }; },
    payload => { payload.reportObservation.report.steps[0].metrics.reward = 1; },
    payload => { payload.reportObservation.report.steps[0].optimizerStepApplied = [false]; },
    payload => { payload.reportObservation.diagnostics = []; },
  ];
  for (const patch of patches) {
    const changed = structuredClone(f.capture); patch(changed.payload);
    const capture = resign(changed);
    assert.throws(() => assessCoworkerCapture(capture, { ...f.request, captureDigest: capture.digest }));
  }
});

test("input getters are not executed and returned assessments cannot drift with caller mutation", async t => {
  const f = await fixture(t); let calls = 0;
  assert.throws(() => assessCoworkerCapture({ ...f.capture, get digest() { calls++; return f.capture.digest; } }, f.request));
  assert.equal(calls, 0);
  const capture = structuredClone(f.capture), result = assessCoworkerCapture(capture, f.request), savedDigest = result.digest;
  object(capture.payload.reportObservation).report.steps[0].metrics.loss = 999;
  assert.equal(result.coverage.metrics.loss?.max, 1); assert.equal(result.digest, savedDigest);
});

test("cached model approval cannot overrule unknown evaluation or failed numerical checks", async t => {
  const f = await fixture(t, JSON.stringify(report([step(0, { loss: 999 })])).replace('"loss":999', '"loss":NaN'));
  const assessment = assessCoworkerCapture(f.capture, f.request);
  const council = await runCouncil({ councilId: "offline-assessment", packet: assessment.packet, reviewers: [{ id: "methods", role: "methods" }], maxRevisions: 0,
    review: async ({ reviewer, packet, round }) => ({ schemaVersion: 1, reviewerId: reviewer.id, packetDigest: packet.digest, round,
      recommendation: "approve", observations: [], interpretations: [], objections: [], resolutions: [],
      criteria: packet.requiredCriteria.map(criterionId => ({ criterionId, status: "satisfied", summary: "Synthetic approval fixture.", evidenceIds: ["capture:assessment-scope"] })),
      rationale: { text: "Synthetic cached approval fixture.", evidenceIds: ["capture:assessment-scope"] } }) });
  assert.equal(council.status, "blocked");
  assert.ok(council.blockers.includes("Independent check numerical-integrity is failed"));
  assert.ok(council.blockers.includes("Independent check independent-evaluation-available is unknown"));
});

test("archive repeats and reopening recover one identical assessment without changing run authority", async t => {
  const f = await fixture(t); const first = archiveCoworkerAssessment(f.ledger(), f.request);
  f.reopen(); const repeated = archiveCoworkerAssessment(f.ledger(), f.request);
  assert.deepEqual(repeated, first); assert.equal(first.source, "coworker-capture-assessment.v1");
  assert.equal(first.runId, null); assert.equal(first.actionId, null); assert.equal(first.jobId, null);
  assert.equal(f.ledger().listObservations("study").length, 2); assert.equal(f.ledger().listRuns().length, 0);
  assert.equal(f.ledger().listActions().length, 0); assert.equal(f.ledger().getScope("global").stopped, false);
  assert.ok(Object.isFrozen(repeated.payload));
});

test("new captures produce distinct assessments and conflicting existing receipts are rejected", async t => {
  const f = await fixture(t), first = archiveCoworkerAssessment(f.ledger(), f.request);
  await writeFile(join(f.root, "report.json"), JSON.stringify(report([step(9)])));
  const later = await captureCoworkerReport(f.ledger(), { captureId: "later", projectId: "study", root: f.root, reportPath: "report.json", observedAt: time });
  const second = archiveCoworkerAssessment(f.ledger(), { projectId: "study", captureId: later.eventId, captureDigest: later.digest });
  assert.notEqual(second.eventId, first.eventId);
  const forged = structuredClone(first); forged.payload = { replacement: true } as JsonObject;
  assert.throws(() => archiveCoworkerAssessment({ getObservation: eventId => eventId === first.eventId ? resign(forged) : f.ledger().getObservation(eventId),
    appendObservation: () => { throw new Error("must not append"); } }, f.request), /conflict/u);
});
