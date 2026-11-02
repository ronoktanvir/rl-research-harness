import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExperimentManifest, ManifestRecord, CreateRunInput } from "../../src/ledger/types.ts";
import { hash } from "../../src/ledger/validation.ts";
import { prepareConventionalRequest } from "../../src/integrations/conventional/protocol.ts";
import type { ConventionalSpec } from "../../src/integrations/conventional/protocol.ts";
import { prepareConventionalAttempt } from "../../src/integrations/conventional/supervised.ts";
import type { ConventionalDeployment } from "../../src/integrations/conventional/supervised.ts";

export const supervisedSpec: ConventionalSpec = {
  schemaVersion: 1, kind: "frozenlake-q-learning", requestId: "supervised-fixture",
  environment: { id: "FrozenLake-v1", mapName: "4x4", isSlippery: true, maxEpisodeSteps: 3 },
  algorithm: { name: "tabular-q-learning", learningRate: 0.5, discount: 0.9, epsilonStart: 1, epsilonEnd: 0.1 },
  replicates: [{ replicateId: "replica-one", policySeed: 31, trainingEpisodeSeeds: [11, 12] }],
  evaluation: { episodeSeeds: [101, 102], randomActionSeeds: [201, 202] }, limits: { maxTransitions: 100, maxEpisodeTransitions: 2 },
};
export function conventionalManifest(spec: ConventionalSpec, deployment: ConventionalDeployment): ExperimentManifest {
  const request = prepareConventionalRequest(spec);
  return { schemaVersion: 1, code: { revision: deployment.code.revision, dirtyPatchSha256: deployment.code.dirtyPatchSha256 },
    environment: { imageDigest: deployment.environment.imageDigest, dependenciesDigest: deployment.environment.dependenciesDigest },
    adapter: { kind: "conventional_rl", name: "frozenlake-q-learning-v1", config: { spec: structuredClone(spec) as unknown as import("../../src/ledger/types.ts").JsonObject } },
    data: { version: "FrozenLake-v1:4x4", splitsDigest: hash({ replicates: request.replicates, evaluation: request.evaluation }) },
    model: { version: "tabular-q-table/v1" }, reward: { version: "FrozenLake-goal1-hole0-frozen0/v1" }, evaluator: { version: "frozenlake-greedy-eval/v1" },
    seeds: [...request.replicates.flatMap(replica => [replica.policySeed, ...replica.trainingEpisodeSeeds]), ...request.evaluation.episodeSeeds, ...request.evaluation.randomActionSeeds],
    resources: { maxDurationSeconds: 60, maxCostMicrodollars: "1000" },
    evaluationPolicy: { kind: "frozen-final-table-shared-random/v1", evaluation: structuredClone(request.evaluation) } };
}
export async function supervisedFixture() {
  const temporary = await mkdtemp(join(tmpdir(), "conventional-supervised-")), directory = await realpath(temporary);
  const code = join(directory, "code"), outputRoot = join(directory, "outputs");
  await mkdir(code); await mkdir(outputRoot);
  const source = async (name: string) => {
    const bytes = await readFile(new URL(`../../src/integrations/conventional/${name}`, import.meta.url));
    const path = join(code, name); await writeFile(path, bytes);
    return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const [runner, entry, requirements] = await Promise.all([source("runner.py"), source("supervised_entry.py"), source("requirements.lock")]);
  const python = join(code, "python3.11"); await writeFile(python, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const limits = { runtimeMs: 10_000, startTimeoutMs: 2000, stopTimeoutMs: 1000, memoryMaxBytes: 256 * 1024 ** 2, tasksMax: 32 };
  const deployment: ConventionalDeployment = { schemaVersion: 1, deploymentId: "fixture-deployment", workerId: "fixture-worker",
    code: { revision: "a".repeat(40), dirtyPatchSha256: null, runner, entry, requirements },
    environment: { pythonExecutable: python, imageDigest: `sha256:${"b".repeat(64)}`, dependenciesDigest: requirements.sha256 }, outputRoot,
    host: { machineId: "c".repeat(32), bootId: "11111111-1111-1111-1111-111111111111" }, limits,
    profile: { userId: 1001, groupId: 1001, executables: [python], readOnlyPaths: [code], writableRoot: outputRoot,
      allowedEnvironment: ["OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS"], maxima: limits, useSudo: false,
      deadlineGate: { pythonExecutable: python, scriptPath: join(code, "deadline-gate.py"), safetyMarginMs: 1000, barrierTimeoutMs: 1000 } },
    trust: { mode: "operator_owned_immutable_deployment", operatorReference: "Synthetic filesystem fixture; no service or dependency qualification." } };
  const manifestData = conventionalManifest(supervisedSpec, deployment);
  const manifest: ManifestRecord = { digest: hash(manifestData), manifest: manifestData };
  const run: CreateRunInput = { runId: "run-one", projectId: "frozenlake", manifestDigest: manifest.digest, replicaId: "replica-one" };
  const input = { manifest, run, operationRevision: 1, deployment };
  return { directory, input, plan: prepareConventionalAttempt(input), close: () => rm(directory, { recursive: true, force: true }) };
}
