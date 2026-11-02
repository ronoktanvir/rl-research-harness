import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { loadHarnessConfig, openConfiguredHarness } from "../../src/scheduler/config.ts";
import type { JsonObject } from "../../src/ledger/types.ts";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const cli = join(root, "src/cli.ts");
interface CliOutput { state?: string; taskCount?: number; executed?: { taskId: string; state: string }[]; invocationLimits?: { consumedCalls: number }[] }
async function run(...args: string[]): Promise<CliOutput> {
  const result = await exec(process.execPath, ["--import", "tsx", cli, ...args], { cwd: root, timeout: 15_000 });
  return JSON.parse(result.stdout);
}

test("separate CLI processes enqueue and finish a local summary with no client invocation allowance", async t => {
  const directory = await mkdtemp(join(tmpdir(), "harness-commands-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configuration = join(directory, "config.json"), taskFile = join(directory, "task.json");
  await writeFile(configuration, JSON.stringify({ schemaVersion: 1, ledgerPath: "ledger.sqlite", queuePath: "queue.sqlite", workerId: "fixture",
    limits: { maxClientInvocations: 0, maxParallel: 1 }, projects: { study: {
      root: "project", summaryDirectory: "summaries", limits: { maxClientInvocations: 0, maxParallel: 1 },
    } } }));
  const task = { taskId: "summary", projectId: "study", kind: "project_summary", handlerVersion: "1", input: {},
    dependencies: [], maxAttempts: 1, notBefore: "2026-01-01T00:00:00.000Z", deadlineAt: "2099-01-01T00:00:00.000Z" };
  await writeFile(taskFile, JSON.stringify(task));
  assert.equal((await run("queue-enqueue", configuration, taskFile)).state, "queued");
  const drain = await run("queue-run", configuration, "1");
  assert.deepEqual(drain.executed, [{ taskId: "summary", state: "completed" }]);
  assert.equal(drain.invocationLimits![0]!.consumedCalls, 0);
  assert.equal((await run("queue-run", configuration, "1")).executed!.length, 0);
  const harness = openConfiguredHarness(await loadHarnessConfig(configuration));
  try {
    const completed = harness.queue.getTask("summary");
    const result = completed.result!.artifact as JsonObject;
    // The artifact path is produced by the trusted configured handler, not task input.
    assert.equal(typeof result.markdownPath, "string");
    assert.match(await readFile(result.markdownPath as string, "utf8"), /study/);
    assert.equal(dirname(dirname(result.markdownPath as string)), join(directory, "summaries"));
    assert.equal(harness.ledger.listRuns("study").length, 0);
  } finally { harness.close(); }
  await writeFile(taskFile, JSON.stringify({ ...task, taskId: "injected-root", input: { root: "/untrusted" } }));
  await assert.rejects(run("queue-enqueue", configuration, taskFile));
  assert.equal((await run("queue-status", configuration)).taskCount, 1);
});
