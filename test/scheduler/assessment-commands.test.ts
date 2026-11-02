import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { captureCoworkerReport } from "../../src/integrations/coworker/capture.ts";
import { loadHarnessConfig, openConfiguredHarness } from "../../src/scheduler/config.ts";

const exec = promisify(execFile);
async function command(expected: number, ...args: string[]) {
  try {
    const output = await exec(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { timeout: 15_000 });
    assert.equal(expected, 0); return JSON.parse(output.stdout);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || !("stdout" in error)) throw error;
    assert.equal(error.code, expected); return JSON.parse(String(error.stdout));
  }
}

test("assessment CLI recovers across processes, keeps follow-ups unresolved and leaves other tasks queued", async t => {
  const directory = await mkdtemp(join(tmpdir(), "harness-assessment-workflow-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "source"), ledgerPath = join(directory, "ledger.sqlite"), configPath = join(directory, "config.json");
  await mkdir(root);
  await writeFile(join(root, "report.json"), JSON.stringify({ steps: [{ step_index: 0, loss: .5, grad_norm: .2 }] }));
  const ledger = openExperimentLedger({ path: ledgerPath });
  let capture;
  try { capture = await captureCoworkerReport(ledger, { projectId: "study", captureId: "historical", root, reportPath: "report.json" }); }
  finally { ledger.close(); }
  await rm(root, { recursive: true });
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, ledgerPath, queuePath: join(directory, "queue.sqlite"), workerId: "fixture",
    limits: { maxClientInvocations: 0, maxParallel: 1 }, projects: { study: { root,
      summaryDirectory: join(directory, "summaries"), limits: { maxClientInvocations: 0, maxParallel: 1 } } } }));
  const requestPath = join(directory, "request.json");
  const request = { projectId: "study", workflowId: "historical-diagnostics", captureId: capture.eventId, captureDigest: capture.digest,
    notBefore: "2026-01-01T00:00:00.000Z", deadlineAt: "2099-01-01T00:00:00.000Z" };
  await writeFile(requestPath, JSON.stringify(request));
  const harness = openConfiguredHarness(await loadHarnessConfig(configPath));
  try {
    harness.queue.enqueue({ taskId: "unselected-summary", projectId: "study", kind: "project_summary", handlerVersion: "1",
      input: {}, dependencies: [], maxAttempts: 1, notBefore: request.notBefore, deadlineAt: request.deadlineAt });
  } finally { harness.close(); }
  const prepared = await command(0, "assessment-prepare", configPath, requestPath);
  assert.deepEqual(await command(0, "assessment-prepare", configPath, requestPath), prepared);
  assert.equal((await command(2, "assessment-advance", configPath, prepared.workflowObservationId)).status, "pending");
  const ran = await command(2, "assessment-run", configPath, prepared.workflowObservationId);
  assert.equal(ran.status, "evidence_required");
  assert.ok(ran.followups.workItems.length > 0);
  assert.ok(ran.followups.workItems.every((item: { state: string; executionAuthorized: boolean }) => item.state === "unresolved" && !item.executionAuthorized));
  assert.deepEqual(await command(2, "assessment-run", configPath, prepared.workflowObservationId), ran);
  const reopened = openConfiguredHarness(await loadHarnessConfig(configPath));
  try {
    assert.equal(reopened.queue.getBudget("global").consumedCalls, 0);
    assert.equal(reopened.queue.getTask("unselected-summary").state, "queued");
    assert.equal(reopened.queue.getTask(prepared.taskId).attempts, 1);
    assert.equal(reopened.ledger.listObservations("study").length, 4);
    assert.equal(reopened.ledger.listActions("study").length, 0);
    assert.equal(reopened.ledger.listRuns("study").length, 0);
  } finally { reopened.close(); }
});
