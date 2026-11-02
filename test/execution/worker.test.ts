import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openJobJournal } from "../../src/execution/journal.ts";
import { createSupervisedWorker } from "../../src/execution/worker.ts";
import type { JobDeclaration, ServiceQueryResult, SystemdTransport } from "../../src/execution/types.ts";
import { workerDeclaration, workerNow, workerSnapshot } from "./worker-fixtures.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "harness-worker-")), path = join(directory, "jobs.sqlite");
  let journal = openJobJournal({ path, now: () => workerNow });
  const declaration = workerDeclaration(); let starts = 0, stops = 0, queries = 0;
  let observed: ServiceQueryResult = { kind: "present", snapshot: workerSnapshot(declaration) };
  const transport: SystemdTransport = {
    hostIdentity: async () => declaration.request.expectedHost,
    start: async (_request, _signal, authorize) => { assert.equal(authorize(), true); starts++; return { kind: "accepted", evidence: {
      source: "fixture", identity: { ...declaration.request.identity }, host: { ...declaration.request.expectedHost },
    } }; },
    query: async () => { queries++; return observed; },
    stop: async (_request, _signal, authorize) => { assert.equal(authorize(), true); stops++; return { command: "sent", observation: observed }; },
  };
  const worker = (authorize: (job: Readonly<JobDeclaration>) => boolean = () => true, callTimeoutMs = 30) => createSupervisedWorker({ journal, transport,
    workerId: "worker-one", now: () => workerNow, authorize, callTimeoutMs });
  return { declaration, transport, worker, journal: () => journal, starts: () => starts, queries: () => queries, stops: () => stops,
    setObservation(value: ServiceQueryResult) { observed = value; }, reopen() { journal.close(); journal = openJobJournal({ path, now: () => workerNow }); },
    async close() { journal.close(); await rm(directory, { recursive: true, force: true }); } };
}
const signal = () => new AbortController().signal;

test("a lost start reply is recovered by identity and reopen never starts that action again", async () => {
  const f = await fixture();
  try {
    const start = f.transport.start;
    f.transport.start = async (...args) => { await start(...args); throw new Error("reply lost"); };
    assert.equal((await f.worker().launch(f.declaration, signal())).acceptance, "accepted");
    assert.equal(f.starts(), 1);
    f.reopen();
    const resumed = await f.worker(() => false).launch(f.declaration, signal());
    assert.equal(resumed.execution, "running"); assert.equal(f.starts(), 1);
    const receipt = f.journal().observations(f.declaration.jobId).find(item => item.observationId === resumed.observationId);
    assert.equal(receipt?.observation.operation, "query"); assert.equal(receipt?.sequence, resumed.observationSequence);
    await f.worker().query(f.declaration.jobId, signal());
    assert.notEqual(f.journal().read(f.declaration.jobId)?.latestObservation?.observationId, resumed.observationId);
    assert.equal(f.journal().observations(f.declaration.jobId)[0]?.observation.operation, "start");
  } finally { await f.close(); }
});

test("concurrent identical launches share the journaled intent and cannot duplicate the start", async () => {
  const f = await fixture();
  try {
    const worker = f.worker();
    const results = await Promise.all(Array.from({ length: 8 }, () => worker.launch(f.declaration, signal())));
    assert.ok(results.every(result => result.acceptance === "accepted")); assert.equal(f.starts(), 1);
    const changed = structuredClone(f.declaration); changed.request.command.args.push("changed");
    assert.throws(() => worker.launch(changed, signal()), /identity/);
    assert.equal(f.starts(), 1);
  } finally { await f.close(); }
});

test("an absent unit after interrupted intent remains unknown across retries and reboot", async () => {
  const f = await fixture();
  try {
    f.journal().prepareIntent(f.declaration); f.reopen();
    f.setObservation({ kind: "absent", host: f.declaration.request.expectedHost, observedAt: workerNow.toISOString() });
    const missing = await f.worker().launch(f.declaration, signal());
    assert.equal(missing.acceptance, "unknown"); assert.equal(missing.execution, "unknown"); assert.equal(f.starts(), 0);
    f.setObservation({ kind: "absent", host: { ...f.declaration.request.expectedHost, bootId: "22222222-2222-2222-2222-222222222222" }, observedAt: workerNow.toISOString() });
    assert.equal((await f.worker().query(f.declaration.jobId, signal())).observation?.kind, "unknown");
    assert.equal(f.starts(), 0);
  } finally { await f.close(); }
});

test("denied authority and cancellation before intent do not consume a launch identity", async () => {
  const f = await fixture();
  try {
    const denied = await f.worker(() => false).launch(f.declaration, signal());
    assert.equal(denied.acceptance, "not_accepted");
    assert.equal(denied.observationId, null); assert.equal(denied.observationSequence, null);
    const aborted = new AbortController(); aborted.abort();
    const cancelled = await f.worker().launch(f.declaration, aborted.signal);
    assert.equal(cancelled.acceptance, "not_accepted");
    assert.equal(cancelled.observationId, null); assert.equal(cancelled.observationSequence, null);
    assert.equal(f.journal().read(f.declaration.jobId), null); assert.equal(f.starts(), 0);
  } finally { await f.close(); }
});

test("a hung start retains uncertainty and late callbacks cannot replace saved observations", async () => {
  const f = await fixture();
  try {
    let late!: (value: { kind: "accepted"; evidence: { source: string } }) => void;
    f.transport.start = async () => new Promise(resolve => { late = resolve; });
    f.setObservation({ kind: "unknown", reason: "manager_unreachable" });
    const result = await f.worker(() => true, 5).launch(f.declaration, signal());
    assert.equal(result.acceptance, "unknown");
    const before = f.journal().observations(f.declaration.jobId);
    late({ kind: "accepted", evidence: { source: "late" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.journal().observations(f.declaration.jobId), before);
    await f.worker().launch(f.declaration, signal()); assert.equal(f.starts(), 0);
  } finally { await f.close(); }
});

test("acceptance, process completion and targeted stopping remain distinct observations", async () => {
  const f = await fixture();
  try {
    const worker = f.worker();
    await worker.launch(f.declaration, signal());
    f.setObservation({ kind: "absent", host: f.declaration.request.expectedHost, observedAt: workerNow.toISOString() });
    const absent = await worker.cancel(f.declaration.jobId, signal(), () => true);
    assert.equal(absent.acceptance, "accepted"); assert.equal(absent.execution, "unknown");
    assert.equal(absent.stopCommand, "sent");
    assert.equal(f.journal().observations(f.declaration.jobId).find(item => item.observationId === absent.stopObservationId)?.observation.operation, "stop");
    f.setObservation({ kind: "present", snapshot: { ...workerSnapshot(f.declaration), mainPid: 0, subState: "exited", cgroupPopulated: null, execMainCode: 1 } });
    assert.equal((await worker.query(f.declaration.jobId, signal())).execution, "unknown");
    f.setObservation({ kind: "present", snapshot: { ...workerSnapshot(f.declaration), mainPid: 0, subState: "dead", activeState: "inactive", cgroupPopulated: false, execMainCode: 2, execMainStatus: 15, result: "signal" } });
    assert.equal((await worker.query(f.declaration.jobId, signal())).execution, "stopped");
    assert.equal(f.stops(), 1);
  } finally { await f.close(); }
});

test("denied cleanup authority preserves launch history but returns a distinct not-sent receipt", async () => {
  const f = await fixture();
  try {
    const worker = f.worker();
    await worker.launch(f.declaration, signal());
    const denied = await worker.cancel(f.declaration.jobId, signal(), () => false);
    assert.equal(denied.acceptance, "accepted"); assert.equal(denied.stopCommand, "not_sent"); assert.equal(f.stops(), 0);
    assert.equal(denied.observation?.kind, "present");
    const receipt = f.journal().observations(f.declaration.jobId).find(item => item.observationId === denied.stopObservationId);
    assert.equal(receipt?.observation.operation, "stop");
    assert.equal(denied.observationId, denied.stopObservationId); assert.equal(denied.observationSequence, receipt?.sequence);
    if (receipt?.observation.operation === "stop") assert.equal(receipt.observation.result.command, "not_sent");
    const confirmed = await worker.cancel(f.declaration.jobId, signal(), () => true);
    assert.equal(confirmed.stopCommand, "sent"); assert.notEqual(confirmed.stopObservationId, denied.stopObservationId);
    await worker.query(f.declaration.jobId, signal());
    assert.notEqual(f.journal().read(f.declaration.jobId)?.latestObservation?.observationId, confirmed.stopObservationId);
    assert.equal(f.journal().observations(f.declaration.jobId).find(item => item.observationId === confirmed.stopObservationId)?.observation.operation, "stop");
  } finally { await f.close(); }
});

test("timed out cancellation keeps its exact unknown receipt and late authority is revoked", async () => {
  const f = await fixture();
  try {
    const worker = f.worker(() => true, 10);
    await worker.launch(f.declaration, signal());
    let permitted!: () => boolean, late!: (value: { command: "sent"; observation: ServiceQueryResult }) => void;
    f.transport.stop = async (_request, _signal, authorize) => {
      permitted = authorize;
      return new Promise(resolve => { late = resolve; });
    };
    const result = await worker.cancel(f.declaration.jobId, signal(), () => true);
    assert.equal(result.stopCommand, "unknown"); assert.equal(result.acceptance, "accepted"); assert.equal(permitted(), false);
    const history = f.journal().observations(f.declaration.jobId);
    assert.equal(history.at(-1)?.observationId, result.stopObservationId);
    assert.equal(result.observationId, result.stopObservationId); assert.equal(result.observationSequence, history.at(-1)?.sequence);
    late({ command: "sent", observation: { kind: "present", snapshot: workerSnapshot(f.declaration) } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.journal().observations(f.declaration.jobId), history);
  } finally { await f.close(); }
});

test("a replacement invocation or malformed result cannot become job acceptance", async () => {
  const f = await fixture();
  try {
    f.transport.start = async () => null as never;
    f.setObservation({ kind: "present", snapshot: { ...workerSnapshot(f.declaration), identity: { ...f.declaration.request.identity, description: "wrong" } } });
    const first = await f.worker().launch(f.declaration, signal());
    assert.equal(first.acceptance, "unknown"); assert.equal(first.observation?.kind, "unknown");
    f.setObservation({ kind: "present", snapshot: workerSnapshot(f.declaration) });
    await f.worker().query(f.declaration.jobId, signal());
    f.setObservation({ kind: "present", snapshot: { ...workerSnapshot(f.declaration), invocationId: "3".repeat(32) } });
    assert.equal((await f.worker().query(f.declaration.jobId, signal())).observation?.kind, "unknown");
  } finally { await f.close(); }
});
