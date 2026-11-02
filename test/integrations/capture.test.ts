import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { openExperimentLedger } from '../../src/ledger/index.ts';
import type { ExperimentLedger, JsonObject, JsonValue, ObservationRecord } from '../../src/ledger/types.ts';
import { captureCoworkerReport, CoworkerCaptureConflict } from '../../src/integrations/coworker/capture.ts';

function object(value: JsonValue | undefined): JsonObject {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value;
}

function report(loss = 0.25) {
  return JSON.stringify({
    config: { steps: 2, training_seed: 7, endpoint: 'https://private.invalid/credential', api_key: 'not-for-the-ledger' },
    runtime_source_sha: 'c'.repeat(40), source_tree_digest: 'd'.repeat(64),
    spend_usd_basis: 'estimated_training_process_gpu_spend; not total pod billing',
    steps: [{ step_index: 0, loss, grad_norm: 0.4, spend_usd: 0.01 }],
  });
}

async function setup(t: TestContext) {
  const temporary = await mkdtemp(join(tmpdir(), 'coworker-capture-'));
  const root = join(temporary, 'project');
  const path = join(temporary, 'ledger.sqlite');
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git', 'HEAD'), 'a'.repeat(40));
  const source = join(root, 'experiments', 'coworkerl-v2', 'pyproject.toml');
  await mkdir(join(root, 'experiments', 'coworkerl-v2'), { recursive: true });
  await writeFile(source, '[project]\nname="fixture-v1"\n');
  const reportFile = join(root, 'report.json');
  await writeFile(reportFile, report());
  await utimes(reportFile, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  let ledger: ExperimentLedger = openExperimentLedger({ path });
  t.after(async () => { ledger.close(); await rm(temporary, { recursive: true, force: true }); });
  return {
    root, source, reportFile, get ledger() { return ledger; },
    reopen() { ledger.close(); ledger = openExperimentLedger({ path }); return ledger; },
    request: { captureId: 'capture-1', projectId: 'coworker', root, reportPath: 'report.json', observedAt: '2026-01-02T00:00:00.000Z' },
  };
}

test('capture archives source provenance and original-run gaps without registering execution or billing facts', async t => {
  const fixture = await setup(t);
  const captured = await captureCoworkerReport(fixture.ledger, fixture.request);
  assert.equal(captured.runId, null);
  assert.equal(captured.actionId, null);
  assert.equal(captured.jobId, null);
  assert.equal(captured.sequence, 0);
  assert.equal(captured.payload.ordering, 'unordered_file_snapshot');
  assert.equal(object(captured.payload.currentCheckout).revision, 'a'.repeat(40));
  const originalRun = object(captured.payload.originalRun);
  assert.equal(object(originalRun.producerReportedSource).runtimeRevision, 'c'.repeat(40));
  assert.equal(originalRun.manifestDigest, null);
  assert.equal(originalRun.registration, 'unregistered');
  assert.equal(originalRun.execution, 'unknown');
  assert.equal(originalRun.allocation, 'unknown');
  assert.equal(originalRun.billingSettlement, 'unknown');
  assert.equal(originalRun.scientificEvaluation, 'unassessed');
  assert.ok(Array.isArray(originalRun.missingManifestFields) && originalRun.missingManifestFields.length >= 8);
  const reader = object(captured.payload.reader);
  assert.equal(reader.version, 'coworker-report-capture.v1');
  assert.match(String(reader.sourceDigest), /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(captured), /private\.invalid|not-for-the-ledger/u);
  assert.equal(fixture.ledger.listActions().length, 0);
  assert.deepEqual(fixture.reopen().getObservation('capture-1'), captured);
});

test('retry after reopen returns the original observation even when report and current source disappear', async t => {
  const fixture = await setup(t);
  const captured = await captureCoworkerReport(fixture.ledger, fixture.request);
  await rm(fixture.reportFile);
  await rm(fixture.source);
  const retry = await captureCoworkerReport(fixture.reopen(), { ...fixture.request, observedAt: '2026-02-01T00:00:00.000Z' });
  assert.deepEqual(retry, captured);
  assert.equal(fixture.ledger.listObservations('coworker').length, 1);
  retry.payload.ordering = 'caller mutation';
  assert.equal(fixture.ledger.getObservation('capture-1')?.payload.ordering, 'unordered_file_snapshot');
});

test('a new capture ID observes changed report and current source without replacing historical evidence', async t => {
  const fixture = await setup(t);
  const first = await captureCoworkerReport(fixture.ledger, fixture.request);
  await writeFile(fixture.reportFile, report(0.1));
  await writeFile(fixture.source, '[project]\nname="fixture-v2"\n');
  const second = await captureCoworkerReport(fixture.ledger, { ...fixture.request, captureId: 'capture-2' });
  const firstReference = object(object(first.payload.reportObservation).reportReference);
  const secondReference = object(object(second.payload.reportObservation).reportReference);
  assert.notEqual(firstReference.sha256, secondReference.sha256);
  assert.notDeepEqual(object(first.payload.currentCheckout).files, object(second.payload.currentCheckout).files);
  assert.equal(object(second.payload.originalRun).execution, 'unknown');
  assert.equal(fixture.ledger.listObservations('coworker').length, 2);
  assert.deepEqual(fixture.ledger.getObservation('capture-1'), first);
});

test('capture IDs cannot be reused for another project, report path, root or observation type', async t => {
  const fixture = await setup(t);
  await captureCoworkerReport(fixture.ledger, fixture.request);
  const otherRoot = join(fixture.root, 'other');
  await mkdir(otherRoot);
  for (const change of [{ projectId: 'another-project' }, { reportPath: 'another/report.json' }, { root: otherRoot }]) {
    await assert.rejects(captureCoworkerReport(fixture.ledger, { ...fixture.request, ...change }), CoworkerCaptureConflict);
  }
  fixture.ledger.appendObservation({ eventId: 'foreign', projectId: 'coworker', runId: null, actionId: null, jobId: null,
    source: 'another-adapter', sequence: 0, observedAt: fixture.request.observedAt, payload: {} });
  await assert.rejects(captureCoworkerReport(fixture.ledger, { ...fixture.request, captureId: 'foreign' }), CoworkerCaptureConflict);
});

test('concurrent same-ID captures keep the first committed snapshot and request mutation cannot redirect a read', async t => {
  const fixture = await setup(t);
  const mutable = { ...fixture.request };
  const pending = captureCoworkerReport(fixture.ledger, mutable);
  mutable.reportPath = '../secret/report.json';
  mutable.projectId = 'changed-after-call';
  const concurrent = captureCoworkerReport(fixture.ledger, { ...fixture.request, observedAt: '2026-03-01T00:00:00.000Z' });
  const [first, second] = await Promise.all([pending, concurrent]);
  assert.deepEqual(first, second);
  assert.equal(first.projectId, 'coworker');
  assert.equal(fixture.ledger.listObservations('coworker').length, 1);
});

test('missing reports are archived as missing observations with no fabricated manifest or state', async t => {
  const fixture = await setup(t);
  await rm(fixture.reportFile);
  const captured: ObservationRecord = await captureCoworkerReport(fixture.ledger, fixture.request);
  const observation = object(captured.payload.reportObservation);
  assert.equal(observation.report, null);
  assert.equal(observation.reportReference, null);
  assert.match(JSON.stringify(observation.diagnostics), /report_missing/u);
  assert.equal(object(captured.payload.originalRun).manifestDigest, null);
  await assert.rejects(captureCoworkerReport(fixture.ledger, { ...fixture.request, captureId: 'invalid-path', reportPath: '../report.json' }), /without traversal/u);
});

test('an oversized sanitized projection fails without truncating evidence or creating a partial capture', async t => {
  const fixture = await setup(t);
  const steps = Array.from({ length: 12_000 }, (_, step_index) => ({ step_index, loss: 0.25, grad_norm: 0.4 }));
  await writeFile(fixture.reportFile, JSON.stringify({ config: {}, steps }));
  await assert.rejects(captureCoworkerReport(fixture.ledger, fixture.request), /Record exceeds 2 MiB/u);
  assert.equal(fixture.ledger.getObservation('capture-1'), null);
});
