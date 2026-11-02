import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { captureCoworkerReport } from "../../src/integrations/coworker/capture.ts";

const execute = promisify(execFile);
test("assessment CLI persists diagnostic requests across restart without rereading the original project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-assessment-cli-")), root = join(directory, "project"), path = join(directory, "ledger.sqlite");
  let ledger = openExperimentLedger({ path });
  try {
    await mkdir(root);
    await writeFile(join(root, "report.json"), JSON.stringify({ config: { steps: 2 }, steps: [
      { step_index: 0, loss: 1, grad_norm: 1, optimizer_step_applied: true, post_update_serve_ok: true },
      { step_index: 1, loss: .5, grad_norm: .2, optimizer_step_applied: false, post_update_serve_ok: false },
    ] }));
    await captureCoworkerReport(ledger, { projectId: "study", captureId: "captured", root, reportPath: "report.json" });
    ledger.close(); await rm(root, { recursive: true });
    const args = ["--import", "tsx", "src/cli.ts", "coworker-assess", path, "study", "captured"];
    const first = JSON.parse((await execute(process.execPath, args, { timeout: 10_000 })).stdout);
    const second = JSON.parse((await execute(process.execPath, args, { timeout: 10_000 })).stdout);
    assert.deepEqual(second, first);
    assert.equal(first.assessment.outcome, "integrity_issues_observed");
    assert.equal(first.assessment.interventionAuthorized, false);
    assert.ok(first.assessment.requests.some((request: { kind: string }) => request.kind === "inspect_serving"));
    await assert.rejects(execute(process.execPath, [...args.slice(0, -2), "another-project", "captured"], { timeout: 10_000 }), /identity|mismatch/);
    ledger = openExperimentLedger({ path });
    assert.equal(ledger.listObservations("study").length, 2);
    assert.equal(ledger.listRuns("study").length, 0);
    assert.equal(ledger.listActions("study").length, 0);
  } finally { ledger.close(); await rm(directory, { recursive: true, force: true }); }
});
