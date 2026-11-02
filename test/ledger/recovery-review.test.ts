import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openExperimentLedger } from '../../src/ledger/index.ts';
import type { ExperimentLedger } from '../../src/ledger/types.ts';
import { admission, deadline, fixedNow, initialize } from './helpers.ts';

async function fixture(body: (ledger: ExperimentLedger) => void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-recovery-review-'));
  const ledger = openExperimentLedger({ path: join(directory, 'ledger.sqlite'), now: fixedNow });
  try { initialize(ledger); body(ledger); }
  finally { ledger.close(); await rm(directory, { recursive: true, force: true }); }
}

function allowCleanup(ledger: ExperimentLedger): void {
  for (const scopeId of ['global', 'project:study']) ledger.configurePolicy({ scopeId, expectedVersion: 1,
    allowedBackends: ['fixture'], allowedOperations: ['launch', 'evaluate', 'cancel', 'release'], requiredChecks: ['adapter-contract'] });
}

test('recorded charges replace reserved headroom while exhaustion holds new work with unresolved liability', async () => {
  await fixture(ledger => {
    const action = ledger.admitAction(admission());
    ledger.admitAction(admission(2, 50n));
    ledger.claimDispatch({ workerId: 'fixture-worker', deadlineAt: deadline });
    const before = ledger.getBudget('global').availableMicrodollars;
    ledger.recordCharge({ chargeId: 'bound-consumed', actionId: action.actionId, amountMicrodollars: 100n,
      source: 'billing', evidence: { invoice: 'partial' } });
    const state = ledger.getAction(action.actionId);
    assert.equal(state.reservation.outstandingMicrodollars, 0n);
    assert.equal(state.reservation.finalized, false);
    assert.equal(ledger.getBudget('global').availableMicrodollars, before);
    assert.throws(() => ledger.admitAction(admission(3, 1n)), /exhausted its bound/u);
    assert.equal(ledger.claimDispatch({ workerId: 'fixture-worker', deadlineAt: deadline }), null);
  });
});

test('only stored zero-cost cleanup bypasses an exceeded cap during dispatch and authorization', async () => {
  await fixture(ledger => {
    allowCleanup(ledger);
    const target = ledger.admitAction(admission());
    ledger.claimDispatch({ workerId: 'fixture-worker', deadlineAt: deadline });
    ledger.stopScope({ scopeId: 'global', expectedEpoch: ledger.getScope('global').epoch, reason: 'stop work' });
    const paid = ledger.admitCleanup({ targetActionId: target.actionId, operation: 'cancel', operationRevision: 1,
      reservation: { amountMicrodollars: 10n, category: 'other', basis: 'bounded paid cleanup' } });
    ledger.configureBudget({ scopeId: 'global', parentScopeId: null, expectedRevision: 1, limitMicrodollars: 1n });
    assert.equal(ledger.claimDispatch({ workerId: 'fixture-worker', deadlineAt: deadline }), null,
      'A paid cleanup must be held after its cap becomes insufficient');
    const free = ledger.admitCleanup({ targetActionId: target.actionId, operation: 'release', operationRevision: 1,
      reservation: { amountMicrodollars: 0n, category: 'other', basis: 'fixture operation with no added charge' } });
    const claim = ledger.claimDispatch({ workerId: 'fixture-worker', deadlineAt: deadline });
    assert.equal(claim?.action.actionId, free.actionId);
    assert.equal(ledger.isDispatchAuthorized(claim!), true);
    assert.equal(ledger.getAction(paid.actionId).state, 'queued');
    ledger.recordCharge({ chargeId: 'unexpected-cleanup-charge', actionId: free.actionId, amountMicrodollars: 1n,
      source: 'billing', evidence: { disproves: 'zero new charge' } });
    assert.equal(ledger.isDispatchAuthorized(claim!), false,
      'An observed charge must remove the supposedly free cleanup cap exception');
  });
});

test('stopped cleanup keeps policy and fresh authority while ordinary names and nested cleanup gain no exemption', async () => {
  await fixture(ledger => {
    allowCleanup(ledger);
    const target = ledger.admitAction(admission());
    ledger.claimDispatch({ workerId: 'fixture-worker', deadlineAt: deadline });
    ledger.recordValidation({ validationId: 'failed-later', manifestDigest: target.manifestDigest, check: 'adapter-contract',
      source: 'trusted-validator', sequence: 2, status: 'failed', evidence: { defect: 'fixture evaluator' } });
    ledger.stopScope({ scopeId: 'global', expectedEpoch: ledger.getScope('global').epoch, reason: 'stop work' });
    assert.throws(() => ledger.admitAction({ ...admission(), operation: 'cancel', payload: { cleanup: 'cancel', targetActionId: target.actionId } }), /stopped/u);
    const cleanup = ledger.admitCleanup({ targetActionId: target.actionId, operation: 'cancel', operationRevision: 1,
      reservation: { amountMicrodollars: 0n, category: 'other', basis: 'fixture free cleanup' } });
    const claim = ledger.claimDispatch({ workerId: 'fixture-worker', deadlineAt: deadline });
    assert.equal(claim?.action.actionId, cleanup.actionId);
    assert.equal(ledger.isDispatchAuthorized(claim!), true);
    assert.throws(() => ledger.admitCleanup({ targetActionId: cleanup.actionId, operation: 'release', operationRevision: 1,
      reservation: { amountMicrodollars: 0n, category: 'other', basis: 'nested cleanup attempt' } }), /original/u);
    ledger.stopScope({ scopeId: 'global', expectedEpoch: ledger.getScope('global').epoch, reason: 'revoke previous claims' });
    assert.equal(ledger.isDispatchAuthorized(claim!), false);
  });
});
