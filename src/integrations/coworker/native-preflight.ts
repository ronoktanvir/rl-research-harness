import { createHash } from "node:crypto";
import type { JsonObject } from "../../ledger/types.ts";
import { digestValue, encode, hash, keys, object } from "../../ledger/validation.ts";
import type { ProcessResult } from "../../workers/process.ts";
import { COWORKER_SOURCE_REVISION, prepareCoworkerAttempt } from "./attempt-plan.ts";
import type { CoworkerAttemptPlan } from "./attempt-plan.ts";

type Frozen<T> = T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;
export const NATIVE_PREFLIGHT_OUTPUT_BYTES = 128_000;
export interface CoworkerPreflightPendingCheck {
  check: "immutable_execution_binding" | "transitive_task_files" | "environment_and_interpreter"
    | "numerical_qualification" | "live_serving_and_sampling" | "model_and_tokenizer"
    | "initial_adapter" | "checkpoint_and_resume" | "output_directory" | "resource_and_scientific_admission";
  status: "pending";
  reason: string;
}
interface DeclarationBody {
  schemaVersion: 1; kind: "coworker-native-preflight-declaration"; qualification: "prepared_only";
  launchSupported: false; digest: string; sourceRevision: typeof COWORKER_SOURCE_REVISION;
  binding: { planDigest: string; actionId: string; manifestDigest: string };
  attemptPlan: CoworkerAttemptPlan;
  command: { executable: string; args: string[]; cwd: string; environment: { inherit: false; values: Record<string, string> } };
  requiredExecutionBoundary: { supervised: true; network: "denied"; credentials: "absent"; inputs: "immutable_read_only";
    resourceLimits: "separately_admitted"; trainerInvocation: false };
}
export type CoworkerNativePreflightDeclaration = Frozen<Omit<DeclarationBody, "attemptPlan">>
  & { readonly attemptPlan: CoworkerAttemptPlan };
/** Supplied by a trusted controller from one retained worker/process observation.
 * The parser does not authenticate its origin or observe the process itself. */
export interface CoworkerNativePreflightObservation {
  planDigest: string; declarationDigest: string;
  startedAt: string; completedAt: string;
  process: ProcessResult;
}
interface ReceiptBody {
  schemaVersion: 1; kind: "coworker-native-preflight-receipt";
  qualification: "local_contract_output_only"; launchSupported: false; digest: string;
  binding: { planDigest: string; declarationDigest: string; commandDigest: string; actionId: string; manifestDigest: string };
  startedAt: string; completedAt: string;
  result: "passed" | "failed" | "unknown";
  reason: "complete_native_output" | "process_nonzero_exit" | "process_incomplete" | "invalid_success_output";
  process: { exitCode: number | null; stopped: ProcessResult["stopped"] };
  output: { stdout: { bytes: number; sha256: string }; stderr: { bytes: number; sha256: string } };
  trainingObjective: JsonObject | null;
  evidenceOrigin: "controller_supplied_process_result_not_independently_attested";
  pending: CoworkerPreflightPendingCheck[];
}
// JsonObject is recursively defined. Do not expand it through the generic mapped
// type in the public signature; the returned metadata is still frozen at runtime.
export type CoworkerNativePreflightReceipt = Frozen<Omit<ReceiptBody, "trainingObjective">>
  & { readonly trainingObjective: Readonly<JsonObject> | null };

function invalid(message: string): never { throw new TypeError(`Invalid CoworkeRL native preflight: ${message}`); }
function snapshot(value: unknown, depth = 0, budget = { nodes: 40_000, bytes: 1_048_576 }): unknown {
  if (--budget.nodes < 0 || depth > 32) invalid("structural bound");
  budget.bytes -= typeof value === "string" ? Buffer.byteLength(value) + 2 : 2;
  if (budget.bytes < 0) invalid("byte bound");
  if (value === null || typeof value === "boolean" || typeof value === "string"
    || (typeof value === "number" && Number.isFinite(value))) return value;
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype)) invalid("expected inert JSON");
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || Object.values(fields).some(field => !Object.hasOwn(field, "value"))) invalid("accessors or symbols");
  if (Array.isArray(value)) {
    if (value.length > 40_000 || Object.keys(fields).length !== value.length + 1) invalid("array bound or extra fields");
    return Array.from({ length: value.length }, (_, index) => {
      const field = fields[index]; if (!field?.enumerable) invalid("sparse array");
      return snapshot(field.value, depth + 1, budget);
    });
  }
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => {
    if (!field.enumerable) invalid("non-enumerable field");
    budget.bytes -= Buffer.byteLength(key) + 3;
    return [key, snapshot(field.value, depth + 1, budget)];
  }));
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function boundedText(value: unknown, maximum: number, empty = false): asserts value is string {
  if (typeof value !== "string" || (!empty && !value.length) || value.includes("\0") || Buffer.byteLength(value) > maximum
    || Buffer.from(value).toString("utf8") !== value) invalid("text bound or encoding");
}
function timestamp(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid("timestamp");
}
function verifiedAttempt(raw: unknown): CoworkerAttemptPlan {
  const value = snapshot(raw);
  keys(value, ["schemaVersion", "kind", "qualification", "launchSupported", "binding", "declarations", "command", "digest"]);
  const expected = prepareCoworkerAttempt(value.declarations);
  if (encode(value) !== encode(expected)) invalid("attempt preview differs from its declarations");
  return expected;
}

/** Pure construction only. No file reads, project imports, process execution,
 * credential access, ledger admission or trainer invocation occurs here. */
export function prepareCoworkerNativePreflight(rawPlan: unknown): CoworkerNativePreflightDeclaration {
  const attemptPlan = verifiedAttempt(rawPlan), original = attemptPlan.command;
  const body: Omit<CoworkerNativePreflightDeclaration, "digest"> = {
    schemaVersion: 1 as const, kind: "coworker-native-preflight-declaration" as const,
    qualification: "prepared_only" as const, launchSupported: false as const,
    sourceRevision: COWORKER_SOURCE_REVISION as typeof COWORKER_SOURCE_REVISION,
    binding: { planDigest: attemptPlan.digest, actionId: attemptPlan.binding.actionId, manifestDigest: attemptPlan.binding.manifestDigest },
    attemptPlan,
    command: { executable: original.executable, args: ["-B", ...original.args, "--preflight-only"], cwd: original.cwd,
      environment: { inherit: false as const, values: { ...original.environment.values } } },
    requiredExecutionBoundary: { supervised: true as const, network: "denied" as const, credentials: "absent" as const,
      inputs: "immutable_read_only" as const, resourceLimits: "separately_admitted" as const, trainerInvocation: false as const },
  };
  return freeze({ ...body, digest: hash(body) });
}

const ACTOR_PINS = {
  clip_ratio: .2, clip_ratio_low: .2, clip_ratio_high: .2, clip_ratio_c: 3, loss_agg_mode: "token-mean",
  ppo_epochs: 1, entropy_coeff: 0, calculate_entropy: false, use_kl_loss: false, kl_loss_coef: .001,
};
const IMPLEMENTATIONS = ["policy_loss", "actor_config_class", "episode_advantage", "microbatch_update",
  "correction_preflight", "correction_weights", "native_custody", "optimizer_update"];
// Data contract from objective.py at the inspected revision. These describe the
// native output; they do not reimplement or independently validate its estimator.
const OBJECTIVE_TEXT = {
  ratio: "exp(clamp(log_pi_current - log_pi_old, -20, 20))",
  unmasked_token_loss: "B=max(-A*r, -A*clip(r,0.8,1.2)); vanilla=min(-3*A,B) if A<0 else B; loss=stop_gradient(exp(min(log_pi_old_teacher-log_pi_native_served,log(2))))*vanilla",
  aggregation: "sum(masked token losses) / total trainable token count; row microbatches weighted by trainable-token mass",
  old_policy_likelihood: "recomputed with no_grad on the same pre-update weights; captured serving logprobs are only the separate correction denominator, never the PPO ratio denominator",
  ppo_kl_metric: "diagnostic only; not an added loss term",
  no_signal_behavior: "skip optimizer.step entirely, including Adam momentum and weight decay; no KL or entropy update",
};
const WEIGHT_TEXT = {
  formula: "stop_gradient(exp(min(log_pi_old_teacher-log_pi_native_served,log(2))))",
  application: "verl vanilla rollout_is_weights hook, once on unreduced token losses",
  denominator: "original unweighted trainable-token count, including zero-advantage groups",
  failure: "abort complete batch before optimizer.step; retain evidence and clear gradients",
  scope: "token-local surrogate; not unbiased whole-trajectory correction or a bound on off-policy bias",
};
const ADVANTAGE_TEXT = {
  unit: "one terminal reward per episode within its group", formula: "(reward - group_mean) / (sample_std + 1e-6)",
  identical_rewards_or_singleton: "exact zero before reduction", broadcast: "same episode advantage on its trainable policy tokens",
};
function declaredText(value: Record<string, unknown>, expected: Record<string, string>): void {
  for (const [key, text] of Object.entries(expected)) if (value[key] !== text) invalid("declared objective text differs");
}

/** JSON.parse checks syntax; this pass additionally rejects duplicate decoded
 * keys, which would otherwise silently replace an earlier scientific setting. */
function strictJson(raw: string): unknown {
  const parsed: unknown = JSON.parse(raw);
  const stack: Array<{ type: "object" | "array"; keys: Set<string>; keyExpected: boolean }> = [];
  const tokens = raw.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/gu) ?? [];
  for (const token of tokens) {
    if (token === "{" || token === "[") stack.push({ type: token === "{" ? "object" : "array", keys: new Set(), keyExpected: token === "{" });
    else if (token === "}" || token === "]") stack.pop();
    else {
      const parent = stack.at(-1);
      if (token === "," && parent?.type === "object") parent.keyExpected = true;
      else if (token.startsWith('"') && parent?.type === "object" && parent.keyExpected) {
        const key = JSON.parse(token) as string;
        if (parent.keys.has(key)) invalid("duplicate objective key");
        parent.keys.add(key); parent.keyExpected = false;
      }
    }
  }
  return snapshot(parsed);
}
function objective(value: unknown, groupSize: number): JsonObject {
  keys(value, ["schema", "verl_version", "policy_loss_function", "actor_objective_pins", "ratio", "unmasked_token_loss", "aggregation",
    "old_policy_likelihood", "rollout_importance_weights", "advantage", "optimization_passes_per_rollout_batch", "reference_policy",
    "effective_kl_coefficient", "effective_entropy_coefficient", "ppo_kl_metric", "no_signal_behavior", "optimizer_weight_decay_on_actual_updates",
    "resolved_actor_config", "resolved_config_note", "implementation"]);
  if (value.schema !== "coworkerl-fit-loop-objective/v2" || value.verl_version !== "0.8.0"
    || value.policy_loss_function !== "verl.trainer.ppo.core_algos.compute_policy_loss_vanilla"
    || value.optimization_passes_per_rollout_batch !== 1 || value.reference_policy !== null || value.effective_kl_coefficient !== 0
    || value.effective_entropy_coefficient !== 0 || value.optimizer_weight_decay_on_actual_updates !== .01) invalid("objective contract");
  declaredText(value, OBJECTIVE_TEXT); boundedText(value.resolved_config_note, 8192);
  if (encode(value.actor_objective_pins) !== encode(ACTOR_PINS)) invalid("actor objective pins");
  keys(value.rollout_importance_weights, ["schema", "formula", "application", "amplification_cap", "lower_floor", "self_normalized", "denominator",
    "max_cap_fraction", "min_token_ess", "qualification_and_training_limits_identical", "failure", "scope"]);
  const weights = value.rollout_importance_weights;
  if (weights.schema !== "coworkerl-token-local-rollout-correction/v1" || weights.amplification_cap !== 2 || weights.lower_floor !== null
    || weights.self_normalized !== false || weights.max_cap_fraction !== .01 || weights.min_token_ess !== .90
    || weights.qualification_and_training_limits_identical !== true) invalid("correction contract");
  declaredText(weights, WEIGHT_TEXT);
  keys(value.advantage, ["unit", "formula", "std_correction", "epsilon", "normalization_dtype", "identical_rewards_or_singleton", "broadcast"]);
  if (value.advantage.std_correction !== 1 || value.advantage.epsilon !== 1e-6 || value.advantage.normalization_dtype !== "float64") invalid("advantage contract");
  declaredText(value.advantage, ADVANTAGE_TEXT);
  // The complete SDK config includes unused defaults. Validate the applied pins
  // and retain the other fields as observations, not new scientific authority.
  object(value.resolved_actor_config);
  for (const [key, expected] of Object.entries(ACTOR_PINS)) {
    if (value.resolved_actor_config[key] !== expected) invalid("resolved actor pins");
  }
  if (value.resolved_actor_config.strategy !== "fsdp" || value.resolved_actor_config.rollout_n !== groupSize
    || value.resolved_actor_config.ppo_micro_batch_size_per_gpu !== 1) invalid("resolved actor configuration");
  keys(value.implementation, IMPLEMENTATIONS);
  for (const implementation of Object.values(value.implementation)) {
    keys(implementation, ["qualified_name", "source_sha256", "module_sha256"]);
    boundedText(implementation.qualified_name, 1024);
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/u.test(implementation.qualified_name)) invalid("implementation name");
    digestValue(implementation.source_sha256); digestValue(implementation.module_sha256);
  }
  return value as JsonObject;
}

function parseOutput(stdout: string, groupSize: number): JsonObject | null {
  try {
    // Native main prints the marker before objective_metadata can still throw.
    // Only the complete two-record shape is interpretable as a success payload.
    const match = /^preflight: PASS\n([^\n]+)\n$/u.exec(stdout);
    if (!match) return null;
    const value = strictJson(match[1]!); keys(value, ["training_objective"]);
    return objective(value.training_objective, groupSize);
  } catch { return null; }
}

function pending(): CoworkerPreflightPendingCheck[] {
  return [
    { check: "immutable_execution_binding", status: "pending", reason: "The parser does not verify source bytes, deployment immutability, process identity or byte-to-execution freshness." },
    { check: "transitive_task_files", status: "pending", reason: "Native selection may read task configs, human approval and interpretation notes beyond the manifest file; their complete execution-time closure is not attested here." },
    { check: "environment_and_interpreter", status: "pending", reason: "Reported imported implementation hashes and verl version do not verify the complete image, interpreter or dependency installation." },
    { check: "numerical_qualification", status: "pending", reason: "--preflight-only does not call verify_receipt or validate the numerical qualification receipt." },
    { check: "live_serving_and_sampling", status: "pending", reason: "The preflight canary is scripted; no live serving, sampling observer or provider readiness is established." },
    { check: "model_and_tokenizer", status: "pending", reason: "Preflight does not load or qualify the actual model, tokenizer, CUDA execution or optimizer update." },
    { check: "initial_adapter", status: "pending", reason: "Preflight checks paired adapter declarations but does not inspect their tensor fingerprint." },
    { check: "checkpoint_and_resume", status: "pending", reason: "Preflight does not inspect checkpoint inventory/tensors, compare expected resume identity or verify the origin run's reserved-step boundary." },
    { check: "output_directory", status: "pending", reason: "The training path's empty-output-directory check is not part of --preflight-only." },
    { check: "resource_and_scientific_admission", status: "pending", reason: "A local contract result grants no launch authority, budget, allocation, evaluation approval or scientific-validity judgment." },
  ];
}

/** Interpret one complete bounded result from an independently supervised call.
 * Even a passed receipt is evidence only, never permission to start training. */
export function interpretCoworkerNativePreflight(rawDeclaration: unknown, rawObservation: unknown): CoworkerNativePreflightReceipt {
  const declaration = snapshot(rawDeclaration);
  keys(declaration, ["schemaVersion", "kind", "qualification", "launchSupported", "digest", "sourceRevision", "binding", "attemptPlan", "command", "requiredExecutionBoundary"]);
  const expected = prepareCoworkerNativePreflight(declaration.attemptPlan);
  if (encode(declaration) !== encode(expected)) invalid("declaration differs from its validated attempt");
  const observation = snapshot(rawObservation);
  keys(observation, ["planDigest", "declarationDigest", "startedAt", "completedAt", "process"]);
  if (observation.planDigest !== expected.binding.planDigest || observation.declarationDigest !== expected.digest) invalid("observation binding mismatch");
  timestamp(observation.startedAt); timestamp(observation.completedAt);
  if (observation.completedAt < observation.startedAt) invalid("completion precedes start");
  keys(observation.process, ["exitCode", "stdout", "stderr", "stopped"]);
  const process = observation.process;
  if (process.exitCode !== null && (typeof process.exitCode !== "number" || !Number.isInteger(process.exitCode) || process.exitCode < 0 || process.exitCode > 255)) invalid("exit code");
  if (process.stopped !== null && (typeof process.stopped !== "string" || !["timeout", "cancelled", "output_limit", "spawn_error"].includes(process.stopped))) invalid("process stop reason");
  boundedText(process.stdout, NATIVE_PREFLIGHT_OUTPUT_BYTES, true); boundedText(process.stderr, NATIVE_PREFLIGHT_OUTPUT_BYTES, true);
  if (Buffer.byteLength(process.stdout) + Buffer.byteLength(process.stderr) > NATIVE_PREFLIGHT_OUTPUT_BYTES) invalid("combined process output exceeds bound");
  const trainingObjective = parseOutput(process.stdout, expected.attemptPlan.declarations.configuration.trainer.g);
  const incomplete = process.stopped !== null || process.exitCode === null;
  const result: CoworkerNativePreflightReceipt["result"] = incomplete ? "unknown" : process.exitCode !== 0 ? "failed" : trainingObjective ? "passed" : "unknown";
  const reason: CoworkerNativePreflightReceipt["reason"] = incomplete ? "process_incomplete" : process.exitCode !== 0 ? "process_nonzero_exit"
    : trainingObjective ? "complete_native_output" : "invalid_success_output";
  const output = (text: string) => ({ bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text, "utf8").digest("hex") });
  const body = {
    schemaVersion: 1 as const, kind: "coworker-native-preflight-receipt" as const,
    qualification: "local_contract_output_only" as const, launchSupported: false as const,
    binding: { ...expected.binding, declarationDigest: expected.digest, commandDigest: hash(expected.command) },
    startedAt: observation.startedAt, completedAt: observation.completedAt, result, reason,
    process: { exitCode: process.exitCode as number | null, stopped: process.stopped as ProcessResult["stopped"] },
    output: { stdout: output(process.stdout), stderr: output(process.stderr) }, trainingObjective,
    evidenceOrigin: "controller_supplied_process_result_not_independently_attested" as const, pending: pending(),
  };
  return freeze({ ...body, digest: hash(body) });
}
