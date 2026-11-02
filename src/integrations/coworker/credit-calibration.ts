import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { encode, hash, keys } from "../../ledger/validation.ts";
import { freezeSnapshot } from "../../research/evidence.ts";
import { runProcess } from "../../workers/process.ts";
import type { ProcessResult } from "../../workers/process.ts";

/** Reviewed standalone extraction modules. A new source requires a reviewed registry change. */
export const CREDIT_SCORERS = Object.freeze({
  legacy: "ce0d32352e386ee0cf4c5d1ad2da34fd70e17690851eda15fe495740cdc0785b",
  v2: "4d3e2e36737b822f07386e95f047d8e261946ed732502e2e24ff6d9344381101",
});
export interface CreditFact {
  id: string; value: string; unit: string; aliases: readonly string[];
  expected: boolean | "unknown"; rationale: string;
}
export interface CreditCase { id: string; category: string; text: string; facts: readonly CreditFact[] }
export interface CreditCalibrationCorpus {
  schemaVersion: 1; kind: "coworker-credit-calibration";
  rubric: { id: string; version: 1; author: string; scope: "synthetic_extraction"; description: string };
  cases: readonly CreditCase[];
}
export interface CreditCalibrationRequest {
  schemaVersion: 1; kind: "coworker-credit-calibration-request";
  source: { path: string; sha256: string }; corpus: CreditCalibrationCorpus; requestDigest: string;
}
export interface CreditProbeResult {
  schemaVersion: 1; kind: "coworker-credit-probe-result"; sourceSha256: string; probeInputDigest: string;
  cases: readonly { id: string; facts: readonly { id: string; credited: boolean | null; error: "scorer_exception" | "invalid_verdict" | null }[] }[];
}
export interface CreditCalibrationAssessment {
  schemaVersion: 1; kind: "coworker-credit-calibration-assessment";
  requestDigest: string; corpusDigest: string; sourceSha256: string; resultDigest: string;
  scope: "synthetic_extraction"; scientificEvaluation: "unassessed";
  counts: { total: number; known: number; unknown: number; errors: number; truePositive: number; trueNegative: number; falsePositive: number; falseNegative: number };
  cases: readonly { id: string; category: string; facts: readonly { id: string; observed: boolean | null; error: "scorer_exception" | "invalid_verdict" | null; expected: boolean | "unknown"; outcome: "agreement" | "false_positive" | "false_negative" | "unassessed" | "scorer_error"; rationale: string }[] }[];
  conclusion: "counterexamples_found" | "no_counterexample_in_fixture" | "unassessed";
  limitations: readonly string[]; digest: string;
}
export interface CreditCalibrationExecution {
  schemaVersion: 1; kind: "coworker-credit-calibration-execution"; requestDigest: string;
  descriptor: { sourceSha256: string; pythonExecutable: string; timeoutMs: number; maxOutputBytes: 131072 };
  status: "completed" | "incomplete"; reason: string;
  process: { exitCode: number | null; stopped: ProcessResult["stopped"]; stdoutSha256: string; stdoutBytes: number; stderrSha256: string; stderrBytes: number };
  result: CreditProbeResult | null; assessment: CreditCalibrationAssessment | null;
}
const MAX_INPUT = 262_144;
function reject(message: string): never { throw new Error(`Credit calibration: ${message}`); }

/** Copy inert JSON without invoking accessors; bound structure before serialization. */
function detached(raw: unknown): unknown {
  let nodes = 0, bytes = 0;
  function charge(n: number): void { bytes += n; if (bytes > MAX_INPUT) reject("input exceeds 256 KiB"); }
  function walk(value: unknown, depth: number): unknown {
    if (++nodes > 40_000 || depth > 16) reject("structural bound exceeded");
    if (value === null || typeof value === "boolean") { charge(value === null || value === true ? 4 : 5); return value; }
    if (typeof value === "number" && Number.isFinite(value)) { charge(JSON.stringify(value).length); return value; }
    if (typeof value === "string") { if (value.length > MAX_INPUT) reject("string bound exceeded"); charge(Buffer.byteLength(JSON.stringify(value))); return value; }
    if (!value || typeof value !== "object" || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) reject("expected inert JSON");
    if (Array.isArray(value) && value.length > 40_000) reject("structural bound exceeded");
    const ds = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(ds).length > 40_000) reject("structural bound exceeded");
    if (Reflect.ownKeys(value).some(k => typeof k !== "string") || Object.values(ds).some(d => !Object.hasOwn(d, "value"))) reject("non-JSON properties");
    if (Array.isArray(value)) {
      if (Object.keys(ds).length !== value.length + 1) reject("sparse or augmented array");
      charge(2 + Math.max(0, value.length - 1));
      return Array.from({ length: value.length }, (_, i) => { if (!ds[i]) reject("sparse array"); return walk(ds[i]!.value, depth + 1); });
    }
    charge(2 + Math.max(0, Object.keys(ds).length - 1));
    return Object.fromEntries(Object.entries(ds).map(([k, d]) => { if (!d.enumerable) reject("hidden field"); if (k.length > MAX_INPUT) reject("key bound exceeded"); charge(Buffer.byteLength(JSON.stringify(k)) + 1); return [k, walk(d.value, depth + 1)]; }));
  }
  const result = walk(raw, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_INPUT) reject("input exceeds 256 KiB");
  return result;
}
function boundedText(v: unknown, max: number, empty = false): asserts v is string {
  const controls = empty ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (typeof v !== "string" || (!empty && !v.trim()) || [...v].length > max || controls.test(v) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)) reject("invalid bounded text");
}
function id(v: unknown): asserts v is string { if (typeof v !== "string" || !/^[A-Za-z0-9_.:-]{1,96}$/.test(v)) reject("invalid identifier"); }
function list(v: unknown, maximum: number): asserts v is unknown[] { if (!Array.isArray(v) || v.length < 1 || v.length > maximum) reject("invalid array size"); }
function unique(values: string[]): void { if (new Set(values).size !== values.length) reject("duplicate identifier"); }
function absolute(v: unknown): asserts v is string {
  boundedText(v, 4096);
  if (!isAbsolute(v) || normalize(v) !== v || v === "/" || /[\\\r\n]/.test(v)) reject("expected canonical absolute path");
}
export function normalizeCreditCalibrationCorpus(raw: unknown): CreditCalibrationCorpus {
  const v = detached(raw); keys(v, ["schemaVersion", "kind", "rubric", "cases"]);
  if (v.schemaVersion !== 1 || v.kind !== "coworker-credit-calibration") reject("unsupported corpus");
  keys(v.rubric, ["id", "version", "author", "scope", "description"]);
  id(v.rubric.id); boundedText(v.rubric.author, 256); boundedText(v.rubric.description, 4096);
  if (v.rubric.version !== 1 || v.rubric.scope !== "synthetic_extraction") reject("unsupported rubric");
  list(v.cases, 128);
  for (const c of v.cases) {
    keys(c, ["id", "category", "text", "facts"]); id(c.id); id(c.category); boundedText(c.text, 8192, true); list(c.facts, 16);
    for (const f of c.facts) {
      keys(f, ["id", "value", "unit", "aliases", "expected", "rationale"]);
      id(f.id); boundedText(f.value, 256); boundedText(f.unit, 32); boundedText(f.rationale, 2048); list(f.aliases, 16);
      f.aliases.forEach(a => boundedText(a, 256)); unique(f.aliases as string[]);
      if (typeof f.expected !== "boolean" && f.expected !== "unknown") reject("invalid expected label");
    }
    unique((c.facts as CreditFact[]).map(f => f.id));
  }
  unique((v.cases as CreditCase[]).map(c => c.id));
  return freezeSnapshot(v) as unknown as CreditCalibrationCorpus;
}
export function prepareCreditCalibrationRequest(raw: unknown): CreditCalibrationRequest {
  const v = detached(raw); keys(v, ["schemaVersion", "kind", "source", "corpus", "requestDigest"], ["source", "corpus"]);
  if ((v.schemaVersion !== undefined && v.schemaVersion !== 1) || (v.kind !== undefined && v.kind !== "coworker-credit-calibration-request")) reject("unsupported request");
  keys(v.source, ["path", "sha256"]); absolute(v.source.path);
  if (!Object.values(CREDIT_SCORERS).includes(v.source.sha256 as typeof CREDIT_SCORERS.legacy)) reject("unreviewed source digest");
  const corpus = normalizeCreditCalibrationCorpus(v.corpus);
  const body = { schemaVersion: 1 as const, kind: "coworker-credit-calibration-request" as const, source: v.source as unknown as CreditCalibrationRequest["source"], corpus };
  const requestDigest = hash(body);
  if (v.requestDigest !== undefined && v.requestDigest !== requestDigest) reject("request digest mismatch");
  return freezeSnapshot({ ...body, requestDigest });
}
export function creditProbeInput(raw: CreditCalibrationRequest) {
  const request = prepareCreditCalibrationRequest(raw);
  // Expected labels and rationales belong to the assessor, never to the scorer.
  return freezeSnapshot({ schemaVersion: 1, kind: "coworker-credit-probe", source: request.source,
    cases: request.corpus.cases.map(c => ({ id: c.id, text: c.text, facts: c.facts.map(f => ({ id: f.id, value: f.value, unit: f.unit, aliases: f.aliases })) })) });
}
function validateResult(raw: unknown, request: CreditCalibrationRequest): CreditProbeResult {
  const v = detached(raw); keys(v, ["schemaVersion", "kind", "sourceSha256", "probeInputDigest", "cases"]);
  if (v.schemaVersion !== 1 || v.kind !== "coworker-credit-probe-result" || v.sourceSha256 !== request.source.sha256 || v.probeInputDigest !== hash(creditProbeInput(request))) reject("result identity mismatch");
  if (!Array.isArray(v.cases) || v.cases.length !== request.corpus.cases.length) reject("case coverage mismatch");
  v.cases.forEach((c: unknown, i: number) => {
    keys(c, ["id", "facts"]); const expected = request.corpus.cases[i]!;
    if (c.id !== expected.id || !Array.isArray(c.facts) || c.facts.length !== expected.facts.length) reject("ordered case join mismatch");
    c.facts.forEach((f: unknown, j: number) => {
      keys(f, ["id", "credited", "error"]);
      const scored = typeof f.credited === "boolean" && f.error === null;
      const failed = f.credited === null && (f.error === "scorer_exception" || f.error === "invalid_verdict");
      if (f.id !== expected.facts[j]!.id || (!scored && !failed)) reject("fact join or verdict mismatch");
    });
  });
  return freezeSnapshot(v) as unknown as CreditProbeResult;
}
/** Computes agreement with declared labels; it cannot certify those labels as truth. */
export function assessCreditCalibration(raw: CreditCalibrationRequest, output: unknown): CreditCalibrationAssessment {
  const request = prepareCreditCalibrationRequest(raw), result = validateResult(output, request);
  const counts = { total: 0, known: 0, unknown: 0, errors: 0, truePositive: 0, trueNegative: 0, falsePositive: 0, falseNegative: 0 };
  const cases = request.corpus.cases.map((c, i) => ({ id: c.id, category: c.category, facts: c.facts.map((f, j) => {
    const { credited: observed, error } = result.cases[i]!.facts[j]!; counts.total++;
    let outcome: CreditCalibrationAssessment["cases"][number]["facts"][number]["outcome"];
    if (error !== null) { counts.errors++; outcome = "scorer_error"; }
    else if (f.expected === "unknown") { counts.unknown++; outcome = "unassessed"; }
    else { counts.known++; if (f.expected) { if (observed) counts.truePositive++; else counts.falseNegative++; }
      else { if (observed) counts.falsePositive++; else counts.trueNegative++; }
      outcome = observed === f.expected ? "agreement" : observed ? "false_positive" : "false_negative";
    }
    return { id: f.id, observed, error, expected: f.expected, outcome, rationale: f.rationale };
  }) }));
  const body = { schemaVersion: 1 as const, kind: "coworker-credit-calibration-assessment" as const, requestDigest: request.requestDigest,
    corpusDigest: hash(request.corpus), sourceSha256: request.source.sha256, resultDigest: hash(result), scope: "synthetic_extraction" as const,
    scientificEvaluation: "unassessed" as const, counts, cases,
    conclusion: (counts.falsePositive + counts.falseNegative ? "counterexamples_found" : counts.known && counts.errors === 0 ? "no_counterexample_in_fixture" : "unassessed") as CreditCalibrationAssessment["conclusion"],
    limitations: ["Agreement is relative to declared fixture labels, not independent human adjudication.", "Selected synthetic cases do not estimate population error or training benefit.", "This probe tests extraction only; disclosure, arrival, source attribution, helper behavior and complete task success remain unassessed."] };
  return freezeSnapshot({ ...body, digest: hash(body) });
}
export function createCreditCalibrationWorker(options: { pythonExecutable: string; timeoutMs?: number }) {
  absolute(options.pythonExecutable); const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) reject("deadline must be 1–30000 ms");
  const source = readFileSync(new URL("./credit-probe.py", import.meta.url), "utf8");
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const descriptor = freezeSnapshot({ sourceSha256: sha(source), pythonExecutable: options.pythonExecutable, timeoutMs, maxOutputBytes: 131072 as const });
  return Object.freeze({ descriptor, async run(raw: CreditCalibrationRequest, signal?: AbortSignal): Promise<CreditCalibrationExecution> {
    const request = prepareCreditCalibrationRequest(raw);
    const p = await runProcess({ executable: descriptor.pythonExecutable, args: ["-I", "-S", "-B", "-c", source], cwd: "/", env: { PATH: "/usr/bin:/bin" },
      input: encode(creditProbeInput(request)), timeoutMs, maxOutputBytes: descriptor.maxOutputBytes, ...(signal ? { signal } : {}) });
    let result: CreditProbeResult | null = null, assessment: CreditCalibrationAssessment | null = null;
    let reason: string = p.stopped ?? (p.exitCode === 0 ? "invalid_worker_result" : "worker_failed");
    if (!p.stopped && p.exitCode === 0) { try { result = validateResult(JSON.parse(p.stdout), request); assessment = assessCreditCalibration(request, result); reason = "completed"; } catch { result = null; } }
    else if (!p.stopped && p.exitCode === 2) { try { const error: unknown = JSON.parse(p.stdout); keys(error, ["error"]);
      const codes = ["invalid_json", "invalid_request", "request_limit", "probe_failed", "unsupported_source", "unsafe_path", "source_missing", "source_unreadable", "source_too_large", "source_changed", "source_mismatch", "scorer_failed", "output_limit", "runtime_unavailable"];
      if (codes.includes(error.error as string)) reason = error.error as string;
    } catch { /* retain generic failure; never expose worker diagnostics as evidence */ } }
    return freezeSnapshot({ schemaVersion: 1, kind: "coworker-credit-calibration-execution", requestDigest: request.requestDigest, descriptor,
      status: assessment ? "completed" : "incomplete", reason, process: { exitCode: p.exitCode, stopped: p.stopped, stdoutSha256: sha(p.stdout), stdoutBytes: Buffer.byteLength(p.stdout), stderrSha256: sha(p.stderr), stderrBytes: Buffer.byteLength(p.stderr) }, result, assessment });
  } });
}
