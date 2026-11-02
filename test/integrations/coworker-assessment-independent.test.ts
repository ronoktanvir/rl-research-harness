import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { captureCoworkerReport } from "../../src/integrations/coworker/capture.ts";
import { assessCoworkerCapture } from "../../src/integrations/coworker/assessment.ts";

test("invalid producer step indices cannot disappear into a passed ordered-series check", async t => {
  const root = await mkdtemp(join(tmpdir(), "coworker-assessment-review-"));
  const ledger = openExperimentLedger({ path: join(root, "ledger.sqlite") });
  t.after(async () => { ledger.close(); await rm(root, { recursive: true, force: true }); });
  const valid = { step_index: 0, loss: 1, grad_norm: 0.5, optimizer_step_applied: true, post_update_serve_ok: true };
  for (const [index, badIndex] of ["-1", '"1"', "NaN"].entries()) {
    await writeFile(join(root, "report.json"), `{"config":{},"steps":[${JSON.stringify(valid)},{"step_index":${badIndex},"loss":1,"grad_norm":0.5}]}`);
    const capture = await captureCoworkerReport(ledger, { captureId: `capture-${index}`, projectId: "study", root,
      reportPath: "report.json", observedAt: "2026-11-02T12:00:00.000Z" });
    const assessment = assessCoworkerCapture(capture, { projectId: "study", captureId: capture.eventId, captureDigest: capture.digest });
    assert.equal(assessment.coverage.stepEntries, 1, "the sanitized projection omits the invalid-index step");
    assert.equal(assessment.findings.find(finding => finding.ruleId === "step-integrity")?.status, "triggered", badIndex);
    assert.equal(assessment.packet.checks.find(check => check.id === "step-integrity")?.status, "failed", badIndex);
    assert.ok(assessment.requests.some(request => request.kind === "inspect_step_order"), badIndex);
  }
});
