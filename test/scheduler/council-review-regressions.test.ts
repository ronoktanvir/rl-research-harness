import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { openExperimentLedger } from '../../src/ledger/index.ts';
import type { JsonObject } from '../../src/ledger/types.ts';
import { createEvidencePacket } from '../../src/research/evidence.ts';
import { createCouncilTaskHandlers } from '../../src/scheduler/council-handlers.ts';
import type { CouncilPlanRequest } from '../../src/scheduler/council-contracts.ts';
import { advanceCouncilCampaign, prepareCouncilCampaign, runCouncilCampaign } from '../../src/scheduler/council-workflow.ts';
import { openTaskQueue } from '../../src/scheduler/index.ts';
import { ledgerAuthority, registerResearchHandlers, runNextResearchTask } from '../../src/scheduler/runner.ts';
import type { CliTask, CliTaskResult } from '../../src/workers/cli.ts';

const NOW = '2030-01-01T00:00:00.000Z';
const clock = () => new Date(NOW);
function request(): CouncilPlanRequest {
  return { projectId: 'fixture-study', campaignId: 'independent-review', packet: createEvidencePacket({
    schemaVersion: 1, packetId: 'fixture-evidence', revision: 1, createdAt: NOW,
    question: 'Is this synthetic fixture limited to protocol testing?', proposal: 'Assess fixture transport only.',
    requiredCriteria: ['scope'], evidence: [{ id: 'fixture', kind: 'artifact', locator: 'fixture:input', version: '1', summary: 'Synthetic protocol evidence, not a scientific experiment.' }], checks: [],
  }), reviewers: [{ id: 'methods', role: 'Methods', backend: 'codex', model: null }, { id: 'critic', role: 'Critic', backend: 'claude', model: null }],
  reviser: null, maxRevisions: 0, notBefore: '2029-01-01T00:00:00.000Z', deadlineAt: '2031-01-01T00:00:00.000Z' };
}
function approved(task: CliTask): CliTaskResult {
  const properties = task.outputSchema!.properties as JsonObject;
  const value = (key: string) => ((properties[key] as JsonObject).enum as unknown[])[0];
  return { backend: task.backend, status: 'succeeded', billing: 'client_managed_account', text: JSON.stringify({
    schemaVersion: 1, reviewerId: value('reviewerId'), packetDigest: value('packetDigest'), round: value('round'), recommendation: 'approve',
    observations: [{ text: 'The supplied record labels itself synthetic.', evidenceIds: ['fixture'] }], interpretations: [],
    criteria: [{ criterionId: 'scope', status: 'satisfied', summary: 'The proposal stays within fixture scope.', evidenceIds: ['fixture'] }],
    objections: [], resolutions: [], rationale: { text: 'The protocol fixture has the stated scope.', evidenceIds: ['fixture'] },
  }) };
}
async function fixture(t: TestContext, execute: (task: CliTask) => Promise<CliTaskResult>) {
  const directory = await mkdtemp(join(tmpdir(), 'council-independent-review-'));
  const ledger = openExperimentLedger({ path: join(directory, 'ledger.sqlite'), now: clock });
  const queue = openTaskQueue({ path: join(directory, 'queue.sqlite'), now: clock, authority: project => ledgerAuthority(ledger, project) });
  const handlers = createCouncilTaskHandlers({ ledger, projects: ['fixture-study'], now: clock, review: execute });
  registerResearchHandlers(queue, handlers);
  for (const scopeId of ['global', 'project:fixture-study']) queue.configureBudget({ scopeId, expectedVersion: 0, maxCalls: 20, maxParallel: 4 });
  t.after(async () => { queue.close(); ledger.close(); await rm(directory, { recursive: true, force: true }); });
  return { ledger, queue, handlers };
}

test('a bounded run reconciles selected expired tasks before returning, without spending invocation allowance', async t => {
  let calls = 0;
  const { ledger, queue, handlers } = await fixture(t, async task => { calls++; return approved(task); });
  const plan = prepareCouncilCampaign(ledger, { ...request(), deadlineAt: '2029-12-31T00:00:00.000Z' }, { now: clock });
  const result = await runCouncilCampaign(ledger, queue, handlers, plan.planObservationId, 1, { workerId: 'review-fixture', now: clock });
  assert.equal(result.progress.status, 'complete');
  if (result.progress.status !== 'complete') throw new Error('Expired tasks must produce a blocked final assessment');
  assert.equal(result.progress.decision.status, 'blocked');
  assert.ok(queue.listTasks().every(task => task.state === 'expired'));
  assert.equal(result.executed.length, 0);
  assert.equal(calls, 0);
  assert.equal(queue.getBudget('global').consumedCalls, 0);
});

test('empty selections invoke nothing and malformed falsy selections cannot broaden into unrelated tasks', async t => {
  let calls = 0;
  const { ledger, queue, handlers } = await fixture(t, async task => { calls++; return approved(task); });
  const plan = prepareCouncilCampaign(ledger, request(), { now: clock });
  await advanceCouncilCampaign(ledger, queue, handlers, plan.planObservationId, { now: clock });
  assert.equal(await runNextResearchTask(queue, handlers, { workerId: 'review-fixture', now: clock, taskIds: [] }), null);
  for (const invalid of [null, false, '', 0]) await assert.rejects(runNextResearchTask(queue, handlers, {
    workerId: 'review-fixture', now: clock, taskIds: invalid as unknown as string[],
  }));
  assert.equal(calls, 0);
  assert.equal(queue.getBudget('global').consumedCalls, 0);
  assert.ok(queue.listTasks().every(task => task.state === 'queued'));
});

test('uncertain reviewer completion remains pending across advancement and never repeats a completed sibling call', async t => {
  const calls: string[] = [];
  const { ledger, queue, handlers } = await fixture(t, async task => {
    calls.push(task.backend);
    return task.backend === 'codex' ? { backend: 'codex', status: 'failed', text: '', billing: 'client_managed_account', diagnostic: 'client_did_not_complete' } : approved(task);
  });
  const plan = prepareCouncilCampaign(ledger, request(), { now: clock });
  const first = await runCouncilCampaign(ledger, queue, handlers, plan.planObservationId, 10, { workerId: 'review-fixture', now: clock });
  assert.equal(first.progress.status, 'pending');
  assert.deepEqual(calls, ['codex', 'claude']);
  assert.deepEqual(queue.listTasks().map(task => task.state), ['uncertain', 'completed']);
  const second = await runCouncilCampaign(ledger, queue, handlers, plan.planObservationId, 10, { workerId: 'review-fixture', now: clock });
  assert.deepEqual(second.progress, first.progress);
  assert.deepEqual(second.executed, []);
  assert.equal(calls.length, 2);
  assert.equal(queue.getBudget('global').activeAttempts, 1);
  assert.equal(ledger.listObservations('fixture-study').filter(record => record.source === 'durable-council-result.v1').length, 0);
});

test('cached stage identity mismatch remains an infrastructure error and cannot finalize or invoke more clients', async t => {
  let calls = 0;
  const { ledger, queue, handlers } = await fixture(t, async task => { calls++; return approved(task); });
  const plan = prepareCouncilCampaign(ledger, request(), { now: clock });
  const first = await runCouncilCampaign(ledger, queue, handlers, plan.planObservationId, 1, { workerId: 'review-fixture', now: clock });
  assert.equal(first.progress.status, 'pending');
  const getTask = queue.getTask.bind(queue);
  queue.getTask = id => {
    const task = getTask(id);
    if (task.state === 'completed' && task.result) task.result.stageDigest = 'b'.repeat(64);
    return task;
  };
  await assert.rejects(advanceCouncilCampaign(ledger, queue, handlers, plan.planObservationId, { now: clock }), /does not match its archived stage/u);
  assert.equal(calls, 1);
  assert.equal(ledger.listObservations('fixture-study').filter(record => record.source === 'durable-council-result.v1').length, 0);
  queue.getTask = getTask;
  const repaired = await runCouncilCampaign(ledger, queue, handlers, plan.planObservationId, 1, { workerId: 'review-fixture', now: clock });
  assert.equal(repaired.progress.status, 'complete');
  assert.equal(calls, 2);
});
