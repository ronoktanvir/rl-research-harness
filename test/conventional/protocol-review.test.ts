import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONVENTIONAL_PINS, FROZEN_LAKE_MAP, prepareConventionalRequest, summarizeEpisodes, validateConventionalResult } from "../../src/integrations/conventional/protocol.ts";
import type { ConventionalRequest, ConventionalResult, Episode } from "../../src/integrations/conventional/protocol.ts";
import { runConventionalToArtifacts } from "../../src/integrations/conventional/artifacts.ts";
import type { ConventionalWorkerOptions } from "../../src/integrations/conventional/worker.ts";

function request(): ConventionalRequest {
  return prepareConventionalRequest({ schemaVersion: 1, kind: "frozenlake-q-learning", requestId: "independent-review",
    environment: { id: "FrozenLake-v1", mapName: "4x4", isSlippery: true, maxEpisodeSteps: 1 },
    algorithm: { name: "tabular-q-learning", learningRate: 0.1, discount: 0.99, epsilonStart: 1, epsilonEnd: 0 },
    replicates: [{ replicateId: "replica", policySeed: 40, trainingEpisodeSeeds: [30] }],
    evaluation: { episodeSeeds: [10], randomActionSeeds: [20] }, limits: { maxTransitions: 3, maxEpisodeTransitions: 1 } });
}
function batch(resetSeed: number, actionSeed: number | null) {
  const episode: Episode = { episodeIndex: 0, resetSeed, actionSeed, return: 0, steps: 1, finalState: 0,
    terminated: false, truncated: true, harnessCutoff: false, success: false };
  return { episodes: [episode], summary: summarizeEpisodes([episode]) };
}
/** Synthetic protocol data only; no environment, Python or model is executed. */
function result(input: ConventionalRequest): ConventionalResult {
  return { schemaVersion: 1, kind: "frozenlake-q-learning-result", requestId: input.requestId, requestDigest: input.requestDigest,
    environment: { ...input.environment, map: [...FROZEN_LAKE_MAP], rewardSchedule: [1, 0, 0], slipSuccessRate: 1 / 3 },
    algorithm: { ...input.algorithm, epsilonSchedule: "linear_per_episode_start_to_end_single_episode_uses_start",
      policyRng: "python.random.Random/MT19937", trainingActionStream: "replicate_continuous", randomBaselineActionStream: "per_episode",
      trainingTieBreak: "seeded_uniform_argmax", evaluationTieBreak: "lowest_action_index", bootstrapMask: "not_terminated", evaluationUpdates: false },
    versions: { python: "3.11.14", gymnasium: CONVENTIONAL_PINS.gymnasium, numpy: CONVENTIONAL_PINS.numpy },
    randomBaseline: batch(10, 20), replicates: [{ replicateId: "replica", policySeed: 40, training: batch(30, 40),
      qTable: Array.from({ length: 16 }, () => [0, 0, 0, 0]), greedyActions: Array(16).fill(0),
      evaluation: { ...batch(10, null), baseline: "shared-random-policy" } }], totalTransitions: 3, resumeSupported: false };
}

test("result validation rejects accessor-bearing output without invoking caller code", () => {
  const expected = request(), raw = result(expected);
  let invoked = false;
  Object.defineProperty(raw, "requestId", { enumerable: true, get() { invoked = true; return expected.requestId; } });
  assert.throws(() => validateConventionalResult(raw, expected), /accessor|JSON|inert/u);
  assert.equal(invoked, false);
});

test("result validation cannot use a mutated request under its original digest", () => {
  const expected = structuredClone(request()); expected.algorithm.discount = 0.5;
  assert.throws(() => validateConventionalResult(result(expected), expected), /digest|identity|request/u);
});

test("validated observation is detached from caller-owned result data", () => {
  const expected = request(), raw = result(expected), checked = validateConventionalResult(raw, expected);
  raw.randomBaseline.episodes[0]!.return = 1;
  raw.replicates[0]!.qTable[0]![0] = 1;
  assert.equal(checked.randomBaseline.episodes[0]!.return, 0);
  assert.equal(checked.replicates[0]!.qTable[0]![0], 0);
});

test("artifact intent and invocation share the original request and options across filesystem awaits", async t => {
  const directory = await mkdtemp(join(tmpdir(), "conventional-review-")), output = join(directory, "artifacts");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { requestDigest: _digest, ...spec } = structuredClone(request());
  let actual: ConventionalRequest | undefined, executable = "", timeout = 0;
  const options: ConventionalWorkerOptions = { pythonExecutable: "/usr/bin/python3", timeoutMs: 1000,
    execute: async invocation => {
      actual = JSON.parse(invocation.input) as ConventionalRequest; executable = invocation.executable; timeout = invocation.timeoutMs;
      return { exitCode: 0, stopped: null, stderr: "", stdout: JSON.stringify(result(actual)) };
    } };
  const running = runConventionalToArtifacts(spec, options, output);
  spec.algorithm.discount = 0.5; options.pythonExecutable = "/changed/python"; options.timeoutMs = 5000;
  const completed = await running;
  const intent = JSON.parse(await readFile(join(output, "intent.json"), "utf8"));
  assert.equal(actual!.requestDigest, intent.request.requestDigest);
  assert.equal(actual!.algorithm.discount, 0.99);
  assert.equal(completed.requestDigest, intent.request.requestDigest);
  assert.equal(executable, "/usr/bin/python3"); assert.equal(timeout, 1000); assert.equal(intent.timeoutMs, 1000);
});
