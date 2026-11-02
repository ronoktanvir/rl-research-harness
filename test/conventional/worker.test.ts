import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareConventionalRequest } from "../../src/integrations/conventional/protocol.ts";
import { runConventionalExperiment } from "../../src/integrations/conventional/worker.ts";
import { runConventionalToArtifacts } from "../../src/integrations/conventional/artifacts.ts";

export function smallSpec() {
  return { schemaVersion: 1, kind: "frozenlake-q-learning", requestId: "bounded-fixture",
    environment: { id: "FrozenLake-v1", mapName: "4x4", isSlippery: false, maxEpisodeSteps: 10 },
    algorithm: { name: "tabular-q-learning", learningRate: .2, discount: .95, epsilonStart: 1, epsilonEnd: .1 },
    replicates: [{ replicateId: "r1", policySeed: 42, trainingEpisodeSeeds: [100, 101] }],
    evaluation: { episodeSeeds: [200, 201], randomActionSeeds: [300, 301] }, limits: { maxTransitions: 60, maxEpisodeTransitions: 10 } };
}

test("fixed worker validates allowance before spawn and receives no inherited credentials or project code", async () => {
  let calls = 0;
  const options = { pythonExecutable: "/trusted/python", timeoutMs: 1000, execute: async (request: import("../../src/workers/process.ts").ProcessRequest) => {
    calls++; assert.deepEqual(request.args.slice(0, 3), ["-I", "-B", "-c"]);
    assert.match(request.args[3]!, /def validate_request/);
    assert.deepEqual(Object.keys(request.env).sort(), ["OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "PATH", "PYTHONIOENCODING"]);
    assert.notEqual(request.cwd, process.cwd());
    assert.equal(JSON.parse(request.input).requestDigest, prepareConventionalRequest(smallSpec()).requestDigest);
    return { exitCode: 0, stdout: "{}", stderr: "", stopped: null } as const;
  } };
  const invalid = smallSpec(); invalid.limits.maxTransitions = 59;
  await assert.rejects(runConventionalExperiment(invalid, options), /allowance/);
  assert.equal(calls, 0);
  const result = await runConventionalExperiment(smallSpec(), options);
  assert.equal(result.status, "incomplete"); assert.equal(result.reason, "invalid_worker_result");
  assert.equal(calls, 1); assert.equal(Object.isFrozen(result.request.algorithm), true);
});

test("timeout and cancelled output cannot become complete evidence", async () => {
  for (const stopped of ["timeout", "cancelled", "output_limit", "spawn_error"] as const) {
    const result = await runConventionalExperiment(smallSpec(), { pythonExecutable: "/trusted/python", timeoutMs: 100,
      execute: async () => ({ exitCode: 0, stdout: '{"partial":true}', stderr: "", stopped }) });
    assert.equal(result.status, "incomplete"); assert.equal(result.reason, stopped); assert.equal(result.resultDigest, null);
  }
});

test("intent precedes the effect, caller mutation cannot change it and an existing artifact directory never replays", async t => {
  const root = await mkdtemp(join(tmpdir(), "conventional-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "experiment"), raw = smallSpec();
  const expected = prepareConventionalRequest(raw); let calls = 0;
  const options = { pythonExecutable: "/trusted/python", timeoutMs: 1000, execute: async (request: import("../../src/workers/process.ts").ProcessRequest) => {
    calls++;
    const intent = JSON.parse(await readFile(join(directory, "intent.json"), "utf8"));
    assert.deepEqual(JSON.parse(request.input), expected); assert.deepEqual(intent.request, expected);
    return { exitCode: 1, stdout: "", stderr: "fixture failure", stopped: null } as const;
  } };
  const running = runConventionalToArtifacts(raw, options, directory);
  raw.algorithm.discount = .1; options.timeoutMs = 5000;
  const result = await running;
  assert.equal(result.status, "incomplete"); assert.equal(result.requestDigest, expected.requestDigest);
  assert.equal(JSON.parse(await readFile(join(directory, "intent.json"), "utf8")).timeoutMs, 1000);
  await assert.rejects(runConventionalToArtifacts(smallSpec(), options, directory), /EEXIST/);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(join(directory, "receipt.json"), "utf8")).status, "incomplete");
});
