import assert from "node:assert/strict";
import test from "node:test";
import { hash } from "../../src/ledger/validation.ts";
import {
  CREDIT_SCORERS, normalizeCreditCalibrationCorpus, prepareCreditCalibrationRequest,
  creditProbeInput, assessCreditCalibration, createCreditCalibrationWorker,
} from "../../src/integrations/coworker/credit-calibration.ts";
import type { CreditCalibrationRequest, CreditProbeResult } from "../../src/integrations/coworker/credit-calibration.ts";

function corpus() {
  return { schemaVersion: 1, kind: "coworker-credit-calibration", rubric: {
    id: "independent-labels", version: 1, author: "test reviewer", scope: "synthetic_extraction",
    description: "Declared labels for arithmetic and input-boundary tests; no native semantic claim.",
  }, cases: [{ id: "example-a", category: "boundary", text: "Reported free cash flow is $12.50M.", facts: [
    { id: "fact-positive", value: "12.50", unit: "M", aliases: ["free cash flow"], expected: true as boolean | "unknown", rationale: "POSITIVE_LABEL_ONLY" },
    { id: "fact-negative", value: "19.50", unit: "M", aliases: ["free cash flow"], expected: false as boolean | "unknown", rationale: "NEGATIVE_LABEL_ONLY" },
    { id: "fact-unknown", value: "8.50", unit: "M", aliases: ["free cash flow"], expected: "unknown" as boolean | "unknown", rationale: "UNKNOWN_LABEL_ONLY" },
  ] }] };
}
function request(value = corpus()): CreditCalibrationRequest {
  return prepareCreditCalibrationRequest({ source: { path: "/never-opened/extraction.py", sha256: CREDIT_SCORERS.legacy }, corpus: value });
}
function result(r: CreditCalibrationRequest, values: readonly boolean[] = [true, false, true]): CreditProbeResult {
  let index = 0;
  return { schemaVersion: 1, kind: "coworker-credit-probe-result", sourceSha256: r.source.sha256,
    probeInputDigest: hash(creditProbeInput(r)), cases: r.corpus.cases.map(c => ({ id: c.id,
      facts: c.facts.map(f => ({ id: f.id, credited: values[index++] ?? false, error: null })) })) };
}

test("credit result binds scored text, fact definition, alias and source path even when identifiers are reused", () => {
  const r = request(), output = result(r);
  const mutations: ((v: ReturnType<typeof corpus>) => void)[] = [
    v => { v.cases[0]!.text = "The same labels now refer to different content."; },
    v => { v.cases[0]!.facts[0]!.value = "19.50"; },
    v => { v.cases[0]!.facts[0]!.unit = "B"; },
    v => { v.cases[0]!.facts[0]!.aliases[0] = "revenue"; },
  ];
  for (const mutate of mutations) {
    const changed = corpus(); mutate(changed);
    assert.throws(() => assessCreditCalibration(request(changed), output), /identity mismatch/);
  }
  const moved = prepareCreditCalibrationRequest({ source: { ...r.source, path: "/another/extraction.py" }, corpus: r.corpus });
  assert.throws(() => assessCreditCalibration(moved, output), /identity mismatch/);
});

test("expected labels and rationales never enter scorer input and relabeling changes assessment identity", () => {
  const original = corpus(), r = request(original), input = creditProbeInput(r), output = result(r);
  assert.deepEqual(Object.keys(input), ["schemaVersion", "kind", "source", "cases"]);
  assert.deepEqual(Object.keys(input.cases[0]!), ["id", "text", "facts"]);
  for (const fact of input.cases[0]!.facts) assert.deepEqual(Object.keys(fact), ["id", "value", "unit", "aliases"]);
  const serialized = JSON.stringify(input);
  for (const key of ["expected", "rationale", "POSITIVE_LABEL_ONLY", "NEGATIVE_LABEL_ONLY", "UNKNOWN_LABEL_ONLY", "rubric"]) assert.ok(!serialized.includes(key));
  const first = assessCreditCalibration(r, output);
  original.cases[0]!.facts[0]!.expected = false;
  original.cases[0]!.facts[0]!.rationale = "Revised annotation, not a new scorer observation.";
  const relabeled = request(original), next = assessCreditCalibration(relabeled, output);
  assert.equal(hash(creditProbeInput(relabeled)), hash(input));
  assert.notEqual(next.requestDigest, first.requestDigest);
  assert.notEqual(next.corpusDigest, first.corpusDigest);
  assert.notEqual(next.digest, first.digest);
  assert.equal(next.counts.falsePositive, 1);
  assert.equal(next.scientificEvaluation, "unassessed");
});

test("unknown labels are never true negatives or favorable evidence and known denominators are recomputed", () => {
  const r = request(), a = assessCreditCalibration(r, result(r, [false, true, false]));
  assert.deepEqual(a.counts, { total: 3, known: 2, unknown: 1, errors: 0, truePositive: 0, trueNegative: 0, falsePositive: 1, falseNegative: 1 });
  assert.equal(a.cases[0]!.facts[2]!.outcome, "unassessed");
  assert.equal(a.conclusion, "counterexamples_found");
  const unknown = corpus(); unknown.cases[0]!.facts.forEach(f => { f.expected = "unknown"; });
  const u = request(unknown), unassessed = assessCreditCalibration(u, result(u, [false, false, false]));
  assert.deepEqual(unassessed.counts, { total: 3, known: 0, unknown: 3, errors: 0, truePositive: 0, trueNegative: 0, falsePositive: 0, falseNegative: 0 });
  assert.equal(unassessed.conclusion, "unassessed");
  const agreement = assessCreditCalibration(r, result(r));
  assert.equal(agreement.conclusion, "no_counterexample_in_fixture");
  assert.equal(agreement.counts.unknown, 1);
  assert.equal(agreement.scope, "synthetic_extraction");
  assert.equal(agreement.scientificEvaluation, "unassessed");
});

test("per-fact scorer errors are excluded from known and unknown agreement denominators and prevent a favorable conclusion", () => {
  const r = request(), output = structuredClone(result(r));
  Object.assign(output.cases[0]!.facts[1]!, { credited: null, error: "scorer_exception" });
  Object.assign(output.cases[0]!.facts[2]!, { credited: null, error: "invalid_verdict" });
  const a = assessCreditCalibration(r, output);
  assert.deepEqual(a.counts, { total: 3, known: 1, unknown: 0, errors: 2, truePositive: 1, trueNegative: 0, falsePositive: 0, falseNegative: 0 });
  assert.equal(a.conclusion, "unassessed");
  assert.equal(a.scientificEvaluation, "unassessed");
  assert.equal(a.cases[0]!.facts[1]!.observed, null);
  assert.equal(a.cases[0]!.facts[1]!.outcome, "scorer_error");
  assert.equal(a.cases[0]!.facts[1]!.error, "scorer_exception");
  assert.equal(a.cases[0]!.facts[2]!.outcome, "scorer_error");
  assert.equal(a.cases[0]!.facts[2]!.error, "invalid_verdict");
  assert.equal(a.cases[0]!.facts[2]!.expected, "unknown");
  assert.equal(a.counts.total, a.counts.known + a.counts.unknown + a.counts.errors);

  const mixed = structuredClone(result(r, [false, false, false]));
  Object.assign(mixed.cases[0]!.facts[1]!, { credited: null, error: "scorer_exception" });
  const m = assessCreditCalibration(r, mixed);
  assert.deepEqual(m.counts, { total: 3, known: 1, unknown: 1, errors: 1, truePositive: 0, trueNegative: 0, falsePositive: 0, falseNegative: 1 });
  assert.equal(m.conclusion, "counterexamples_found");

  const failed = structuredClone(result(r));
  failed.cases[0]!.facts.forEach(f => Object.assign(f, { credited: null, error: "scorer_exception" }));
  const f = assessCreditCalibration(r, failed);
  assert.deepEqual(f.counts, { total: 3, known: 0, unknown: 0, errors: 3, truePositive: 0, trueNegative: 0, falsePositive: 0, falseNegative: 0 });
  assert.equal(f.conclusion, "unassessed");
});

test("verdict and per-fact error fields must form exactly one valid pair", () => {
  const r = request();
  for (const pair of [
    { credited: true, error: "scorer_exception" },
    { credited: false, error: "invalid_verdict" },
    { credited: null, error: null },
    { credited: null, error: "scorer_failed" },
    { credited: null, error: ["scorer_exception"] },
    { credited: "false", error: null },
    { credited: 0, error: null },
  ]) {
    const bad = structuredClone(result(r));
    Object.assign(bad.cases[0]!.facts[0]!, pair);
    assert.throws(() => assessCreditCalibration(r, bad), JSON.stringify(pair));
  }
  const missingError = structuredClone(result(r));
  delete (missingError.cases[0]!.facts[0]! as any).error;
  assert.throws(() => assessCreditCalibration(r, missingError));
  const missingVerdict = structuredClone(result(r));
  delete (missingVerdict.cases[0]!.facts[0]! as any).credited;
  assert.throws(() => assessCreditCalibration(r, missingVerdict));
});

test("missing, extra, duplicated or reordered facts and coercible verdicts cannot enter calibration counts", () => {
  const r = request();
  const mutations: ((v: any) => void)[] = [
    v => { v.cases = []; }, v => { v.cases.push(structuredClone(v.cases[0])); },
    v => { v.cases[0].facts.pop(); }, v => { v.cases[0].facts.push({ id: "surplus", credited: true }); },
    v => { v.cases[0].facts[1] = structuredClone(v.cases[0].facts[0]); },
    v => { v.cases[0].facts.reverse(); },
    ...[null, 0, 1, "true", "false", [true], { value: true }].map(credited => (v: any) => { v.cases[0].facts[0].credited = credited; }),
    v => { v.counts = { truePositive: 999 }; }, v => { v.conclusion = "valid"; },
    v => { v.sourceSha256 = CREDIT_SCORERS.v2; },
  ];
  for (const mutate of mutations) { const bad = structuredClone(result(r)); mutate(bad); assert.throws(() => assessCreditCalibration(r, bad)); }
  assert.throws(() => assessCreditCalibration(r, { status: "incomplete", result: null }));
});

test("inert normalization rejects getters, sparse arrays, extra labels, unsupported sources and oversized Unicode", () => {
  let invoked = 0;
  const getterCorpus = corpus();
  Object.defineProperty(getterCorpus.cases[0]!.facts[0]!, "expected", { enumerable: true, get() { invoked++; return true; } });
  assert.throws(() => normalizeCreditCalibrationCorpus(getterCorpus), /non-JSON properties/);
  const getterResult = result(request());
  Object.defineProperty(getterResult.cases[0]!.facts[0]!, "credited", { enumerable: true, get() { invoked++; return true; } });
  assert.throws(() => assessCreditCalibration(request(), getterResult), /non-JSON properties/);
  assert.equal(invoked, 0);
  const sparse = corpus(); delete sparse.cases[0]!.facts[1]; assert.throws(() => normalizeCreditCalibrationCorpus(sparse), /sparse/);
  const dup = corpus(); dup.cases[0]!.facts[1]!.id = dup.cases[0]!.facts[0]!.id; assert.throws(() => normalizeCreditCalibrationCorpus(dup), /duplicate/);
  const extra = { ...corpus(), scientificEvaluation: "approved" }; assert.throws(() => normalizeCreditCalibrationCorpus(extra));
  assert.throws(() => prepareCreditCalibrationRequest({ source: { path: "/x/../extraction.py", sha256: CREDIT_SCORERS.legacy }, corpus: corpus() }), /canonical absolute path/);
  assert.throws(() => prepareCreditCalibrationRequest({ source: { path: "/extraction.py", sha256: "a".repeat(64) }, corpus: corpus() }), /unreviewed/);
  const invalid = corpus(); (invalid.cases[0]!.facts[0] as any).expected = 1; assert.throws(() => normalizeCreditCalibrationCorpus(invalid));
  const large = corpus(); large.cases = Array.from({ length: 9 }, (_, i) => ({ ...structuredClone(large.cases[0]!), id: "large-" + i, text: "😀".repeat(8192) }));
  assert.throws(() => normalizeCreditCalibrationCorpus(large), /256 KiB/);
});

test("Python protocol controls are rejected during preparation while ordinary multiline memo text is preserved", () => {
  const multiline = corpus(); multiline.cases[0]!.text = "Cash flow:\n$12.50M\treported.\r\n";
  assert.equal(normalizeCreditCalibrationCorpus(multiline).cases[0]!.text, multiline.cases[0]!.text);
  for (const control of ["\u0001", "\u000b", "\u001f"]) {
    const c = corpus(); c.cases[0]!.text += control; assert.throws(() => normalizeCreditCalibrationCorpus(c));
  }
  for (const field of ["value", "unit"] as const) {
    const c = corpus(); c.cases[0]!.facts[0]![field] += "\n"; assert.throws(() => normalizeCreditCalibrationCorpus(c));
  }
  const alias = corpus(); alias.cases[0]!.facts[0]!.aliases[0] += "\t"; assert.throws(() => normalizeCreditCalibrationCorpus(alias));
});

test("prepared inputs and assessment results are detached and deeply frozen", () => {
  const raw = corpus(), r = request(raw), output = result(r), a = assessCreditCalibration(r, output);
  raw.cases[0]!.text = "changed"; raw.cases[0]!.facts[0]!.expected = false;
  assert.notEqual(r.corpus.cases[0]!.text, "changed");
  assert.equal(r.corpus.cases[0]!.facts[0]!.expected, true);
  assert.ok(Object.isFrozen(r.corpus.cases[0]!.facts[0]!.aliases));
  assert.ok(Object.isFrozen(a.cases[0]!.facts[0])); assert.ok(Object.isFrozen(a.counts));
  const changed = structuredClone(r); changed.source.sha256 = CREDIT_SCORERS.v2;
  assert.throws(() => prepareCreditCalibrationRequest(changed), /request digest mismatch/);
  const { digest, ...body } = a; assert.equal(digest, hash(body));
});

test("pre-aborted and spawn-failed workers retain incomplete execution and no scientific verdict", async () => {
  // These two process paths never execute Python or inspect an upstream source file.
  const worker = createCreditCalibrationWorker({ pythonExecutable: "/nonexistent-credit-review/python3", timeoutMs: 100 });
  const controller = new AbortController(); controller.abort();
  const cancelled = await worker.run(request(), controller.signal);
  assert.equal(cancelled.status, "incomplete"); assert.equal(cancelled.reason, "cancelled");
  assert.equal(cancelled.process.stopped, "cancelled"); assert.equal(cancelled.assessment, null); assert.equal(cancelled.result, null);
  const absent = await worker.run(request());
  assert.equal(absent.status, "incomplete"); assert.equal(absent.reason, "spawn_error");
  assert.equal(absent.assessment, null); assert.equal(absent.result, null);
});
