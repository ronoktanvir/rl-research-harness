import { randomUUID } from "node:crypto";
import { loadHarnessConfig, openConfiguredHarness, readBoundedJson } from "./config.ts";
import { enqueueResearchTask, runNextResearchTask } from "./runner.ts";
import { aggregateReportReviews, loadReportReviewPlan, prepareReportReviews } from "./report-review.ts";
import { writeDecisionArtifacts } from "../research/artifacts.ts";
import type { ReportReviewRequest } from "./report-review.ts";
import type { ConfiguredHarness } from "./config.ts";
import type { EnqueueTaskInput, ReleaseResourceInput, ResumeTaskInput } from "./types.ts";

export const QUEUE_USAGE = `Persistent research tasks (configured official-client invocation limits apply):
  npm run harness -- queue-status <config.json>
  npm run harness -- queue-enqueue <config.json> <task.json>
  npm run harness -- queue-run <config.json> <maximum-tasks>
  npm run harness -- queue-cancel <config.json> <task-id> <reason>
  npm run harness -- queue-resume <config.json> <resume-request.json>
  npm run harness -- queue-release-resource <config.json> <release-request.json>
  npm run harness -- report-review-prepare <config.json> <request.json>
  npm run harness -- report-review-aggregate <config.json> <plan-observation-id> <output-directory>

queue-run drains currently eligible work up to its bound. It does not spin while
waiting for quota/authentication or repeat interrupted calls. SIGINT/SIGTERM writes
the ledger stop barrier before asking active work to cancel. There is no TCP service.
`;

const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));

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
    "report-review-prepare": 2, "report-review-aggregate": 3 };
  if (!command || !Object.hasOwn(arity, command)) return null;
  if (rest.length !== arity[command]) throw new Error(`Invalid research queue arguments.\n${QUEUE_USAGE}`);
  const config = await loadHarnessConfig(rest[0]!);
  const harness = openConfiguredHarness(config);
  try {
    if (command === "queue-status") { output(summary(harness)); return 0; }
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
    const maximumTasks = Number(rest[1]);
    if (!/^[1-9][0-9]*$/.test(rest[1]!) || !Number.isSafeInteger(maximumTasks) || maximumTasks > 1000) {
      throw new Error("maximum-tasks must be an integer from 1 to 1,000");
    }
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
    const executed: { taskId: string; state: string }[] = [];
    try {
      for (let index = 0; index < maximumTasks && !abort.signal.aborted; index++) {
        const task = await runNextResearchTask(harness.queue, harness.handlers, { workerId: config.workerId, signal: abort.signal });
        if (!task) break;
        executed.push({ taskId: task.taskId, state: task.state });
      }
    } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
    const status = summary(harness);
    output({ executed, stopPersisted, ...status });
    if (stopPersisted === false) return 1;
    return Object.entries(status.states).some(([state, count]) => count && state !== "completed") ? 2 : 0;
  } finally { harness.close(); }
}
