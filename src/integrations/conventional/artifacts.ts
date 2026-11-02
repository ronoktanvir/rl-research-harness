import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { prepareConventionalRequest } from "./protocol.ts";
import { runConventionalExperiment, summarizeConventionalExecution } from "./worker.ts";
import type { ConventionalWorkerOptions } from "./worker.ts";

/** A new directory is the local intent marker. Existing directories are never replayed:
 * after an interrupted invocation, inspect its intent/artifacts and use a new explicit
 * experiment identity if another run is wanted. This is not a remote job supervisor.
 */
export async function runConventionalToArtifacts(raw: unknown, options: ConventionalWorkerOptions, outputDirectory: string) {
  const request = prepareConventionalRequest(raw), directory = resolve(outputDirectory);
  const workerOptions = { ...options }, { requestDigest: _requestDigest, ...spec } = request;
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const save = (name: string, text: string) => writeFile(join(directory, name), text, { flag: "wx", mode: 0o600 });
  await save("intent.json", `${JSON.stringify({ schemaVersion: 1, kind: "local-conventional-intent", request,
    pythonExecutable: workerOptions.pythonExecutable, timeoutMs: workerOptions.timeoutMs, createdAt: new Date().toISOString(), replaySupported: false,
    meaning: "Requested local engineering experiment; this record does not establish whether execution started or finished." }, null, 2)}\n`);
  const execution = await runConventionalExperiment(spec, workerOptions);
  await save("worker-stdout.txt", execution.process.stdout);
  await save("worker-stderr.txt", execution.process.stderr);
  const summary = summarizeConventionalExecution(execution);
  await save("summary.json", `${JSON.stringify(summary, null, 2)}\n`);
  const rows = summary.trainingReplicates.map(replica => `| ${replica.replicateId} | ${replica.training.episodes} | ${replica.evaluation.successes}/${replica.evaluation.episodes} | ${replica.successRateDeltaFromSharedBaseline.toFixed(4)} |`).join("\n");
  await save("report.md", `# Conventional RL engineering experiment\n\nStatus: **${summary.status}** (${summary.reason}). Request: \`${summary.requestId}\`.\n\n` +
    `FrozenLake 4×4; tabular Q-learning. Raw episode records are in [worker stdout](worker-stdout.txt); exact digests and runtime versions are in [summary](summary.json).\n\n` +
    (summary.sharedRandomBaseline ? `One shared random baseline: ${summary.sharedRandomBaseline.successes}/${summary.sharedRandomBaseline.episodes} successful episodes. Each row is one separately trained final policy evaluated on the declared common seed schedule.\n\n| Training replicate | Training episodes | Evaluation successes | Success-rate difference from shared baseline |\n|---|---:|---:|---:|\n${rows}\n\n` : "No complete result was accepted. Partial output cannot establish success.\n\n") +
    summary.limitations.map(item => `- ${item}`).join("\n") + "\n");
  // Written last: readers may use this receipt only when all referenced artifacts exist.
  await save("receipt.json", `${JSON.stringify({ schemaVersion: 1, requestDigest: summary.requestDigest,
    runnerDigest: summary.runnerDigest, resultDigest: summary.resultDigest, status: summary.status,
    artifacts: ["intent.json", "worker-stdout.txt", "worker-stderr.txt", "summary.json", "report.md"] }, null, 2)}\n`);
  return { ...summary, artifacts: { directory, report: join(directory, "report.md"), summary: join(directory, "summary.json"),
    raw: join(directory, "worker-stdout.txt"), receipt: join(directory, "receipt.json") } };
}
