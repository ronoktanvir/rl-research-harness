import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { openConfiguredHarness, parseHarnessConfig, readBoundedJson } from "../../src/scheduler/config.ts";
import type { HarnessConfig } from "../../src/scheduler/config.ts";

function config(directory: string): HarnessConfig {
  return parseHarnessConfig({ schemaVersion: 1, ledgerPath: "ledger.sqlite", queuePath: "queue.sqlite", workerId: "fixture",
    limits: { maxClientInvocations: 2, maxParallel: 1 }, projects: { study: {
      root: "project", summaryDirectory: "summaries", limits: { maxClientInvocations: 2, maxParallel: 1 },
    } } }, directory);
}

test("reopening or increasing configured caps preserves consumption and ledger stop authority", async t => {
  const directory = await mkdtemp(join(tmpdir(), "harness-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = config(directory);
  let harness = openConfiguredHarness(settings);
  try {
    harness.queue.registerHandler({ kind: "fixture-client", version: "1", replay: "never", callUnits: 1, resourceKey: "fixture" });
    harness.queue.enqueue({ taskId: "spent", projectId: "study", kind: "fixture-client", handlerVersion: "1", input: {}, dependencies: [],
      maxAttempts: 1, notBefore: "2026-01-01T00:00:00.000Z", deadlineAt: "2099-01-01T00:00:00.000Z" });
    const claim = harness.queue.claim({ workerId: "fixture" })!;
    harness.queue.recordOutcome({ resultId: "receipt", taskId: "spent", attemptId: claim.attemptId, status: "completed", result: {} });
    const version = harness.queue.getBudget("global").version;
    harness.ledger.stopScope({ scopeId: "global", expectedEpoch: harness.ledger.getScope("global").epoch, reason: "operator stop" });
    harness.close(); harness = openConfiguredHarness(settings);
    assert.equal(harness.queue.getBudget("global").version, version);
    assert.equal(harness.queue.getBudget("global").consumedCalls, 1);
    assert.equal(harness.ledger.getScope("global").stopped, true);
    harness.close();
    settings.limits.maxClientInvocations = 3;
    harness = openConfiguredHarness(settings);
    assert.equal(harness.queue.getBudget("global").maxCalls, 3);
    assert.equal(harness.queue.getBudget("global").consumedCalls, 1);
    assert.equal(harness.queue.getBudget("project:study").consumedCalls, 1);
    assert.equal(harness.queue.getBudget("global").version, version + 1);
    assert.equal(harness.ledger.getScope("global").stopped, true);
  } finally { harness.close(); }
});

test("a rejected queue database releases the ledger owner acquired during setup", async t => {
  const directory = await mkdtemp(join(tmpdir(), "harness-config-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = config(directory);
  const wrongStore = openExperimentLedger({ path: settings.queuePath }); wrongStore.close();
  assert.throws(() => openConfiguredHarness(settings));
  const ledger = openExperimentLedger({ path: settings.ledgerPath });
  try { assert.equal(ledger.listRuns("study").length, 0); } finally { ledger.close(); }
});

test("configuration is detached, resolves relative paths, and rejects implicit or foreign limits", async () => {
  const original = config("/trusted/config");
  const detached = parseHarnessConfig(original, "/elsewhere");
  original.projects.study!.root = "/changed";
  assert.equal(detached.projects.study!.root, "/trusted/config/project");
  assert.throws(() => parseHarnessConfig({ ...original, limits: { maxParallel: 1 } }, "/trusted"));
  assert.throws(() => parseHarnessConfig({ ...original, apiKey: "not-a-real-key" }, "/trusted"));
  assert.throws(() => parseHarnessConfig({ ...original, queuePath: original.ledgerPath }, "/trusted"));
});

test("operator JSON reading rejects non-files, malformed and oversized content", async t => {
  const directory = await mkdtemp(join(tmpdir(), "harness-config-json-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "request.json");
  await writeFile(file, "{}"); assert.deepEqual(await readBoundedJson(file, 2), {});
  await writeFile(file, "{} "); await assert.rejects(readBoundedJson(file, 2), /exceeds/);
  await writeFile(file, "no"); await assert.rejects(readBoundedJson(file));
  await assert.rejects(readBoundedJson(directory), /regular/);
});
