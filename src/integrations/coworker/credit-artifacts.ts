import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { hash } from "../../ledger/validation.ts";
import { createCreditCalibrationWorker, prepareCreditCalibrationRequest } from "./credit-calibration.ts";

/** Explicit local qualification, with a new-directory intent before running pinned code.
 * An interrupted directory is evidence of uncertainty, not permission to replay it.
 */
export async function runCreditCalibrationToArtifacts(raw: unknown, options: { pythonExecutable: string; timeoutMs?: number; signal?: AbortSignal }, outputDirectory: string) {
  const request = prepareCreditCalibrationRequest(raw), worker = createCreditCalibrationWorker(options), directory = resolve(outputDirectory);
  const signal = options.signal;
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const save = (name: string, value: unknown) => writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await save("intent.json", { schemaVersion: 1, kind: "credit-calibration-intent", createdAt: new Date().toISOString(), request,
    descriptor: worker.descriptor, replaySupported: false, meaning: "Requested synthetic extraction check; not proof of execution or scientific validity." });
  const execution = await worker.run(request, signal);
  await save("execution.json", execution);
  const a = execution.assessment;
  const rows = a?.cases.flatMap(c => c.facts.filter(f => f.outcome !== "agreement").map(f => `| ${c.id} | ${f.id} | ${f.expected} | ${f.observed} | ${f.error ?? f.outcome} |`)).join("\n");
  const report = `# Synthetic extraction calibration\n\nExecution: **${execution.status}** (${execution.reason}).\n\n` +
    `Request: \`${request.requestDigest}\`. Scorer: \`${request.source.sha256}\`.\n\n` +
    (a ? `Conclusion: **${a.conclusion}**. Scored known labels: ${a.counts.known}; scored unknown labels: ${a.counts.unknown}; scorer errors: ${a.counts.errors}; false positives: ${a.counts.falsePositive}; false negatives: ${a.counts.falseNegative}.\n\n` +
      (rows ? `| Case | Fact | Expected | Observed | Outcome |\n|---|---|---|---|---|\n${rows}\n\n` : "") + a.limitations.map(s => `- ${s}`).join("\n") + "\n"
      : "No complete scoring result was accepted. Failure is not a negative prediction or evidence of scorer validity.\n");
  await writeFile(join(directory, "report.md"), report, { flag: "wx", mode: 0o600 });
  // Last-written receipt binds the evidence projections, not historical execution custody.
  await save("receipt.json", { schemaVersion: 1, kind: "credit-calibration-receipt", requestDigest: request.requestDigest,
    executionDigest: hash(execution), assessmentDigest: a?.digest ?? null, status: execution.status, scientificEvaluation: "unassessed",
    artifacts: ["intent.json", "execution.json", "report.md"] });
  return { status: execution.status, reason: execution.reason, conclusion: a?.conclusion ?? "unassessed", counts: a?.counts ?? null,
    requestDigest: request.requestDigest, assessmentDigest: a?.digest ?? null, artifacts: { directory, report: join(directory, "report.md"), execution: join(directory, "execution.json"), receipt: join(directory, "receipt.json") } };
}
