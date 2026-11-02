import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openJobJournal } from "../../src/execution/journal.ts";
import { createSupervisedWorker } from "../../src/execution/worker.ts";
import type { ServiceQueryResult, ServiceSnapshot, SystemdTransport } from "../../src/execution/types.ts";
import { workerDeclaration, workerNow, workerSnapshot } from "./worker-fixtures.ts";

const signal = () => new AbortController().signal;
const declaration = workerDeclaration();
function terminal(): ServiceSnapshot {
  const live = workerSnapshot(declaration), at = workerNow.toISOString();
  return { ...live, mainPid: 0, controlGroup: "", cgroupPopulated: false,
    activeState: "active", subState: "exited", result: "success", execMainCode: 1, execMainStatus: 0,
    cleanupEvidence: { kind: "cgroup_v2_absent", controlGroup: live.controlGroup,
      invocationId: live.invocationId, observedAt: at, confirmedAt: at } };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "worker-cleanup-")), path = join(directory, "jobs.sqlite");
  let journal = openJobJournal({ path, now: () => workerNow });
  let observation: ServiceQueryResult = { kind: "present", snapshot: workerSnapshot(declaration) };
  const transport: SystemdTransport = {
    hostIdentity: async () => declaration.request.expectedHost,
    start: async () => ({ kind: "accepted", evidence: { identity: { ...declaration.request.identity }, host: { ...declaration.request.expectedHost } } }),
    query: async () => observation,
    stop: async () => ({ command: "sent", observation }),
  };
  return {
    observe(snapshot: ServiceSnapshot) { observation = { kind: "present", snapshot }; },
    absent() { observation = { kind: "absent", host: declaration.request.expectedHost, observedAt: workerNow.toISOString() }; },
    worker() { return createSupervisedWorker({ journal, transport, workerId: declaration.workerId, authorize: () => true, now: () => workerNow }); },
    reopen() { journal.close(); journal = openJobJournal({ path, now: () => workerNow }); },
    async close() { journal.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("identity-bound kernel cleanup survives manager path removal, unit collection and reopening", async () => {
  const f = await fixture();
  try {
    await f.worker().launch(declaration, signal());
    f.observe(terminal());
    const ended = await f.worker().query(declaration.jobId, signal());
    assert.equal(ended.acceptance, "accepted"); assert.equal(ended.execution, "succeeded");
    assert.equal(ended.observation?.kind, "present");
    if (ended.observation?.kind === "present") {
      assert.equal(ended.observation.snapshot.controlGroup, "", "Preserve the manager's actual observation");
      assert.equal(ended.observation.snapshot.cleanupEvidence?.kind, "cgroup_v2_absent");
    }
    f.absent(); f.reopen();
    assert.equal((await f.worker().query(declaration.jobId, signal())).execution, "succeeded");
  } finally { await f.close(); }
});

test("confirmed cleanup after stop preserves the manager's timeout failure without inventing its cause", async () => {
  const f = await fixture();
  try {
    await f.worker().launch(declaration, signal());
    f.observe({ ...terminal(), activeState: "failed", subState: "failed", result: "timeout", execMainCode: 2, execMainStatus: 9 });
    const stopped = await f.worker().cancel(declaration.jobId, signal());
    assert.equal(stopped.acceptance, "accepted"); assert.equal(stopped.execution, "failed");
    assert.equal(stopped.reason, "stop_observed");
    f.absent(); f.reopen();
    assert.equal((await f.worker().query(declaration.jobId, signal())).execution, "failed");
  } finally { await f.close(); }
});

const invalidProofs: Array<[string, (snapshot: ServiceSnapshot) => void]> = [
  ["missing proof", value => { delete value.cleanupEvidence; }],
  ["another unit path", value => { value.cleanupEvidence!.controlGroup = "/system.slice/another.service"; }],
  ["another invocation", value => { value.cleanupEvidence!.invocationId = "3".repeat(32); }],
  ["confirmation before kernel observation", value => { value.cleanupEvidence!.observedAt = "2026-11-02T12:00:01.000Z"; }],
  ["confirmation after final snapshot", value => { value.cleanupEvidence!.confirmedAt = "2026-11-02T12:00:01.000Z"; }],
  ["live main process", value => { value.mainPid = 123; }],
  ["unestablished exit", value => { value.execMainCode = 0; }],
  ["nonterminal service", value => { value.subState = "running"; }],
  ["populated group", value => { value.cgroupPopulated = true; }],
];
for (const [name, invalidate] of invalidProofs) {
  test(`cleanup with ${name} cannot manufacture a terminal worker result`, async () => {
    const f = await fixture();
    try {
      await f.worker().launch(declaration, signal());
      const snapshot = terminal(); invalidate(snapshot); f.observe(snapshot);
      const result = await f.worker().query(declaration.jobId, signal());
      assert.equal(result.acceptance, "accepted", "Existing acceptance remains distinct from malformed cleanup");
      assert.equal(result.execution, "unknown"); assert.equal(result.observation?.kind, "unknown");
    } finally { await f.close(); }
  });
}
