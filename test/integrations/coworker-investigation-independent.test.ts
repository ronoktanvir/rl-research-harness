import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { TestContext } from "node:test";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { hash } from "../../src/ledger/validation.ts";
import type { ObservationRecord } from "../../src/ledger/types.ts";
import { captureCoworkerReport } from "../../src/integrations/coworker/capture.ts";
import { runCoworkerInvestigation, loadCoworkerInvestigation } from "../../src/integrations/coworker/investigation.ts";
import { COWORKER_INVESTIGATION_LIMITS, prepareCoworkerInvestigationRequest, validateCoworkerInvestigationExecution } from "../../src/integrations/coworker/investigation-worker.ts";
import type { CoworkerInvestigationWorker, CoworkerInvestigationExecution, CoworkerInvestigationRequest } from "../../src/integrations/coworker/investigation-worker.ts";
import { syntheticInvestigationExecution } from "./coworker-investigation-fixtures.ts";

const time = "2026-11-02T12:00:00.000Z";
const descriptor = { name: "coworker-run1-investigation" as const, version: 1 as const, sourceSha256: "d".repeat(64), pythonExecutable: "/usr/bin/python3", timeoutMs: 1000, limits: COWORKER_INVESTIGATION_LIMITS };
const base = "artifacts/probing-helper-artifacts";

async function fixture(t: TestContext, label = "independent-b", source = "ccfd25df63f55e408b67e984710eb6d3dd9e609f") {
  const directory = await mkdtemp(join(tmpdir(), "coworker-investigation-review-")), root = join(await realpath(directory), "project");
  const reportPath = `${base}/${label}/report.json`;
  await mkdir(join(root, base, label), { recursive: true });
  await writeFile(join(root, reportPath), JSON.stringify({ runtime_source_sha: source, source_tree_digest: "b".repeat(64),
    config: { training_seed: 23, training_configs: ["synthetic-train"] }, steps: [{ step_index: 0, loss: 0.2 }] }));
  const ledger = openExperimentLedger({ path: join(directory, "ledger.sqlite"), now: () => new Date(time) });
  t.after(async () => { ledger.close(); await rm(directory, { recursive: true, force: true }); });
  const capture = await captureCoworkerReport(ledger, { projectId: "study", captureId: `capture-${label}`, root, reportPath, observedAt: time });
  const request = { projectId: "study", investigationId: `inspection-${label}`, captureId: capture.eventId, captureDigest: capture.digest,
    localArtifacts: { adapterPath: `.local-artifacts/${base}/${label}/adapter-step-0/adapter_model.safetensors`,
      trainedEvaluationDirectory: `${base}/eval-${label}/trained`, baselineEvaluationDirectory: `${base}/eval-${label}/baseline`,
      trainedTracePath: `.local-artifacts/${base}/eval-${label}/trained/step0-trace.jsonl`, baselineTracePath: `.local-artifacts/${base}/eval-${label}/baseline/step0-trace.jsonl` } };
  return { root, ledger, capture, request, reportPath };
}
function incomplete(request: CoworkerInvestigationRequest): CoworkerInvestigationExecution {
  return { schemaVersion: 1, request, descriptor, status: "incomplete", reason: "missing_file", result: null, resultSha256: null,
    observations: [{ check: "report", status: "failed", reason: "missing_file", files: [] }],
    process: { exitCode: 0, stopped: null, stdoutSha256: "a".repeat(64), stdoutBytes: 0, stderrSha256: "b".repeat(64), stderrBytes: 0 } };
}
function resign(record: ObservationRecord): ObservationRecord {
  const { digest: _digest, ...body } = record; return { ...body, digest: hash(body) };
}

test("investigation binds variable captured report identities and snapshots selected artifact paths before awaiting", async t => {
  const f = await fixture(t);
  let finish!: (value: CoworkerInvestigationExecution) => void, received!: CoworkerInvestigationRequest;
  const worker: CoworkerInvestigationWorker = { descriptor, run: request => {
    received = request; return new Promise(resolve => { finish = resolve; });
  } };
  const original = structuredClone(f.request.localArtifacts);
  const pending = runCoworkerInvestigation(f.ledger, f.request, { root: f.root, worker, now: () => new Date(time) });
  f.request.localArtifacts.trainedTracePath = "changed/after/call";
  assert.equal(received.report.path, f.reportPath);
  assert.notEqual(received.report.sha256, "8d73572a733f05bcdf9eacda9af3bb5f92394745c6cd77c00786fe245df80c5a");
  assert.notEqual(received.report.bytes, 58_876);
  assert.deepEqual(received.localArtifacts, original);
  assert.ok(Object.isFrozen(received.localArtifacts));
  finish(incomplete(received));
  const record = await pending;
  assert.equal(record.payload.status, "incomplete");
  assert.equal(record.payload.scientificEvaluation, "unassessed");
  assert.equal(record.payload.followupDisposition, "unresolved");
  assert.equal(f.ledger.listRuns().length, 0);
});

test("a different source compatibility declaration cannot silently reuse the supported historical inspection", async t => {
  const f = await fixture(t, "phase2-looking-label", "0".repeat(40)); let calls = 0;
  const worker: CoworkerInvestigationWorker = { descriptor, async run(request) { calls++; return incomplete(request); } };
  await assert.rejects(runCoworkerInvestigation(f.ledger, f.request, { root: f.root, worker }), /unsupported capture source/);
  assert.equal(calls, 0);
});

test("cached failure outcome rejects coercible enum arrays even if every changed envelope is rehashed", async t => {
  const f = await fixture(t, "coercible-outcome");
  const worker: CoworkerInvestigationWorker = { descriptor, async run() { throw new Error("fixture failure"); } };
  const record = await runCoworkerInvestigation(f.ledger, f.request, { root: f.root, worker, now: () => new Date(time) });
  const outputId = (record.payload.output as { observationId: string }).observationId;
  const output = structuredClone(f.ledger.getObservation(outputId)!);
  output.payload.outcome = ["worker_exception"];
  const changedOutput = resign(output), changedResult = structuredClone(record);
  (changedResult.payload.output as { digest: string }).digest = changedOutput.digest;
  changedResult.payload.reason = ["worker_exception"];
  const changed = new Map([[outputId, changedOutput], [record.eventId, resign(changedResult)]]);
  const archive = { getObservation: (eventId: string) => changed.get(eventId) ?? f.ledger.getObservation(eventId), appendObservation: f.ledger.appendObservation.bind(f.ledger) };
  assert.throws(() => loadCoworkerInvestigation(archive, record.eventId), /unsupported output disposition/);
});

test("completed evidence requires all six checks with file identities matching its typed result", async t => {
  const f = await fixture(t, "check-correspondence");
  const observed = f.capture.payload.reportObservation as { reportReference: { path: string; bytes: number; sha256: string } };
  const { path, bytes, sha256 } = observed.reportReference;
  const request = prepareCoworkerInvestigationRequest({ schemaVersion: 1, kind: "coworker-run1-investigation", root: f.root,
    report: { path, bytes, sha256 }, localArtifacts: f.request.localArtifacts });
  const original = syntheticInvestigationExecution(request, descriptor);
  const variants = [structuredClone(original), structuredClone(original), structuredClone(original)];
  variants[0]!.observations = [];
  variants[1]!.observations[1]!.files[0]!.sha256 = "0".repeat(64);
  variants[2]!.observations[0]!.status = "failed";
  variants[2]!.observations[0]!.reason = "missing_file";
  for (const variant of variants) assert.throws(() => validateCoworkerInvestigationExecution(variant, request, descriptor));
});
