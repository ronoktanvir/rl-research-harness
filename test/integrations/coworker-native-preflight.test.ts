import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { hash } from "../../src/ledger/validation.ts";
import { prepareCoworkerAttempt } from "../../src/integrations/coworker/attempt-plan.ts";
import { interpretCoworkerNativePreflight, prepareCoworkerNativePreflight, NATIVE_PREFLIGHT_OUTPUT_BYTES } from "../../src/integrations/coworker/native-preflight.ts";
import type { CoworkerNativePreflightDeclaration, CoworkerNativePreflightObservation } from "../../src/integrations/coworker/native-preflight.ts";
import { runProcess } from "../../src/workers/process.ts";
import { coworkerAttemptFixture, rebindCoworkerFixture } from "./coworker-attempt-fixtures.ts";

/** Synthetic output shaped like the inspected native schema; no native package,
 * actual module hash, filesystem input or model is qualified by this fixture. */
function metadata(groupSize = 8) {
  const pins = { clip_ratio: .2, clip_ratio_low: .2, clip_ratio_high: .2, clip_ratio_c: 3,
    loss_agg_mode: "token-mean", ppo_epochs: 1, entropy_coeff: 0, calculate_entropy: false, use_kl_loss: false, kl_loss_coef: .001 };
  return {
    schema: "coworkerl-fit-loop-objective/v2", verl_version: "0.8.0",
    policy_loss_function: "verl.trainer.ppo.core_algos.compute_policy_loss_vanilla", actor_objective_pins: pins,
    ratio: "exp(clamp(log_pi_current - log_pi_old, -20, 20))",
    unmasked_token_loss: "B=max(-A*r, -A*clip(r,0.8,1.2)); vanilla=min(-3*A,B) if A<0 else B; loss=stop_gradient(exp(min(log_pi_old_teacher-log_pi_native_served,log(2))))*vanilla",
    aggregation: "sum(masked token losses) / total trainable token count; row microbatches weighted by trainable-token mass",
    old_policy_likelihood: "recomputed with no_grad on the same pre-update weights; captured serving logprobs are only the separate correction denominator, never the PPO ratio denominator",
    rollout_importance_weights: {
      schema: "coworkerl-token-local-rollout-correction/v1", formula: "stop_gradient(exp(min(log_pi_old_teacher-log_pi_native_served,log(2))))",
      application: "verl vanilla rollout_is_weights hook, once on unreduced token losses", amplification_cap: 2, lower_floor: null,
      self_normalized: false, denominator: "original unweighted trainable-token count, including zero-advantage groups",
      max_cap_fraction: .01, min_token_ess: .90, qualification_and_training_limits_identical: true,
      failure: "abort complete batch before optimizer.step; retain evidence and clear gradients",
      scope: "token-local surrogate; not unbiased whole-trajectory correction or a bound on off-policy bias",
    },
    advantage: { unit: "one terminal reward per episode within its group", formula: "(reward - group_mean) / (sample_std + 1e-6)",
      std_correction: 1, epsilon: 1e-6, normalization_dtype: "float64", identical_rewards_or_singleton: "exact zero before reduction",
      broadcast: "same episode advantage on its trainable policy tokens" },
    optimization_passes_per_rollout_batch: 1, reference_policy: null, effective_kl_coefficient: 0, effective_entropy_coefficient: 0,
    ppo_kl_metric: "diagnostic only; not an added loss term",
    no_signal_behavior: "skip optimizer.step entirely, including Adam momentum and weight decay; no KL or entropy update",
    optimizer_weight_decay_on_actual_updates: .01,
    resolved_actor_config: { ...pins, strategy: "fsdp", rollout_n: groupSize, ppo_micro_batch_size_per_gpu: 1,
      fixture_unused_defaults: { betas: [.9, .999] } },
    resolved_config_note: "Fixture metadata; not an actual dependency observation.",
    implementation: Object.fromEntries(["policy_loss", "actor_config_class", "episode_advantage", "microbatch_update", "correction_preflight",
      "correction_weights", "native_custody", "optimizer_update"].map(name => [name,
      { qualified_name: `fixture.${name}`, source_sha256: "a".repeat(64), module_sha256: "b".repeat(64) }])),
  };
}
function declaration() { return prepareCoworkerNativePreflight(prepareCoworkerAttempt(coworkerAttemptFixture())); }
function stdout(objective = metadata()) { return `preflight: PASS\n${JSON.stringify({ training_objective: objective })}\n`; }
function observation(d: CoworkerNativePreflightDeclaration): CoworkerNativePreflightObservation {
  return { planDigest: d.binding.planDigest, declarationDigest: d.digest,
    startedAt: "2026-11-02T12:00:00.000Z", completedAt: "2026-11-02T12:00:01.000Z",
    process: { exitCode: 0, stdout: stdout(), stderr: "", stopped: null } };
}
function rehash<T extends { digest: string }>(value: T): void { const { digest: _, ...body } = value; value.digest = hash(body); }

test("preflight preparation reconstructs the exact preview and changes only bytecode and preflight flags", () => {
  const plan = prepareCoworkerAttempt(coworkerAttemptFixture()), d = prepareCoworkerNativePreflight(plan);
  assert.deepEqual(d.command.args, ["-B", ...plan.command.args, "--preflight-only"]);
  assert.equal(d.command.executable, plan.command.executable); assert.equal(d.command.cwd, plan.command.cwd);
  assert.deepEqual(d.command.environment, plan.command.environment);
  assert.equal(d.binding.planDigest, plan.digest); assert.equal(d.launchSupported, false);
  assert.equal(d.requiredExecutionBoundary.network, "denied"); assert.equal(d.requiredExecutionBoundary.credentials, "absent");
  assert.equal(d.requiredExecutionBoundary.resourceLimits, "separately_admitted");
  assert.ok(Object.isFrozen(d.command.args)); assert.ok(Object.isFrozen(d.attemptPlan));
});

test("self-hashed command substitution, getter access and declaration tampering cannot become native evidence", () => {
  const plan = structuredClone(prepareCoworkerAttempt(coworkerAttemptFixture())) as unknown as { command: { args: string[] }; digest: string };
  plan.command.args.push("--replay-manifest=/different"); rehash(plan);
  assert.throws(() => prepareCoworkerNativePreflight(plan), /differs/);
  let reads = 0;
  const getter = { get declarations() { reads++; return coworkerAttemptFixture(); } };
  assert.throws(() => prepareCoworkerNativePreflight(getter), /accessor/); assert.equal(reads, 0);
  const original = declaration(), o = observation(original);
  const d = structuredClone(original) as unknown as { command: { args: string[] }; digest: string };
  d.command.args.pop(); rehash(d); o.declarationDigest = d.digest;
  assert.throws(() => interpretCoworkerNativePreflight(d, o), /differs/);
});

test("complete success retains checked objective observations and output hashes without granting launch authority", () => {
  const d = declaration(), o = observation(d); o.process.stderr = "fixture warning\n";
  const result = interpretCoworkerNativePreflight(d, o);
  assert.equal(result.result, "passed"); assert.equal(result.reason, "complete_native_output");
  assert.deepEqual(result.trainingObjective, metadata()); assert.equal(result.launchSupported, false);
  assert.equal(result.qualification, "local_contract_output_only");
  assert.equal(result.evidenceOrigin, "controller_supplied_process_result_not_independently_attested");
  assert.equal(result.binding.commandDigest, hash(d.command));
  assert.equal(result.output.stderr.sha256, createHash("sha256").update(o.process.stderr).digest("hex"));
  assert.ok(result.pending.every(row => row.status === "pending"));
  for (const check of ["checkpoint_and_resume", "transitive_task_files", "live_serving_and_sampling", "numerical_qualification", "model_and_tokenizer", "resource_and_scientific_admission"])
    assert.ok(result.pending.some(row => row.check === check), check);
  o.process.stdout = "changed";
  assert.deepEqual(result.trainingObjective, metadata()); assert.ok(Object.isFrozen(result.trainingObjective));
});

test("a success marker before a metadata exception or a nonzero completion never passes", () => {
  const d = declaration(), o = observation(d);
  o.process.stdout = "preflight: PASS\n"; o.process.stderr = "fixture metadata exception"; o.process.exitCode = 1;
  const failed = interpretCoworkerNativePreflight(d, o);
  assert.equal(failed.result, "failed"); assert.equal(failed.trainingObjective, null);
  o.process.stdout = stdout();
  assert.equal(interpretCoworkerNativePreflight(d, o).result, "failed");
  o.process.exitCode = 0; o.process.stdout = "preflight: PASS\n";
  assert.equal(interpretCoworkerNativePreflight(d, o).result, "unknown");
});

test("interruption, missing exit and truncated or extra output preserve uncertainty even when a pass marker exists", () => {
  const d = declaration();
  for (const stopped of ["cancelled", "timeout", "output_limit", "spawn_error"] as const) {
    const o = observation(d); o.process.stopped = stopped;
    const result = interpretCoworkerNativePreflight(d, o); assert.equal(result.result, "unknown"); assert.equal(result.reason, "process_incomplete");
  }
  const o = observation(d); o.process.exitCode = null;
  assert.equal(interpretCoworkerNativePreflight(d, o).result, "unknown");
  o.process.exitCode = 0;
  for (const output of [stdout().slice(0, -1), `prefix\n${stdout()}`, `${stdout()}{}\n`, stdout() + stdout(), "preflight: PASS\n{}\n"]) {
    o.process.stdout = output; assert.equal(interpretCoworkerNativePreflight(d, o).reason, "invalid_success_output");
  }
});

test("objective schema drift, altered formulas, duplicate keys and resolved group mismatches do not pass", () => {
  const d = declaration();
  const variants = [metadata(), metadata(), metadata(), metadata(), metadata(), metadata(4)];
  variants[0]!.verl_version = "0.9.0"; variants[1]!.ratio = "wrong ratio";
  variants[2]!.actor_objective_pins.use_kl_loss = true;
  variants[3]!.implementation.policy_loss!.source_sha256 = "missing";
  variants[4]!.rollout_importance_weights.amplification_cap = 3;
  for (const changed of variants) { const o = observation(d); o.process.stdout = stdout(changed); assert.equal(interpretCoworkerNativePreflight(d, o).result, "unknown"); }
  const o = observation(d);
  o.process.stdout = stdout().replace('"verl_version":"0.8.0"', '"verl_version":"wrong","verl_version":"0.8.0"');
  assert.equal(interpretCoworkerNativePreflight(d, o).result, "unknown");
  o.process.stdout = stdout().replace('"verl_version":"0.8.0"', '"verl_version":"wrong","verl_\\u0076ersion":"0.8.0"');
  assert.equal(interpretCoworkerNativePreflight(d, o).result, "unknown");
});

test("result identities, timestamps, strict primitives and aggregate output bounds are checked before receipt creation", () => {
  const d = declaration(), o = observation(d);
  assert.throws(() => interpretCoworkerNativePreflight(d, { ...o, declarationDigest: "f".repeat(64) }), /binding/);
  assert.throws(() => interpretCoworkerNativePreflight(d, { ...o, planDigest: "f".repeat(64) }), /binding/);
  assert.throws(() => interpretCoworkerNativePreflight(d, { ...o, completedAt: "2026-11-02T11:59:59.999Z" }), /precedes/);
  assert.throws(() => interpretCoworkerNativePreflight(d, { ...o, process: { ...o.process, exitCode: "0" } }), /exit code/);
  assert.throws(() => interpretCoworkerNativePreflight(d, { ...o, process: { ...o.process, stopped: new String("timeout") } }), /JSON/);
  o.process.stderr = "x".repeat(NATIVE_PREFLIGHT_OUTPUT_BYTES);
  assert.throws(() => interpretCoworkerNativePreflight(d, o), /combined/);
});

test("a missing resume path remains only a declaration and cannot be promoted by passing local preflight output", () => {
  const input = coworkerAttemptFixture();
  input.configuration.inputs.resume = { parentRunId: "parent", checkpoint: { relativePath: "prior/adapter-step-0/checkpoint.json", sha256: "1".repeat(64) },
    originRunEvidence: { relativePath: "prior/run-evidence.json", sha256: "2".repeat(64) } };
  input.run.lineage = { parentRunId: "parent", checkpointDigest: "1".repeat(64) };
  const d = prepareCoworkerNativePreflight(prepareCoworkerAttempt(rebindCoworkerFixture(input)));
  assert.ok(d.command.args.includes("--resume-from=/srv/inputs/prior/adapter-step-0"));
  const receipt = interpretCoworkerNativePreflight(d, observation(d));
  assert.equal(receipt.result, "passed"); assert.equal(receipt.launchSupported, false);
  assert.equal(receipt.pending.find(row => row.check === "checkpoint_and_resume")!.status, "pending");
});

test("a harmless real process can supply the output protocol without being mistaken for native runtime qualification", async () => {
  const d = declaration(), o = observation(d);
  o.process = await runProcess({ executable: process.execPath,
    args: ["-e", "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>process.stdout.write(input));"],
    cwd: process.cwd(), env: {}, input: stdout(), timeoutMs: 2000, maxOutputBytes: NATIVE_PREFLIGHT_OUTPUT_BYTES });
  const receipt = interpretCoworkerNativePreflight(d, o);
  assert.equal(receipt.result, "passed"); assert.equal(receipt.launchSupported, false);
  assert.equal(receipt.evidenceOrigin, "controller_supplied_process_result_not_independently_attested");
});
