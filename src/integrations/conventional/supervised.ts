import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { posix } from "node:path";
import type { CreateRunInput, DispatchClaim, ExperimentLedger, ManifestRecord, JsonObject } from "../../ledger/types.ts";
import { digestValue, encode, hash, id, integer, keys, policyScope } from "../../ledger/validation.ts";
import { validateManifest } from "../../ledger/manifest.ts";
import type { PreparedLocalLaunch } from "../../execution/backend.ts";
import { createJobDeclaration } from "../../execution/worker.ts";
import type { HostIdentity, ServiceCommand, ServiceLimits, SystemdProfile } from "../../execution/types.ts";
import { CONVENTIONAL_PINS, prepareConventionalRequest } from "./protocol.ts";
import type { ConventionalRequest } from "./protocol.ts";

export const CONVENTIONAL_SUPERVISED_BACKEND = "conventional-systemd-v1";
export const CONVENTIONAL_SUPERVISED_ENVELOPE_BYTES = 72_000;
export interface ConventionalSourceFile { path: string; sha256: string }
export interface ConventionalDeployment {
  schemaVersion: 1;
  deploymentId: string;
  workerId: string;
  code: { revision: string; dirtyPatchSha256: string | null;
    runner: ConventionalSourceFile; entry: ConventionalSourceFile; requirements: ConventionalSourceFile };
  environment: { pythonExecutable: string; imageDigest: string; dependenciesDigest: string };
  outputRoot: string;
  host: HostIdentity;
  limits: ServiceLimits;
  profile: SystemdProfile;
  /** Explicit operator prerequisite, not something a byte hash establishes. */
  trust: { mode: "operator_owned_immutable_deployment"; operatorReference: string };
}
export interface ConventionalAttemptInput {
  manifest: ManifestRecord; run: CreateRunInput; operationRevision: number; deployment: ConventionalDeployment;
}
export interface ConventionalAttemptPlan {
  schemaVersion: 1; kind: "conventional-supervised-plan"; digest: string;
  qualification: "trusted_deployment_required";
  binding: { projectId: string; runId: string; replicaId: string; manifestDigest: string; actionId: string;
    backendKey: string; backend: typeof CONVENTIONAL_SUPERVISED_BACKEND; operation: "launch"; operationRevision: number };
  declarations: ConventionalAttemptInput;
  request: ConventionalRequest;
  requestBytesSha256: string;
  envelopeSha256: string;
  profileDigest: string;
  command: ServiceCommand;
  limits: ServiceLimits;
  outputs: { root: string; directoryName: string; directory: string; intent: string; result: string; receipt: string };
}
export interface ConventionalLaunchResolverOptions {
  ledger: Pick<ExperimentLedger, "getRun" | "getManifest" | "getAction">;
  deployment: ConventionalDeployment;
  /** Trusted operator policy and actual profile/deployment binding, checked fresh before dispatch. */
  authorizeDeployment: () => boolean;
}
export type ConventionalLaunchResolver = (claim: Readonly<DispatchClaim>, signal: AbortSignal) => Promise<PreparedLocalLaunch | null>;

function invalid(message: string): never { throw new TypeError(`Invalid supervised conventional attempt: ${message}`); }
function snapshot<T>(raw: T, money = false): T {
  let nodes = 0;
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 100_000 || depth > 32) invalid("structural bound exceeded");
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
    if (money && typeof value === "bigint") return value;
    if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype)) invalid("expected inert data");
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length || Object.values(fields).some(field => !Object.hasOwn(field, "value"))) invalid("accessors and symbols are unsupported");
    if (Array.isArray(value)) {
      if (value.length > 30_000 || Object.keys(fields).length !== value.length + 1) invalid("dense arrays required");
      return Array.from({ length: value.length }, (_, index) => {
        if (!fields[index]?.enumerable) invalid("dense arrays required");
        return visit(fields[index]!.value, depth + 1);
      });
    }
    return Object.fromEntries(Object.entries(fields).map(([key, field]) => {
      if (!field.enumerable) invalid("hidden fields are unsupported");
      return [key, visit(field.value, depth + 1)];
    }));
  };
  const result = visit(raw, 0);
  if (Buffer.byteLength(JSON.stringify(result, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)) > 256_000) invalid("input byte bound exceeded");
  return result as T;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function absolute(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 2048 || !/^\/[A-Za-z0-9_./-]+$/.test(value)
    || value === "/" || value.endsWith("/") || posix.normalize(value) !== value) invalid("canonical absolute Linux path required");
}
function within(root: string, path: string): boolean { return root === path || path.startsWith(`${root}/`); }
function equal(actual: unknown, expected: unknown, message: string): void { if (encode(actual) !== encode(expected)) invalid(message); }
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) invalid("bounded text required");
}
function limits(raw: unknown): asserts raw is ServiceLimits {
  keys(raw, ["runtimeMs", "startTimeoutMs", "stopTimeoutMs", "memoryMaxBytes", "tasksMax"]);
  for (const item of Object.values(raw)) integer(item, 1);
  if (Number(raw.runtimeMs) > 120_000 || Number(raw.startTimeoutMs) > 300_000 || Number(raw.stopTimeoutMs) > 300_000
    || Number(raw.memoryMaxBytes) > 8 * 1024 ** 3 || Number(raw.tasksMax) > 256) invalid("local CPU resource ceiling exceeded");
}
function strings(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 64 || new Set(value).size !== value.length || value.some(item => typeof item !== "string")) invalid("bounded unique string list required");
}
function deployment(raw: unknown): asserts raw is ConventionalDeployment {
  keys(raw, ["schemaVersion", "deploymentId", "workerId", "code", "environment", "outputRoot", "host", "limits", "profile", "trust"]);
  if (raw.schemaVersion !== 1) invalid("deployment schema"); id(raw.deploymentId); id(raw.workerId);
  keys(raw.code, ["revision", "dirtyPatchSha256", "runner", "entry", "requirements"]); text(raw.code.revision);
  if (raw.code.dirtyPatchSha256 !== null) digestValue(raw.code.dirtyPatchSha256);
  for (const file of [raw.code.runner, raw.code.entry, raw.code.requirements]) {
    keys(file, ["path", "sha256"]); absolute(file.path); digestValue(file.sha256);
  }
  keys(raw.environment, ["pythonExecutable", "imageDigest", "dependenciesDigest"]); absolute(raw.environment.pythonExecutable);
  if (typeof raw.environment.imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(raw.environment.imageDigest)) invalid("image declaration format");
  digestValue(raw.environment.dependenciesDigest);
  if (raw.environment.dependenciesDigest !== (raw.code.requirements as ConventionalSourceFile).sha256) invalid("dependency digest must bind the declared lock bytes");
  absolute(raw.outputRoot); keys(raw.host, ["machineId", "bootId"]);
  if (typeof raw.host.machineId !== "string" || !/^[a-f0-9]{32}$/.test(raw.host.machineId) || /^0+$/.test(raw.host.machineId)
    || typeof raw.host.bootId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(raw.host.bootId)
    || /^0+$/.test(raw.host.bootId.replaceAll("-", ""))) invalid("host identity");
  limits(raw.limits);
  const profile = raw.profile;
  keys(profile, ["userId", "groupId", "executables", "readOnlyPaths", "writableRoot", "allowedEnvironment", "maxima", "useSudo", "deadlineGate"]);
  integer(profile.userId, 1); integer(profile.groupId, 1);
  if (Number(profile.userId) > 0xffff_fffe || Number(profile.groupId) > 0xffff_fffe || typeof profile.useSudo !== "boolean") invalid("profile identity");
  strings(profile.executables); strings(profile.readOnlyPaths); strings(profile.allowedEnvironment);
  for (const path of [...profile.executables, ...profile.readOnlyPaths]) absolute(path);
  if (profile.writableRoot !== raw.outputRoot || !profile.executables.includes(raw.environment.pythonExecutable)) invalid("profile does not bind the interpreter/output root");
  limits(profile.maxima);
  for (const name of Object.keys(raw.limits) as (keyof ServiceLimits)[]) if (raw.limits[name] > profile.maxima[name]) invalid("resource request exceeds profile");
  keys(profile.deadlineGate, ["pythonExecutable", "scriptPath", "safetyMarginMs", "barrierTimeoutMs"]);
  absolute(profile.deadlineGate.pythonExecutable); absolute(profile.deadlineGate.scriptPath);
  integer(profile.deadlineGate.safetyMarginMs, 1000); integer(profile.deadlineGate.barrierTimeoutMs, 1);
  if (Number(profile.deadlineGate.safetyMarginMs) > 300_000 || Number(profile.deadlineGate.barrierTimeoutMs) > raw.limits.startTimeoutMs) invalid("deadline gate bound");
  const protectedPaths = [(raw.code.runner as ConventionalSourceFile).path, (raw.code.entry as ConventionalSourceFile).path,
    (raw.code.requirements as ConventionalSourceFile).path, raw.environment.pythonExecutable, profile.deadlineGate.scriptPath, profile.deadlineGate.pythonExecutable];
  for (const path of protectedPaths) if (!profile.readOnlyPaths.some(root => within(root, path))) invalid("source/interpreter/gate outside declared read-only roots");
  for (const path of [...profile.readOnlyPaths, ...profile.executables, ...protectedPaths]) {
    if (within(raw.outputRoot, path) || within(path, raw.outputRoot)) invalid("writable and immutable declarations overlap");
  }
  for (const name of ["OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS"]) if (!profile.allowedEnvironment.includes(name)) invalid("profile omits fixed thread-limit environment");
  keys(raw.trust, ["mode", "operatorReference"]);
  if (raw.trust.mode !== "operator_owned_immutable_deployment") invalid("explicit deployment prerequisite required"); text(raw.trust.operatorReference);
}

/** Pure deterministic declaration. It neither observes files nor admits/starts work. */
export function prepareConventionalAttempt(raw: unknown): ConventionalAttemptPlan {
  const input = snapshot(raw); keys(input, ["manifest", "run", "operationRevision", "deployment"]);
  keys(input.manifest, ["digest", "manifest"]); digestValue(input.manifest.digest);
  validateManifest(input.manifest.manifest as ManifestRecord["manifest"]);
  if (hash(input.manifest.manifest) !== input.manifest.digest) invalid("manifest digest mismatch");
  keys(input.run, ["runId", "projectId", "manifestDigest", "replicaId"]);
  for (const item of Object.values(input.run)) id(item); policyScope(`project:${input.run.projectId}`);
  if (input.run.manifestDigest !== input.manifest.digest) invalid("run manifest binding");
  integer(input.operationRevision, 1); deployment(input.deployment);
  const declared = input as unknown as ConventionalAttemptInput, manifest = declared.manifest.manifest, d = declared.deployment;
  if (manifest.adapter.kind !== "conventional_rl" || manifest.adapter.name !== "frozenlake-q-learning-v1") invalid("adapter identity");
  keys(manifest.adapter.config, ["spec"]);
  const request = prepareConventionalRequest(manifest.adapter.config.spec);
  if (request.replicates.length !== 1 || request.replicates[0]!.replicateId !== declared.run.replicaId) invalid("one matching training replica per registered run is required");
  equal(manifest.code, { revision: d.code.revision, dirtyPatchSha256: d.code.dirtyPatchSha256 }, "code declaration mismatch");
  equal(manifest.environment, { imageDigest: d.environment.imageDigest, dependenciesDigest: d.environment.dependenciesDigest }, "environment declaration mismatch");
  equal(manifest.data, { version: "FrozenLake-v1:4x4", splitsDigest: hash({ replicates: request.replicates, evaluation: request.evaluation }) }, "seed-split binding mismatch");
  equal(manifest.model, { version: "tabular-q-table/v1" }, "model identity mismatch");
  equal(manifest.reward, { version: "FrozenLake-goal1-hole0-frozen0/v1" }, "reward identity mismatch");
  equal(manifest.evaluator, { version: "frozenlake-greedy-eval/v1" }, "evaluator identity mismatch");
  equal(manifest.evaluationPolicy, { kind: "frozen-final-table-shared-random/v1", evaluation: request.evaluation }, "evaluation policy mismatch");
  equal(manifest.seeds, [...request.replicates.flatMap(replica => [replica.policySeed, ...replica.trainingEpisodeSeeds]),
    ...request.evaluation.episodeSeeds, ...request.evaluation.randomActionSeeds], "complete seed schedule mismatch");
  if (d.limits.runtimeMs + d.limits.startTimeoutMs + d.limits.stopTimeoutMs > manifest.resources.maxDurationSeconds * 1000) invalid("lifecycle exceeds manifest duration");
  const actionId = `action:${hash([declared.run.runId, "launch", declared.operationRevision])}`;
  const binding = { ...declared.run, actionId, backendKey: actionId, backend: CONVENTIONAL_SUPERVISED_BACKEND as typeof CONVENTIONAL_SUPERVISED_BACKEND,
    operation: "launch" as const, operationRevision: declared.operationRevision };
  const directoryName = `attempt-${actionId.slice("action:".length)}`, directory = posix.join(d.outputRoot, directoryName);
  const outputs = { root: d.outputRoot, directoryName, directory, intent: posix.join(directory, "intent.json"),
    result: posix.join(directory, "result.json"), receipt: posix.join(directory, "receipt.json") };
  // Ledger serialization sorts object keys. Canonical wire bytes keep a plan
  // identical before admission and after loading the registered manifest.
  const requestJson = encode(request), requestBytesSha256 = createHash("sha256").update(requestJson).digest("hex");
  const envelope = { schemaVersion: 1, kind: "conventional-supervised-envelope", binding,
    requestJson, requestBytesSha256, source: { runner: d.code.runner, entry: d.code.entry, requirements: d.code.requirements },
    output: { root: d.outputRoot, directoryName }, pins: CONVENTIONAL_PINS };
  const bytes = Buffer.from(encode(envelope));
  if (bytes.length > CONVENTIONAL_SUPERVISED_ENVELOPE_BYTES) invalid("supervised envelope exceeds 72,000 bytes");
  const envelopeSha256 = createHash("sha256").update(bytes).digest("hex"), serialized = bytes.toString("base64");
  const chunks = serialized.match(/.{1,8192}/g)!;
  const command: ServiceCommand = { executable: d.environment.pythonExecutable,
    args: ["-I", "-B", d.code.entry.path, "envelope-v1", envelopeSha256, ...chunks], cwd: d.outputRoot,
    environment: { OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1" } };
  const body = { schemaVersion: 1 as const, kind: "conventional-supervised-plan" as const,
    qualification: "trusted_deployment_required" as const, binding, declarations: declared, request, requestBytesSha256,
    envelopeSha256, profileDigest: hash(d.profile), command, limits: d.limits, outputs };
  return freeze({ ...body, digest: hash(body) });
}

/** Rebuild every derived field; a self-hashed replacement command is not accepted. */
export function verifyConventionalAttempt(raw: unknown): ConventionalAttemptPlan {
  const value = snapshot(raw);
  keys(value, ["schemaVersion", "kind", "digest", "qualification", "binding", "declarations", "request", "requestBytesSha256",
    "envelopeSha256", "profileDigest", "command", "limits", "outputs"]);
  const expected = prepareConventionalAttempt(value.declarations);
  equal(value, expected, "plan differs from its validated declarations");
  return expected;
}

async function observedFile(file: ConventionalSourceFile, signal: AbortSignal): Promise<JsonObject> {
  if (signal.aborted) throw new Error("deployment read aborted");
  if (await realpath(file.path) !== file.path) invalid("deployment file alias is unsupported");
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 128_000) invalid("deployment source must be one bounded regular file");
    const buffer = Buffer.alloc(128_001); let total = 0;
    while (total < buffer.length) { const read = await handle.read(buffer, total, buffer.length - total, total); if (!read.bytesRead) break; total += read.bytesRead; }
    const after = await handle.stat(), named = await lstat(file.path);
    if (signal.aborted || total > 128_000 || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || named.dev !== after.dev || named.ino !== after.ino
      || named.isSymbolicLink() || await realpath(file.path) !== file.path) invalid("deployment source changed during observation");
    const sha256 = createHash("sha256").update(buffer.subarray(0, total)).digest("hex");
    if (sha256 !== file.sha256) invalid("deployment source hash mismatch");
    return { path: file.path, sha256, bytes: total };
  } finally { await handle.close(); }
}

/** Read-only resolver. Existing uncertain work is recovered by the generic bridge,
 * which queries the original journal instead of invoking this resolver again. */
export function createConventionalLaunchResolver(options: ConventionalLaunchResolverOptions): ConventionalLaunchResolver {
  const ledger = options.ledger, d = freeze(snapshot(options.deployment)), authorizeDeployment = options.authorizeDeployment;
  deployment(d); if (typeof authorizeDeployment !== "function") invalid("trusted deployment authorization callback required");
  return async (rawClaim, signal) => {
    const claim = snapshot(rawClaim, true);
    if (signal.aborted || authorizeDeployment() !== true) return null;
    const action = ledger.getAction(claim.action.actionId), run = ledger.getRun(action.runId), manifest = ledger.getManifest(run.manifestDigest);
    if (run.lineage) invalid("resume lineage is unsupported");
    const { execution: _execution, evaluation: _evaluation, ...registration } = run;
    const plan = prepareConventionalAttempt({ manifest, run: registration, operationRevision: action.operationRevision, deployment: d });
    if (claim.workerId !== d.workerId || claim.action.actionId !== plan.binding.actionId || action.backend !== CONVENTIONAL_SUPERVISED_BACKEND
      || action.operation !== "launch" || action.cleanupTargetActionId !== null || action.attemptId !== claim.attemptId
      || action.manifestDigest !== plan.binding.manifestDigest || action.backendKey !== plan.binding.backendKey) invalid("dispatch identity mismatch");
    equal(action.payload, { attemptPlanDigest: plan.digest }, "admitted plan mismatch");
    for (const field of ["runId", "manifestDigest", "backend", "backendKey", "operation", "operationRevision", "payload", "payloadDigest", "attemptId"] as const) {
      equal(claim.action[field], action[field], "claim differs from persisted action");
    }
    const source = await Promise.all([d.code.runner, d.code.entry, d.code.requirements].map(file => observedFile(file, signal)));
    for (const path of [d.outputRoot, d.environment.pythonExecutable]) {
      if (await realpath(path) !== path) invalid("deployment path alias is unsupported");
      const metadata = await lstat(path);
      if (path === d.outputRoot ? !metadata.isDirectory() : !metadata.isFile() || !(metadata.mode & 0o111)) invalid("deployment path type is invalid");
    }
    if (signal.aborted || authorizeDeployment() !== true) return null;
    const declaration = createJobDeclaration({ actionId: action.actionId, backendKey: action.backendKey, manifestDigest: action.manifestDigest,
      planDigest: plan.digest, workerId: d.workerId, command: plan.command, limits: plan.limits, deadlineAt: claim.deadlineAt, host: d.host });
    return { declaration, authorizeDeployment,
      evidence: { kind: "conventional-deployment-observation", qualification: "operator_trust_required", deploymentId: d.deploymentId,
        profileDigest: plan.profileDigest, requestDigest: plan.request.requestDigest, requestBytesSha256: plan.requestBytesSha256,
        envelopeSha256: plan.envelopeSha256, source, outputDirectory: plan.outputs.directory,
        imageMeaning: "operator_declaration_not_oci_attestation", sourceMeaning: "bounded_current_byte_observations_not_immutability_proof",
        prerequisites: { ...d.trust }, pins: { ...CONVENTIONAL_PINS } } };
  };
}
