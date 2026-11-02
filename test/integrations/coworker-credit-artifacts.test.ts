import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { CREDIT_SCORERS, prepareCreditCalibrationRequest } from "../../src/integrations/coworker/credit-calibration.ts";
import { runCreditCalibrationToArtifacts } from "../../src/integrations/coworker/credit-artifacts.ts";
import { hash } from "../../src/ledger/validation.ts";

const corpus = JSON.parse(await readFile(new URL("../../examples/calibration/coworker-credit-cases.json", import.meta.url), "utf8"));
const request = prepareCreditCalibrationRequest({ source: { path: "/absent/scorer.py", sha256: CREDIT_SCORERS.legacy }, corpus });

test("failed execution preserves a receipt without converting missing output into correct predictions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "credit-artifacts-")), output = join(dir, "run");
  try {
    const result = await runCreditCalibrationToArtifacts(request, { pythonExecutable: "/no-such-credit-interpreter" }, output);
    assert.equal(result.status, "incomplete"); assert.equal(result.reason, "spawn_error");
    assert.equal(result.counts, null); assert.equal(result.conclusion, "unassessed");
    const execution = JSON.parse(await readFile(join(output, "execution.json"), "utf8"));
    const receipt = JSON.parse(await readFile(join(output, "receipt.json"), "utf8"));
    const intent = JSON.parse(await readFile(join(output, "intent.json"), "utf8"));
    assert.equal(receipt.executionDigest, hash(execution)); assert.equal(receipt.assessmentDigest, null);
    assert.equal(intent.request.requestDigest, request.requestDigest); assert.equal(intent.replaySupported, false);
    assert.match(await readFile(join(output, "report.md"), "utf8"), /No complete scoring result/);
    await assert.rejects(runCreditCalibrationToArtifacts(request, { pythonExecutable: "/no-such-credit-interpreter" }, output), /EEXIST/);
    assert.deepEqual(JSON.parse(await readFile(join(output, "receipt.json"), "utf8")), receipt);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("CLI returns incomplete and leaves source-bound evidence when the configured interpreter is unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "credit-cli-"));
  try {
    const input = join(dir, "request.json"), output = join(dir, "run");
    await writeFile(input, JSON.stringify(request));
    const p = spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "credit-calibrate", input, "/no-such-credit-interpreter", output],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 131072 });
    assert.equal(p.status, 2, p.stderr); const summary = JSON.parse(p.stdout);
    assert.equal(summary.reason, "spawn_error"); assert.equal(summary.assessmentDigest, null);
    const receipt = JSON.parse(await readFile(join(output, "receipt.json"), "utf8"));
    assert.equal(receipt.scientificEvaluation, "unassessed"); assert.equal(receipt.requestDigest, request.requestDigest);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
