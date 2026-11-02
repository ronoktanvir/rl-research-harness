import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { hash } from "../../src/ledger/validation.ts";
import type { ExperimentManifest } from "../../src/ledger/types.ts";
import { prepareConventionalAttempt } from "../../src/integrations/conventional/supervised.ts";
import type { ConventionalAttemptInput, ConventionalDeployment } from "../../src/integrations/conventional/supervised.ts";

function fixture(): ConventionalAttemptInput {
  const spec = { schemaVersion: 1, kind: "frozenlake-q-learning", requestId: "admitted-methods-review",
    environment: { id: "FrozenLake-v1", mapName: "4x4", isSlippery: true, maxEpisodeSteps: 10 },
    algorithm: { name: "tabular-q-learning", learningRate: .2, discount: .95, epsilonStart: 1, epsilonEnd: .1 },
    replicates: [{ replicateId: "r1", policySeed: 42, trainingEpisodeSeeds: [100, 101] }],
    evaluation: { episodeSeeds: [200, 201], randomActionSeeds: [300, 301] },
    limits: { maxTransitions: 60, maxEpisodeTransitions: 10 } };
  const limits = { runtimeMs: 5000, startTimeoutMs: 2000, stopTimeoutMs: 1000, memoryMaxBytes: 128 * 1024 * 1024, tasksMax: 16 };
  const deployment: ConventionalDeployment = { schemaVersion: 1, deploymentId: "fixture-deployment", workerId: "fixture-worker",
    code: { revision: "f".repeat(40), dirtyPatchSha256: null,
      runner: { path: "/srv/harness/runner.py", sha256: "1".repeat(64) },
      entry: { path: "/srv/harness/entry.py", sha256: "2".repeat(64) },
      requirements: { path: "/srv/harness/requirements.lock", sha256: "3".repeat(64) } },
    environment: { pythonExecutable: "/opt/venv/bin/python", imageDigest: `sha256:${"4".repeat(64)}`, dependenciesDigest: "3".repeat(64) },
    outputRoot: "/var/lib/harness/results", host: { machineId: "1".repeat(32), bootId: "22222222-2222-2222-2222-222222222222" },
    limits, profile: { userId: 1000, groupId: 1000, executables: ["/opt/venv/bin/python"],
      readOnlyPaths: ["/srv/harness", "/opt/venv", "/srv/gate"], writableRoot: "/var/lib/harness/results",
      allowedEnvironment: ["OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS"], maxima: { ...limits }, useSudo: true,
      deadlineGate: { pythonExecutable: "/opt/venv/bin/python", scriptPath: "/srv/gate/gate.py", safetyMarginMs: 1000, barrierTimeoutMs: 1000 } },
    trust: { mode: "operator_owned_immutable_deployment", operatorReference: "synthetic-declaration-not-a-host-attestation" } };
  const manifest: ExperimentManifest = { schemaVersion: 1,
    code: { revision: deployment.code.revision, dirtyPatchSha256: null },
    environment: { imageDigest: deployment.environment.imageDigest, dependenciesDigest: deployment.environment.dependenciesDigest },
    adapter: { kind: "conventional_rl", name: "frozenlake-q-learning-v1", config: { spec } },
    data: { version: "FrozenLake-v1:4x4", splitsDigest: hash({ replicates: spec.replicates, evaluation: spec.evaluation }) },
    model: { version: "tabular-q-table/v1" }, reward: { version: "FrozenLake-goal1-hole0-frozen0/v1" }, evaluator: { version: "frozenlake-greedy-eval/v1" },
    seeds: [42, 100, 101, 200, 201, 300, 301], resources: { maxDurationSeconds: 10, maxCostMicrodollars: "0" },
    evaluationPolicy: { kind: "frozen-final-table-shared-random/v1", evaluation: spec.evaluation } };
  const digest = hash(manifest);
  return { manifest: { digest, manifest }, run: { runId: "run-one", projectId: "project-one", manifestDigest: digest, replicaId: "r1" },
    operationRevision: 1, deployment };
}

function rebind(input: ConventionalAttemptInput): ConventionalAttemptInput {
  input.manifest.digest = hash(input.manifest.manifest);
  input.run.manifestDigest = input.manifest.digest;
  return input;
}

test("supervised scientific identity rejects multiple policies and mismatched training-replica registration", () => {
  const mismatched = fixture(); mismatched.run.replicaId = "r2";
  assert.throws(() => prepareConventionalAttempt(mismatched), /matching training replica/u);
  const batch = fixture();
  const spec = batch.manifest.manifest.adapter.config.spec as unknown as { replicates: { replicateId: string; policySeed: number; trainingEpisodeSeeds: number[] }[]; limits: { maxTransitions: number } };
  spec.replicates.push({ replicateId: "r2", policySeed: 43, trainingEpisodeSeeds: [102, 103] });
  spec.limits.maxTransitions = 100;
  assert.throws(() => prepareConventionalAttempt(rebind(batch)), /one matching training replica/u);
});

test("rehashed manifests cannot silently change evaluator, reward, seed inventory or final-policy selection", () => {
  const variants = [fixture(), fixture(), fixture(), fixture(), fixture()];
  variants[0]!.manifest.manifest.evaluator.version = "other-evaluator";
  variants[1]!.manifest.manifest.reward.version = "shaped-reward";
  variants[2]!.manifest.manifest.seeds.pop();
  variants[3]!.manifest.manifest.evaluationPolicy.kind = "select-best-evaluation-checkpoint";
  variants[4]!.manifest.manifest.data.splitsDigest = "9".repeat(64);
  for (const input of variants) assert.throws(() => prepareConventionalAttempt(rebind(input)), /binding|mismatch/u);
});

test("command envelope preserves exact admitted action, manifest, request and source bytes without a job-digest cycle", () => {
  const input = fixture(), plan = prepareConventionalAttempt(input);
  assert.equal(plan.binding.actionId, `action:${hash([input.run.runId, "launch", input.operationRevision])}`);
  assert.equal(plan.binding.manifestDigest, input.manifest.digest);
  assert.equal(plan.binding.replicaId, "r1");
  assert.equal(plan.qualification, "trusted_deployment_required");
  const bytes = Buffer.from(plan.command.args.slice(5).join(""), "base64");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), plan.envelopeSha256);
  assert.equal(plan.command.args[4], plan.envelopeSha256);
  const envelope = JSON.parse(bytes.toString("utf8"));
  assert.deepEqual(envelope.binding, plan.binding);
  assert.equal(envelope.requestBytesSha256, createHash("sha256").update(envelope.requestJson).digest("hex"));
  assert.deepEqual(JSON.parse(envelope.requestJson), plan.request);
  assert.deepEqual(envelope.source.runner, input.deployment.code.runner);
  assert.equal(envelope.output.directoryName, plan.outputs.directoryName);
  assert.equal(Object.hasOwn(envelope, "jobId"), false);
  input.deployment.code.runner.sha256 = "8".repeat(64);
  assert.equal(plan.declarations.deployment.code.runner.sha256, "1".repeat(64));
  assert.ok(Object.isFrozen(plan.request.replicates[0]!.trainingEpisodeSeeds));
  assert.ok(Object.isFrozen(plan.command.args));
});
