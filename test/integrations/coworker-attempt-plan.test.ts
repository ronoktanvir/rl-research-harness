import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { prepareCoworkerAttempt } from "../../src/integrations/coworker/attempt-plan.ts";
import type { CoworkerAttemptInput } from "../../src/integrations/coworker/attempt-plan.ts";
import { coworkerAttemptFixture, rebindCoworkerFixture } from "./coworker-attempt-fixtures.ts";

test("preview maps the inspected CLI exactly, including explicit caps and pinned source import path", () => {
  const plan = prepareCoworkerAttempt(coworkerAttemptFixture());
  assert.equal(plan.launchSupported, false);
  assert.equal(plan.qualification, "declarations_only");
  assert.equal(plan.command.executable, "/opt/trainer/bin/python");
  assert.equal(plan.command.cwd, "/opt/coworker-source");
  assert.deepEqual(plan.command.environment, { inherit: false, values: { PYTHONPATH: "/opt/coworker-source/experiments/coworkerl-v2/src", PYTHONNOUSERSITE: "1", PYTHONHASHSEED: "11", PROBING_RUNTIME_SOURCE_SHA: plan.declarations.configuration.source.revision } });
  const out = plan.command.outputs;
  assert.deepEqual(plan.command.args, ["-s", "-m", "probing.verl.fit_loop", "--manifest=/srv/inputs/tasks/manifest.json", "--selection=train",
    "--helper-model=fixture-helper-model", "--helper-provider=anthropic", "--helper-concurrency=4", "--helper-timeout-s=60", `--helper-cache-path=${out.helperCachePath}`, "--endpoint=http://127.0.0.1:8000/v1",
    "--model-name=m-qwen3-8b-v2", "--base-model=Qwen/Qwen3-8B", `--adapter-dir=${out.adapterDirectory}`, `--out-dir=${out.runDirectory}`,
    "--configs", "task-1", "task-2", "--init=base", "--g=8", "--steps=2", "--training-seed=11", "--init-seed=11", "--sampling-external-preflights=10",
    "--numerical-qualification-receipt=/srv/inputs/qualification/receipt.json", "--step-index-start=0", "--world-seed-start=0", "--judge-model=fixture-judge-model",
    "--reward-mode=banded", "--max-prompt-tokens=36864", "--learning-rate=0.00001", "--pod-hourly-usd=1.500000", "--spend-ceiling-usd=1.000000",
    "--max-elapsed-seconds=60", "--max-helper-provider-calls=4", "--max-judge-provider-calls=4", "--max-degenerate-steps=5"]);
});

test("snapshot and digest survive caller mutation and key ordering; changed declarations change digest", () => {
  const input = coworkerAttemptFixture(), plan = prepareCoworkerAttempt(input);
  input.configuration.trainer.steps = 8;
  input.manifest.manifest.seeds.push(12);
  assert.equal(plan.declarations.configuration.trainer.steps, 2);
  assert.deepEqual(plan.declarations.manifest.manifest.seeds, [11]);
  assert.throws(() => (plan.command.args as string[]).push("--extra"), TypeError);
  assert.throws(() => { (plan.declarations.configuration.trainer as { steps: number }).steps = 9; }, TypeError);
  const clean = coworkerAttemptFixture();
  const reordered = { configuration: clean.configuration, operationRevision: clean.operationRevision, run: clean.run, manifest: clean.manifest };
  assert.equal(prepareCoworkerAttempt(reordered).digest, plan.digest);
  clean.configuration.trainer.steps = 3;
  assert.notEqual(prepareCoworkerAttempt(rebindCoworkerFixture(clean)).digest, plan.digest);
});

test("output namespaces follow ledger action identity and separate explicit replicas and operation revisions", async () => {
  const input = coworkerAttemptFixture(), first = prepareCoworkerAttempt(input);
  assert.deepEqual(prepareCoworkerAttempt(input), first);
  const second = prepareCoworkerAttempt({ ...input, run: { ...input.run, runId: "run-two", replicaId: "replica-two" } });
  const revised = prepareCoworkerAttempt({ ...input, operationRevision: 2 });
  assert.notEqual(second.command.outputs.attemptRoot, first.command.outputs.attemptRoot);
  assert.notEqual(revised.command.outputs.attemptRoot, first.command.outputs.attemptRoot);
  const directory = await mkdtemp(join(tmpdir(), "coworker-plan-ledger-"));
  const ledger = openExperimentLedger({ path: join(directory, "ledger.sqlite") });
  try {
    ledger.registerManifest(input.manifest.manifest); ledger.createRun(input.run);
    ledger.configureBudget({ scopeId: "global", parentScopeId: null, expectedRevision: 0, limitMicrodollars: 100n });
    ledger.configureBudget({ scopeId: "project:coworker", parentScopeId: "global", expectedRevision: 0, limitMicrodollars: 100n });
    for (const scopeId of ["global", "project:coworker"]) ledger.configurePolicy({ scopeId, expectedVersion: 0, allowedBackends: [first.binding.backend], allowedOperations: ["launch"], requiredChecks: [] });
    const action = ledger.admitAction({ runId: input.run.runId, operation: "launch", operationRevision: input.operationRevision,
      backend: first.binding.backend, payload: { attemptPlanDigest: first.digest }, reservation: { amountMicrodollars: 1n, category: "compute", basis: "offline identity fixture" } });
    assert.equal(action.actionId, first.binding.actionId); assert.equal(action.backendKey, first.binding.backendKey);
    assert.equal(ledger.listActions().length, 1); // Only this test's explicit admission mutates the ledger.
  } finally { ledger.close(); await rm(directory, { recursive: true, force: true }); }
});

test("resume binds the complete origin layout and checkpoint digest without claiming native inspection", () => {
  const input = coworkerAttemptFixture();
  input.configuration.inputs.resume = { parentRunId: "parent-run", checkpoint: { relativePath: "origin/adapter-step-0/checkpoint.json", sha256: "1".repeat(64) }, originRunEvidence: { relativePath: "origin/run-evidence.json", sha256: "2".repeat(64) } };
  input.run.lineage = { parentRunId: "parent-run", checkpointDigest: "1".repeat(64) };
  const plan = prepareCoworkerAttempt(rebindCoworkerFixture(input));
  assert.ok(plan.command.args.includes("--resume-from=/srv/inputs/origin/adapter-step-0"));
  assert.equal(plan.qualification, "declarations_only");
  input.run.lineage.checkpointDigest = "3".repeat(64);
  assert.throws(() => prepareCoworkerAttempt(input), /lineage mismatch/);
  input.run.lineage.checkpointDigest = "1".repeat(64);
  input.configuration.inputs.resume.checkpoint.relativePath = "origin/nested/adapter-step-0/checkpoint.json";
  assert.throws(() => prepareCoworkerAttempt(rebindCoworkerFixture(input)), /immediate child/);
});

test("supported optional settings are mapped rather than silently discarded", () => {
  const input = coworkerAttemptFixture(), config = input.configuration;
  config.inputs.initialAdapter = { directory: "shared-adapter", fingerprintSha256: "4".repeat(64) };
  config.helper = { ...config.helper, provider: "bedrock", region: "us-east-1", cache: "attempt-local" };
  config.trainer = { ...config.trainer, rewardMode: "faithful_recovery", semanticInstrument: "instrument-v4", taskManifestSha256: config.inputs.experimentManifest.sha256,
    configIds: ["fr-v1-fixture"], g: 4, shuffledControlSeed: 4, shuffledTrainingRunSeed: 11 };
  const plan = prepareCoworkerAttempt(rebindCoworkerFixture(input));
  for (const arg of ["--helper-provider=bedrock", "--helper-region=us-east-1", `--helper-cache-path=${plan.command.outputs.helperCachePath}`,
    "--initial-adapter-dir=/srv/inputs/shared-adapter", `--initial-adapter-sha256=${"4".repeat(64)}`, "--reward-mode=faithful_recovery", "--semantic-instrument=instrument-v4",
    `--task-manifest-sha256=${"d".repeat(64)}`, "--shuffled-control-seed=4", "--shuffled-training-run-seed=11"]) assert.ok(plan.command.args.includes(arg), arg);
});

test("mismatched run, manifest, source, environment, seed and task declarations fail before a preview", () => {
  const cases: Array<(value: CoworkerAttemptInput) => void> = [
    x => { x.operationRevision = 0; },
    x => { x.manifest.digest = "0".repeat(64); }, x => { x.run.manifestDigest = "0".repeat(64); },
    x => { x.configuration.trainer.steps++; }, x => { x.configuration.source.revision = "0".repeat(40); rebindCoworkerFixture(x); },
    x => { x.manifest.manifest.code.dirtyPatchSha256 = "0".repeat(64); rebindCoworkerFixture(x); },
    x => { x.configuration.environment.dependenciesDigest = "0".repeat(64); rebindCoworkerFixture(x); },
    x => { x.configuration.trainer.trainingSeed = 9; rebindCoworkerFixture(x); },
    x => { x.configuration.trainer.rewardMode = "faithful_recovery"; rebindCoworkerFixture(x); },
    x => { x.configuration.trainer.configIds = ["fr-v1-fixture"]; rebindCoworkerFixture(x); },
    x => { x.configuration.trainer.selection = "train_qualification"; rebindCoworkerFixture(x); },
    x => { x.run.lineage = { parentRunId: "old", checkpointDigest: "0".repeat(64) }; },
  ];
  for (const change of cases) { const input = coworkerAttemptFixture(); change(input); assert.throws(() => prepareCoworkerAttempt(input)); }
});

test("lexical path escapes, writable aliases, option injection and credential URLs are rejected", () => {
  const cases: Array<(value: CoworkerAttemptInput) => void> = [
    x => { x.configuration.inputs.experimentManifest.relativePath = "../secret"; },
    x => { x.configuration.inputs.experimentManifest.relativePath = "/absolute"; },
    x => { x.configuration.inputs.experimentManifest.relativePath = "foo\\bar"; },
    x => { x.configuration.paths.outputRoot = "/srv/inputs/new"; },
    x => { x.configuration.paths.outputRoot = "/opt"; },
    x => { x.configuration.paths.outputRoot = "/srv/../attempts"; },
    x => { x.configuration.source.root = "/opt/source:/tmp/other-import"; },
    x => { x.configuration.environment.pythonExecutable = "/srv/attempts/python"; },
    x => { x.configuration.trainer.configIds = ["--preflight-only"]; },
    x => { x.configuration.trainer.endpoint = "http://token:secret@127.0.0.1:8000/v1"; },
    x => { x.configuration.trainer.endpoint = "http://127.0.0.1:8000/v1?api_key=secret"; },
    x => { x.configuration.trainer.endpoint = "https://remote.invalid/v1"; },
    x => { x.configuration.trainer.endpoint = "http://127.0.0.1:8000/secret-path"; },
  ];
  for (const change of cases) { const input = coworkerAttemptFixture(); change(input); assert.throws(() => prepareCoworkerAttempt(rebindCoworkerFixture(input))); }
  const spaces = coworkerAttemptFixture(); spaces.configuration.paths.inputRoot = "/srv/inputs with spaces";
  assert.ok(prepareCoworkerAttempt(rebindCoworkerFixture(spaces)).command.args.includes("--manifest=/srv/inputs with spaces/tasks/manifest.json"));
});

test("nonfinite or exceeded limits and unsupported scientific flags are rejected", () => {
  const cases: Array<(value: CoworkerAttemptInput) => void> = [
    x => { x.configuration.trainer.learningRate = NaN; }, x => { x.configuration.trainer.maxPromptTokens = 36_865; },
    x => { x.configuration.limits.maxElapsedSeconds = 121; }, x => { x.configuration.limits.runtimeMaxSeconds = 180; },
    x => { x.configuration.limits.maxHelperProviderCalls = 0; }, x => { x.configuration.limits.memoryMaxBytes = -1; },
    x => { x.configuration.limits.trainingGpuCeilingMicrodollars = "2000001"; }, x => { x.configuration.limits.podHourlyMicrodollars = "01"; },
    x => { x.configuration.helper.provider = "other" as "anthropic"; },
    x => { (x.configuration.trainer as unknown as Record<string, unknown>).maxResponseTokens = 2048; },
    x => { (x.configuration.inputs as unknown as Record<string, unknown>).replayManifest = "replay.json"; },
    x => { (x.configuration as unknown as Record<string, unknown>).environmentVariables = { OPENAI_API_KEY: "secret" }; },
  ];
  for (const change of cases) { const input = coworkerAttemptFixture(); change(input); assert.throws(() => prepareCoworkerAttempt(rebindCoworkerFixture(input))); }
});

test("malformed JSON objects and accessors cannot hide or mutate configuration fields", () => {
  const input = coworkerAttemptFixture();
  let called = false;
  Object.defineProperty(input.configuration.trainer, "steps", { enumerable: true, get() { called = true; return 3; } });
  assert.throws(() => prepareCoworkerAttempt(input), /accessors/); assert.equal(called, false);
  const sparse = coworkerAttemptFixture(); sparse.configuration.trainer.configIds = new Array(2) as string[];
  assert.throws(() => prepareCoworkerAttempt(sparse), /dense/);
  const symbol = coworkerAttemptFixture(); Object.defineProperty(symbol, Symbol("hidden"), { value: 1 });
  assert.throws(() => prepareCoworkerAttempt(symbol), /symbols/);
});
