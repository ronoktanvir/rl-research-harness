import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { inspectCoworkerProject, inspectCoworkerRun } from "./integrations/coworker/index.ts";
import { captureCoworkerReport } from "./integrations/coworker/capture.ts";
import { archiveCoworkerAssessment } from "./integrations/coworker/assessment.ts";
import { prepareCoworkerAttempt } from "./integrations/coworker/attempt-plan.ts";
import { LedgerError, openExperimentLedger } from "./ledger/index.ts";
import type { ExperimentLedger, ScopeState } from "./ledger/index.ts";
import { writeProjectSummary } from "./controller/project-summary.ts";
import { createEvidencePacket, writeDecisionArtifacts } from "./research/index.ts";
import { runCliReview } from "./workers/cli.ts";
import { runCliCouncil } from "./workers/council.ts";
import type { CliBackend } from "./workers/cli.ts";
import { QUEUE_USAGE, queueCommand } from "./scheduler/commands.ts";
import { readBoundedJson } from "./scheduler/config.ts";
import { runConventionalToArtifacts } from "./integrations/conventional/artifacts.ts";
import { PUBLISHER_USAGE, publisherCommand } from "./literature/commands.ts";

const USAGE = `RL research harness

Read-only inspection (no model calls, no training):
  npm run harness -- inspect <CoworkeRL directory>
  npm run harness -- observe <CoworkeRL directory> <relative/report.json>
  npm run harness -- coworker-plan <attempt-request.json>

Persistent observations and local controller administration (no training):
  npm run harness -- capture <ledger.sqlite> <project-id> <capture-id> <CoworkeRL directory> <relative/report.json>
  npm run harness -- coworker-assess <ledger.sqlite> <project-id> <capture-id>
  npm run harness -- ledger-status <ledger.sqlite> <project-id>
  npm run harness -- ledger-export <ledger.sqlite> <project-id> <output-directory>
  npm run harness -- ledger-stop <ledger.sqlite> <global|project:ID> <reason>
  npm run harness -- ledger-resume <ledger.sqlite> <global|project:ID> <reason>

Subscription-backed review (uses the selected official client's allowance):
  npm run harness -- review <packet.json> <codex|claude> <output-directory>
  npm run harness -- smoke <codex|claude>

Explicit bounded local RL engineering experiment (CPU, no model calls):
  npm run harness -- conventional-run <request.json> <absolute-python-executable> <new-output-directory>

review performs independent methods, systems and adversarial reviews and up to two
proposal revisions. It saves JSON/Markdown decisions; it cannot launch training.
smoke makes one short, tool-suppressed client call. API fallback is not configured.
coworker-plan validates declarations and prints a fixed command preview. It does not
read the trainer's files, run preflight, admit a job, or launch training.
coworker-assess archives deterministic diagnostics and evidence requests from an
existing capture. It makes no model calls and cannot intervene in training.
conventional-run executes the fixed FrozenLake adapter for at most 120 seconds.
It requires the pinned Python environment and refuses an existing output directory.
Ledger commands take exclusive local ownership and recover abandoned dispatches as
unknown. They cannot attach to a running controller or confirm remote cancellation.

${QUEUE_USAGE}

${PUBLISHER_USAGE}
`;

function print(value: unknown): void {
  console.log(JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item, 2));
}

function optionalScope(ledger: ExperimentLedger, scopeId: string): ScopeState | null {
  try { return ledger.getScope(scopeId); }
  catch (error) { if (error instanceof LedgerError && error.code === "missing") return null; throw error; }
}

function backend(value: string | undefined): CliBackend {
  if (value !== "codex" && value !== "claude") throw new Error("Select codex or claude explicitly");
  return value;
}

export async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "help") { console.log(USAGE); return 0; }
  const publisher = await publisherCommand(args);
  if (publisher !== null) return publisher;
  const queued = await queueCommand(args);
  if (queued !== null) return queued;
  if (command === "conventional-run" && rest.length === 3) {
    const abort = new AbortController(), stop = () => abort.abort();
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try {
      const result = await runConventionalToArtifacts(await readBoundedJson(rest[0]!, 131_072),
        { pythonExecutable: rest[1]!, timeoutMs: 120_000, signal: abort.signal }, rest[2]!);
      print(result); return result.status === "completed" ? 0 : 2;
    } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  }
  if (command === "coworker-plan" && rest.length === 1) {
    print(prepareCoworkerAttempt(await readBoundedJson(rest[0]!)));
    return 0;
  }
  if (command === "inspect" && rest.length === 1) {
    console.log(JSON.stringify(await inspectCoworkerProject(rest[0]!), null, 2));
    return 0;
  }
  if (command === "observe" && rest.length === 2) {
    const inspection = await inspectCoworkerRun(rest[0]!, rest[1]!);
    console.log(JSON.stringify(inspection, null, 2));
    return inspection.diagnostics.some(item => item.severity === "error") ? 1 : 0;
  }
  if (command === "capture" && rest.length === 5) {
    const ledger = openExperimentLedger({ path: rest[0]! });
    try {
      const observation = await captureCoworkerReport(ledger, { projectId: rest[1]!, captureId: rest[2]!, root: rest[3]!, reportPath: rest[4]! });
      print({ eventId: observation.eventId, digest: observation.digest, observedAt: observation.observedAt,
        projectId: observation.projectId, runId: observation.runId, source: observation.source,
        originalRun: observation.payload.originalRun });
      return 0;
    } finally { ledger.close(); }
  }
  if (command === "coworker-assess" && rest.length === 3) {
    const ledger = openExperimentLedger({ path: rest[0]! });
    try {
      const capture = ledger.getObservation(rest[2]!);
      if (!capture) throw new Error("Capture not found in the selected ledger");
      const assessment = archiveCoworkerAssessment(ledger, { projectId: rest[1]!, captureId: capture.eventId, captureDigest: capture.digest });
      print({ eventId: assessment.eventId, digest: assessment.digest, projectId: assessment.projectId,
        observedAt: assessment.observedAt, assessment: assessment.payload });
      return 0;
    } finally { ledger.close(); }
  }
  if (command === "ledger-status" && rest.length === 2) {
    const ledger = openExperimentLedger({ path: rest[0]! });
    try {
      const actions = ledger.listActions(rest[1]!);
      const observations = ledger.listObservations(rest[1]!);
      print({ projectId: rest[1], globalAuthority: ledger.getScope("global"), projectAuthority: optionalScope(ledger, `project:${rest[1]}`), actionCount: actions.length,
        // Keep the operator view bounded. The ledger retains the full records.
        recentActions: actions.slice(-20), observationCount: observations.length,
        recentObservations: observations.slice(-20).map(({ eventId, digest, source, observedAt, runId }) => ({ eventId, digest, source, observedAt, runId })) });
      return 0;
    } finally { ledger.close(); }
  }
  if ((command === "ledger-stop" || command === "ledger-resume") && rest.length === 3) {
    const ledger = openExperimentLedger({ path: rest[0]! });
    try {
      // The explicit operator command is authority to change the barrier. Read its epoch
      // after acquiring ownership; another controller cannot race this local operation.
      const scope = command === "ledger-stop" ? optionalScope(ledger, rest[1]!) : ledger.getScope(rest[1]!);
      const input = { scopeId: rest[1]!, expectedEpoch: scope?.epoch ?? 0, reason: rest[2]! };
      print(command === "ledger-stop" ? ledger.stopScope(input) : ledger.resumeScope(input));
      return 0;
    } finally { ledger.close(); }
  }
  if (command === "ledger-export" && rest.length === 3) {
    const ledger = openExperimentLedger({ path: rest[0]! });
    try { print(await writeProjectSummary(ledger, rest[1]!, rest[2]!)); return 0; }
    finally { ledger.close(); }
  }
  if (command === "smoke" && rest.length === 1) {
    const result = await runCliReview({ backend: backend(rest[0]), prompt: "Return exactly READY. Do not call any tools.", timeoutMs: 45_000 });
    console.log(JSON.stringify(result, null, 2));
    return result.status === "succeeded" && result.text.trim() === "READY" ? 0 : 1;
  }
  if (command === "review" && rest.length === 3) {
    const path = rest[0]!;
    if ((await stat(path)).size > 512_000) throw new Error("Evidence packet exceeds 512,000 bytes");
    const packet = createEvidencePacket(JSON.parse(await readFile(path, "utf8")));
    const selected = backend(rest[1]);
    const decision = await runCliCouncil({ councilId: `${packet.packetId}-review`, packet,
      workers: [
        { id: "methods", role: "Scientific methods, comparisons, uncertainty and leakage", backend: selected },
        { id: "systems", role: "Feasibility, execution, recovery and resource control", backend: selected },
        { id: "adversary", role: "Reward exploitation, evaluator defects and alternative explanations", backend: selected },
      ],
      reviser: { backend: selected },
    });
    const artifacts = await writeDecisionArtifacts(rest[2]!, decision);
    console.log(JSON.stringify({ status: decision.status, blockers: decision.blockers, artifacts }, null, 2));
    return decision.status === "approved" ? 0 : 2;
  }
  throw new Error(`Invalid command or arguments.\n${USAGE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof Error ? error.message : "Harness command failed");
    process.exitCode = 1;
  });
}
