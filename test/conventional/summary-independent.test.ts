import assert from "node:assert/strict";
import test from "node:test";
import { prepareConventionalRequest, summarizeEpisodes } from "../../src/integrations/conventional/protocol.ts";
import type { ConventionalRequest, ConventionalResult, Episode } from "../../src/integrations/conventional/protocol.ts";
import { runConventionalExperiment, summarizeConventionalExecution } from "../../src/integrations/conventional/worker.ts";

function spec() {
  return { schemaVersion: 1, kind: "frozenlake-q-learning", requestId: "summary-review",
    environment: { id: "FrozenLake-v1", mapName: "4x4", isSlippery: false, maxEpisodeSteps: 1 },
    algorithm: { name: "tabular-q-learning", learningRate: .2, discount: .9, epsilonStart: 1, epsilonEnd: 0 },
    replicates: [{ replicateId: "one", policySeed: 10, trainingEpisodeSeeds: [11] }],
    evaluation: { episodeSeeds: [20], randomActionSeeds: [30] },
    limits: { maxTransitions: 3, maxEpisodeTransitions: 1 } };
}

/** Synthetic worker observation only. No Python, Gymnasium or training executes. */
function observation(request: ConventionalRequest): ConventionalResult {
  const batch = (resetSeed: number, actionSeed: number | null) => {
    const episodes: Episode[] = [{ episodeIndex: 0, resetSeed, actionSeed, return: 0, steps: 1, finalState: 0,
      terminated: false, truncated: true, harnessCutoff: false, success: false }];
    return { episodes, summary: summarizeEpisodes(episodes) };
  };
  return { schemaVersion: 1, kind: "frozenlake-q-learning-result", requestId: request.requestId, requestDigest: request.requestDigest,
    environment: { ...request.environment, map: ["SFFF", "FHFH", "FFFH", "HFFG"], rewardSchedule: [1, 0, 0], slipSuccessRate: 1 / 3 },
    algorithm: { ...request.algorithm, epsilonSchedule: "linear_per_episode_start_to_end_single_episode_uses_start",
      policyRng: "python.random.Random/MT19937", trainingActionStream: "replicate_continuous", randomBaselineActionStream: "per_episode",
      trainingTieBreak: "seeded_uniform_argmax", evaluationTieBreak: "lowest_action_index", bootstrapMask: "not_terminated", evaluationUpdates: false },
    versions: { python: "3.11.14", gymnasium: "1.4.0", numpy: "2.3.5" }, randomBaseline: batch(20, 30),
    replicates: [{ replicateId: "one", policySeed: 10, training: batch(11, 10),
      qTable: Array.from({ length: 16 }, () => [0, 0, 0, 0]), greedyActions: Array<number>(16).fill(0),
      evaluation: { ...batch(20, null), baseline: "shared-random-policy" } }],
    totalTransitions: 3, resumeSupported: false };
}

test("offline summary derives evidence from frozen digest-bound stdout rather than a caller's mutable projection", async () => {
  const raw = observation(prepareConventionalRequest(spec()));
  const execution = await runConventionalExperiment(spec(), { pythonExecutable: "/fixture/python-never-executed", timeoutMs: 1000,
    execute: async () => ({ exitCode: 0, stopped: null, stdout: JSON.stringify(raw), stderr: "" }) });
  assert.equal(execution.status, "completed");
  assert.ok(Object.isFrozen(execution));
  assert.ok(Object.isFrozen(execution.request.replicates[0]!.trainingEpisodeSeeds));
  assert.ok(Object.isFrozen(execution.result!.replicates[0]!.qTable[0]));
  const expected = summarizeConventionalExecution(execution);
  assert.equal(expected.trainingReplicates[0]!.evaluation.successes, 0);
  assert.equal(expected.sharedRandomBaseline!.episodes, 1);

  raw.replicates[0]!.evaluation.summary.successes = 50;
  const mutable = structuredClone(execution);
  mutable.result!.replicates[0]!.qTable[0]![0] = 1;
  mutable.result!.randomBaseline.summary.successes = 50;
  mutable.result!.replicates[0]!.evaluation.summary.successes = 50;
  assert.deepEqual(summarizeConventionalExecution(mutable), expected);
  mutable.result = null;
  assert.deepEqual(summarizeConventionalExecution(mutable), expected);
  assert.deepEqual(summarizeConventionalExecution(execution), expected);

  const changedOutput = structuredClone(execution);
  changedOutput.process.stdout += " ";
  assert.throws(() => summarizeConventionalExecution(changedOutput), /digest/u);
  const changedRequest = structuredClone(execution);
  changedRequest.request.algorithm.discount = .5;
  assert.throws(() => summarizeConventionalExecution(changedRequest), /digest/u);
  const interrupted = structuredClone(execution);
  interrupted.process.stopped = "timeout";
  assert.throws(() => summarizeConventionalExecution(interrupted), /terminal status/u);
});
