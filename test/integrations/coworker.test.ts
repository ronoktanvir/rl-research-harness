import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { inspectCoworkerProject, inspectCoworkerRun, parseCoworkerReport } from '../../src/integrations/coworker/index.ts';
import { readProjectFile } from '../../src/integrations/coworker/files.ts';

// Fictional observations using only the producer's field names; no private run data.
function fixture() {
  return {
    config: { steps: 2, step_index_start: 0, training_seed: 7, endpoint: 'https://credential.invalid/secret', api_key: 'do-not-return' },
    runtime_source_sha: 'a'.repeat(40), source_tree_digest: 'b'.repeat(64), base_revision: 'c'.repeat(40),
    spend_usd_basis: 'estimated_training_process_gpu_spend; not total pod billing',
    steps: [{ step_index: 0, loss: 0.25, grad_norm: 0.5, optimizer_updates: 1, optimizer_step_applied: true,
      elapsed_seconds: 20, spend_usd: 0.01, post_update_serve_ok: true,
      groups: { groups_formed: 2, groups_discarded: 0, episodes_trained: 8 },
      loss_decomposition: { entropy: 0.7, approx_kl: 0.01, clipfrac: 0.1 },
      checkpoint: { full_training_state: true, round_trip_verified: true, adapter_sha256: 'd'.repeat(64), dir: '/private/checkpoint' } }],
  };
}

test('projects retain source references without importing Python or returning configuration secrets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coworker-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(root, '.git', 'refs', 'heads', 'main'), 'a'.repeat(40));
  const config = join(root, 'experiments/coworkerl-v2/src/probing/configs');
  await mkdir(config, { recursive: true });
  await writeFile(join(config, 'selection_manifest.json'), JSON.stringify({
    schema: 'coworkerl-v2-selection-manifest', selections: { training_development: ['one', 'two'], heldout_review: ['three'] },
  }));
  const result = await inspectCoworkerProject(root);
  assert.equal(result.revision, 'a'.repeat(40));
  assert.equal(result.workingTreeState, 'not_assessed');
  assert.deepEqual(result.selections, [{ name: 'training_development', configurationCount: 2 }, { name: 'heldout_review', configurationCount: 1 }]);
  assert.equal(result.files[0]?.sha256.length, 64);
  assert.equal(result.capabilities.launch, false);
  assert.ok(result.missingOrUnreadable.some(item => item.path.endsWith('fit_loop.py')));
});

test('report parsing preserves observed metrics and does not infer job completion or expose arbitrary text', () => {
  const parsed = parseCoworkerReport(JSON.stringify(fixture()));
  assert.equal(parsed.format, 'coworkerl-fit-loop');
  assert.equal(parsed.steps[0]?.metrics['loss_decomposition.entropy'], 0.7);
  assert.equal(parsed.steps[0]?.metrics.reward, undefined);
  assert.equal(parsed.steps[0]?.checkpointReported.fullTrainingState, true);
  assert.equal(parsed.executionState, 'unknown');
  assert.equal(parsed.spendMeaning, 'producer_declared_training_process_gpu_estimate');
  assert.doesNotMatch(JSON.stringify(parsed), /credential\.invalid|do-not-return|\/private\/checkpoint/u);
});

test('legacy reports keep missing optimizer and checkpoint capabilities unknown', () => {
  const parsed = parseCoworkerReport(JSON.stringify({ config: {}, steps: [{ step_index: 29, loss: 0.2, grad_norm: 0.4, spend_usd: 30 }] }));
  assert.equal(parsed.steps[0]?.optimizerStepApplied, null);
  assert.equal(parsed.steps[0]?.checkpointReported.fullTrainingState, null);
  assert.equal(parsed.steps[0]?.metrics.optimizer_updates, undefined);
  assert.equal(parsed.spendMeaning, 'unspecified');
  assert.equal(parsed.executionState, 'unknown');
});

test('Python nonfinite literals are errors without corrupting quoted strings or inventing zeros', () => {
  const text = '{"config":{"endpoint":"NaN Infinity -Infinity"},"steps":[{"step_index":0,"loss":NaN,"grad_norm":Infinity,"elapsed_seconds":-Infinity,"rows":1e309}]}';
  const parsed = parseCoworkerReport(text);
  assert.equal(parsed.format, 'coworkerl-fit-loop');
  assert.equal(parsed.diagnostics.filter(d => d.code === 'nonfinite_metric').length, 4);
  assert.deepEqual(parsed.steps[0]?.metrics, {});
  assert.equal(parsed.configuration.plannedSteps, null);
});

test('truncated JSON and unrelated reports return no fabricated metrics', () => {
  assert.equal(parseCoworkerReport('{"config":{},"steps":[').diagnostics[0]?.code, 'invalid_json');
  assert.equal(parseCoworkerReport('{"steps":[]}').format, 'unsupported');
  const empty = parseCoworkerReport('{"config":{},"steps":[]}');
  assert.ok(empty.diagnostics.some(d => d.code === 'no_step_observations'));
});

test('duplicate and reordered steps remain visible, and absent metrics are diagnosed', () => {
  const parsed = parseCoworkerReport(JSON.stringify({ config: {}, steps: [{ step_index: 2 }, { step_index: 2 }, { step_index: 1 }] }));
  assert.deepEqual(parsed.steps.map(step => step.stepIndex), [2, 2, 1]);
  assert.ok(parsed.diagnostics.some(d => d.code === 'duplicate_step'));
  assert.ok(parsed.diagnostics.some(d => d.code === 'out_of_order_step'));
  assert.ok(parsed.diagnostics.some(d => d.code === 'missing_metric'));
});

test('old report observations warn about freshness without labeling a historical run failed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coworker-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'report.json');
  const bytes = JSON.stringify(fixture());
  await writeFile(file, bytes);
  const modified = new Date('2026-01-01T00:00:00Z');
  await utimes(file, modified, modified);
  const result = await inspectCoworkerRun(root, 'report.json', { now: new Date('2026-01-01T00:01:00Z'), staleAfterMs: 1000 });
  assert.equal(result.observationAgeMs, 60_000);
  assert.ok(result.diagnostics.some(d => d.code === 'stale_report_observation'));
  assert.equal(result.report?.executionState, 'unknown');
  assert.equal(await readFile(file, 'utf8'), bytes);
  assert.equal(result.reportReference?.bytes, Buffer.byteLength(bytes));
});

test('missing reports, path traversal, links and non-report inputs fail closed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coworker-paths-'));
  const outside = await mkdtemp(join(tmpdir(), 'coworker-outside-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  await writeFile(join(outside, 'report.json'), JSON.stringify(fixture()));
  await symlink(join(outside, 'report.json'), join(root, 'report.json'));
  await symlink(outside, join(root, 'linked'));
  assert.equal((await inspectCoworkerRun(root, 'report.json')).diagnostics[0]?.code, 'report_unsafe_path');
  assert.equal((await inspectCoworkerRun(root, 'linked/report.json')).diagnostics[0]?.code, 'report_unsafe_path');
  assert.equal((await inspectCoworkerRun(root, '../report.json')).diagnostics[0]?.code, 'report_unsafe_path');
  assert.equal((await inspectCoworkerRun(root, 'missing/report.json')).diagnostics[0]?.code, 'report_missing');
  assert.equal((await inspectCoworkerRun(root, '.env')).diagnostics[0]?.code, 'unsupported_report_path');
});

test('oversized report reads are refused and invalid clocks do not hide staleness', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coworker-large-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'report.json'), ' '.repeat(16 * 1024 * 1024 + 1));
  assert.equal((await inspectCoworkerRun(root, 'report.json')).diagnostics[0]?.code, 'report_too_large');
  await assert.rejects(inspectCoworkerRun(root, 'report.json', { staleAfterMs: NaN }), /must be finite/u);
});

test('directory replacement cannot redirect the descriptor-relative reader outside the project', async () => {
  // Instrument the trusted helper's actual os.open calls, without a production test hook.
  // Swap immediately before opening an ancestor, then immediately after pinning it.
  const script = `
import base64, importlib.util, json, os, sys, tempfile
spec = importlib.util.spec_from_file_location("reader_under_test", sys.argv[1])
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
original_open = os.open
results = []
for timing in ("before", "after"):
    with tempfile.TemporaryDirectory(prefix="coworker-swap-") as temporary:
        temporary = os.path.realpath(temporary)
        root = os.path.join(temporary, "root")
        outside = os.path.join(temporary, "outside")
        os.mkdir(root)
        os.mkdir(outside)
        ancestor = os.path.join(root, "runs")
        os.mkdir(ancestor)
        with open(os.path.join(ancestor, "report.json"), "wb") as file:
            file.write(b"inside-fixture")
        with open(os.path.join(outside, "report.json"), "wb") as file:
            file.write(b"outside-private-fixture")
        swapped = [False]
        def swap():
            os.rename(ancestor, os.path.join(root, "displaced"))
            os.symlink(outside, ancestor)
            swapped[0] = True
        def racing_open(path, flags, mode=0o777, *, dir_fd=None):
            target = path == "runs" and not swapped[0]
            if target and timing == "before":
                swap()
            descriptor = original_open(path, flags, mode, dir_fd=dir_fd)
            if target and timing == "after":
                swap()
            return descriptor
        os.supports_dir_fd.add(racing_open)
        os.open = racing_open
        try:
            result = reader.read_file(root, "runs/report.json", 1024)
        finally:
            os.open = original_open
            os.supports_dir_fd.remove(racing_open)
        if result.get("ok"):
            result["text"] = base64.b64decode(result.pop("data")).decode()
        results.append({"timing": timing, "swapped": swapped[0], "result": result})
print(json.dumps(results))
`;
  const helper = fileURLToPath(new URL('../../src/integrations/coworker/read_file.py', import.meta.url));
  const { stdout } = await promisify(execFile)('python3', ['-I', '-S', '-B', '-c', script, helper], { timeout: 10_000 });
  const results = JSON.parse(stdout);
  assert.equal(results[0].swapped, true);
  assert.deepEqual(results[0].result, { ok: false, problem: 'unsafe_path' });
  assert.equal(results[1].swapped, true);
  assert.equal(results[1].result.ok, true);
  assert.equal(results[1].result.text, 'inside-fixture');
  assert.doesNotMatch(stdout, /outside-private-fixture/u);
});

test('reader validates its root and byte limit, including root-component symlinks', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'coworker-reader-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const canonical = await realpath(temporary);
  await mkdir(join(canonical, 'root'));
  await writeFile(join(canonical, 'root', 'report.json'), '1234');
  await symlink(join(canonical, 'root'), join(canonical, 'alias'));
  assert.deepEqual(await readProjectFile('relative-root', 'report.json', 4), { ok: false, problem: 'unsafe_path' });
  assert.deepEqual(await readProjectFile(join(canonical, 'alias'), 'report.json', 4), { ok: false, problem: 'unsafe_path' });
  assert.deepEqual(await readProjectFile(join(canonical, 'root'), 'report.json', 3), { ok: false, problem: 'too_large' });
  assert.equal((await readProjectFile(join(canonical, 'root'), 'report.json', 4)).ok, true);
  await assert.rejects(readProjectFile(join(canonical, 'root'), 'report.json', Infinity), /File read limit/u);
});
