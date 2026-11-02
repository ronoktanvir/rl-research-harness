import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { captureCoworkerReport } from "../../src/integrations/coworker/capture.ts";
import { openTaskQueue } from "../../src/scheduler/index.ts";
import { createResearchTaskHandlers } from "../../src/scheduler/handlers.ts";
import { prepareReportReviews } from "../../src/scheduler/report-review.ts";
import type { ReportReviewPlan } from "../../src/scheduler/report-review.ts";

async function planFromReport(report: unknown, inspect: (plan: ReportReviewPlan) => void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "report-review-independent-")), root = join(directory, "project");
  await mkdir(root); await writeFile(join(root, "report.json"), JSON.stringify(report));
  const ledger = openExperimentLedger({ path: join(directory, "ledger.sqlite") });
  const queue = openTaskQueue({ path: join(directory, "queue.sqlite"), authority: () => ({ globalEpoch: ledger.getScope("global").epoch, projectEpoch: null, stopped: false }) });
  try {
    await captureCoworkerReport(ledger, { captureId: "capture", projectId: "study", root, reportPath: "report.json" });
    const handlers = createResearchTaskHandlers({ ledger, projects: { study: { root, summaryDirectory: join(directory, "summary") } }, review: async () => { throw new Error("No review invocation permitted"); } });
    inspect(prepareReportReviews(ledger, queue, handlers, { projectId: "study", campaignId: "audit", captureId: "capture",
      reviewers: [{ id: "methods", role: "Assess supporting evidence and missing controls", backend: "codex", model: null }],
      notBefore: "2026-01-01T00:00:00.000Z", deadlineAt: "2099-01-01T00:00:00.000Z" }));
  } finally { queue.close(); ledger.close(); await rm(directory, { recursive: true, force: true }); }
}

test("producer checkpoint hashes accepted by the capture reader remain reviewable in their original case", async () => {
  const producerDigest = "ABCDEF01".repeat(8);
  await planFromReport({ config: {}, steps: [{ step_index: 0, loss: 0.1, grad_norm: 1, checkpoint: { adapter_sha256: producerDigest } }] }, plan => {
    const metrics = JSON.parse(plan.packet.evidence.find(item => item.id === "capture:metrics")!.summary);
    assert.equal(metrics.steps[0].checkpointReported.adapterSha256, producerDigest);
  });
});

test("diagnostic compaction preserves later severe errors even when step sampling omits that entry", async () => {
  const steps = Array.from({ length: 40 }, (_, step_index) => step_index < 20
    ? { step_index }
    : { step_index, loss: 0.1, grad_norm: 1, post_update_serve_ok: step_index !== 20 });
  await planFromReport({ config: {}, steps }, plan => {
    const metrics = JSON.parse(plan.packet.evidence.find(item => item.id === "capture:metrics")!.summary);
    assert.equal(metrics.steps.some((step: { stepIndex: number }) => step.stepIndex === 20), false);
    const diagnostics = plan.packet.evidence.find(item => item.id === "capture:diagnostics")!.summary;
    assert.match(diagnostics, /serving_check_failed/, "Prefix sampling must not hide all evidence of a severe middle-step failure");
  });
});
