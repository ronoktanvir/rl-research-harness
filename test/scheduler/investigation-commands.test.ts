import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { loadCoworkerInvestigation } from "../../src/integrations/coworker/investigation.ts";
import { loadAssessmentFollowups } from "../../src/scheduler/assessment-workflow.ts";
import { verifyEvidencePacket } from "../../src/research/evidence.ts";
import type { CoworkerEvidenceUpdateRequest } from "../../src/scheduler/evidence-update.ts";
import { prepareCoworkerInvestigationRequest } from "../../src/integrations/coworker/investigation-worker.ts";

const execute = promisify(execFile);
const fixtureGenerator = fileURLToPath(new URL("../integrations/coworker_investigation_fixtures.py", import.meta.url));

/** Every command owns and closes its stores in a fresh process. No handler injection. */
async function command(python: string, expected: number, ...args: string[]) {
  let stdout: string, code = 0;
  try {
    const response = await execute(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      timeout: 30_000, maxBuffer: 1_000_000,
      // The capture reader selects python3 by PATH; the investigation worker binds
      // the same explicitly selected interpreter through trusted config.
      env: { ...process.env, PATH: `${dirname(python)}:${process.env.PATH ?? "/usr/bin:/bin"}` },
    });
    stdout = response.stdout;
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "number"
      || !("stdout" in error) || typeof error.stdout !== "string") throw error;
    code = error.code; stdout = error.stdout;
    if (code !== expected && "stderr" in error) assert.fail(`CLI exit ${code}; expected ${expected}: ${String(error.stderr)}`);
  }
  assert.equal(code, expected);
  return JSON.parse(stdout);
}

test("production investigation CLI joins capture and assessment, then restarts from receipts after source deletion", { timeout: 90_000 }, async t => {
  const selected = await execute("python3", ["-I", "-S", "-B", "-c", "import sys;assert sys.version_info >= (3,11);print(sys.executable)"], { timeout: 5000 });
  const python = selected.stdout.trim(); assert.ok(python.startsWith("/"));
  const directory = await realpath(await mkdtemp(join(tmpdir(), "harness-investigation-cli-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "source"); await mkdir(root);
  const generated = await execute(python, ["-I", "-S", "-B", fixtureGenerator, root, "cli"], { timeout: 5000, maxBuffer: 16_384 });
  const workerRequest = prepareCoworkerInvestigationRequest(JSON.parse(generated.stdout));
  const ledgerPath = join(directory, "ledger.sqlite"), configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, ledgerPath, queuePath: join(directory, "queue.sqlite"), workerId: "cli-fixture",
    investigationPythonExecutable: python, limits: { maxClientInvocations: 0, maxParallel: 1 },
    projects: { study: { root, summaryDirectory: join(directory, "summaries"), limits: { maxClientInvocations: 0, maxParallel: 1 } } } }));

  const capture = await command(python, 0, "capture", ledgerPath, "study", "synthetic-capture", root, workerRequest.report.path);
  assert.equal(capture.eventId, "synthetic-capture"); assert.equal(capture.runId, null);
  const eligibility = { notBefore: "2026-01-01T00:00:00.000Z", deadlineAt: "2099-01-01T00:00:00.000Z" };
  const assessmentRequestPath = join(directory, "assessment.json");
  await writeFile(assessmentRequestPath, JSON.stringify({ projectId: "study", workflowId: "cli-assessment", captureId: capture.eventId,
    captureDigest: capture.digest, ...eligibility }));
  const assessment = await command(python, 0, "assessment-prepare", configPath, assessmentRequestPath);
  const assessed = await command(python, 2, "assessment-run", configPath, assessment.workflowObservationId);
  assert.equal(assessed.status, "evidence_required"); assert.ok(assessed.followups.workItems.length > 0);

  const investigationRequestPath = join(directory, "investigation.json");
  await writeFile(investigationRequestPath, JSON.stringify({ workflowId: "cli-investigation", assessmentWorkflowObservationId: assessment.workflowObservationId,
    investigationId: "synthetic-inspection", localArtifacts: workerRequest.localArtifacts, ...eligibility }));
  const prepared = await command(python, 0, "investigation-prepare", configPath, investigationRequestPath);
  assert.deepEqual(await command(python, 0, "investigation-prepare", configPath, investigationRequestPath), prepared);
  assert.equal((await command(python, 2, "investigation-advance", configPath, prepared.workflowObservationId)).status, "pending");
  const inspected = await command(python, 2, "investigation-run", configPath, prepared.workflowObservationId);
  assert.equal(inspected.status, "evidence_required"); assert.equal(inspected.inspectionStatus, "completed");
  assert.equal(inspected.scientificEvaluation, "unassessed"); assert.equal(inspected.interventionAuthorized, false);
  assert.deepEqual(inspected.unresolvedWorkItems, assessed.followups.workItems.map((item: { workItemId: string }) => item.workItemId));

  const before = openExperimentLedger({ path: ledgerPath });
  let observationCount: number, receiptDigest: string, evidenceRequest: CoworkerEvidenceUpdateRequest;
  try {
    const receipt = loadCoworkerInvestigation(before, inspected.investigationObservationId);
    receiptDigest = receipt.digest; observationCount = before.listObservations("study").length;
    const execution = receipt.payload.execution;
    assert.ok(execution && typeof execution === "object" && !Array.isArray(execution));
    assert.equal(execution.status, "completed"); assert.equal(execution.reason, "verified_byte_correspondence_and_producer_counts");
    assert.equal(JSON.stringify(receipt).includes("SENTINEL"), false);
    const followups = loadAssessmentFollowups(before, assessment.workflowObservationId);
    assert.deepEqual(followups.workItems.map(item => item.workItemId), inspected.unresolvedWorkItems);
    const workflowRecord = before.getObservation(prepared.workflowObservationId)!;
    const followupsRecord = before.getObservation(followups.observationId)!;
    evidenceRequest = { projectId: "study", updateId: "cli-evidence-update",
      investigationWorkflow: { observationId: workflowRecord.eventId, observationDigest: workflowRecord.digest },
      investigation: { observationId: receipt.eventId, observationDigest: receipt.digest },
      followups: { observationId: followupsRecord.eventId, observationDigest: followupsRecord.digest } };
    assert.equal(before.listObservations("study").filter(item => item.source === "coworker-investigation-attempt.v1").length, 1);
    assert.equal(before.listRuns("study").length, 0); assert.equal(before.listActions("study").length, 0);
  } finally { before.close(); }

  const evidenceRequestPath = join(directory, "evidence-update.json");
  await writeFile(evidenceRequestPath, JSON.stringify(evidenceRequest));
  const queueBeforeEvidence = await command(python, 0, "queue-status", configPath);
  const updated = await command(python, 2, "evidence-update", configPath, evidenceRequestPath);
  assert.equal(updated.status, "evidence_required"); assert.equal(updated.decisionScope, "prospective_research_action_planning");
  assert.equal(updated.executionAuthorized, false); assert.equal(updated.scientificEvaluation, "unassessed");
  assert.ok(updated.criteria.some((criterion: { status: string }) => criterion.status === "supported"));
  assert.ok(updated.criteria.some((criterion: { status: string }) => criterion.status === "not_established"));
  assert.ok(updated.originalRequests.every((item: { originalRequestUnresolved: boolean }) => item.originalRequestUnresolved === true));
  assert.ok(updated.originalRequests.some((item: { disposition: string }) => item.disposition === "partially_supported"));
  assert.deepEqual(await command(python, 2, "evidence-status", configPath, updated.updateObservationId), updated);

  const packetPath = join(directory, "planning-packet.json");
  const exported = await command(python, 0, "evidence-packet", configPath, updated.updateObservationId, packetPath);
  assert.equal(exported.packetDigest, updated.packetDigest); assert.equal(exported.executionAuthorized, false);
  assert.equal(exported.decisionScope, updated.decisionScope); assert.equal(exported.scientificEvaluation, "unassessed");
  const packetBytes = await readFile(packetPath, "utf8"), packet = verifyEvidencePacket(JSON.parse(packetBytes));
  assert.equal(packet.digest, updated.packetDigest); assert.equal(Object.hasOwn(packet, "packet"), false);
  assert.equal(JSON.stringify(packet).includes("SENTINEL"), false);
  const scope = JSON.parse(packet.evidence.find(item => item.id === "planning:scope")!.summary);
  assert.equal(scope.executionAuthorized, false); assert.equal(scope.interventionAuthorized, false);
  assert.equal(scope.scientificEvaluation, "unassessed");
  assert.deepEqual(await command(python, 0, "evidence-packet", configPath, updated.updateObservationId, packetPath), exported);

  const existingPath = join(directory, "keep-existing.json"), existingBytes = '{"sentinel":"must not be replaced"}\n';
  await writeFile(existingPath, existingBytes);
  await assert.rejects(execute(process.execPath, ["--import", "tsx", "src/cli.ts", "evidence-packet", configPath, updated.updateObservationId, existingPath],
    { timeout: 30_000, maxBuffer: 1_000_000, env: { ...process.env, PATH: `${dirname(python)}:${process.env.PATH ?? "/usr/bin:/bin"}` } }),
  error => !!error && typeof error === "object" && "code" in error && error.code === 1);
  assert.equal(await readFile(existingPath, "utf8"), existingBytes);
  const queueAfterEvidence = await command(python, 0, "queue-status", configPath);
  const { globalAuthority: originalAuthority, ...originalQueueState } = queueBeforeEvidence;
  const { globalAuthority: evidenceAuthority, ...evidenceQueueState } = queueAfterEvidence;
  assert.deepEqual(evidenceQueueState, originalQueueState);
  // Each exclusive-owner reopen advances the ledger fencing epoch; this does
  // not enqueue work or change the durable stop state.
  assert.ok(evidenceAuthority.epoch > originalAuthority.epoch);
  assert.equal(evidenceAuthority.stopped, originalAuthority.stopped);
  assert.equal(evidenceAuthority.reason, originalAuthority.reason);

  await rm(root, { recursive: true });
  // Fresh processes must recover exact evidence. A new filesystem inspection
  // would now fail because every selected source and artifact has been deleted.
  assert.deepEqual(await command(python, 2, "investigation-run", configPath, prepared.workflowObservationId), inspected);
  const advanced = await command(python, 2, "investigation-advance", configPath, prepared.workflowObservationId);
  const { stopPersisted: _, ...withoutRunnerStatus } = inspected;
  assert.deepEqual(advanced, withoutRunnerStatus);
  assert.deepEqual(await command(python, 2, "evidence-update", configPath, evidenceRequestPath), updated);
  assert.deepEqual(await command(python, 2, "evidence-status", configPath, updated.updateObservationId), updated);
  assert.deepEqual(await command(python, 0, "evidence-packet", configPath, updated.updateObservationId, packetPath), exported);
  assert.equal(await readFile(packetPath, "utf8"), packetBytes);
  const recoveredPacketPath = join(directory, "planning-packet-after-restart.json");
  const reexported = await command(python, 0, "evidence-packet", configPath, updated.updateObservationId, recoveredPacketPath);
  assert.equal(reexported.packetDigest, exported.packetDigest); assert.equal(await readFile(recoveredPacketPath, "utf8"), packetBytes);
  const queue = await command(python, 0, "queue-status", configPath);
  const { globalAuthority: restoredAuthority, ...restoredQueueState } = queue;
  assert.deepEqual(restoredQueueState, originalQueueState);
  assert.ok(restoredAuthority.epoch > evidenceAuthority.epoch);
  assert.equal(restoredAuthority.stopped, originalAuthority.stopped);
  assert.equal(queue.invocationLimits[0].consumedCalls, 0);
  assert.equal(queue.recentTasks.find((task: { taskId: string }) => task.taskId === prepared.taskId).attempts, 1);
  const after = openExperimentLedger({ path: ledgerPath });
  try {
    assert.equal(after.listObservations("study").length, observationCount + 1);
    assert.equal(after.getObservation(updated.updateObservationId)?.digest, updated.observationDigest);
    assert.equal(after.listObservations("study").filter(item => item.source === "coworker-evidence-update.v1").length, 1);
    assert.equal(loadCoworkerInvestigation(after, inspected.investigationObservationId).digest, receiptDigest);
    assert.equal(after.listRuns("study").length, 0); assert.equal(after.listActions("study").length, 0);
  } finally { after.close(); }
});
