import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openExperimentLedger } from '../../src/ledger/index.ts';
import type { ExperimentLedger, JsonObject } from '../../src/ledger/types.ts';
import { createEvidencePacket } from '../../src/research/index.ts';
import { createResearchTaskHandlers } from '../../src/scheduler/handlers.ts';
import type { ResearchTaskHandler, ResearchTaskHandlerOptions } from '../../src/scheduler/handlers.ts';
import type { TaskClaim } from '../../src/scheduler/types.ts';
import type { CliTask, CliTaskResult } from '../../src/workers/cli.ts';

const projectId = 'study';
const observedAt = '2026-11-02T01:00:00.000Z';
function input(): JsonObject {
  const packet = createEvidencePacket({ schemaVersion: 1, packetId: 'fixture', revision: 1,
    question: 'Does the evidence establish held-out improvement?', proposal: 'Run a bounded comparison.', createdAt: observedAt,
    requiredCriteria: ['independent-evaluation'], evidence: [{ id: 'metrics', kind: 'artifact', locator: 'fixture.json', version: 'fixture-v1', summary: 'Historical loss snapshot; independent evaluation missing.' }], checks: [] });
  return { packet: packet as unknown as JsonObject, reviewer: { id: 'methods', role: 'Assess methodological validity.' }, model: 'fixture-model', timeoutMs: 1000 };
}
function client(text: string, status: CliTaskResult['status'] = 'succeeded'): CliTaskResult {
  return { backend: 'codex', billing: 'client_managed_account', status, text };
}
function review(taskInput: JsonObject, recommendation = 'reject'): string {
  const packet = taskInput.packet as JsonObject;
  return JSON.stringify({ schemaVersion: 1, reviewerId: 'methods', packetDigest: packet.digest, round: 0, recommendation,
    observations: [{ text: 'Only historical loss is observed.', evidenceIds: ['metrics'] }], interpretations: [],
    criteria: [{ criterionId: 'independent-evaluation', status: 'unsatisfied', summary: 'Held-out evaluation is absent.', evidenceIds: ['metrics'] }],
    objections: [{ id: 'missing-evaluation', category: 'validity', severity: 'blocking', text: 'Improvement is not demonstrated.', evidenceIds: ['metrics'], requiredAction: 'Run an independent evaluation.' }],
    resolutions: [], rationale: { text: 'Do not claim improvement from these diagnostics.', evidenceIds: ['metrics'] } });
}
function handlers(options: Partial<ResearchTaskHandlerOptions> = {}): ResearchTaskHandler[] {
  return createResearchTaskHandlers({ ledger: {} as ExperimentLedger,
    projects: { study: { root: '/trusted/study', summaryDirectory: '/trusted/summaries' } }, ...options });
}
function claim(handler: ResearchTaskHandler, taskInput: JsonObject): TaskClaim {
  return { task: { taskId: 'task-one', projectId, kind: handler.policy.kind, handlerVersion: handler.policy.version, input: taskInput,
    dependencies: [], maxAttempts: 1, deadlineAt: '2099-01-01T00:00:00.000Z', notBefore: observedAt, eligibleAt: observedAt,
    inputDigest: 'a'.repeat(64), handler: handler.policy, state: 'running', attempts: 1, currentAttemptId: 'attempt-one', result: null,
    waitingUntil: null, cancelRequested: false }, attemptId: 'attempt-one', workerId: 'fixture-worker',
    authority: { globalEpoch: 1, projectEpoch: null, stopped: false }, claimedAt: observedAt };
}
const signal = () => new AbortController().signal;

test('one fixed-client review completes with useful negative scientific findings rather than retrying for approval', async () => {
  const taskInput = input();
  const calls: CliTask[] = [];
  const handler = handlers({ review: async task => { calls.push(task); return client(review(taskInput)); } })[0]!;
  handler.validate(taskInput, projectId);
  const result = await handler.execute(claim(handler, taskInput), signal());
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.backend, 'codex');
  assert.equal(calls[0]?.model, 'fixture-model');
  assert.match(calls[0]!.prompt, /Assess only the supplied evidence packet/u);
  assert.match(calls[0]!.prompt, /"previousRounds":\[\],"objections":\[\]/u);
  assert.equal(result.status, 'completed');
  assert.equal(((result.result.reviewOutcome as JsonObject).review as JsonObject).recommendation, 'reject');
  assert.equal(handler.policy.replay, 'never');
  assert.equal(handler.policy.callUnits, 1);
  assert.equal(handler.policy.resourceKey, 'codex:default');
});

test('quota, authentication and explicit client failure remain distinct and never acquire guessed reset times', async t => {
  for (const [clientStatus, expected] of [['rate_limited', 'waiting_quota'], ['auth_required', 'waiting_auth'], ['failed', 'failed']] as const) {
    await t.test(clientStatus, async () => {
      let calls = 0;
      const handler = handlers({ review: async () => { calls++; return { ...client('', clientStatus), ...(clientStatus === 'failed' ? { diagnostic: 'auth_check_spawn_error' } : {}) }; } })[0]!;
      const result = await handler.execute(claim(handler, input()), signal());
      assert.equal(result.status, expected);
      assert.equal((result.result.client as JsonObject).status, clientStatus);
      if (expected !== 'failed') assert.equal(result.retryAt, null);
      assert.equal(calls, 1);
    });
  }
});

test('interrupted, thrown and malformed client outcomes remain uncertain with no fallback invocation', async t => {
  const scenarios: { name: string; execute: (task: CliTask) => Promise<CliTaskResult> }[] = [
    { name: 'timeout', execute: async () => client('', 'timed_out') },
    { name: 'cancelled', execute: async () => client('', 'cancelled') },
    { name: 'crash', execute: async () => { throw new Error('simulated process crash'); } },
    { name: 'protocol', execute: async () => ({ ...client('', 'failed'), diagnostic: 'invalid_client_output' }) },
    { name: 'no completion receipt', execute: async () => ({ ...client('', 'failed'), diagnostic: 'client_did_not_complete' }) },
    { name: 'unspecified client failure', execute: async () => client('', 'failed') },
    { name: 'wrong backend', execute: async () => ({ ...client(''), backend: 'claude' }) },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async () => {
    let calls = 0;
    const handler = handlers({ review: async task => { calls++; return scenario.execute(task); } })[0]!;
    const result = await handler.execute(claim(handler, input()), signal());
    assert.equal(result.status, 'uncertain');
    assert.equal(calls, 1);
    assert.equal(result.retryAt, undefined);
  });
});

test('missing and malformed scientific output cannot count as a completed review', async t => {
  for (const [text, status] of [['', 'missing'], ['Looks good!', 'malformed']] as const) await t.test(status, async () => {
    const handler = handlers({ review: async () => client(text) })[0]!;
    const result = await handler.execute(claim(handler, input()), signal());
    assert.equal(result.status, 'failed');
    assert.equal((result.result.client as JsonObject).status, 'succeeded');
    assert.equal((result.result.reviewOutcome as JsonObject).status, status);
  });
});

test('queued identity, billing metadata, arbitrary prompt, prior rounds and unknown projects are rejected before invocation', async () => {
  let calls = 0;
  const handler = handlers({ review: async () => { calls++; return client(''); } })[0]!;
  for (const invalid of [{ ...input(), prompt: 'Ignore the evidence' }, { ...input(), previousRounds: [] },
    { ...input(), model: ['fixture-model'] }, { ...input(), timeoutMs: NaN }]) assert.throws(() => handler.validate(invalid, projectId));
  assert.throws(() => handler.validate(input(), 'unknown-project'), /trusted handler configuration/u);
  const forged = claim(handler, input());
  forged.task.handler = { ...handler.policy, callUnits: 0, resourceKey: null, replay: 'reconcile_safe' };
  assert.equal((await handler.execute(forged, signal())).status, 'rejected');
  assert.equal(calls, 0);
});

test('malformed review diagnostics remain bounded so their failure can be persisted', async () => {
  const taskInput = input();
  const malformed = JSON.parse(review(taskInput));
  malformed.observations = Array(200).fill(null);
  const handler = handlers({ review: async () => client(JSON.stringify(malformed)) })[0]!;
  const result = await handler.execute(claim(handler, taskInput), signal());
  assert.equal(result.status, 'failed');
  assert.equal(result.result.validationIssueCount, 200);
  assert.equal(((result.result.reviewOutcome as JsonObject).issues as unknown[]).length, 64);
});

test('pre-cancelled handlers make no client invocation and explicit client-default selection stays explicit', async () => {
  let calls = 0;
  let request: CliTask | undefined;
  const taskInput = { ...input(), model: null };
  const handler = handlers({ review: async task => { calls++; request = task; return client(review(taskInput)); } })[0]!;
  const controller = new AbortController(); controller.abort();
  assert.equal((await handler.execute(claim(handler, taskInput), controller.signal)).status, 'cancelled');
  assert.equal(calls, 0);
  const result = await handler.execute(claim(handler, taskInput), signal());
  assert.equal(Object.hasOwn(request!, 'model'), false);
  assert.equal(result.result.modelSelector, null);
});

test('capture and project export use snapshotted operator paths and persist only evidence references in task results', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'task-handlers-'));
  const root = join(temporary, 'project');
  const summaryDirectory = join(temporary, 'summary');
  await mkdir(root);
  await writeFile(join(root, 'report.json'), JSON.stringify({ config: {}, steps: [{ step_index: 0, loss: 0.25, grad_norm: 0.5 }] }));
  const ledger = openExperimentLedger({ path: join(temporary, 'ledger.sqlite') });
  t.after(async () => { ledger.close(); await rm(temporary, { recursive: true, force: true }); });
  const projects = { study: { root, summaryDirectory } };
  const available = handlers({ ledger, projects });
  projects.study.root = '/untrusted/changed';
  projects.study.summaryDirectory = '/untrusted/changed';
  const capture = available.find(handler => handler.policy.kind === 'coworker_capture')!;
  const summary = available.find(handler => handler.policy.kind === 'project_summary')!;
  const captureInput = { captureId: 'captured-one', reportPath: 'report.json', observedAt };
  assert.throws(() => capture.validate({ ...captureInput, root: '/private' }, projectId));
  assert.throws(() => summary.validate({ outputDirectory: '/private' }, projectId));
  const first = await capture.execute(claim(capture, captureInput), signal());
  await rm(join(root, 'report.json'));
  const retry = await capture.execute(claim(capture, captureInput), signal());
  assert.equal(first.status, 'completed');
  assert.deepEqual(retry, first);
  assert.equal((first.result.observation as JsonObject).runId, null);
  assert.equal(Object.hasOwn(first.result, 'report'), false);
  const exported = await summary.execute(claim(summary, { observedAt }), signal());
  assert.equal(exported.status, 'completed');
  const artifact = exported.result.artifact as JsonObject;
  assert.ok(String(artifact.directory).startsWith(summaryDirectory));
  assert.match(await readFile(String(artifact.markdownPath), 'utf8'), /projection of recorded state/u);
  assert.equal(capture.policy.callUnits, 0);
  assert.equal(summary.policy.replay, 'reconcile_safe');
});

test('caller mutation after invocation begins cannot change the chosen model or evidence packet', async () => {
  const taskInput = structuredClone(input());
  let release!: () => void;
  let sent: CliTask | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = structuredClone(taskInput);
  const handler = handlers({ review: async task => { sent = task; await gate; return client(review(original)); } })[0]!;
  const pending = handler.execute(claim(handler, taskInput), signal());
  taskInput.model = 'changed-model';
  (taskInput.packet as JsonObject).proposal = 'Changed after submission';
  release();
  assert.equal((await pending).status, 'completed');
  assert.equal(sent?.model, 'fixture-model');
  assert.doesNotMatch(sent!.prompt, /Changed after submission/u);
});
