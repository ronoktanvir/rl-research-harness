import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { createEvidencePacket } from '../../src/research/index.ts';
import { openConfiguredHarness, parseHarnessConfig } from '../../src/scheduler/config.ts';
import { enqueueResearchTask } from '../../src/scheduler/runner.ts';
import type { JsonObject } from '../../src/ledger/types.ts';

const execute = promisify(execFile);

test('bounded JSON rejects a FIFO before waiting for a writer', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'config-fifo-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pipe = join(directory, 'request.json');
  await execute('mkfifo', [pipe]);
  const moduleUrl = new URL('../../src/scheduler/config.ts', import.meta.url).href;
  const code = `import { readBoundedJson } from ${JSON.stringify(moduleUrl)};
try { await readBoundedJson(process.argv[1]); process.exitCode=2; }
catch(error) { if (!String(error.message).includes('regular JSON')) throw error; console.log('rejected'); }`;
  // Subprocess timeout bounds the regression even if open() accidentally blocks again.
  const result = await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, pipe], { timeout: 5000 });
  assert.match(result.stdout, /rejected/u);
});

test('queue-run SIGTERM persists global stop before cancelling a synthetic official-client process', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'command-stop-review-'));
  let child: ReturnType<typeof spawn> | undefined;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await rm(directory, { recursive: true, force: true });
  });
  const marker = join(directory, 'fake-review-invoked');
  const executable = join(directory, 'codex');
  // This fake executable reads no account files and makes no network/provider call.
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  console.log('Logged in using ChatGPT');
} else {
  fs.appendFileSync(${JSON.stringify(marker)}, 'synthetic invocation\\n');
  console.log(JSON.stringify({type:'thread.started',thread_id:'synthetic'}));
  process.stdin.resume();
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
}
`);
  await chmod(executable, 0o700);
  const raw = { schemaVersion: 1, ledgerPath: 'ledger.sqlite', queuePath: 'queue.sqlite', workerId: 'fixture-worker',
    limits: { maxClientInvocations: 5, maxParallel: 1 }, projects: { study: { root: directory,
      summaryDirectory: join(directory, 'summary'), limits: { maxClientInvocations: 5, maxParallel: 1 } } } };
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify(raw));
  const config = parseHarnessConfig(raw, directory);
  const prepared = openConfiguredHarness(config);
  const packet = createEvidencePacket({ schemaVersion: 1, packetId: 'signal-fixture', revision: 1,
    question: 'What is missing?', proposal: 'Inspect supplied evidence.', createdAt: new Date().toISOString(), requiredCriteria: ['validity'],
    evidence: [{ id: 'fixture', kind: 'artifact', locator: 'fixture', version: 'v1', summary: 'Synthetic test evidence.' }], checks: [] });
  try {
    for (const taskId of ['first-review', 'second-review']) enqueueResearchTask(prepared.queue, prepared.handlers, { taskId,
      projectId: 'study', kind: 'cli-review-codex', handlerVersion: '1', dependencies: [], maxAttempts: 1,
      notBefore: new Date(Date.now() - 1000).toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      input: { packet: packet as unknown as JsonObject, reviewer: { id: 'methods', role: 'Assess fixture.' }, model: null } });
  } finally { prepared.close(); }
  const cli = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
  child = spawn(process.execPath, ['--import', 'tsx', cli, 'queue-run', configPath, '10'], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout!.on('data', data => { stdout += String(data); });
  child.stderr!.on('data', data => { stderr += String(data); });
  const readyDeadline = Date.now() + 10_000;
  while (true) {
    try { await access(marker); break; } catch { /* Wait for the synthetic review to start. */ }
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > readyDeadline) throw new Error(`Fixture did not start: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => { child!.kill('SIGKILL'); reject(new Error('Runner did not stop')); }, 10_000); })]); }
  finally { if (timer) clearTimeout(timer); }
  assert.equal(child.exitCode, 2, stderr);
  assert.equal(JSON.parse(stdout).stopPersisted, true);
  const reopened = openConfiguredHarness(config);
  try {
    assert.equal(reopened.ledger.getScope('global').stopped, true);
    assert.equal(reopened.queue.getTask('first-review').state, 'uncertain');
    assert.equal(reopened.queue.getTask('second-review').state, 'queued');
    assert.equal(reopened.queue.getBudget('global').consumedCalls, 1);
    assert.equal(reopened.queue.getBudget('global').activeAttempts, 1);
  } finally { reopened.close(); }
  assert.equal((await readFile(marker, 'utf8')).match(/synthetic invocation/gu)?.length, 1);
});
