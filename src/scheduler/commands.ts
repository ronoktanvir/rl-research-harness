import { randomUUID } from "node:crypto";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadHarnessConfig, openConfiguredHarness, readBoundedJson } from "./config.ts";
import { enqueueResearchTask, ledgerAuthority, runNextResearchTask } from "./runner.ts";
import { aggregateReportReviews, loadReportReviewPlan, prepareReportReviews } from "./report-review.ts";
import { writeDecisionArtifacts } from "../research/artifacts.ts";
import type { ReportReviewRequest } from "./report-review.ts";
import type { ConfiguredHarness } from "./config.ts";
import type { EnqueueTaskInput, ReleaseResourceInput, ResumeTaskInput } from "./types.ts";
import { advanceCouncilCampaign, prepareCouncilCampaign, runCouncilCampaign } from "./council-workflow.ts";
import { loadCouncilPlan } from "./council-contracts.ts";
import type { CouncilPlanRequest } from "./council-contracts.ts";
import { buildLiteratureEvidencePacket, discoverArxiv, getArxivAvailability, releaseArxivHold } from "../literature/index.ts";
import type { ArxivDiscoveryRequest, LiteraturePacketRequest, ReleaseArxivHoldRequest } from "../literature/types.ts";
import { hash } from "../ledger/validation.ts";
import { advanceAssessmentWorkflow, loadAssessmentWorkflow, prepareAssessmentWorkflow, runAssessmentWorkflow } from "./assessment-workflow.ts";
import type { AssessmentWorkflowRequest } from "./assessment-workflow.ts";
import { advanceInvestigationWorkflow, loadInvestigationWorkflow, prepareInvestigationWorkflow, runInvestigationWorkflow } from "./investigation-workflow.ts";
import type { InvestigationWorkflowRequest } from "./investigation-workflow.ts";

export const QUEUE_USAGE = `Persistent research tasks (configured official-client invocation limits apply):
  npm run harness -- queue-status <config.json>
  npm run harness -- queue-enqueue <config.json> <task.json>
  npm run harness -- queue-run <config.json> <maximum-tasks>
  npm run harness -- queue-cancel <config.json> <task-id> <reason>
  npm run harness -- queue-resume <config.json> <resume-request.json>
  npm run harness -- queue-release-resource <config.json> <release-request.json>
  npm run harness -- report-review-prepare <config.json> <request.json>
  npm run harness -- report-review-aggregate <config.json> <plan-observation-id> <output-directory>
  npm run harness -- council-prepare <config.json> <request.json>
  npm run harness -- council-advance <config.json> <plan-observation-id>
  npm run harness -- council-run <config.json> <plan-observation-id> <maximum-tasks> <output-directory>
  npm run harness -- assessment-prepare <config.json> <request.json>
  npm run harness -- assessment-advance <config.json> <workflow-observation-id>
  npm run harness -- assessment-run <config.json> <workflow-observation-id>
  npm run harness -- investigation-prepare <config.json> <request.json>
  npm run harness -- investigation-advance <config.json> <workflow-observation-id>
  npm run harness -- investigation-run <config.json> <workflow-observation-id>
  npm run harness -- literature-discover <config.json> <request.json>
  npm run harness -- literature-packet <config.json> <query-observation-id> <request.json> <output.json>
  npm run harness -- literature-status <config.json>
  npm run harness -- literature-release <config.json> <release-request.json>

queue-run drains currently eligible work up to its bound. It does not spin while
waiting for quota/authentication or repeat interrupted calls. SIGINT/SIGTERM writes
the ledger stop barrier before asking active work to cancel. There is no TCP service.
`;

const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));

function maximum(value: string): number {
  const number = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(number) || number > 1000) throw new Error("maximum-tasks must be an integer from 1 to 1,000");
  return number;
}
function configuredProject(harness: ConfiguredHarness, projectId: string): void {
  if (!Object.hasOwn(harness.config.projects, projectId)) throw new Error("Project has no trusted controller configuration");
}
function runnerSignal(harness: ConfiguredHarness) {
  const abort = new AbortController();
  let stopPersisted: boolean | null = null;
  const stop = () => {
    try {
      const global = harness.ledger.getScope("global");
      harness.ledger.stopScope({ scopeId: "global", expectedEpoch: global.epoch, reason: "Operator interrupted the research runner" });
      stopPersisted = true;
    } catch { stopPersisted = false; }
    finally { abort.abort(); }
  };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  return { signal: abort.signal, status: () => stopPersisted,
    close() { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); } };
}

async function savePacket(path: string, packet: unknown): Promise<string> {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(destination), `.packet-${randomUUID()}`);
  try {
    await writeFile(temporary, `${JSON.stringify(packet, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    try { await link(temporary, destination); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")
        || hash(await readBoundedJson(destination, 2_000_000)) !== hash(packet)) throw error;
    }
  } finally { await rm(temporary, { force: true }); }
  return destination;
}

function summary(harness: ConfiguredHarness) {
  const tasks = harness.queue.listTasks();
  const states: Record<string, number> = {};
  for (const task of tasks) states[task.state] = (states[task.state] ?? 0) + 1;
  return { taskCount: tasks.length, states, globalAuthority: harness.ledger.getScope("global"),
    invocationLimits: [harness.queue.getBudget("global"), ...Object.keys(harness.config.projects).map(projectId => harness.queue.getBudget(`project:${projectId}`))],
    resourceHolds: harness.queue.listResourceHolds(),
    recentTasks: tasks.slice(-30).map(({ taskId, projectId, kind, state, attempts, currentAttemptId }) => ({ taskId, projectId, kind, state, attempts, currentAttemptId })) };
}

/** Operator entry points. Callers cannot install executable handlers through task JSON. */
export async function queueCommand(args: string[]): Promise<number | null> {
  const [command, ...rest] = args;
  const arity: Record<string, number> = { "queue-status": 1, "queue-enqueue": 2, "queue-run": 2,
    "queue-cancel": 3, "queue-resume": 2, "queue-release-resource": 2,
    "report-review-prepare": 2, "report-review-aggregate": 3,
    "council-prepare": 2, "council-advance": 2, "council-run": 4,
    "assessment-prepare": 2, "assessment-advance": 2, "assessment-run": 2,
    "investigation-prepare": 2, "investigation-advance": 2, "investigation-run": 2,
    "literature-discover": 2, "literature-packet": 4, "literature-status": 1, "literature-release": 2 };
  if (!command || !Object.hasOwn(arity, command)) return null;
  if (rest.length !== arity[command]) throw new Error(`Invalid research queue arguments.\n${QUEUE_USAGE}`);
  const config = await loadHarnessConfig(rest[0]!);
  const harness = openConfiguredHarness(config);
  try {
    if (command === "queue-status") { output(summary(harness)); return 0; }
    if (command === "investigation-prepare") {
      const request = await readBoundedJson(rest[1]!, 16_384) as InvestigationWorkflowRequest;
      const assessment = loadAssessmentWorkflow(harness.ledger, request.assessmentWorkflowObservationId);
      configuredProject(harness, assessment.request.projectId);
      const plan = prepareInvestigationWorkflow(harness.ledger, harness.queue, harness.handlers, request);
      output({ workflowObservationId: plan.observationId, workflowDigest: plan.digest, taskId: plan.task.taskId }); return 0;
    }
    if (command === "investigation-advance" || command === "investigation-run") {
      const plan = loadInvestigationWorkflow(harness.ledger, rest[1]!);
      configuredProject(harness, plan.projectId);
      if (command === "investigation-advance") {
        output(advanceInvestigationWorkflow(harness.ledger, harness.queue, plan.observationId)); return 2;
      }
      const control = runnerSignal(harness);
      try {
        const progress = await runInvestigationWorkflow(harness.ledger, harness.queue, harness.handlers, plan.observationId,
          { workerId: config.workerId, signal: control.signal, maxExecutionMs: 180_000 });
        output({ ...progress, stopPersisted: control.status() });
        return control.status() === false ? 1 : 2;
      } finally { control.close(); }
    }
    if (command === "assessment-prepare") {
      const request = await readBoundedJson(rest[1]!) as AssessmentWorkflowRequest;
      configuredProject(harness, request.projectId);
      const plan = prepareAssessmentWorkflow(harness.ledger, harness.queue, harness.handlers, request);
      output({ workflowObservationId: plan.observationId, workflowDigest: plan.digest, taskId: plan.task.taskId }); return 0;
    }
    if (command === "assessment-advance" || command === "assessment-run") {
      const plan = loadAssessmentWorkflow(harness.ledger, rest[1]!);
      configuredProject(harness, plan.request.projectId);
      if (command === "assessment-advance") {
        const progress = advanceAssessmentWorkflow(harness.ledger, harness.queue, plan.observationId);
        output(progress); return 2;
      }
      const control = runnerSignal(harness);
      try {
        const progress = await runAssessmentWorkflow(harness.ledger, harness.queue, harness.handlers, plan.observationId,
          { workerId: config.workerId, signal: control.signal });
        output({ ...progress, stopPersisted: control.status() });
        // Successful assessment still leaves scientific evidence requests unresolved.
        return control.status() === false ? 1 : 2;
      } finally { control.close(); }
    }
    if (command === "literature-status") { output(getArxivAvailability(harness.ledger)); return 0; }
    if (command === "literature-release") {
      const released = releaseArxivHold(harness.ledger, await readBoundedJson(rest[1]!) as ReleaseArxivHoldRequest);
      output({ releaseObservationId: released.eventId, availability: getArxivAvailability(harness.ledger) }); return 0;
    }
    if (command === "council-prepare") {
      const request = await readBoundedJson(rest[1]!) as CouncilPlanRequest;
      configuredProject(harness, request.projectId);
      const plan = prepareCouncilCampaign(harness.ledger, request);
      output({ planObservationId: plan.planObservationId, planDigest: plan.planDigest,
        progress: await advanceCouncilCampaign(harness.ledger, harness.queue, harness.handlers, plan.planObservationId) }); return 0;
    }
    if (command === "council-advance" || command === "council-run") {
      const plan = loadCouncilPlan(harness.ledger, rest[1]!);
      configuredProject(harness, plan.request.projectId);
      if (command === "council-advance") {
        const progress = await advanceCouncilCampaign(harness.ledger, harness.queue, harness.handlers, plan.planObservationId);
        output(progress); return progress.status === "complete" ? 0 : 2;
      }
      const maximumTasks = maximum(rest[2]!);
      const control = runnerSignal(harness);
      try {
        const result = await runCouncilCampaign(harness.ledger, harness.queue, harness.handlers, plan.planObservationId,
          maximumTasks, { workerId: config.workerId, signal: control.signal });
        const artifacts = result.progress.status === "complete" ? await writeDecisionArtifacts(rest[3]!, result.progress.decision) : null;
        output({ ...result, stopPersisted: control.status(), artifacts });
        if (control.status() === false) return 1;
        return result.progress.status === "complete" ? 0 : 2;
      } finally { control.close(); }
    }
    if (command === "literature-discover") {
      const request = await readBoundedJson(rest[1]!) as ArxivDiscoveryRequest;
      configuredProject(harness, request.projectId);
      if (ledgerAuthority(harness.ledger, request.projectId).stopped) throw new Error("Literature retrieval is stopped by controller authority");
      const control = runnerSignal(harness);
      try {
        const discovery = await discoverArxiv(harness.ledger, request, { signal: control.signal });
        output(discovery);
        return control.status() === false ? 1 : discovery.status === "complete" ? 0 : 2;
      } finally { control.close(); }
    }
    if (command === "literature-packet") {
      const packet = buildLiteratureEvidencePacket(harness.ledger, rest[1]!, await readBoundedJson(rest[2]!) as LiteraturePacketRequest);
      output({ path: await savePacket(rest[3]!, packet), packetDigest: packet.digest, evidenceCount: packet.evidence.length }); return 0;
    }
    if (command === "report-review-prepare") {
      const plan = prepareReportReviews(harness.ledger, harness.queue, harness.handlers,
        await readBoundedJson(rest[1]!) as ReportReviewRequest);
      output({ planObservationId: plan.planObservationId, planDigest: plan.planDigest,
        packetDigest: plan.packet.digest, taskIds: plan.reviews.map(review => review.task.taskId) }); return 0;
    }
    if (command === "report-review-aggregate") {
      const plan = loadReportReviewPlan(harness.ledger, rest[1]!);
      const result = await aggregateReportReviews(harness.ledger, harness.queue, plan);
      if (result.status === "pending") { output(result); return 2; }
      const artifacts = await writeDecisionArtifacts(rest[2]!, result.decision);
      output({ status: result.decision.status, stopReason: result.decision.stopReason,
        blockers: result.decision.blockers, artifacts }); return 0;
    }
    if (command === "queue-enqueue") {
      const task = enqueueResearchTask(harness.queue, harness.handlers, await readBoundedJson(rest[1]!) as EnqueueTaskInput);
      output({ taskId: task.taskId, state: task.state, inputDigest: task.inputDigest }); return 0;
    }
    if (command === "queue-cancel") {
      const task = harness.queue.cancelTask({ commandId: `operator:${randomUUID()}`, taskId: rest[1]!, reason: rest[2]! });
      output({ taskId: task.taskId, state: task.state, cancelRequested: task.cancelRequested }); return 0;
    }
    if (command === "queue-resume") {
      const task = harness.queue.resumeTask(await readBoundedJson(rest[1]!) as ResumeTaskInput);
      output({ taskId: task.taskId, state: task.state, eligibleAt: task.eligibleAt }); return 0;
    }
    if (command === "queue-release-resource") {
      output(harness.queue.releaseResource(await readBoundedJson(rest[1]!) as ReleaseResourceInput)); return 0;
    }
    const maximumTasks = maximum(rest[1]!);
    const control = runnerSignal(harness);
    const executed: { taskId: string; state: string }[] = [];
    try {
      for (let index = 0; index < maximumTasks && !control.signal.aborted; index++) {
        const task = await runNextResearchTask(harness.queue, harness.handlers, { workerId: config.workerId, signal: control.signal });
        if (!task) break;
        executed.push({ taskId: task.taskId, state: task.state });
      }
    } finally { control.close(); }
    const status = summary(harness);
    output({ executed, stopPersisted: control.status(), ...status });
    if (control.status() === false) return 1;
    return Object.entries(status.states).some(([state, count]) => count && state !== "completed") ? 2 : 0;
  } finally { harness.close(); }
}
