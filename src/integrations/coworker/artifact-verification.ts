import { posix, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encode, hash, keys, digestValue } from "../../ledger/validation.ts";
import { runProcess } from "../../workers/process.ts";
import type { ProcessRequest, ProcessResult } from "../../workers/process.ts";
import { prepareCoworkerAttempt } from "./attempt-plan.ts";
import type { CoworkerAttemptPlan } from "./attempt-plan.ts";

export const COWORKER_SOURCE_INVENTORY_ALGORITHM = "coworker-source-inventory-v1";
export interface ArtifactReadLimits {
  maxFiles: number; maxDirectories: number; maxDepth: number; maxFileBytes: number; maxTotalBytes: number;
}
export const ARTIFACT_READ_CAPS: Readonly<ArtifactReadLimits> = Object.freeze({
  maxFiles: 4096, maxDirectories: 2048, maxDepth: 32,
  maxFileBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024,
});
export type ArtifactReadProblem = "missing" | "unreadable" | "unsafe_path" | "limit_exceeded" | "changed_during_read"
  | "reader_unavailable" | "invalid_request" | "cancelled" | "timeout" | "invalid_reader_output";
export type SourceInventoryEntry = { path: string; kind: "directory"; executableBits: number }
  | { path: string; kind: "file"; executableBits: number; bytes: number; sha256: string };
type Frozen<T> = T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;
export type CoworkerSourceInventory = Frozen<{
  algorithm: typeof COWORKER_SOURCE_INVENTORY_ALGORITHM; rootExecutableBits: number;
  entries: SourceInventoryEntry[]; sha256: string;
}>;
export type SourceInventoryResult = { ok: true; inventory: CoworkerSourceInventory }
  | { ok: false; problem: ArtifactReadProblem };
export interface ArtifactVerificationOptions {
  limits?: Partial<ArtifactReadLimits>;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => Date;
  /** Trusted controller setting, never the Python executable declared by the trainer plan. */
  readerExecutable?: string;
  /** Trusted test seam; receipts from an injected executor are not native-reader qualification. */
  execute?: (request: ProcessRequest) => Promise<ProcessResult>;
}
type InputId = "experimentManifest" | "numericalQualificationReceipt" | "resumeCheckpoint" | "originRunEvidence";
interface InputRead { id: InputId; path: string; kind: "file"; bytes: number; sha256: string; executableBits: number }
interface ReadSuccess { ok: true; inventory: CoworkerSourceInventory; inputs: InputRead[] }
type ReadResult = ReadSuccess | { ok: false; problem: ArtifactReadProblem };
export interface ArtifactPendingCheck {
  check: "immutable_deployment" | "execution_time_freshness" | "source_revision_authenticity" | "image_contents"
    | "dependencies_contents" | "python_executable_identity" | "model_and_tokenizer_contents"
    | "native_preflight" | "initial_adapter_fingerprint" | "checkpoint_tensors_and_identity" | "resume_boundary";
  status: "pending"; reason: string;
}
export type CoworkerArtifactReceipt = Frozen<{
  schemaVersion: 1; kind: "coworker-artifact-byte-verification"; qualification: "byte_observation_only";
  launchSupported: false; digest: string;
  binding: { planDigest: string; actionId: string; manifestDigest: string };
  sourceInventoryAlgorithm: typeof COWORKER_SOURCE_INVENTORY_ALGORITHM;
  startedAt: string; completedAt: string; limits: ArtifactReadLimits;
  byteChecks: "matched" | "mismatched" | "unavailable";
  readProblem: ArtifactReadProblem | null;
  source: { expectedSha256: string; matched: boolean | null; inventory: CoworkerSourceInventory | null };
  inputs: { id: InputId; path: string; expectedSha256: string; observedSha256: string | null;
    bytes: number | null; matched: boolean | null }[];
  pending: ArtifactPendingCheck[];
}>;

const helper = fileURLToPath(new URL("./artifact-verification-reader.py", import.meta.url));
const readProblems: readonly ArtifactReadProblem[] = ["missing", "unreadable", "unsafe_path", "limit_exceeded",
  "changed_during_read", "reader_unavailable", "invalid_request"];
function invalid(message: string): never { throw new TypeError(`Invalid artifact verification: ${message}`); }
function freeze<T>(value: T): Frozen<T> {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value as Frozen<T>;
}
/** Inspect descriptors before copying so caller getters never run in the controller. */
function plainSnapshot(value: unknown, depth = 0, budget = { remaining: 30_000, bytes: 1024 * 1024 }): unknown {
  if (--budget.remaining < 0 || depth > 30) invalid("data exceeds structural bounds");
  budget.bytes -= typeof value === "string" ? Buffer.byteLength(value) + 2 : 2;
  if (budget.bytes < 0) invalid("data exceeds byte bounds");
  if (value === null || typeof value === "boolean" || typeof value === "string"
    || (typeof value === "number" && Number.isFinite(value))) return value;
  if (!value || typeof value !== "object" || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) invalid("expected plain JSON");
  if (Array.isArray(value) && value.length > 30_000) invalid("array exceeds structural bounds");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || Object.values(descriptors).some(item => !Object.hasOwn(item, "value"))) invalid("accessors or symbols are unsupported");
  if (Array.isArray(value)) {
    if (Object.keys(descriptors).length !== value.length + 1) invalid("arrays must be dense without extra properties");
    return Array.from({ length: value.length }, (_, index) => {
      if (!descriptors[index]) invalid("sparse arrays are unsupported");
      return plainSnapshot(descriptors[index]!.value, depth + 1, budget);
    });
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, property]) => {
    if (!property.enumerable) invalid("non-enumerable properties are unsupported");
    budget.bytes -= Buffer.byteLength(key) + 3;
    if (budget.bytes < 0) invalid("data exceeds byte bounds");
    return [key, plainSnapshot(property.value, depth + 1, budget)];
  }));
}
function absolute(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.startsWith("/") || value === "/" || value.endsWith("/")
    || Buffer.byteLength(value) > 2048 || posix.normalize(value) !== value || /[\\\x00-\x1f\x7f]/u.test(value)) invalid("root must be a canonical absolute path");
}
function relative(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 1024 || /[\\\x00-\x1f\x7f]/u.test(value)
    || value.split("/").some(part => !part || part === "." || part === ".." || Buffer.byteLength(part) > 255)) invalid("invalid relative path");
}
function integer(value: unknown, max: number, min = 0): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid("integer outside bounds");
}
function mode(value: unknown): asserts value is number {
  integer(value, 0o111); if ((value & 0o111) !== value) invalid("invalid executable bits");
}
function optionsSnapshot(options: ArtifactVerificationOptions) {
  const supplied = plainSnapshot(options.limits ?? {});
  keys(supplied, Object.keys(ARTIFACT_READ_CAPS), []);
  const limits = { ...ARTIFACT_READ_CAPS, ...supplied } as ArtifactReadLimits;
  for (const key of Object.keys(limits) as (keyof ArtifactReadLimits)[]) integer(limits[key], ARTIFACT_READ_CAPS[key], 1);
  const timeoutMs = options.timeoutMs ?? 30_000; integer(timeoutMs, 60_000, 1);
  const readerExecutable = options.readerExecutable ?? "python3";
  if (readerExecutable !== "python3") absolute(readerExecutable);
  return { limits, timeoutMs, readerExecutable, execute: options.execute ?? runProcess, signal: options.signal,
    now: options.now ?? (() => new Date()), path: process.env.PATH ?? "/usr/bin:/bin" };
}
type NormalizedOptions = ReturnType<typeof optionsSnapshot>;

function interpret(raw: string, expected: { id: InputId; path: string }[], limits: ArtifactReadLimits): ReadResult {
  try {
    const output: unknown = JSON.parse(raw);
    if (output && typeof output === "object" && "ok" in output && output.ok === false) {
      keys(output, ["ok", "problem"]);
      const problem = (output as Record<string, unknown>).problem;
      if (typeof problem !== "string" || !readProblems.includes(problem as ArtifactReadProblem)) invalid("unknown reader problem");
      return { ok: false, problem: problem as ArtifactReadProblem };
    }
    keys(output, ["ok", "entries", "inputs", "sourceRootExecutableBits"]);
    if (output.ok !== true || !Array.isArray(output.entries) || !Array.isArray(output.inputs)) invalid("reader protocol");
    mode(output.sourceRootExecutableBits);
    if (output.entries.length > limits.maxFiles + limits.maxDirectories || output.inputs.length !== expected.length) invalid("reader result count");
    let bytes = 0, files = 0, directories = 1;
    const seen = new Map<string, string>();
    let previous: string | null = null;
    for (const entry of output.entries) {
      if (entry?.kind === "directory") { keys(entry, ["path", "kind", "executableBits"]); directories++; }
      else {
        keys(entry, ["path", "kind", "executableBits", "bytes", "sha256"]);
        if (entry.kind !== "file") invalid("unknown entry kind");
        integer(entry.bytes, limits.maxFileBytes); digestValue(entry.sha256); bytes += entry.bytes; files++;
      }
      relative(entry.path); mode(entry.executableBits);
      if (previous !== null && Buffer.compare(Buffer.from(previous), Buffer.from(entry.path)) >= 0) invalid("unordered or duplicate source paths");
      const parent = posix.dirname(entry.path);
      if (parent !== "." && seen.get(parent) !== "directory") invalid("missing directory entry");
      if (entry.path.split("/").length > limits.maxDepth + (entry.kind === "file" ? 1 : 0)) invalid("depth limit");
      seen.set(entry.path, entry.kind); previous = entry.path;
    }
    for (let index = 0; index < output.inputs.length; index++) {
      const entry = output.inputs[index]; keys(entry, ["id", "path", "kind", "bytes", "sha256", "executableBits"]);
      if (entry.id !== expected[index]!.id || entry.path !== expected[index]!.path || entry.kind !== "file") invalid("input binding");
      relative(entry.path);
      if (entry.path.split("/").length - 1 > limits.maxDepth) invalid("input depth limit");
      integer(entry.bytes, limits.maxFileBytes); digestValue(entry.sha256); mode(entry.executableBits); bytes += entry.bytes; files++;
    }
    if (bytes > limits.maxTotalBytes || files > limits.maxFiles || directories > limits.maxDirectories) invalid("aggregate reader bounds");
    const body = { algorithm: COWORKER_SOURCE_INVENTORY_ALGORITHM as typeof COWORKER_SOURCE_INVENTORY_ALGORITHM, rootExecutableBits: output.sourceRootExecutableBits,
      entries: output.entries as SourceInventoryEntry[] };
    return { ok: true, inventory: freeze({ ...body, sha256: hash(body) }), inputs: output.inputs as InputRead[] };
  } catch { return { ok: false, problem: "invalid_reader_output" }; }
}

async function read(sourceRoot: string, inputRoot: string | null, inputs: { id: InputId; path: string }[], options: NormalizedOptions): Promise<ReadResult> {
  if (options.signal?.aborted) return { ok: false, problem: "cancelled" };
  let result: ProcessResult;
  try {
    result = await options.execute({ executable: options.readerExecutable, args: ["-I", "-S", helper], cwd: dirname(helper),
      env: { PATH: options.path }, input: JSON.stringify({ sourceRoot, inputRoot, inputs, limits: options.limits }),
      timeoutMs: options.timeoutMs, maxOutputBytes: 2 * 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}) });
  } catch { return { ok: false, problem: "reader_unavailable" }; }
  if (result.stopped !== null) return { ok: false, problem: result.stopped === "cancelled" ? "cancelled"
    : result.stopped === "timeout" ? "timeout" : result.stopped === "output_limit" ? "limit_exceeded" : "reader_unavailable" };
  if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > 2 * 1024 * 1024) return { ok: false, problem: "reader_unavailable" };
  return interpret(result.stdout, inputs, options.limits);
}

/** Whole staged tree, no implicit exclusions. This does not authenticate a Git revision. */
export async function inventoryCoworkerSource(root: string, options: ArtifactVerificationOptions = {}): Promise<SourceInventoryResult> {
  absolute(root); const normalized = optionsSnapshot(options);
  const result = await read(root, null, [], normalized);
  return freeze(result.ok ? { ok: true as const, inventory: result.inventory } : result);
}

/** Reconstruct exact preview before any I/O; changed commands or digests cannot borrow its receipt. */
export async function verifyCoworkerArtifacts(rawPlan: CoworkerAttemptPlan,
  request: { sourceInventoryAlgorithm: typeof COWORKER_SOURCE_INVENTORY_ALGORITHM },
  options: ArtifactVerificationOptions = {}): Promise<CoworkerArtifactReceipt> {
  const supplied = plainSnapshot(rawPlan);
  const suppliedEncoded = encode(supplied);
  if (Buffer.byteLength(suppliedEncoded) > 1024 * 1024) invalid("preview exceeds 1 MiB");
  keys(supplied, ["schemaVersion", "kind", "qualification", "launchSupported", "binding", "declarations", "command", "digest"]);
  const plan = prepareCoworkerAttempt(supplied.declarations);
  if (suppliedEncoded !== encode(plan)) invalid("preview differs from its reconstructed declaration");
  const requestCopy = plainSnapshot(request); keys(requestCopy, ["sourceInventoryAlgorithm"]);
  if (requestCopy.sourceInventoryAlgorithm !== COWORKER_SOURCE_INVENTORY_ALGORITHM) invalid("an explicit supported source inventory algorithm is required");
  const normalized = optionsSnapshot(options);
  const startedAt = normalized.now().toISOString();
  const config = plan.declarations.configuration;
  const references: { id: InputId; path: string; expectedSha256: string }[] = [
    { id: "experimentManifest", path: config.inputs.experimentManifest.relativePath, expectedSha256: config.inputs.experimentManifest.sha256 },
    { id: "numericalQualificationReceipt", path: config.inputs.numericalQualificationReceipt.relativePath, expectedSha256: config.inputs.numericalQualificationReceipt.sha256 },
  ];
  if (config.inputs.resume) references.push(
    { id: "resumeCheckpoint", path: config.inputs.resume.checkpoint.relativePath, expectedSha256: config.inputs.resume.checkpoint.sha256 },
    { id: "originRunEvidence", path: config.inputs.resume.originRunEvidence.relativePath, expectedSha256: config.inputs.resume.originRunEvidence.sha256 });
  const result = await read(config.source.root, config.paths.inputRoot, references.map(({ id, path }) => ({ id, path })), normalized);
  const completedAt = normalized.now().toISOString();
  const inputs = references.map((ref, index) => {
    const found = result.ok ? result.inputs[index]! : null;
    return { ...ref, observedSha256: found?.sha256 ?? null, bytes: found?.bytes ?? null,
      matched: found ? found.sha256 === ref.expectedSha256 : null };
  });
  const source = { expectedSha256: config.source.treeSha256,
    matched: result.ok ? result.inventory.sha256 === config.source.treeSha256 : null,
    inventory: result.ok ? result.inventory : null };
  const pending: ArtifactPendingCheck[] = [
    { check: "immutable_deployment", status: "pending", reason: "Reads do not freeze paths, prevent later writes, or attest read-only deployment enforcement." },
    { check: "execution_time_freshness", status: "pending", reason: "No descriptor or byte-to-execution binding persists after this observation." },
    { check: "source_revision_authenticity", status: "pending", reason: "A matching inventory does not establish that these bytes belong to the declared Git revision." },
    { check: "image_contents", status: "pending", reason: "The declared image digest was not resolved or inspected." },
    { check: "dependencies_contents", status: "pending", reason: "The declared dependencies digest was not resolved or inspected." },
    { check: "python_executable_identity", status: "pending", reason: "The trainer interpreter was neither opened nor executed." },
    { check: "model_and_tokenizer_contents", status: "pending", reason: "The model and tokenizer contents were not inspected." },
    { check: "native_preflight", status: "pending", reason: "Hash equality does not validate task, evaluator, numerical receipt or native trainer semantics." },
  ];
  if (config.inputs.initialAdapter) pending.push({ check: "initial_adapter_fingerprint", status: "pending",
    reason: "The native tensor fingerprint is not a directory inventory hash; adapter tensors were not inspected." });
  if (config.inputs.resume) pending.push(
    { check: "checkpoint_tensors_and_identity", status: "pending", reason: "Only checkpoint.json bytes were hashed; tensor inventory, optimizer state and native identity were not verified." },
    { check: "resume_boundary", status: "pending", reason: "Origin evidence byte equality does not validate lineage, reserved steps or later artifacts." });
  const body = { schemaVersion: 1 as const, kind: "coworker-artifact-byte-verification" as const, qualification: "byte_observation_only" as const,
    launchSupported: false as const, binding: { planDigest: plan.digest, actionId: plan.binding.actionId, manifestDigest: plan.binding.manifestDigest },
    sourceInventoryAlgorithm: COWORKER_SOURCE_INVENTORY_ALGORITHM as typeof COWORKER_SOURCE_INVENTORY_ALGORITHM, startedAt, completedAt, limits: normalized.limits,
    byteChecks: !result.ok ? "unavailable" as const : source.matched && inputs.every(item => item.matched) ? "matched" as const : "mismatched" as const,
    readProblem: result.ok ? null : result.problem, source, inputs, pending };
  return freeze({ ...body, digest: hash(body) });
}
