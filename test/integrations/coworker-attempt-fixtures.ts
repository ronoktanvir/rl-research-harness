import type { JsonObject } from "../../src/ledger/types.ts";
import { hash } from "../../src/ledger/validation.ts";
import { COWORKER_SOURCE_REVISION } from "../../src/integrations/coworker/attempt-plan.ts";
import type { CoworkerAttemptInput, CoworkerAttemptConfiguration } from "../../src/integrations/coworker/attempt-plan.ts";

/** Synthetic declarations only: no fixture path, receipt, source tree or qualification exists. */
export function coworkerAttemptFixture(): CoworkerAttemptInput {
  const configuration: CoworkerAttemptConfiguration = {
    source: { revision: COWORKER_SOURCE_REVISION, treeSha256: "a".repeat(64), root: "/opt/coworker-source" },
    environment: { imageDigest: `sha256:${"b".repeat(64)}`, dependenciesDigest: "c".repeat(64), pythonExecutable: "/opt/trainer/bin/python" },
    paths: { inputRoot: "/srv/inputs", outputRoot: "/srv/attempts" },
    inputs: { experimentManifest: { relativePath: "tasks/manifest.json", sha256: "d".repeat(64) },
      numericalQualificationReceipt: { relativePath: "qualification/receipt.json", sha256: "e".repeat(64) }, initialAdapter: null, resume: null },
    trainer: { selection: "train", configIds: ["task-1", "task-2"], endpoint: "http://127.0.0.1:8000/v1", modelName: "m-qwen3-8b-v2",
      baseModel: "Qwen/Qwen3-8B", init: "base", g: 8, steps: 2, trainingSeed: 11, initSeed: 11,
      samplingExternalPreflights: 10, stepIndexStart: 0, worldSeedStart: 0, judgeModel: "fixture-judge-model",
      rewardMode: "banded", semanticInstrument: null, taskManifestSha256: null, maxPromptTokens: 36_864, learningRate: 0.00001,
      maxDegenerateSteps: 5, shuffledControlSeed: null, shuffledTrainingRunSeed: null },
    helper: { model: "fixture-helper-model", provider: "anthropic", region: null, concurrency: 4, timeoutSeconds: 60, cache: "attempt-local" },
    limits: { podHourlyMicrodollars: "1500000", trainingGpuCeilingMicrodollars: "1000000", maxElapsedSeconds: 60,
      maxHelperProviderCalls: 4, maxJudgeProviderCalls: 4, runtimeMaxSeconds: 120, startTimeoutSeconds: 30, stopGraceSeconds: 10,
      memoryMaxBytes: 8_589_934_592, tasksMax: 128 },
  };
  const manifest = { schemaVersion: 1 as const, code: { revision: COWORKER_SOURCE_REVISION, dirtyPatchSha256: null },
    environment: { imageDigest: configuration.environment.imageDigest, dependenciesDigest: configuration.environment.dependenciesDigest },
    adapter: { kind: "llm_posttraining" as const, name: "coworkerl-v2-fit-loop", config: JSON.parse(JSON.stringify(configuration)) as JsonObject },
    data: { version: "fixture-tasks", splitsDigest: "f".repeat(64) }, model: { version: "fixture-model" },
    reward: { version: "fixture-reward" }, evaluator: { version: "fixture-evaluator" }, seeds: [11],
    resources: { maxDurationSeconds: 180, maxCostMicrodollars: "2000000" }, evaluationPolicy: { fixture: true } };
  const digest = hash(manifest);
  return { manifest: { digest, manifest }, run: { projectId: "coworker", runId: "run-one", replicaId: "replica-one", manifestDigest: digest }, operationRevision: 1, configuration };
}

/** Rebind changed synthetic declarations; this is not a native preflight. */
export function rebindCoworkerFixture(input: CoworkerAttemptInput): CoworkerAttemptInput {
  input.manifest.manifest.adapter.config = JSON.parse(JSON.stringify(input.configuration)) as JsonObject;
  input.manifest.digest = hash(input.manifest.manifest);
  input.run.manifestDigest = input.manifest.digest;
  return input;
}
