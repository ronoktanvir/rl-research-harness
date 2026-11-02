import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { hash, keys, digestValue, encode } from "../../ledger/validation.ts";
import { freezeSnapshot } from "../../research/evidence.ts";
import { runProcess } from "../../workers/process.ts";
import type { ProcessResult } from "../../workers/process.ts";

export const COWORKER_INVESTIGATION_SUPPORTED_SOURCE = "ccfd25df63f55e408b67e984710eb6d3dd9e609f";
const BASE = "artifacts/probing-helper-artifacts";
export const COWORKER_INVESTIGATION_LAYOUT = Object.freeze({
  reportPath: `${BASE}/grpo-run1/main-s11/report.json`,
  reportSha256: "8d73572a733f05bcdf9eacda9af3bb5f92394745c6cd77c00786fe245df80c5a", reportBytes: 58_876,
  adapterPath: `.local-artifacts/${BASE}/grpo-run1/main-s11/adapter-step-29/adapter_model.safetensors`,
  trainedTracePath: `.local-artifacts/${BASE}/heldout-diagnostic/s11-trained/step0-trace.jsonl`,
  baselineTracePath: `.local-artifacts/${BASE}/heldout-diagnostic/s11-baseline/step0-trace.jsonl`,
  trainedEvaluationDirectory: `${BASE}/heldout-diagnostic/s11-trained`, baselineEvaluationDirectory: `${BASE}/heldout-diagnostic/s11-baseline`,
});
export const COWORKER_INVESTIGATION_LIMITS = Object.freeze({ requestBytes: 16_384, outputBytes: 65_536,
  smallFileBytes: 4_194_304, lineBytes: 8_388_608, traceBytes: 838_860_800, adapterBytes: 419_430_400, records: 1000 });
export interface InvestigationFile { path: string; sha256: string; bytes: number }
export interface CoworkerInvestigationRequest {
  schemaVersion: 1; kind: "coworker-run1-investigation"; root: string;
  report: InvestigationFile; localArtifacts: { adapterPath: string; trainedTracePath: string; baselineTracePath: string; trainedEvaluationDirectory: string; baselineEvaluationDirectory: string };
  requestDigest: string;
}
export interface CoworkerInvestigationWorkerDescriptor {
  name: "coworker-run1-investigation"; version: 1; sourceSha256: string; pythonExecutable: string; timeoutMs: number;
  limits: typeof COWORKER_INVESTIGATION_LIMITS;
}
export interface InvestigationCell {
  plan: InvestigationFile; summary: InvestigationFile; judgedResults: InvestigationFile; traces: InvestigationFile;
  rows: number; uniqueWorlds: number; uniqueTraceIds: number; uniqueResultIds: number; exactJudgedTraceJoin: true;
  producerCompleteCount: number; producerStatusOkCount: number; producerStatusOtherCount: number; producerErrorCount: number;
  producerTargetsCredited: number; producerCleanSuccessCount: number; producerCreditHistogram: number[];
  summaryRan: number; summaryResumedFrom: number; summaryScoredTotal: number;
  storedFunnelDenominator: number; storedFunnelRate: number;
  setFingerprint: string; selectedPolicySettingsSha256: string;
  adapterSha256: string; runtimeSourceSha: string; baseModelRevision: string; tokenizerSha256: string; schemaContractHash: string;
}
export interface CoworkerInvestigationResult {
  schemaVersion: 1; kind: "coworker-run1-investigation-result"; requestDigest: string;
  report: InvestigationFile; runManifest: InvestigationFile; revisions: InvestigationFile; archiveTree: InvestigationFile;
  adapter: InvestigationFile; checksums: InvestigationFile; funnel: InvestigationFile;
  source: { commit: string; archiveTreeId: string; pythonFiles: number; pythonBytes: number; pythonSourceSha256: string; gitBlobIdsVerified: true };
  cells: { trained: InvestigationCell; baseline: InvestigationCell };
  trainingConfigCount: number; evaluationConfigCount: number; configOverlapCount: 0;
  sameEvaluationWorlds: true; sameSelectedPolicySettings: true; producerCreditedDifference: number;
  scientificReplicationCount: 1; comparator: "bare_base"; scientificEvaluation: "unassessed"; historicalExecution: "unverified";
}
const REASONS = ["verified_byte_correspondence_and_producer_counts", "missing_file", "unsafe_path", "file_changed", "size_limit", "invalid_input", "invalid_json", "unsupported_source", "evidence_mismatch", "reader_unavailable", "unreadable", "timeout", "cancelled", "output_limit", "spawn_error", "worker_failed", "invalid_worker_result"] as const;
export type CoworkerInvestigationReason = typeof REASONS[number];
export interface CoworkerInvestigationExecution {
  schemaVersion: 1; request: CoworkerInvestigationRequest; descriptor: CoworkerInvestigationWorkerDescriptor;
  status: "completed" | "incomplete"; reason: CoworkerInvestigationReason;
  process: { exitCode: number | null; stopped: ProcessResult["stopped"]; stdoutSha256: string; stdoutBytes: number; stderrSha256: string; stderrBytes: number };
  observations: InvestigationCheck[];
  resultSha256: string | null; result: CoworkerInvestigationResult | null;
}
export interface InvestigationCheck { check: "report" | "source" | "adapter" | "trained_evaluation" | "baseline_evaluation" | "comparison"; status: "verified" | "failed"; reason: CoworkerInvestigationReason; files: InvestigationFile[] }
export interface CoworkerInvestigationWorker {
  descriptor: CoworkerInvestigationWorkerDescriptor;
  run(request: CoworkerInvestigationRequest, signal?: AbortSignal): Promise<CoworkerInvestigationExecution>;
}

/** Reject accessors, sparse/augmented arrays and non-JSON objects before reading values. */
function detached(raw: unknown, maxBytes = 65_536): unknown {
  let nodes = 0;
  function walk(value: unknown, depth: number): unknown {
    if (++nodes > 10_000 || depth > 24) throw new Error("Investigation input exceeds structural bounds");
    if (typeof value === "string" && value.length > maxBytes) throw new Error("Investigation string exceeds byte bound");
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value))) throw new Error("Investigation data must be inert JSON");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some(key => typeof key !== "string")) throw new Error("Symbol keys are unsupported");
    if (Object.values(descriptors).some(d => !Object.hasOwn(d, "value"))) throw new Error("Accessors are unsupported");
    if (Array.isArray(value)) {
      if (Object.keys(descriptors).length !== value.length + 1) throw new Error("Sparse or augmented array");
      return Array.from({ length: value.length }, (_, i) => { if (!Object.hasOwn(descriptors, i)) throw new Error("Sparse array"); return walk(descriptors[i]!.value, depth + 1); });
    }
    return Object.fromEntries(Object.entries(descriptors).map(([key, d]) => { if (!d.enumerable) throw new Error("Hidden fields unsupported"); return [key, walk(d.value, depth + 1)]; }));
  }
  const result = walk(raw, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new Error("Investigation data exceeds byte bound");
  return result;
}
function equal(a: unknown, b: unknown, message = "Investigation identity mismatch"): void { if (hash(a) !== hash(b)) throw new Error(message); }
function absolute(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 4096 || !isAbsolute(value) || normalize(value) !== value || value === "/" || /[\0\r\n\\]/.test(value)) throw new Error("Expected canonical absolute path");
}
function relative(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 4096 || value.startsWith("/") || /[\\\0\r\n]/.test(value) || value.split("/").some(p => !p || p === "." || p === "..")) throw new Error("Unsafe relative path");
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw new Error("Invalid bounded count");
}
export function prepareCoworkerInvestigationRequest(raw: unknown): CoworkerInvestigationRequest {
  const v = detached(raw, COWORKER_INVESTIGATION_LIMITS.requestBytes);
  keys(v, ["schemaVersion", "kind", "root", "report", "localArtifacts", "requestDigest"], ["schemaVersion", "kind", "root", "report", "localArtifacts"]);
  if (v.schemaVersion !== 1 || v.kind !== "coworker-run1-investigation") throw new Error("Unsupported investigation schema");
  absolute(v.root);
  keys(v.report, ["path", "sha256", "bytes"]); relative(v.report.path); digestValue(v.report.sha256); integer(v.report.bytes, COWORKER_INVESTIGATION_LIMITS.smallFileBytes); if (v.report.bytes === 0) throw new Error("Empty report anchor");
  if (!v.report.path.startsWith(`${BASE}/`) || !v.report.path.endsWith("/report.json")) throw new Error("Unsupported report layout");
  keys(v.localArtifacts, ["adapterPath", "trainedTracePath", "baselineTracePath", "trainedEvaluationDirectory", "baselineEvaluationDirectory"]);
  for (const value of Object.values(v.localArtifacts)) relative(value);
  const selected = v.localArtifacts as unknown as CoworkerInvestigationRequest["localArtifacts"];
  const parent = (path: string) => path.slice(0, path.lastIndexOf("/"));
  if (!selected.trainedEvaluationDirectory.startsWith(`${BASE}/`) || !selected.baselineEvaluationDirectory.startsWith(`${BASE}/`) || selected.trainedEvaluationDirectory === selected.baselineEvaluationDirectory || parent(selected.trainedEvaluationDirectory) !== parent(selected.baselineEvaluationDirectory)
    || selected.trainedTracePath !== `.local-artifacts/${selected.trainedEvaluationDirectory}/step0-trace.jsonl` || selected.baselineTracePath !== `.local-artifacts/${selected.baselineEvaluationDirectory}/step0-trace.jsonl`
    || !selected.adapterPath.startsWith(`.local-artifacts/${parent(v.report.path)}/adapter-step-`) || !/\/adapter-step-(0|[1-9][0-9]*)\/adapter_model\.safetensors$/.test(selected.adapterPath)) throw new Error("Unsupported artifact selection layout");
  const { requestDigest: supplied, ...body } = v; const requestDigest = hash(body);
  if (supplied !== undefined && supplied !== requestDigest) throw new Error("Request digest mismatch");
  return freezeSnapshot({ ...body, requestDigest }) as CoworkerInvestigationRequest;
}
export function validateCoworkerInvestigationDescriptor(raw: unknown): CoworkerInvestigationWorkerDescriptor {
  const v = detached(raw); keys(v, ["name", "version", "sourceSha256", "pythonExecutable", "timeoutMs", "limits"]);
  if (v.name !== "coworker-run1-investigation" || v.version !== 1) throw new Error("Unsupported worker");
  digestValue(v.sourceSha256); absolute(v.pythonExecutable); integer(v.timeoutMs, 300_000);
  if (v.timeoutMs < 1) throw new Error("Timeout must be positive"); equal(v.limits, COWORKER_INVESTIGATION_LIMITS);
  return freezeSnapshot(v) as unknown as CoworkerInvestigationWorkerDescriptor;
}
function file(raw: unknown, path: string, max: number): void { keys(raw, ["path", "sha256", "bytes"]); if (raw.path !== path) throw new Error("Unexpected evidence path"); digestValue(raw.sha256); integer(raw.bytes, max); }
function validateResult(raw: unknown, request: CoworkerInvestigationRequest): CoworkerInvestigationResult {
  const v = detached(raw); keys(v, ["schemaVersion", "kind", "requestDigest", "report", "runManifest", "revisions", "archiveTree", "adapter", "checksums", "funnel", "source", "cells", "trainingConfigCount", "evaluationConfigCount", "configOverlapCount", "sameEvaluationWorlds", "sameSelectedPolicySettings", "producerCreditedDifference", "scientificReplicationCount", "comparator", "scientificEvaluation", "historicalExecution"]);
  if (v.schemaVersion !== 1 || v.kind !== "coworker-run1-investigation-result" || v.requestDigest !== request.requestDigest || v.scientificReplicationCount !== 1 || v.comparator !== "bare_base" || v.scientificEvaluation !== "unassessed" || v.historicalExecution !== "unverified" || v.configOverlapCount !== 0 || v.sameEvaluationWorlds !== true || v.sameSelectedPolicySettings !== true) throw new Error("Invalid result claims");
  equal(v.report, request.report); const base = request.localArtifacts.trainedEvaluationDirectory.replace(/\/[^/]+$/, "");
  file(v.runManifest, request.report.path.replace(/report\.json$/, "run-manifest.json"), COWORKER_INVESTIGATION_LIMITS.smallFileBytes);
  file(v.revisions, "history/halluminate/revisions.json", COWORKER_INVESTIGATION_LIMITS.smallFileBytes);
  keys(v.source, ["commit", "archiveTreeId", "pythonFiles", "pythonBytes", "pythonSourceSha256", "gitBlobIdsVerified"]);
  const tree = v.source.archiveTreeId; digestValue(tree);
  file(v.archiveTree, `history/halluminate/trees/${tree}.json`, COWORKER_INVESTIGATION_LIMITS.smallFileBytes);
  equal((v.archiveTree as InvestigationFile).sha256, tree);
  file(v.adapter, request.localArtifacts.adapterPath, COWORKER_INVESTIGATION_LIMITS.adapterBytes);
  file(v.checksums, `${base}/SHA256SUMS`, COWORKER_INVESTIGATION_LIMITS.smallFileBytes); file(v.funnel, `${base}/funnel.json`, COWORKER_INVESTIGATION_LIMITS.smallFileBytes);
  if (v.source.commit !== COWORKER_INVESTIGATION_SUPPORTED_SOURCE || v.source.gitBlobIdsVerified !== true) throw new Error("Unsupported source");
  integer(v.source.pythonFiles, 1000); integer(v.source.pythonBytes, 64 * 1024 * 1024); digestValue(v.source.pythonSourceSha256);
  if (v.source.pythonFiles === 0) throw new Error("No source files");
  keys(v.cells, ["trained", "baseline"]);
  const fields = ["plan", "summary", "judgedResults", "traces", "rows", "uniqueWorlds", "uniqueTraceIds", "uniqueResultIds", "exactJudgedTraceJoin", "producerCompleteCount", "producerStatusOkCount", "producerStatusOtherCount", "producerErrorCount", "producerTargetsCredited", "producerCleanSuccessCount", "producerCreditHistogram", "summaryRan", "summaryResumedFrom", "summaryScoredTotal", "storedFunnelDenominator", "storedFunnelRate", "setFingerprint", "selectedPolicySettingsSha256", "adapterSha256", "runtimeSourceSha", "baseModelRevision", "tokenizerSha256", "schemaContractHash"];
  for (const name of ["trained", "baseline"] as const) {
    const c = v.cells[name]; keys(c, fields); const cell = request.localArtifacts[name === "trained" ? "trainedEvaluationDirectory" : "baselineEvaluationDirectory"];
    file(c.plan, `${cell}/cell-plan.json`, COWORKER_INVESTIGATION_LIMITS.smallFileBytes); file(c.summary, `${cell}/cell-summary.json`, COWORKER_INVESTIGATION_LIMITS.smallFileBytes); file(c.judgedResults, `${cell}/step0-judged-results.jsonl`, COWORKER_INVESTIGATION_LIMITS.smallFileBytes); file(c.traces, request.localArtifacts[name === "trained" ? "trainedTracePath" : "baselineTracePath"], COWORKER_INVESTIGATION_LIMITS.traceBytes);
    integer(c.rows, COWORKER_INVESTIGATION_LIMITS.records); if (c.rows === 0) throw new Error("Empty evaluation");
    for (const field of ["uniqueWorlds", "uniqueTraceIds", "uniqueResultIds", "summaryScoredTotal"]) if (c[field] !== c.rows) throw new Error("Invalid evaluation cardinality");
    if (c.exactJudgedTraceJoin !== true) throw new Error("Invalid join");
    for (const field of ["producerCompleteCount", "producerStatusOkCount", "producerStatusOtherCount", "producerErrorCount", "producerCleanSuccessCount", "summaryRan", "summaryResumedFrom"]) integer(c[field], c.rows);
    integer(c.producerTargetsCredited, 2 * c.rows); if (!Array.isArray(c.producerCreditHistogram) || c.producerCreditHistogram.length !== 3) throw new Error("Invalid credit histogram");
    for (const n of c.producerCreditHistogram) integer(n, c.rows);
    if (c.producerCreditHistogram.reduce((a: number, b: number) => a + b, 0) !== c.rows || c.producerCreditHistogram[1] + 2 * c.producerCreditHistogram[2] !== c.producerTargetsCredited || (c.summaryRan as number) + (c.summaryResumedFrom as number) !== c.rows || (c.producerStatusOkCount as number) + (c.producerStatusOtherCount as number) !== c.rows || c.storedFunnelDenominator !== 2 * c.rows || typeof c.storedFunnelRate !== "number" || Math.abs(c.storedFunnelRate - Math.round(c.producerTargetsCredited / (2 * c.rows) * 10000) / 10000) > 1e-12) throw new Error("Inconsistent producer counts");
    for (const field of ["setFingerprint", "selectedPolicySettingsSha256", "adapterSha256", "tokenizerSha256", "schemaContractHash"]) digestValue(c[field]);
    if (typeof c.runtimeSourceSha !== "string" || !/^[a-f0-9]{40}$/.test(c.runtimeSourceSha) || typeof c.baseModelRevision !== "string" || !/^[a-f0-9]{8,40}$/.test(c.baseModelRevision)) throw new Error("Invalid producer version declaration");
    if (c.adapterSha256 !== (name === "trained" ? (v.adapter as InvestigationFile).sha256 : createHash("sha256").digest("hex"))) throw new Error("Adapter mismatch");
  }
  const trained = v.cells.trained as unknown as InvestigationCell, baseline = v.cells.baseline as unknown as InvestigationCell;
  if (trained.runtimeSourceSha !== baseline.runtimeSourceSha || trained.schemaContractHash !== baseline.schemaContractHash || trained.tokenizerSha256 !== baseline.tokenizerSha256 || trained.baseModelRevision !== baseline.baseModelRevision || trained.setFingerprint !== baseline.setFingerprint || trained.selectedPolicySettingsSha256 !== baseline.selectedPolicySettingsSha256 || v.producerCreditedDifference !== trained.producerTargetsCredited - baseline.producerTargetsCredited || trained.rows !== baseline.rows) throw new Error("Comparison mismatch");
  integer(v.trainingConfigCount, 1000); integer(v.evaluationConfigCount, 1000);
  return freezeSnapshot(v) as unknown as CoworkerInvestigationResult;
}
function validateChecks(raw: unknown, request: CoworkerInvestigationRequest): asserts raw is InvestigationCheck[] {
  const parent = request.localArtifacts.trainedEvaluationDirectory.replace(/\/[^/]+$/, "");
  const cellPaths = (name: "trained" | "baseline") => { const dir = request.localArtifacts[name === "trained" ? "trainedEvaluationDirectory" : "baselineEvaluationDirectory"]; return [dir + "/cell-plan.json", dir + "/cell-summary.json", dir + "/step0-judged-results.jsonl", request.localArtifacts[name === "trained" ? "trainedTracePath" : "baselineTracePath"]]; };
  const expectedPaths = [[request.report.path, request.report.path.replace(/report\.json$/, "run-manifest.json")], ["history/halluminate/revisions.json", "dynamic-tree"], [request.localArtifacts.adapterPath], [parent + "/SHA256SUMS", parent + "/funnel.json", ...cellPaths("trained")], cellPaths("baseline"), []];
  const checkNames = ["report", "source", "adapter", "trained_evaluation", "baseline_evaluation", "comparison"];
  if (!Array.isArray(raw) || raw.length > checkNames.length) throw new Error("Invalid check observations");
  for (let index = 0; index < raw.length; index++) {
    const v: unknown = raw[index]; keys(v, ["check", "status", "reason", "files"]);
    if (v.check !== checkNames[index] || !["verified", "failed"].includes(v.status as string) || !REASONS.includes(v.reason as CoworkerInvestigationReason) || !Array.isArray(v.files) || v.files.length > 8) throw new Error("Invalid check observation");
    if ((v.status === "verified") !== (v.reason === REASONS[0]) || (v.status === "failed" && index !== raw.length - 1)) throw new Error("Inconsistent check observation");
    const expected = expectedPaths[index]!;
    if (v.files.length > expected.length || (v.status === "verified" && v.files.length !== expected.length)) throw new Error("Missing or surplus check references");
    for (let fileIndex = 0; fileIndex < v.files.length; fileIndex++) {
      const f: unknown = v.files[fileIndex]; keys(f, ["path", "sha256", "bytes"]); relative(f.path); digestValue(f.sha256); integer(f.bytes, COWORKER_INVESTIGATION_LIMITS.traceBytes);
      if (expected[fileIndex] === "dynamic-tree") { if (f.path !== `history/halluminate/trees/${f.sha256}.json` && v.status === "verified") throw new Error("Invalid archive reference"); if (!/^history\/halluminate\/trees\/[a-f0-9]{64}\.json$/.test(f.path)) throw new Error("Invalid archive path"); }
      else if (f.path !== expected[fileIndex]) throw new Error("Unselected evidence path");
      if (index === 0 && fileIndex === 0 && v.status === "verified") equal(f, request.report);
    }
  }
}
export function validateCoworkerInvestigationExecution(raw: unknown, requestRaw: CoworkerInvestigationRequest, descriptorRaw: CoworkerInvestigationWorkerDescriptor): CoworkerInvestigationExecution {
  const request = prepareCoworkerInvestigationRequest(requestRaw), descriptor = validateCoworkerInvestigationDescriptor(descriptorRaw), v = detached(raw);
  keys(v, ["schemaVersion", "request", "descriptor", "status", "reason", "process", "observations", "resultSha256", "result"]);
  equal(v.request, request); equal(v.descriptor, descriptor); keys(v.process, ["exitCode", "stopped", "stdoutSha256", "stdoutBytes", "stderrSha256", "stderrBytes"]);
  digestValue(v.process.stdoutSha256); digestValue(v.process.stderrSha256); integer(v.process.stdoutBytes, descriptor.limits.outputBytes); integer(v.process.stderrBytes, descriptor.limits.outputBytes);
  if ((v.process.stdoutBytes as number) + (v.process.stderrBytes as number) > descriptor.limits.outputBytes) throw new Error("Output limit");
  validateChecks(v.observations, request);
  if (v.schemaVersion !== 1 || !REASONS.includes(v.reason as CoworkerInvestigationReason) || (v.process.exitCode !== null && (typeof v.process.exitCode !== "number" || !Number.isSafeInteger(v.process.exitCode))) || ![null, "timeout", "cancelled", "output_limit", "spawn_error"].includes(v.process.stopped as null)) throw new Error("Invalid process result");
  if (v.status === "completed") {
    if (v.reason !== REASONS[0] || v.process.exitCode !== 0 || v.process.stopped !== null) throw new Error("Incomplete process cannot verify evidence");
    const result = validateResult(v.result, request);
    const r = result; const expectedFiles = [[r.report, r.runManifest], [r.revisions, r.archiveTree], [r.adapter], [r.checksums, r.funnel, r.cells.trained.plan, r.cells.trained.summary, r.cells.trained.judgedResults, r.cells.trained.traces], [r.cells.baseline.plan, r.cells.baseline.summary, r.cells.baseline.judgedResults, r.cells.baseline.traces], []];
    if (v.observations.length !== 6 || v.observations.some((check, index) => check.status !== "verified" || hash(check.files) !== hash(expectedFiles[index]))) throw new Error("Completed result lacks matching checks");
    if (v.resultSha256 !== hash(result)) throw new Error("Result digest mismatch");
  } else if (v.status !== "incomplete" || v.result !== null || v.resultSha256 !== null || v.reason === REASONS[0]) throw new Error("Invalid incomplete result");
  else if (v.observations.length && (v.observations.at(-1)!.status !== "failed" || v.observations.at(-1)!.reason !== v.reason)) throw new Error("Incomplete result contradicts checks");
  return freezeSnapshot(v) as unknown as CoworkerInvestigationExecution;
}
/** Source bytes and execution bounds are pinned before an archival intent is written. No retry. */
export function createCoworkerInvestigationWorker(options: { pythonExecutable: string; timeoutMs?: number }): CoworkerInvestigationWorker {
  const source = readFileSync(new URL("./investigation-worker.py", import.meta.url), "utf8");
  const descriptor = validateCoworkerInvestigationDescriptor({ name: "coworker-run1-investigation", version: 1, sourceSha256: createHash("sha256").update(source).digest("hex"), pythonExecutable: options.pythonExecutable, timeoutMs: options.timeoutMs ?? 120_000, limits: COWORKER_INVESTIGATION_LIMITS });
  return Object.freeze({ descriptor, async run(raw: CoworkerInvestigationRequest, signal?: AbortSignal) {
    const request = prepareCoworkerInvestigationRequest(raw);
    const p = await runProcess({ executable: descriptor.pythonExecutable, args: ["-I", "-S", "-B", "-c", source], cwd: "/", env: { PATH: "/usr/bin:/bin" }, input: encode(request), timeoutMs: descriptor.timeoutMs, maxOutputBytes: descriptor.limits.outputBytes, ...(signal ? { signal } : {}) });
    let observations: InvestigationCheck[] = [];
    let result: CoworkerInvestigationResult | null = null; let reason: CoworkerInvestigationReason = p.stopped ?? (p.exitCode !== 0 ? "worker_failed" : "invalid_worker_result");
    if (!p.stopped && p.exitCode === 0) {
      try { const parsed: unknown = JSON.parse(p.stdout); keys(parsed, ["status", "reason", "result", "observations"]); validateChecks(parsed.observations, request); observations = parsed.observations;
        if (parsed.status === "completed" && parsed.reason === REASONS[0]) { result = validateResult(parsed.result, request); reason = REASONS[0]; }
        else if (parsed.status === "incomplete" && parsed.result === null && REASONS.includes(parsed.reason as CoworkerInvestigationReason) && parsed.reason !== REASONS[0]) reason = parsed.reason as CoworkerInvestigationReason;
      } catch { observations = []; result = null; reason = "invalid_worker_result"; /* Never retain malformed helper evidence. */ }
    }
    return validateCoworkerInvestigationExecution({ schemaVersion: 1, request, descriptor, status: result ? "completed" : "incomplete", reason, process: { exitCode: p.exitCode, stopped: p.stopped, stdoutSha256: createHash("sha256").update(p.stdout).digest("hex"), stdoutBytes: Buffer.byteLength(p.stdout), stderrSha256: createHash("sha256").update(p.stderr).digest("hex"), stderrBytes: Buffer.byteLength(p.stderr) }, observations, resultSha256: result ? hash(result) : null, result }, request, descriptor);
  } });
}
