import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { discoverArxiv } from '../../src/literature/index.ts';
import { createEvidencePacket } from '../../src/research/evidence.ts';
import { loadHarnessConfig, openConfiguredHarness } from '../../src/scheduler/config.ts';
import { feed } from '../literature/fixtures.ts';

const exec = promisify(execFile);
const workspace = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(workspace, 'src/cli.ts');
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'research-command-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configuration = join(directory, 'config.json'), guard = join(directory, 'offline-guard.mjs');
  const fetchMarker = join(directory, 'unexpected-fetch'), clientMarker = join(directory, 'unexpected-client');
  const bin = join(directory, 'bin'); await mkdir(bin);
  await writeFile(configuration, JSON.stringify({ schemaVersion: 1, ledgerPath: 'ledger.sqlite', queuePath: 'queue.sqlite', workerId: 'fixture',
    limits: { maxClientInvocations: 0, maxParallel: 1 }, projects: { study: {
      root: 'project', summaryDirectory: 'summaries', limits: { maxClientInvocations: 0, maxParallel: 1 },
    } } }));
  await writeFile(guard, `import { appendFileSync } from 'node:fs';\nglobalThis.fetch = async () => { appendFileSync(${JSON.stringify(fetchMarker)}, 'attempt\\n'); throw new Error('Offline command fixture forbids network'); };\n`);
  for (const name of ['codex', 'claude']) await writeFile(join(bin, name), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(clientMarker)}, 'attempt\\n'); process.exit(99);\n`, { mode: 0o755 });
  async function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const output = await exec(process.execPath, ['--import', guard, '--import', 'tsx', cli, ...args], {
        cwd: workspace, timeout: 15_000, env: { ...process.env, PATH: bin },
      });
      return { code: 0, ...output };
    } catch (error) {
      const result = error as Error & { code?: number; stdout?: string; stderr?: string };
      if (typeof result.code !== 'number') throw error;
      return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    }
  }
  return { directory, configuration, run, async verifyOffline() {
    await assert.rejects(access(fetchMarker)); await assert.rejects(access(clientMarker));
  } };
}

test('CLI expires a zero-allowance council and publishes a blocked bundle without invoking either client', async t => {
  const f = await fixture(t), requestPath = join(f.directory, 'council.json');
  const request = { projectId: 'study', campaignId: 'expired-fixture', packet: createEvidencePacket({
    schemaVersion: 1, packetId: 'expired-evidence', revision: 1, createdAt: '2020-01-01T00:00:00.000Z',
    question: 'Does expiration avoid invocation?', proposal: 'Exercise deterministic expiration only.', requiredCriteria: ['scope'],
    evidence: [{ id: 'fixture', kind: 'artifact', locator: 'fixture:expired', version: '1', summary: 'Synthetic CLI fixture, not a model evaluation.' }], checks: [],
  }), reviewers: [{ id: 'methods', role: 'Methods', backend: 'codex', model: null }, { id: 'critic', role: 'Critic', backend: 'claude', model: null }],
    reviser: null, maxRevisions: 0, notBefore: '2020-01-01T00:00:00.000Z', deadlineAt: '2020-01-02T00:00:00.000Z' };
  await writeFile(requestPath, JSON.stringify(request));
  const prepared = await f.run('council-prepare', f.configuration, requestPath);
  assert.equal(prepared.code, 0, prepared.stderr);
  const plan = JSON.parse(prepared.stdout);
  const outputDirectory = join(f.directory, 'decisions');
  const completed = await f.run('council-run', f.configuration, plan.planObservationId, '1', outputDirectory);
  assert.equal(completed.code, 0, completed.stderr);
  const result = JSON.parse(completed.stdout);
  assert.equal(result.progress.status, 'complete');
  assert.equal(result.progress.decision.status, 'blocked');
  assert.deepEqual(result.executed, []);
  assert.equal(JSON.parse(await readFile(result.artifacts.jsonPath, 'utf8')).status, 'blocked');
  assert.match(await readFile(result.artifacts.markdownPath, 'utf8'), /expired/u);
  const replay = await f.run('council-run', f.configuration, plan.planObservationId, '1', outputDirectory);
  assert.equal(replay.code, 0, replay.stderr);
  assert.deepEqual(JSON.parse(replay.stdout).artifacts, result.artifacts);
  const harness = openConfiguredHarness(await loadHarnessConfig(f.configuration));
  try {
    assert.equal(harness.queue.getBudget('global').consumedCalls, 0);
    assert.deepEqual(harness.queue.listTasks().map(task => task.state), ['expired', 'expired']);
  } finally { harness.close(); }
  await f.verifyOffline();
});

test('CLI exports a verified cached literature packet, reuses matching output and refuses a mismatching existing file without fetching', async t => {
  const f = await fixture(t);
  const harness = openConfiguredHarness(await loadHarnessConfig(f.configuration));
  let queryId = '', fixtureFetches = 0;
  try {
    const discovered = await discoverArxiv(harness.ledger, { projectId: 'study', discoveryId: 'offline-source', query: 'cat:cs.LG', maxResults: 1 }, {
      now: () => new Date('2026-11-01T00:00:00.000Z'),
      fetch: async () => { fixtureFetches++; return new Response(feed(), { status: 200, headers: { 'content-type': 'application/atom+xml' } }); },
    });
    assert.equal(discovered.status, 'complete'); queryId = discovered.queryObservationId;
  } finally { harness.close(); }
  assert.equal(fixtureFetches, 1);
  const requestPath = join(f.directory, 'packet-request.json'), outputPath = join(f.directory, 'evidence.json');
  await writeFile(requestPath, JSON.stringify({ packetId: 'offline-packet', question: 'What evidence remains missing?', proposal: 'Read full methods before making claims.', requiredCriteria: ['method-validity'] }));
  const first = await f.run('literature-packet', f.configuration, queryId, requestPath, outputPath);
  assert.equal(first.code, 0, first.stderr);
  const packetText = await readFile(outputPath, 'utf8'), before = await stat(outputPath);
  const packet = JSON.parse(packetText);
  assert.equal(packet.digest, JSON.parse(first.stdout).packetDigest);
  assert.ok(packet.checks.every((check: { status: string }) => check.status === 'unknown'));
  const matching = await f.run('literature-packet', f.configuration, queryId, requestPath, outputPath);
  assert.equal(matching.code, 0, matching.stderr);
  assert.equal(await readFile(outputPath, 'utf8'), packetText);
  assert.equal((await stat(outputPath)).ino, before.ino);
  const unrelated = '{"operator":"keep this different file"}\n';
  await writeFile(outputPath, unrelated);
  const mismatch = await f.run('literature-packet', f.configuration, queryId, requestPath, outputPath);
  assert.equal(mismatch.code, 1);
  assert.equal(await readFile(outputPath, 'utf8'), unrelated);
  assert.ok((await readdir(f.directory)).every(name => !name.startsWith('.packet-')));
  await f.verifyOffline();
});
