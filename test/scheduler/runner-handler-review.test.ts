import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { openExperimentLedger } from '../../src/ledger/index.ts';
import { createEvidencePacket } from '../../src/research/index.ts';
import { createResearchTaskHandlers } from '../../src/scheduler/handlers.ts';
import { openTaskQueue } from '../../src/scheduler/index.ts';
import { enqueueResearchTask, ledgerAuthority, registerResearchHandlers, runNextResearchTask } from '../../src/scheduler/runner.ts';
import type { JsonObject } from '../../src/ledger/types.ts';
import type { CliTask, CliTaskResult } from '../../src/workers/cli.ts';

const packet = createEvidencePacket({ schemaVersion: 1, packetId: 'review-fixture', revision: 1,
  question: 'Does historical loss establish success?', proposal: 'Assess missing evidence.', createdAt: '2026-11-02T00:00:00.000Z',
  requiredCriteria: ['evaluation'], evidence: [{ id: 'history', kind: 'artifact', locator: 'fixture', version: 'v1', summary: 'Historical loss only.' }], checks: [] });
const completed = (): CliTaskResult => ({ backend: 'codex', status: 'succeeded', billing: 'client_managed_account', text: JSON.stringify({
  schemaVersion: 1, reviewerId: 'methods', packetDigest: packet.digest, round: 0, recommendation: 'reject',
  observations: [{ text: 'No evaluation is supplied.', evidenceIds: ['history'] }], interpretations: [],
  criteria: [{ criterionId: 'evaluation', status: 'unsatisfied', summary: 'Missing evaluation.', evidenceIds: ['history'] }],
  objections: [], resolutions: [], rationale: { text: 'A loss snapshot does not establish success.', evidenceIds: ['history'] },
}) });

async function setup(t: TestContext, review: (task: CliTask) => Promise<CliTaskResult>) {
  const directory = await mkdtemp(join(tmpdir(), 'runner-handler-review-'));
  const ledger = openExperimentLedger({ path: join(directory, 'ledger.sqlite') });
  const queue = openTaskQueue({ path: join(directory, 'queue.sqlite'), authority: projectId => ledgerAuthority(ledger, projectId) });
  t.after(async () => { queue.close(); ledger.close(); await rm(directory, { recursive: true, force: true }); });
  const handlers = createResearchTaskHandlers({ ledger, projects: { study: { root: '/trusted/project', summaryDirectory: '/trusted/summary' } }, review });
  registerResearchHandlers(queue, handlers);
  for (const scopeId of ['global', 'project:study']) queue.configureBudget({ scopeId, expectedVersion: 0, maxCalls: 10, maxParallel: 1 });
  const enqueue = (taskId: string) => enqueueResearchTask(queue, handlers, { taskId, projectId: 'study', kind: 'cli-review-codex', handlerVersion: '1',
    input: { packet: packet as unknown as JsonObject, reviewer: { id: 'methods', role: 'Assess validity.' }, model: null }, dependencies: [], maxAttempts: 2,
    notBefore: new Date(Date.now() - 1000).toISOString(), deadlineAt: new Date(Date.now() + 30_000).toISOString() });
  return { ledger, queue, handlers, enqueue };
}

test('a known review completion during stop cleanup grace is retained with its negative verdict', async t => {
  let invoked = 0;
  let stop!: () => void;
  const fixture = await setup(t, async task => {
    invoked++;
    return new Promise(resolve => {
      task.signal!.addEventListener('abort', () => resolve(completed()), { once: true });
      stop();
    });
  });
  stop = () => fixture.ledger.stopScope({ scopeId: 'global', expectedEpoch: fixture.ledger.getScope('global').epoch, reason: 'fixture stop' });
  fixture.enqueue('review-one');
  const result = await runNextResearchTask(fixture.queue, fixture.handlers, { workerId: 'worker', maxExecutionMs: 1000, cleanupGraceMs: 100, authorityCheckMs: 5 });
  assert.equal(result?.state, 'completed');
  assert.equal(invoked, 1);
  assert.equal(fixture.queue.getBudget('global').activeAttempts, 0);
  assert.equal(fixture.ledger.getScope('global').stopped, true);
  assert.equal(((result!.result!.reviewOutcome as JsonObject).review as JsonObject).recommendation, 'reject');
});

test('an unresponsive invocation retains its slot after grace and its late result cannot overwrite uncertainty', async t => {
  let invoked = 0;
  let aborted = false;
  let late!: (result: CliTaskResult) => void;
  const fixture = await setup(t, async task => {
    invoked++; task.signal!.addEventListener('abort', () => { aborted = true; }, { once: true });
    return new Promise(resolve => { late = resolve; });
  });
  fixture.enqueue('review-one'); fixture.enqueue('review-two');
  const result = await runNextResearchTask(fixture.queue, fixture.handlers, { workerId: 'worker', maxExecutionMs: 10, cleanupGraceMs: 10, authorityCheckMs: 5 });
  assert.equal(result?.state, 'uncertain');
  assert.equal(aborted, true);
  assert.equal(fixture.queue.getBudget('global').activeAttempts, 1);
  late(completed());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.queue.getTask('review-one').state, 'uncertain');
  assert.equal(await runNextResearchTask(fixture.queue, fixture.handlers, { workerId: 'worker' }), null);
  assert.equal(invoked, 1);
});

test('pre-cancelled runner leaves invocation allowance untouched and quota holds block sibling reviews', async t => {
  let invoked = 0;
  const fixture = await setup(t, async () => { invoked++; return { backend: 'codex', status: 'rate_limited', billing: 'client_managed_account', text: '' }; });
  fixture.enqueue('review-one'); fixture.enqueue('review-two');
  const controller = new AbortController(); controller.abort();
  assert.equal(await runNextResearchTask(fixture.queue, fixture.handlers, { workerId: 'worker', signal: controller.signal }), null);
  assert.equal(fixture.queue.getBudget('global').consumedCalls, 0);
  const result = await runNextResearchTask(fixture.queue, fixture.handlers, { workerId: 'worker' });
  assert.equal(result?.state, 'waiting_quota');
  assert.equal(fixture.queue.getResourceHold('codex:default')?.retryAt, null);
  assert.equal(await runNextResearchTask(fixture.queue, fixture.handlers, { workerId: 'worker' }), null);
  assert.equal(invoked, 1);
});
