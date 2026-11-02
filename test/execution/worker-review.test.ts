import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openJobJournal } from "../../src/execution/journal.ts";
import { createSupervisedWorker } from "../../src/execution/worker.ts";
import type { ServiceQueryRequest, ServiceQueryResult, SystemdTransport } from "../../src/execution/types.ts";
import { workerDeclaration, workerNow, workerSnapshot } from "./worker-fixtures.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "harness-worker-review-"));
  const path = join(directory, "jobs.sqlite");
  let journal = openJobJournal({ path, now: () => workerNow });
  const declaration = workerDeclaration();
  const evidence = { identity: { ...declaration.request.identity }, host: { ...declaration.request.expectedHost } };
  let observation: ServiceQueryResult = { kind: "unknown", reason: "fixture_no_query_evidence" };
  const transport: SystemdTransport = {
    hostIdentity: async () => declaration.request.expectedHost,
    start: async (_request, _signal, authorize) => authorize()
      ? { kind: "accepted", evidence }
      : { kind: "unknown", reason: "authority_revoked" },
    query: async () => observation,
    stop: async () => ({ command: "sent", observation }),
  };
  return {
    declaration, transport, evidence, journal: () => journal,
    observe(value: ServiceQueryResult) { observation = value; },
    worker(authorize: () => boolean = () => true) {
      return createSupervisedWorker({ journal, transport, workerId: "worker-one", authorize, now: () => workerNow });
    },
    reopen() { journal.close(); journal = openJobJournal({ path, now: () => workerNow }); },
    async close() { journal.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
const signal = () => new AbortController().signal;

test("accepted receipt pins cancellation to its invocation even when every query is unknown", async () => {
  const f = await fixture();
  try {
    const invocationId = "4".repeat(32);
    f.transport.start = async () => ({ kind: "accepted", evidence: { ...f.evidence, invocationId } });
    assert.equal((await f.worker().launch(f.declaration, signal())).acceptance, "accepted");
    f.reopen();
    let cancelRequest: ServiceQueryRequest | undefined;
    f.transport.stop = async request => {
      cancelRequest = request;
      return { command: "not_sent", observation: { kind: "unknown", reason: "fixture_manager_unavailable" } };
    };
    await f.worker().cancel(f.declaration.jobId, signal(), () => true);
    assert.equal(cancelRequest?.expectedInvocationId, invocationId);
  } finally { await f.close(); }
});

for (const outcome of ["succeeded", "failed"] as const) {
  test(`confirmed ${outcome} survives later cancellation, unit absence and journal reopen`, async () => {
    const f = await fixture();
    try {
      const snapshot = { ...workerSnapshot(f.declaration), mainPid: 0, cgroupPopulated: false,
        activeState: outcome === "succeeded" ? "active" : "failed", subState: outcome === "succeeded" ? "exited" : "failed",
        result: outcome === "succeeded" ? "success" : "exit-code", execMainCode: 1, execMainStatus: outcome === "succeeded" ? 0 : 7 };
      f.observe({ kind: "present", snapshot });
      assert.equal((await f.worker().launch(f.declaration, signal())).execution, outcome);
      assert.equal((await f.worker().cancel(f.declaration.jobId, signal(), () => true)).execution, outcome);
      f.observe({ kind: "absent", host: f.declaration.request.expectedHost, observedAt: workerNow.toISOString() });
      assert.equal((await f.worker().cancel(f.declaration.jobId, signal(), () => true)).execution, outcome);
      f.reopen();
      assert.equal((await f.worker().query(f.declaration.jobId, signal())).execution, outcome);
    } finally { await f.close(); }
  });
}

test("authority revoked in the post-intent microtask prevents the transport start", async () => {
  const f = await fixture();
  try {
    let allowed = true, checks = 0, starts = 0;
    f.transport.start = async () => { starts++; return { kind: "accepted", evidence: f.evidence }; };
    const worker = f.worker(() => {
      if (++checks === 1) queueMicrotask(() => { allowed = false; });
      return allowed;
    });
    assert.equal((await worker.launch(f.declaration, signal())).acceptance, "unknown");
    assert.equal(starts, 0);
    assert.ok(f.journal().read(f.declaration.jobId), "An issued intent is retained despite authority revocation");
    await worker.launch(f.declaration, signal());
    assert.equal(starts, 0, "The retained intent never authorizes another start");
  } finally { await f.close(); }
});

test("the transport receives fresh authority after its asynchronous preflight", async () => {
  const f = await fixture();
  try {
    let allowed = true, managerEffects = 0;
    f.transport.start = async (_request, _signal, authorize) => {
      await Promise.resolve();
      allowed = false;
      if (!authorize()) return { kind: "unknown", reason: "authority_revoked_after_preflight" };
      managerEffects++;
      return { kind: "accepted", evidence: f.evidence };
    };
    assert.equal((await f.worker(() => allowed).launch(f.declaration, signal())).acceptance, "unknown");
    assert.equal(managerEffects, 0);
  } finally { await f.close(); }
});

test("an empty invocation cannot become accepted execution evidence", async () => {
  const f = await fixture();
  try {
    f.transport.start = async () => ({ kind: "unknown", reason: "fixture_lost_reply" });
    f.observe({ kind: "present", snapshot: { ...workerSnapshot(f.declaration), invocationId: "", loadState: "",
      mainPid: 0, cgroupPopulated: false, subState: "exited", execMainCode: 1, execMainStatus: 0 } });
    const result = await f.worker().launch(f.declaration, signal());
    assert.equal(result.acceptance, "unknown");
    assert.equal(result.execution, "unknown");
    assert.equal(result.observation?.kind, "unknown");
  } finally { await f.close(); }
});

test("an unbound accepted reply cannot establish acceptance while queries remain unknown", async () => {
  const f = await fixture();
  try {
    f.transport.start = async () => ({ kind: "accepted", evidence: {} });
    const result = await f.worker().launch(f.declaration, signal());
    assert.equal(result.acceptance, "unknown");
    const saved = f.journal().observations(f.declaration.jobId)[0]!.observation;
    assert.equal(saved.operation, "start");
    if (saved.operation === "start") assert.equal(saved.result.kind, "unknown");
  } finally { await f.close(); }
});
