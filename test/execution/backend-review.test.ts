import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dispatchNext } from "../../src/controller/dispatcher.ts";
import { createSupervisedExperimentBackend } from "../../src/execution/backend.ts";
import type { SupervisedBackendOptions } from "../../src/execution/backend.ts";
import { openJobJournal } from "../../src/execution/journal.ts";
import { createJobDeclaration } from "../../src/execution/worker.ts";
import type { JobDeclaration, JobObservationInput, ServiceQueryResult, SystemdTransport } from "../../src/execution/types.ts";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { admission, deadline, fixedNow, initialize } from "../ledger/helpers.ts";
import { workerSnapshot } from "./worker-fixtures.ts";

const signal = () => new AbortController().signal;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "harness-backend-review-"));
  const ledger = openExperimentLedger({ path: join(directory, "ledger.sqlite"), now: fixedNow });
  const journal = openJobJournal({ path: join(directory, "jobs.sqlite"), now: fixedNow });
  initialize(ledger);
  const action = ledger.admitAction({ ...admission(), payload: { attemptPlanDigest: "d".repeat(64) } });
  let declaration: JobDeclaration | undefined;
  let starts = 0;
  const observed = (): ServiceQueryResult => ({ kind: "present", snapshot: workerSnapshot(declaration!) });
  const transport: SystemdTransport = {
    hostIdentity: async () => declaration!.request.expectedHost,
    start: async (_request, _signal, authorize) => {
      assert.equal(authorize(), true); starts++;
      return { kind: "accepted", evidence: { source: "offline-review", identity: { ...declaration!.request.identity }, host: { ...declaration!.request.expectedHost } } };
    },
    query: async () => observed(),
    stop: async (_request, _signal, authorize) => ({ command: authorize() ? "sent" : "not_sent", observation: observed() }),
  };
  const options: SupervisedBackendOptions = { name: "fixture", workerId: "review-worker", ledger, journal, transport, now: fixedNow, callTimeoutMs: 1000,
    prepareLaunch: async claim => {
      declaration = createJobDeclaration({ actionId: claim.action.actionId, backendKey: claim.action.backendKey,
        manifestDigest: claim.action.manifestDigest, planDigest: "d".repeat(64), workerId: "review-worker",
        command: { executable: "/usr/bin/python3", args: ["-c", "pass"], cwd: "/srv/source", environment: {} },
        limits: { runtimeMs: 1000, startTimeoutMs: 1000, stopTimeoutMs: 1000, memoryMaxBytes: 104857600, tasksMax: 8 },
        deadlineAt: claim.deadlineAt, host: { machineId: "1".repeat(32), bootId: "11111111-1111-1111-1111-111111111111" } });
      return { declaration, evidence: { fixture: "injected deployment; no trainer qualification" }, authorizeDeployment: () => true };
    },
  };
  const backend = createSupervisedExperimentBackend(options);
  return { ledger, journal, backend, options, action, transport, declaration: () => declaration!, starts: () => starts,
    setDeclaration(value: JobDeclaration) { declaration = value; },
    dispatch: () => dispatchNext(ledger, [backend], { workerId: "review-worker", deadlineAt: deadline, timeoutMs: 1000 }),
    async close() { ledger.close(); journal.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("preparation uses the validated timeout captured at construction rather than mutable caller options", async () => {
  const f = await fixture();
  try {
    Object.defineProperty(f.options, "callTimeoutMs", { get() { throw new Error("Caller options changed after construction"); } });
    assert.equal((await f.dispatch())?.state, "acknowledged");
    assert.equal(f.starts(), 1);
  } finally { await f.close(); }
});

test("recovery rejects a worker declaration that differs from the already durable bridge intent", async () => {
  const f = await fixture();
  try {
    const original = f.journal.prepareIntent.bind(f.journal);
    f.journal.prepareIntent = () => { throw new Error("Simulated crash after bridge intent, before worker intent"); };
    assert.equal((await f.dispatch())?.state, "unknown");
    assert.equal(f.starts(), 0);
    f.journal.prepareIntent = original;
    // Simulate independently restored stores: both records are internally valid,
    // but the worker's command is not the declaration in the bridge intent.
    const previous = f.declaration();
    const changed = createJobDeclaration({ actionId: previous.actionId, backendKey: previous.backendKey,
      manifestDigest: previous.manifestDigest, planDigest: previous.planDigest, workerId: previous.workerId,
      command: { ...previous.request.command, args: ["-c", "print('different command')"] }, limits: previous.request.limits,
      deadlineAt: previous.request.deadlineAt, host: previous.request.expectedHost });
    original(changed); f.setDeclaration(changed);
    const action = f.ledger.getAction(f.action.actionId);
    const response = await f.backend.reconcile({ actionId: action.actionId, attemptId: action.attemptId!, manifestDigest: action.manifestDigest,
      backend: action.backend, backendKey: action.backendKey }, signal()).catch(() => null);
    assert.notEqual((response as { outcome?: string } | null)?.outcome, "accepted",
      "Matching action/plan labels cannot override the durable declaration digest");
    assert.equal(f.starts(), 0);
  } finally { await f.close(); }
});

test("status projection cites its own query receipt even if a later observation arrives before continuation", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.dispatch())?.state, "acknowledged");
    const original = f.journal.recordObservation.bind(f.journal);
    let ownId = "", injected = false;
    f.journal.recordObservation = (input: JobObservationInput) => {
      const result = original(input);
      if (!injected && input.observation.operation === "query") {
        injected = true; ownId = result.observationId;
        // Another trusted observation can commit after the worker's synchronous
        // result computation but before the bridge resumes its await.
        queueMicrotask(() => original({ ...input, observationId: "review-later-query",
          observation: { operation: "query", result: { kind: "present", snapshot: { ...workerSnapshot(f.declaration()),
            mainPid: 0, activeState: "failed", subState: "failed", result: "exit-code", execMainCode: 1, execMainStatus: 23, cgroupPopulated: false } } } }));
      }
      return result;
    };
    const status = await f.backend.observe(f.action.actionId, signal());
    assert.equal(status.result.execution, "running");
    assert.equal(status.observation.eventId, `supervised-status:${ownId}`,
      "The latest journal pointer may already describe a different query");
  } finally { await f.close(); }
});
