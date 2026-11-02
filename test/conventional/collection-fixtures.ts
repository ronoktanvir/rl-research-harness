import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { openJobJournal } from "../../src/execution/journal.ts";
import { createSupervisedExperimentBackend } from "../../src/execution/backend.ts";
import type { ServiceLaunchRequest, ServiceSnapshot, SystemdTransport } from "../../src/execution/types.ts";
import { dispatchNext } from "../../src/controller/dispatcher.ts";
import { CONVENTIONAL_SUPERVISED_BACKEND, createConventionalLaunchResolver } from "../../src/integrations/conventional/supervised.ts";
import { summarizeEpisodes } from "../../src/integrations/conventional/protocol.ts";
import type { ConventionalResult, Episode } from "../../src/integrations/conventional/protocol.ts";
import { supervisedFixture } from "./supervised-fixtures.ts";

export const collectionNow = () => new Date("2026-11-02T12:00:00.000Z");
export async function collectionFixture() {
  const f = await supervisedFixture(), { plan } = f;
  let ledger = openExperimentLedger({ path: join(f.directory, "ledger.sqlite"), now: collectionNow });
  let journal = openJobJournal({ path: join(f.directory, "jobs.sqlite"), now: collectionNow });
  for (const scopeId of ["global", "project:frozenlake"]) {
    ledger.configureBudget({ scopeId, parentScopeId: scopeId === "global" ? null : "global", expectedRevision: 0, limitMicrodollars: 1000n });
    ledger.configurePolicy({ scopeId, expectedVersion: 0, allowedBackends: [CONVENTIONAL_SUPERVISED_BACKEND], allowedOperations: ["launch", "cancel"], requiredChecks: [] });
  }
  ledger.registerManifest(f.input.manifest.manifest); ledger.createRun(f.input.run);
  const action = ledger.admitAction({ runId: f.input.run.runId, operation: "launch", operationRevision: 1,
    backend: CONVENTIONAL_SUPERVISED_BACKEND, payload: { attemptPlanDigest: plan.digest }, reservation: { amountMicrodollars: 1n, category: "compute", basis: "offline collection fixture" } });
  let mode: "running" | "succeeded" | "failed" = "running", launched: ServiceLaunchRequest | undefined;
  const snapshot = (): ServiceSnapshot => {
    const request = launched!, ended = mode !== "running", group = `/system.slice/${request.identity.unitName}`;
    return { identity: request.identity, host: request.expectedHost, observedAt: collectionNow().toISOString(), invocationId: "d".repeat(32),
      loadState: "loaded", activeState: mode === "failed" ? "failed" : "active", subState: mode === "failed" ? "failed" : ended ? "exited" : "running",
      result: mode === "failed" ? "exit-code" : "success", mainPid: ended ? 0 : 123, execMainCode: ended ? 1 : 0, execMainStatus: mode === "failed" ? 1 : 0,
      controlGroup: group, cgroupPopulated: !ended, ...(ended ? { cleanupEvidence: { kind: "cgroup_v2_empty" as const, controlGroup: group,
        invocationId: "d".repeat(32), observedAt: collectionNow().toISOString(), confirmedAt: collectionNow().toISOString() } } : {}) };
  };
  const transport: SystemdTransport = { async hostIdentity() { return f.input.deployment.host; },
    async start(request, _signal, authorized) { if (!authorized()) throw new Error("fixture authority denied"); launched = request;
      return { kind: "accepted", evidence: { identity: { ...request.identity }, host: { ...request.expectedHost } } }; },
    async query() { return { kind: "present", snapshot: snapshot() }; },
    async stop() { return { command: "not_sent", observation: { kind: "unknown", reason: "unused" } }; } };
  const backend = () => createSupervisedExperimentBackend({ name: CONVENTIONAL_SUPERVISED_BACKEND, workerId: f.input.deployment.workerId,
    ledger, journal, transport, now: collectionNow, prepareLaunch: createConventionalLaunchResolver({ ledger, deployment: f.input.deployment, authorizeDeployment: () => true }) });
  await dispatchNext(ledger, [backend()], { workerId: f.input.deployment.workerId, deadlineAt: "2026-11-02T12:00:30.000Z", timeoutMs: 1000 });
  function result(): ConventionalResult {
    const request = plan.request, replica = request.replicates[0]!;
    const batch = (seeds: number[], actions: (number | null)[]) => {
      const episodes: Episode[] = seeds.map((resetSeed, episodeIndex) => ({ episodeIndex, resetSeed, actionSeed: actions[episodeIndex]!,
        return: 0, steps: 2, finalState: 1, terminated: false, truncated: false, harnessCutoff: true, success: false }));
      return { episodes, summary: summarizeEpisodes(episodes) };
    };
    return { schemaVersion: 1, kind: "frozenlake-q-learning-result", requestId: request.requestId, requestDigest: request.requestDigest,
      environment: { ...request.environment, map: ["SFFF", "FHFH", "FFFH", "HFFG"], rewardSchedule: [1, 0, 0], slipSuccessRate: 1 / 3 },
      algorithm: { ...request.algorithm, epsilonSchedule: "linear_per_episode_start_to_end_single_episode_uses_start", policyRng: "python.random.Random/MT19937",
        trainingActionStream: "replicate_continuous", randomBaselineActionStream: "per_episode", trainingTieBreak: "seeded_uniform_argmax",
        evaluationTieBreak: "lowest_action_index", bootstrapMask: "not_terminated", evaluationUpdates: false },
      versions: { python: "3.11.14", gymnasium: "1.4.0", numpy: "2.3.5" },
      randomBaseline: batch(request.evaluation.episodeSeeds, request.evaluation.randomActionSeeds),
      replicates: [{ replicateId: replica.replicateId, policySeed: replica.policySeed,
        training: batch(replica.trainingEpisodeSeeds, replica.trainingEpisodeSeeds.map(() => replica.policySeed)),
        qTable: Array.from({ length: 16 }, () => [0, 0, 0, 0]), greedyActions: Array(16).fill(0),
        evaluation: { ...batch(request.evaluation.episodeSeeds, request.evaluation.episodeSeeds.map(() => null)), baseline: "shared-random-policy" } }],
      totalTransitions: 12, resumeSupported: false };
  }
  async function writeArtifacts(raw = `${JSON.stringify(result())}\n`) {
    const envelope = JSON.parse(Buffer.from(plan.command.args.slice(5).join(""), "base64").toString("utf8"));
    await mkdir(plan.outputs.directory, { recursive: true, mode: 0o700 });
    await writeFile(plan.outputs.intent, JSON.stringify({ schemaVersion: 1, kind: "conventional-supervised-intent", envelope,
      envelopeSha256: plan.envelopeSha256, replaySupported: false }));
    await writeFile(plan.outputs.result, raw);
    const receipt = { schemaVersion: 1, kind: "conventional-supervised-receipt", binding: plan.binding,
      requestDigest: plan.request.requestDigest, requestBytesSha256: plan.requestBytesSha256, envelopeSha256: plan.envelopeSha256,
      source: envelope.source, resultSha256: createHash("sha256").update(raw).digest("hex"), resultBytes: Buffer.byteLength(raw), runnerExitCode: 0,
      meaning: "worker_output_receipt_requires_owned_terminal_supervisor_observation" };
    await writeFile(plan.outputs.receipt, JSON.stringify(receipt));
    return receipt;
  }
  async function observe(next: typeof mode) {
    mode = next;
    const observed = await backend().observe(action.actionId, new AbortController().signal);
    return journal.observations(observed.result.jobId).find(item => item.observationId === observed.result.observationId)!;
  }
  return { ...f, action, result, writeArtifacts, observe, ledger: () => ledger, journal: () => journal,
    reopen() { ledger.close(); journal.close(); ledger = openExperimentLedger({ path: join(f.directory, "ledger.sqlite"), now: collectionNow });
      journal = openJobJournal({ path: join(f.directory, "jobs.sqlite"), now: collectionNow }); },
    async close() { ledger.close(); journal.close(); await f.close(); } };
}
