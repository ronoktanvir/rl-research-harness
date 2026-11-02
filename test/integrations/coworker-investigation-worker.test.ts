import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { hash } from "../../src/ledger/validation.ts";
import { createCoworkerInvestigationWorker, prepareCoworkerInvestigationRequest, validateCoworkerInvestigationExecution } from "../../src/integrations/coworker/investigation-worker.ts";

const python = execFileSync("python3", ["-I", "-S", "-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
const fixtureFile = new URL("./coworker_investigation_fixtures.py", import.meta.url).pathname;
async function fixture(label = "first") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "investigation-worker-")));
  const raw: unknown = JSON.parse(execFileSync(python, ["-I", "-S", "-B", fixtureFile, root, label], { encoding: "utf8" }));
  return { root, request: prepareCoworkerInvestigationRequest(raw), close: () => rm(root, { recursive: true, force: true }) };
}

test("fixed isolated worker verifies two capture-driven synthetic datasets without exposing content", async () => {
  const worker = createCoworkerInvestigationWorker({ pythonExecutable: python });
  let lastDigest: string | undefined;
  for (const label of ["first", "second"]) {
    const f = await fixture(label);
    try {
      const result = await worker.run(f.request);
      assert.equal(result.status, "completed"); assert.equal(result.result?.scientificEvaluation, "unassessed");
      assert.equal(result.result?.cells.trained.rows, 3); assert.equal(result.result?.cells.trained.summaryRan, 2);
      assert.equal(result.result?.cells.trained.summaryResumedFrom, 1); assert.equal(result.result?.scientificReplicationCount, 1);
      assert.equal(result.resultSha256, hash(result.result)); assert.equal(result.observations.length, 6);
      assert.notEqual(lastDigest, result.request.report.sha256); lastDigest = result.request.report.sha256;
      const encoded = JSON.stringify(result); assert.ok(!encoded.includes("SENTINEL")); assert.ok(!encoded.includes("endpoint_base_url")); assert.ok(!encoded.includes("transcript"));
      assert.equal(result.process.stderrBytes, 0); assert.equal(result.process.stderrSha256, createHash("sha256").digest("hex"));
      assert.ok(Object.isFrozen(result.result?.cells));
    } finally { await f.close(); }
  }
});

test("captured hash mismatch is distinct from missing adapter, with retained earlier checks", async () => {
  const f = await fixture(); const worker = createCoworkerInvestigationWorker({ pythonExecutable: python });
  try {
    await unlink(join(f.root, f.request.localArtifacts.adapterPath));
    const result = await worker.run(f.request); assert.equal(result.reason, "missing_file");
    assert.deepEqual(result.observations.map(c => [c.check, c.status]), [["report", "verified"], ["source", "verified"], ["adapter", "failed"]]);
    assert.equal(result.result, null);
    await writeFile(join(f.root, f.request.report.path), "{}");
    const changed = await worker.run(f.request); assert.equal(changed.reason, "evidence_mismatch");
    assert.equal(changed.observations[0]?.files[0]?.bytes, 2);
  } finally { await f.close(); }
});

test("request validation rejects accessors and selections outside declared direct paths", async () => {
  const f = await fixture();
  try {
    let accessed = 0;
    assert.throws(() => prepareCoworkerInvestigationRequest({ ...f.request, get root() { accessed++; return f.root; } }), /Accessors/);
    assert.equal(accessed, 0);
    const { requestDigest: _, ...request } = f.request;
    assert.throws(() => prepareCoworkerInvestigationRequest({ ...request, localArtifacts: { ...request.localArtifacts, trainedTracePath: "../escape" } }), /Unsafe/);
    assert.throws(() => prepareCoworkerInvestigationRequest({ ...request, localArtifacts: { ...request.localArtifacts, trainedTracePath: request.localArtifacts.trainedEvaluationDirectory + "/step0-trace.jsonl" } }), /Unsupported/);
    assert.throws(() => prepareCoworkerInvestigationRequest({ ...f.request, requestDigest: "f".repeat(64) }), /digest/);
  } finally { await f.close(); }
});

test("strict execution projection rejects added trace content, changed identity and contradictory complete checks", async () => {
  const f = await fixture(); const worker = createCoworkerInvestigationWorker({ pythonExecutable: python });
  try {
    const value = await worker.run(f.request); assert.equal(value.status, "completed");
    assert.throws(() => validateCoworkerInvestigationExecution({ ...value, rawTrace: "private" }, f.request, worker.descriptor));
    assert.throws(() => validateCoworkerInvestigationExecution({ ...value, observations: [] }, f.request, worker.descriptor));
    const changed = structuredClone(value); changed.result!.historicalExecution = "verified" as "unverified";
    changed.resultSha256 = hash(changed.result); assert.throws(() => validateCoworkerInvestigationExecution(changed, f.request, worker.descriptor));
    const counts = structuredClone(value); counts.result!.cells.trained.producerCleanSuccessCount = 999;
    counts.resultSha256 = hash(counts.result); assert.throws(() => validateCoworkerInvestigationExecution(counts, f.request, worker.descriptor));
    assert.throws(() => validateCoworkerInvestigationExecution(value, f.request, { ...worker.descriptor, timeoutMs: 1 }));
  } finally { await f.close(); }
});

test("aborted invocation is incomplete and never reads selected files", async () => {
  const f = await fixture(); const controller = new AbortController(); controller.abort();
  try {
    const worker = createCoworkerInvestigationWorker({ pythonExecutable: python });
    const value = await worker.run(f.request, controller.signal);
    assert.equal(value.reason, "cancelled"); assert.equal(value.result, null); assert.deepEqual(value.observations, []); assert.equal(value.process.stdoutBytes, 0);
  } finally { await f.close(); }
});
