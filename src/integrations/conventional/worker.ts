import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { runProcess } from "../../workers/process.ts";
import type { ProcessRequest, ProcessResult } from "../../workers/process.ts";
import { hash } from "../../ledger/validation.ts";
import { freezeSnapshot } from "../../research/evidence.ts";
import { CONVENTIONAL_OUTPUT_BYTES, CONVENTIONAL_PINS, prepareConventionalRequest, validateConventionalResult } from "./protocol.ts";
import type { ConventionalRequest, ConventionalResult } from "./protocol.ts";

export interface ConventionalWorkerOptions {
  pythonExecutable: string; timeoutMs: number; signal?: AbortSignal;
  /** Test injection only; production uses the fixed, bounded no-shell process helper. */
  execute?: (request: ProcessRequest) => Promise<ProcessResult>;
}
export type ConventionalExecution = {
  schemaVersion: 1; request: ConventionalRequest; runnerDigest: string; startedAt: string; completedAt: string;
  process: ProcessResult; resultDigest: string | null; result: ConventionalResult | null;
  status: "completed" | "incomplete"; reason: string;
};

/** One explicit local test experiment. No admission, automatic retry, remote launch or resume. */
export async function runConventionalExperiment(raw: unknown, options: ConventionalWorkerOptions): Promise<ConventionalExecution> {
  const request = prepareConventionalRequest(raw), python = options.pythonExecutable, timeoutMs = options.timeoutMs;
  if (typeof python !== "string" || !isAbsolute(python) || /[\0\r\n]/.test(python)) throw new Error("Select an absolute trusted Python executable");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("Local conventional experiment timeout must be 1–120,000 ms");
  const execute = options.execute ?? runProcess, signal = options.signal;
  const source = await readFile(new URL("./runner.py", import.meta.url), "utf8");
  const runnerDigest = createHash("sha256").update(source).digest("hex");
  const directory = await mkdtemp(join(tmpdir(), "harness-conventional-"));
  const startedAt = new Date().toISOString();
  try {
    // Execute the exact source bytes we hashed. -I ignores user-site/PYTHONPATH;
    // no inherited account/cloud credentials or project working directory.
    const process = await execute({ executable: python, args: ["-I", "-B", "-c", source], cwd: directory,
      env: { PATH: "/usr/bin:/bin", PYTHONIOENCODING: "utf-8", OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1" },
      input: JSON.stringify(request), timeoutMs, maxOutputBytes: CONVENTIONAL_OUTPUT_BYTES, ...(signal ? { signal } : {}) });
    const base = { schemaVersion: 1 as const, request, runnerDigest, startedAt, completedAt: new Date().toISOString(), process };
    if (process.stopped || process.exitCode !== 0) return freezeSnapshot({ ...base, status: "incomplete", reason: process.stopped ?? "worker_failed", result: null, resultDigest: null }) as ConventionalExecution;
    try {
      if (Buffer.byteLength(process.stdout) + Buffer.byteLength(process.stderr) > CONVENTIONAL_OUTPUT_BYTES) throw new Error("output_limit");
      const result = validateConventionalResult(JSON.parse(process.stdout), request);
      return freezeSnapshot({ ...base, status: "completed", reason: "fixed_worker_result_validated",
        resultDigest: createHash("sha256").update(process.stdout).digest("hex"), result }) as ConventionalExecution;
    } catch { return freezeSnapshot({ ...base, status: "incomplete", reason: "invalid_worker_result", result: null, resultDigest: null }) as ConventionalExecution; }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Compact projection; raw episodes remain necessary for audit and must be archived separately. */
export function summarizeConventionalExecution(execution: ConventionalExecution) {
  const { requestDigest, ...spec } = execution.request;
  const request = prepareConventionalRequest(spec);
  if (requestDigest !== request.requestDigest) throw new Error("Execution request digest is inconsistent");
  let result: ConventionalResult | null = null;
  if (execution.status === "completed") {
    if (execution.process.stopped || execution.process.exitCode !== 0
      || createHash("sha256").update(execution.process.stdout).digest("hex") !== execution.resultDigest) throw new Error("Execution result digest or terminal status is inconsistent");
    // Recompute the projection from the bound raw observation, even if a caller
    // constructed or deserialized a mutable execution object.
    result = validateConventionalResult(JSON.parse(execution.process.stdout), request);
  }
  return { schemaVersion: 1, status: execution.status, reason: execution.reason, requestId: execution.request.requestId,
    requestDigest: execution.request.requestDigest, runnerDigest: execution.runnerDigest,
    resultDigest: execution.resultDigest, resultDigestMeaning: "SHA-256 of exact worker stdout bytes",
    startedAt: execution.startedAt, completedAt: execution.completedAt, pins: CONVENTIONAL_PINS,
    versions: result?.versions ?? null, stopped: execution.process.stopped, exitCode: execution.process.exitCode,
    totalTransitions: result?.totalTransitions ?? null, sharedRandomBaseline: result?.randomBaseline.summary ?? null,
    trainingReplicates: result?.replicates.map(replica => ({ replicateId: replica.replicateId,
      policyDigest: hash(replica.qTable), training: replica.training.summary, evaluation: replica.evaluation.summary,
      successRateDeltaFromSharedBaseline: replica.evaluation.summary.successRate - result.randomBaseline.summary.successRate })) ?? [],
    limitations: ["Fixed-map engineering qualification, not a learning/generalization or significance claim.",
      "Evaluation freezes each final Q-table; it is not isolated from experiment-author read access.",
      "Training replicates are the replication unit; all use one shared random baseline observation set.",
      "This local process has no durable launch recovery, checkpoint resume or cloud allocation support."] };
}
