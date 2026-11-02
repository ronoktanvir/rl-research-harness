import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { runConventionalExperiment, summarizeConventionalExecution } from "../../src/integrations/conventional/worker.ts";

const python = process.env.HARNESS_TEST_CONVENTIONAL_PYTHON;
test("real pinned Gymnasium runs reproducible policies and one shared baseline under both transition modes", { skip: !python, timeout: 120_000 }, async () => {
  for (const isSlippery of [false, true]) {
    const spec = { schemaVersion: 1, kind: "frozenlake-q-learning", requestId: `qualification-${isSlippery ? "slippery" : "deterministic"}`,
      environment: { id: "FrozenLake-v1", mapName: "4x4", isSlippery, maxEpisodeSteps: 100 },
      algorithm: { name: "tabular-q-learning", learningRate: .2, discount: .95, epsilonStart: 1, epsilonEnd: .1 },
      replicates: [0, 1, 2].map(index => ({ replicateId: `r${index}`, policySeed: 50_000 + index,
        trainingEpisodeSeeds: Array.from({ length: 500 }, (_, episode) => 1000 + index * 1000 + episode) })),
      evaluation: { episodeSeeds: Array.from({ length: 50 }, (_, index) => 10_000 + index),
        randomActionSeeds: Array.from({ length: 50 }, (_, index) => 20_000 + index) },
      limits: { maxTransitions: 170_000, maxEpisodeTransitions: 100 } };
    const first = await runConventionalExperiment(spec, { pythonExecutable: python!, timeoutMs: 30_000 });
    assert.equal(first.status, "completed", `${first.reason}: ${first.process.stderr}`);
    assert.equal(first.resultDigest, createHash("sha256").update(first.process.stdout).digest("hex"));
    const repeated = await runConventionalExperiment(spec, { pythonExecutable: python!, timeoutMs: 30_000 });
    assert.equal(repeated.status, "completed"); assert.equal(first.resultDigest, repeated.resultDigest);
    const summary = summarizeConventionalExecution(first);
    assert.equal(summary.trainingReplicates.length, 3);
    assert.equal(summary.sharedRandomBaseline!.episodes, 50);
    assert.equal(first.result!.replicates.every(replica => replica.evaluation.episodes.length === 50), true);
    assert.equal(first.result!.totalTransitions <= 170_000, true);
    // This verifies measurement and reproducibility; zero learning is a valid result.
    for (const replica of summary.trainingReplicates) assert.equal(Number.isFinite(replica.successRateDeltaFromSharedBaseline), true);
    const mutable = structuredClone(first); mutable.result!.replicates[0]!.evaluation.summary.successes = 999;
    assert.deepEqual(summarizeConventionalExecution(mutable), summary);
    mutable.process.stdout += " ";
    assert.throws(() => summarizeConventionalExecution(mutable), /digest/);
  }
});
