import { posix } from "node:path";
import type { CreateRunInput, ManifestRecord } from "../../ledger/types.ts";
import { validateManifest } from "../../ledger/manifest.ts";
import { decimalMoney, digestValue, encode, hash, id, integer, keys, policyScope } from "../../ledger/validation.ts";

export const COWORKER_SOURCE_REVISION = "84b219f64f1152f8b02babea388bfbbfff41e75a";
export const COWORKER_PROPOSED_BACKEND = "coworker-systemd-v1";

/** Paths are relative to the declared read-only input root; hashes are declarations. */
export interface CoworkerInputReference { relativePath: string; sha256: string }
export interface CoworkerAttemptConfiguration {
  source: { revision: string; treeSha256: string; root: string };
  environment: { imageDigest: string; dependenciesDigest: string; pythonExecutable: string };
  paths: { inputRoot: string; outputRoot: string };
  inputs: {
    experimentManifest: CoworkerInputReference;
    numericalQualificationReceipt: CoworkerInputReference;
    initialAdapter: { directory: string; fingerprintSha256: string } | null;
    /** checkpoint.sha256 means the bytes of <directory>/checkpoint.json. */
    resume: { parentRunId: string; checkpoint: CoworkerInputReference; originRunEvidence: CoworkerInputReference } | null;
  };
  trainer: {
    selection: string; configIds: string[]; endpoint: string; modelName: string;
    baseModel: "Qwen/Qwen3-8B"; init: "base"; g: number; steps: number;
    trainingSeed: number; initSeed: number; samplingExternalPreflights: number;
    stepIndexStart: number; worldSeedStart: number; judgeModel: string;
    rewardMode: "banded" | "faithful_recovery"; semanticInstrument: string | null;
    taskManifestSha256: string | null; maxPromptTokens: number; learningRate: number;
    maxDegenerateSteps: number; shuffledControlSeed: number | null; shuffledTrainingRunSeed: number | null;
  };
  helper: { model: string; provider: "anthropic" | "bedrock"; region: string | null;
    concurrency: number; timeoutSeconds: number; cache: "attempt-local" };
  limits: {
    podHourlyMicrodollars: string; trainingGpuCeilingMicrodollars: string;
    maxElapsedSeconds: number; maxHelperProviderCalls: number; maxJudgeProviderCalls: number;
    /** Proposed supervisor caps; the preview does not enforce them. */
    runtimeMaxSeconds: number; startTimeoutSeconds: number; stopGraceSeconds: number;
    memoryMaxBytes: number; tasksMax: number;
  };
}
export interface CoworkerAttemptInput {
  manifest: ManifestRecord;
  run: CreateRunInput;
  operationRevision: number;
  configuration: CoworkerAttemptConfiguration;
}
type Frozen<T> = T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;
interface PlanBody {
  schemaVersion: 1; kind: "coworker-attempt-preview"; qualification: "declarations_only"; launchSupported: false;
  binding: { projectId: string; runId: string; replicaId: string; manifestDigest: string;
    actionId: string; backendKey: string; backend: typeof COWORKER_PROPOSED_BACKEND; operation: "launch"; operationRevision: number };
  declarations: CoworkerAttemptInput;
  command: { executable: string; args: string[]; cwd: string;
    environment: { inherit: false; values: { PYTHONPATH: string; PYTHONNOUSERSITE: "1"; PYTHONHASHSEED: string; PROBING_RUNTIME_SOURCE_SHA: string } };
    outputs: { attemptRoot: string; runDirectory: string; adapterDirectory: string; helperCachePath: string } };
}
export type CoworkerAttemptPlan = Frozen<PlanBody & { digest: string }>;

function invalid(message: string): never { throw new TypeError(`Invalid CoworkeRL attempt: ${message}`); }
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.length || value.length > 1024 || /[\x00-\x20\x7f]/u.test(value) || value.startsWith("-")) invalid(`${label} must be bounded text without whitespace, control characters or a leading '-'`);
}
function integerRange(value: unknown, minimum: number, maximum: number, label: string): asserts value is number {
  integer(value, minimum); if (value > maximum) invalid(`${label} exceeds ${maximum}`);
}
function positive(value: unknown, maximum: number, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) invalid(`${label} must be positive, finite and <= ${maximum}`);
}
function absolute(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("/") || value === "/" || /[\\\x00-\x1f\x7f]/u.test(value) || posix.normalize(value) !== value || value.endsWith("/")) invalid(`${label} must be a canonical absolute Linux path`);
}
function relative(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length > 1024 || !value.length || /[\\\x00-\x1f\x7f]/u.test(value)
    || value.startsWith("/") || value.split("/").some(part => !part || part === "." || part === "..")) invalid(`${label} must be a contained relative path`);
}
function contains(parent: string, child: string): boolean { return child === parent || child.startsWith(`${parent}/`); }
function reference(value: unknown): asserts value is CoworkerInputReference {
  keys(value, ["relativePath", "sha256"]); relative(value.relativePath, "input path"); digestValue(value.sha256);
}
/** Reject accessors and non-JSON values before copying; this function never reads files or awaits. */
function snapshot(input: unknown): unknown {
  let count = 0;
  function copy(value: unknown, depth: number): unknown {
    if (++count > 20_000 || depth > 24) invalid("input is too large or deeply nested");
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) invalid("input must be plain JSON data");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length || Object.values(descriptors).some(item => !Object.hasOwn(item, "value"))) invalid("accessors and symbols are unsupported");
    if (Array.isArray(value)) {
      if (value.length > 20_000 || Object.keys(descriptors).length !== value.length + 1) invalid("arrays must be dense without extra properties");
      return Array.from({ length: value.length }, (_, index) => {
        if (!descriptors[index]) invalid("sparse arrays are unsupported");
        return copy(descriptors[index]!.value, depth + 1);
      });
    }
    const result: Record<string, unknown> = {};
    for (const [key, property] of Object.entries(descriptors)) {
      if (!property.enumerable) invalid("non-enumerable input fields are unsupported");
      Object.defineProperty(result, key, { value: copy(property.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  const result = copy(input, 0);
  if (Buffer.byteLength(encode(result)) > 256_000) invalid("input exceeds 256 KB");
  return result;
}
function freeze<T>(value: T): Frozen<T> {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value as Frozen<T>;
}
function dollars(microdollars: string): string {
  const value = BigInt(microdollars);
  return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, "0")}`;
}

/** Build a proposal, not authority: no files, credentials, ledger writes or process calls. */
export function prepareCoworkerAttempt(raw: unknown): CoworkerAttemptPlan {
  const value = snapshot(raw);
  keys(value, ["manifest", "run", "operationRevision", "configuration"]);
  keys(value.manifest, ["digest", "manifest"]); digestValue(value.manifest.digest);
  validateManifest(value.manifest.manifest as ManifestRecord["manifest"]);
  if (hash(value.manifest.manifest) !== value.manifest.digest) invalid("manifest digest mismatch");
  keys(value.run, ["runId", "projectId", "manifestDigest", "replicaId", "lineage"], ["runId", "projectId", "manifestDigest", "replicaId"]);
  for (const name of ["runId", "projectId", "replicaId"] as const) id(value.run[name], name);
  policyScope(`project:${value.run.projectId}`);
  if (value.run.manifestDigest !== value.manifest.digest) invalid("run manifest binding mismatch");
  integerRange(value.operationRevision, 1, Number.MAX_SAFE_INTEGER, "operation revision");
  const c = value.configuration;
  keys(c, ["source", "environment", "paths", "inputs", "trainer", "helper", "limits"]);
  keys(c.source, ["revision", "treeSha256", "root"]); digestValue(c.source.treeSha256); absolute(c.source.root, "source root");
  if (c.source.root.includes(":")) invalid("source root cannot contain the PYTHONPATH separator ':'");
  if (c.source.revision !== COWORKER_SOURCE_REVISION) invalid("source revision has not been inspected for this command contract");
  keys(c.environment, ["imageDigest", "dependenciesDigest", "pythonExecutable"]);
  absolute(c.environment.pythonExecutable, "Python executable"); digestValue(c.environment.dependenciesDigest);
  keys(c.paths, ["inputRoot", "outputRoot"]); absolute(c.paths.inputRoot, "input root"); absolute(c.paths.outputRoot, "output root");
  for (const root of [c.source.root, c.paths.inputRoot]) if (contains(root, c.paths.outputRoot) || contains(c.paths.outputRoot, root)) invalid("writable output root overlaps a read-only source/input root");
  if (contains(c.paths.outputRoot, c.environment.pythonExecutable)) invalid("Python executable is inside the writable root");
  keys(c.inputs, ["experimentManifest", "numericalQualificationReceipt", "initialAdapter", "resume"]);
  reference(c.inputs.experimentManifest); reference(c.inputs.numericalQualificationReceipt);
  if (c.inputs.initialAdapter !== null) {
    keys(c.inputs.initialAdapter, ["directory", "fingerprintSha256"]); relative(c.inputs.initialAdapter.directory, "initial adapter directory"); digestValue(c.inputs.initialAdapter.fingerprintSha256);
  }
  if (c.inputs.resume !== null) {
    keys(c.inputs.resume, ["parentRunId", "checkpoint", "originRunEvidence"]); id(c.inputs.resume.parentRunId);
    reference(c.inputs.resume.checkpoint); reference(c.inputs.resume.originRunEvidence);
    if (c.inputs.initialAdapter !== null) invalid("resume and initial adapter are mutually exclusive");
    if (!c.inputs.resume.checkpoint.relativePath.endsWith("/checkpoint.json") || !c.inputs.resume.originRunEvidence.relativePath.endsWith("/run-evidence.json")) invalid("resume must reference checkpoint.json and origin run-evidence.json");
    // Native resume locates run evidence from the checkpoint's origin run directory.
    const origin = posix.dirname(c.inputs.resume.originRunEvidence.relativePath);
    if (origin !== posix.dirname(posix.dirname(c.inputs.resume.checkpoint.relativePath))) invalid("checkpoint must be an immediate child directory of its origin run directory");
    keys(value.run.lineage, ["parentRunId", "checkpointDigest"]);
    if (value.run.lineage.parentRunId !== c.inputs.resume.parentRunId || value.run.lineage.checkpointDigest !== c.inputs.resume.checkpoint.sha256 || value.run.lineage.parentRunId === value.run.runId) invalid("resume lineage mismatch");
  } else if (Object.hasOwn(value.run, "lineage")) invalid("fresh attempts cannot carry checkpoint lineage");
  keys(c.trainer, ["selection", "configIds", "endpoint", "modelName", "baseModel", "init", "g", "steps", "trainingSeed", "initSeed", "samplingExternalPreflights", "stepIndexStart", "worldSeedStart", "judgeModel", "rewardMode", "semanticInstrument", "taskManifestSha256", "maxPromptTokens", "learningRate", "maxDegenerateSteps", "shuffledControlSeed", "shuffledTrainingRunSeed"]);
  for (const field of ["selection", "modelName", "judgeModel"] as const) text(c.trainer[field], field);
  if (c.trainer.selection === "train_qualification") invalid("train_qualification is not an optimizer training selection");
  if (c.trainer.baseModel !== "Qwen/Qwen3-8B" || c.trainer.init !== "base") invalid("only the inspected pinned base model and base initialization are supported");
  if (!Array.isArray(c.trainer.configIds) || !c.trainer.configIds.length || c.trainer.configIds.length > 256) invalid("explicit config IDs are required");
  for (const item of c.trainer.configIds) text(item, "config ID");
  if (new Set(c.trainer.configIds).size !== c.trainer.configIds.length) invalid("duplicate config IDs");
  text(c.trainer.endpoint, "endpoint");
  const endpoint = new URL(c.trainer.endpoint);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !["/", "/v1", "/v1/"].includes(endpoint.pathname)) invalid("serving endpoint must be credential-free loopback HTTP with an optional /v1 path");
  integerRange(c.trainer.g, 2, 100_000, "group size"); integerRange(c.trainer.steps, 1, 10_000_000, "steps");
  for (const field of ["trainingSeed", "initSeed", "stepIndexStart", "worldSeedStart"] as const) integerRange(c.trainer[field], 0, 0xffff_ffff, field);
  integerRange(c.trainer.samplingExternalPreflights, 1, 100_000, "sampling preflights");
  integerRange(c.trainer.maxPromptTokens, 1, 40_960 - 4096, "prompt tokens");
  integerRange(c.trainer.maxDegenerateSteps, 1, 10_000_000, "degenerate steps"); positive(c.trainer.learningRate, 1, "learning rate");
  for (const field of ["shuffledControlSeed", "shuffledTrainingRunSeed"] as const) if (c.trainer[field] !== null) integerRange(c.trainer[field], 0, 0xffff_ffff, field);
  if ((c.trainer.shuffledControlSeed === null) !== (c.trainer.shuffledTrainingRunSeed === null)) invalid("shuffled control requires both explicit seeds");
  if (c.trainer.shuffledControlSeed !== null && c.trainer.g !== 4) invalid("the inspected shuffled-control CLI supports only groups of four");
  if (c.trainer.rewardMode === "faithful_recovery") {
    if (!(c.trainer.configIds as string[]).every(item => item.startsWith("fr-v1-"))) invalid("faithful reward requires faithful task IDs");
    text(c.trainer.semanticInstrument, "semantic instrument"); digestValue(c.trainer.taskManifestSha256);
    if (c.trainer.taskManifestSha256 !== c.inputs.experimentManifest.sha256) invalid("task manifest identity mismatch");
  } else if (c.trainer.rewardMode !== "banded" || c.trainer.semanticInstrument !== null || c.trainer.taskManifestSha256 !== null || (c.trainer.configIds as string[]).some(item => item.startsWith("fr-v1-"))) invalid("reward and task/instrument declarations disagree");
  keys(c.helper, ["model", "provider", "region", "concurrency", "timeoutSeconds", "cache"]); text(c.helper.model, "helper model");
  if (c.helper.provider === "bedrock") text(c.helper.region, "Bedrock region");
  else if (c.helper.provider !== "anthropic" || c.helper.region !== null) invalid("helper provider/region combination is unsupported");
  integerRange(c.helper.concurrency, 1, 1024, "helper concurrency"); positive(c.helper.timeoutSeconds, 86_400, "helper timeout");
  if (c.helper.cache !== "attempt-local") invalid("only explicit attempt-local helper caching is supported by the inspected trainer");
  keys(c.limits, ["podHourlyMicrodollars", "trainingGpuCeilingMicrodollars", "maxElapsedSeconds", "maxHelperProviderCalls", "maxJudgeProviderCalls", "runtimeMaxSeconds", "startTimeoutSeconds", "stopGraceSeconds", "memoryMaxBytes", "tasksMax"]);
  for (const field of ["podHourlyMicrodollars", "trainingGpuCeilingMicrodollars"] as const) { decimalMoney(c.limits[field]); if (BigInt(c.limits[field]) === 0n) invalid(`${field} must be positive`); }
  for (const field of ["maxElapsedSeconds", "runtimeMaxSeconds", "startTimeoutSeconds", "stopGraceSeconds"] as const) integerRange(c.limits[field], 1, 31_536_000, field);
  for (const field of ["maxHelperProviderCalls", "maxJudgeProviderCalls", "memoryMaxBytes", "tasksMax"] as const) integerRange(c.limits[field], 1, Number.MAX_SAFE_INTEGER, field);
  const input = value as unknown as CoworkerAttemptInput, config = input.configuration, manifest = input.manifest.manifest;
  if (manifest.adapter.kind !== "llm_posttraining" || manifest.adapter.name !== "coworkerl-v2-fit-loop" || hash(manifest.adapter.config) !== hash(config)) invalid("manifest must bind the exact supported adapter configuration");
  if (manifest.code.revision !== config.source.revision || manifest.code.dirtyPatchSha256 !== null) invalid("only the inspected clean source revision is supported");
  if (manifest.environment.imageDigest !== config.environment.imageDigest || manifest.environment.dependenciesDigest !== config.environment.dependenciesDigest) invalid("environment binding mismatch");
  if (!manifest.seeds.includes(config.trainer.trainingSeed) || !manifest.seeds.includes(config.trainer.initSeed)) invalid("training and initialization seeds must be declared in the manifest");
  if (config.limits.maxElapsedSeconds > config.limits.runtimeMaxSeconds || config.limits.runtimeMaxSeconds + config.limits.startTimeoutSeconds + config.limits.stopGraceSeconds > manifest.resources.maxDurationSeconds) invalid("worker lifecycle limits exceed manifest duration");
  if (BigInt(config.limits.trainingGpuCeilingMicrodollars) > BigInt(manifest.resources.maxCostMicrodollars)) invalid("training GPU ceiling exceeds total manifest cap");

  const actionId = `action:${hash([input.run.runId, "launch", input.operationRevision])}`;
  const attemptRoot = posix.join(config.paths.outputRoot, actionId.slice("action:".length));
  const outputs = { attemptRoot, runDirectory: posix.join(attemptRoot, "run"), adapterDirectory: posix.join(attemptRoot, "adapter"), helperCachePath: posix.join(attemptRoot, "helper-cache.jsonl") };
  const path = (ref: CoworkerInputReference) => posix.join(config.paths.inputRoot, ref.relativePath);
  const args: string[] = ["-s", "-m", "probing.verl.fit_loop"];
  const flag = (name: string, field: string | number | null) => { if (field !== null) args.push(`--${name}=${String(field)}`); };
  const t = config.trainer, h = config.helper, l = config.limits;
  flag("manifest", path(config.inputs.experimentManifest)); flag("selection", t.selection);
  flag("helper-model", h.model); flag("helper-provider", h.provider); flag("helper-region", h.region);
  flag("helper-concurrency", h.concurrency); flag("helper-timeout-s", h.timeoutSeconds); flag("helper-cache-path", outputs.helperCachePath);
  flag("endpoint", t.endpoint); flag("model-name", t.modelName); flag("base-model", t.baseModel);
  flag("adapter-dir", outputs.adapterDirectory); flag("out-dir", outputs.runDirectory);
  args.push("--configs", ...t.configIds);
  flag("init", t.init); flag("g", t.g); flag("steps", t.steps); flag("training-seed", t.trainingSeed); flag("init-seed", t.initSeed);
  flag("initial-adapter-dir", config.inputs.initialAdapter ? posix.join(config.paths.inputRoot, config.inputs.initialAdapter.directory) : null);
  flag("initial-adapter-sha256", config.inputs.initialAdapter?.fingerprintSha256 ?? null);
  flag("resume-from", config.inputs.resume ? posix.dirname(path(config.inputs.resume.checkpoint)) : null);
  flag("sampling-external-preflights", t.samplingExternalPreflights); flag("numerical-qualification-receipt", path(config.inputs.numericalQualificationReceipt));
  flag("step-index-start", t.stepIndexStart); flag("world-seed-start", t.worldSeedStart); flag("judge-model", t.judgeModel);
  flag("reward-mode", t.rewardMode); flag("semantic-instrument", t.semanticInstrument); flag("task-manifest-sha256", t.taskManifestSha256);
  flag("max-prompt-tokens", t.maxPromptTokens); flag("learning-rate", t.learningRate);
  flag("pod-hourly-usd", dollars(l.podHourlyMicrodollars)); flag("spend-ceiling-usd", dollars(l.trainingGpuCeilingMicrodollars));
  flag("max-elapsed-seconds", l.maxElapsedSeconds); flag("max-helper-provider-calls", l.maxHelperProviderCalls); flag("max-judge-provider-calls", l.maxJudgeProviderCalls);
  flag("max-degenerate-steps", t.maxDegenerateSteps); flag("shuffled-control-seed", t.shuffledControlSeed); flag("shuffled-training-run-seed", t.shuffledTrainingRunSeed);
  const body: PlanBody = { schemaVersion: 1, kind: "coworker-attempt-preview", qualification: "declarations_only", launchSupported: false,
    binding: { projectId: input.run.projectId, runId: input.run.runId, replicaId: input.run.replicaId, manifestDigest: input.manifest.digest,
      actionId, backendKey: actionId, backend: COWORKER_PROPOSED_BACKEND, operation: "launch", operationRevision: input.operationRevision }, declarations: input,
    command: { executable: config.environment.pythonExecutable, args, cwd: config.source.root,
      environment: { inherit: false, values: { PYTHONPATH: posix.join(config.source.root, "experiments/coworkerl-v2/src"), PYTHONNOUSERSITE: "1", PYTHONHASHSEED: String(t.trainingSeed), PROBING_RUNTIME_SOURCE_SHA: config.source.revision } }, outputs } };
  return freeze({ ...body, digest: hash(body) });
}
