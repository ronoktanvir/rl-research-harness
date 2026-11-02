import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { hash } from "../../src/ledger/validation.ts";
import { captureCoworkerReport } from "../../src/integrations/coworker/capture.ts";
import { COWORKER_INVESTIGATION_LAYOUT, COWORKER_INVESTIGATION_LIMITS, validateCoworkerInvestigationExecution } from "../../src/integrations/coworker/investigation-worker.ts";
import type { CoworkerInvestigationExecution, CoworkerInvestigationRequest as WorkerRequest, CoworkerInvestigationWorkerDescriptor,
  CoworkerInvestigationResult, InvestigationCell, InvestigationFile } from "../../src/integrations/coworker/investigation-worker.ts";
import type { CoworkerInvestigationRequest } from "../../src/integrations/coworker/investigation.ts";

export const INVESTIGATION_TIME = "2026-11-02T12:00:00.000Z";
export const SYNTHETIC_WORKER: CoworkerInvestigationWorkerDescriptor = { name: "coworker-run1-investigation", version: 1,
  sourceSha256: "f".repeat(64), pythonExecutable: "/usr/bin/python3", timeoutMs: 1000, limits: COWORKER_INVESTIGATION_LIMITS };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const file = (path: string, sha256 = "a".repeat(64)): InvestigationFile => ({ path, sha256, bytes: 10 });

/** Synthetic typed output only; it does not claim these fixture files were inspected. */
export function syntheticInvestigationExecution(request: WorkerRequest, descriptor = SYNTHETIC_WORKER, complete = true): CoworkerInvestigationExecution {
  const base = dirname(request.localArtifacts.trainedEvaluationDirectory), tree = "d".repeat(64);
  const cell = (name: "trained" | "baseline"): InvestigationCell => {
    const directory = request.localArtifacts[name === "trained" ? "trainedEvaluationDirectory" : "baselineEvaluationDirectory"];
    return { plan: file(`${directory}/cell-plan.json`), summary: file(`${directory}/cell-summary.json`),
      judgedResults: file(`${directory}/step0-judged-results.jsonl`), traces: file(request.localArtifacts[name === "trained" ? "trainedTracePath" : "baselineTracePath"]),
      rows: 1, uniqueWorlds: 1, uniqueTraceIds: 1, uniqueResultIds: 1, exactJudgedTraceJoin: true,
      producerCompleteCount: 1, producerStatusOkCount: 1, producerStatusOtherCount: 0, producerErrorCount: 0,
      producerTargetsCredited: 0, producerCleanSuccessCount: 0, producerCreditHistogram: [1, 0, 0], summaryRan: 1, summaryResumedFrom: 0,
      summaryScoredTotal: 1, storedFunnelDenominator: 2, storedFunnelRate: 0, setFingerprint: "b".repeat(64),
      selectedPolicySettingsSha256: "c".repeat(64), adapterSha256: name === "trained" ? "a".repeat(64) : sha(""),
      runtimeSourceSha: "c".repeat(40), baseModelRevision: "e".repeat(40), tokenizerSha256: "e".repeat(64), schemaContractHash: "f".repeat(64) };
  };
  const result: CoworkerInvestigationResult = { schemaVersion: 1, kind: "coworker-run1-investigation-result", requestDigest: request.requestDigest,
    report: request.report, runManifest: file(request.report.path.replace(/report\.json$/u, "run-manifest.json")),
    revisions: file("history/halluminate/revisions.json"), archiveTree: file(`history/halluminate/trees/${tree}.json`, tree),
    adapter: file(request.localArtifacts.adapterPath), checksums: file(`${base}/SHA256SUMS`), funnel: file(`${base}/funnel.json`),
    source: { commit: "ccfd25df63f55e408b67e984710eb6d3dd9e609f", archiveTreeId: tree, pythonFiles: 1, pythonBytes: 10,
      pythonSourceSha256: "b".repeat(64), gitBlobIdsVerified: true }, cells: { trained: cell("trained"), baseline: cell("baseline") },
    trainingConfigCount: 1, evaluationConfigCount: 1, configOverlapCount: 0, sameEvaluationWorlds: true, sameSelectedPolicySettings: true,
    producerCreditedDifference: 0, scientificReplicationCount: 1, comparator: "bare_base", scientificEvaluation: "unassessed", historicalExecution: "unverified" };
  const reason = "verified_byte_correspondence_and_producer_counts" as const;
  const observations = complete ? [
    { check: "report" as const, status: "verified" as const, reason, files: [result.report, result.runManifest] },
    { check: "source" as const, status: "verified" as const, reason, files: [result.revisions, result.archiveTree] },
    { check: "adapter" as const, status: "verified" as const, reason, files: [result.adapter] },
    { check: "trained_evaluation" as const, status: "verified" as const, reason,
      files: [result.checksums, result.funnel, result.cells.trained.plan, result.cells.trained.summary, result.cells.trained.judgedResults, result.cells.trained.traces] },
    { check: "baseline_evaluation" as const, status: "verified" as const, reason,
      files: [result.cells.baseline.plan, result.cells.baseline.summary, result.cells.baseline.judgedResults, result.cells.baseline.traces] },
    { check: "comparison" as const, status: "verified" as const, reason, files: [] },
  ] : [{ check: "report" as const, status: "failed" as const, reason: "missing_file" as const, files: [] }];
  return validateCoworkerInvestigationExecution({ schemaVersion: 1, request, descriptor, status: complete ? "completed" : "incomplete",
    reason: complete ? reason : "missing_file", process: { exitCode: 0, stopped: null, stdoutSha256: sha(""), stdoutBytes: 0, stderrSha256: sha(""), stderrBytes: 0 },
    observations, result: complete ? result : null, resultSha256: complete ? hash(result) : null }, request, descriptor);
}

export async function investigationArchiveFixture(t: TestContext, revision = "ccfd25df63f55e408b67e984710eb6d3dd9e609f") {
  const directory = await mkdtemp(join(tmpdir(), "coworker-investigation-archive-"));
  const root = join(await realpath(directory), "project"), reportPath = COWORKER_INVESTIGATION_LAYOUT.reportPath;
  await mkdir(dirname(join(root, reportPath)), { recursive: true });
  await writeFile(join(root, reportPath), JSON.stringify({ runtime_source_sha: revision, source_tree_digest: "b".repeat(64),
    base_revision: "c".repeat(40), config: { steps: 1, training_seed: 11 }, steps: [{ step_index: 0, loss: 1 }] }));
  const path = join(directory, "ledger.sqlite"), now = () => new Date(INVESTIGATION_TIME);
  let ledger = openExperimentLedger({ path, now });
  t.after(async () => { ledger.close(); await rm(directory, { recursive: true, force: true }); });
  const capture = await captureCoworkerReport(ledger, { captureId: "captured-report", projectId: "study", root, reportPath, observedAt: INVESTIGATION_TIME });
  const { adapterPath, trainedTracePath, baselineTracePath, trainedEvaluationDirectory, baselineEvaluationDirectory } = COWORKER_INVESTIGATION_LAYOUT;
  const request: CoworkerInvestigationRequest = { projectId: "study", investigationId: "inspection-one", captureId: capture.eventId, captureDigest: capture.digest,
    localArtifacts: { adapterPath, trainedTracePath, baselineTracePath, trainedEvaluationDirectory, baselineEvaluationDirectory } };
  return { root, request, capture, now, ledger: () => ledger, reopen() { ledger.close(); ledger = openExperimentLedger({ path, now }); } };
}
