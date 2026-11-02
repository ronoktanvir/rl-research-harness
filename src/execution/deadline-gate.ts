import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServiceCommand, ServiceLaunchRequest } from "./types.ts";

/** Trusted deployment configuration. The interpreter and script must be immutable
 * to the trainer and visible in the service's read-only filesystem namespace. */
export interface DeadlineGateConfig {
  pythonExecutable: string;
  scriptPath: string;
  safetyMarginMs: number;
  barrierTimeoutMs: number;
}
/** Sample boot time first, then UTC. Flooring boot time is conservative: elapsed
 * time projected from this anchor can be too long, never too short from rounding. */
export interface DispatchClockAnchor { bootId: string; utcMs: number; bootTimeMs: number }
export const PACKAGED_DEADLINE_GATE_PATH = fileURLToPath(new URL("./deadline-gate.py", import.meta.url));
const MAX_BYTES = 128_000;

function invalid(message: string): never { throw new TypeError(`Invalid deadline gate input: ${message}`); }
function copy<T>(input: T): T {
  let count = 0;
  function visit(value: unknown, depth: number): unknown {
    if (++count > 20_000 || depth > 12) invalid("structural bound exceeded");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype)) invalid("expected inert JSON");
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length || Object.values(fields).some(field => !Object.hasOwn(field, "value"))) invalid("accessors and symbols are unsupported");
    if (Array.isArray(value)) {
      if (value.length > 20_000 || Object.keys(fields).length !== value.length + 1) invalid("expected dense array");
      return Array.from({ length: value.length }, (_, index) => {
        const field = fields[index]; if (!field?.enumerable) invalid("expected dense array");
        return visit(field.value, depth + 1);
      });
    }
    return Object.fromEntries(Object.entries(fields).map(([key, field]) => {
      if (!field.enumerable) invalid("non-enumerable field");
      return [key, visit(field.value, depth + 1)];
    }));
  }
  const result = visit(input, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) invalid("request exceeds 128 KB");
  return result as T;
}
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid("expected object");
}
function fields(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  object(value);
  if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) invalid("unexpected or missing fields");
}
function integer(value: unknown, min: number, max: number): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid("integer outside bound");
}
function literal(value: unknown, bytes: number): asserts value is string {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > bytes || Buffer.from(value).toString("utf8") !== value) invalid("invalid UTF-8 argument");
}
function path(value: unknown): asserts value is string {
  literal(value, 2048);
  if (!/^\/[A-Za-z0-9_./-]+$/u.test(value) || posix.normalize(value) !== value || value.endsWith("/")) invalid("expected canonical absolute path");
}
function bootId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value) || /^0+$/u.test(value.replaceAll("-", ""))) invalid("boot identity");
}
function validateConfig(value: unknown): asserts value is DeadlineGateConfig {
  fields(value, ["pythonExecutable", "scriptPath", "safetyMarginMs", "barrierTimeoutMs"]);
  path(value.pythonExecutable); path(value.scriptPath);
  integer(value.safetyMarginMs, 1, 300_000); integer(value.barrierTimeoutMs, 1, 300_000);
}

/** Builds the required Type=notify gate command. This does not authorize a job,
 * validate trainer bytes, verify deployment paths, or start any process. */
export function buildDeadlineGateCommand(raw: ServiceLaunchRequest, rawConfig: DeadlineGateConfig, rawAnchor: DispatchClockAnchor): ServiceCommand {
  const request = copy(raw), config = copy(rawConfig), anchor = copy(rawAnchor);
  validateConfig(config);
  fields(anchor, ["bootId", "utcMs", "bootTimeMs"]); bootId(anchor.bootId);
  integer(anchor.utcMs, 0, 253_402_300_799_999); integer(anchor.bootTimeMs, 0, Number.MAX_SAFE_INTEGER);
  fields(request, ["identity", "expectedHost", "command", "limits", "deadlineAt"]);
  fields(request.identity, ["unitName", "description"]);
  if (typeof request.identity.unitName !== "string" || !/^rlh-[a-f0-9]{64}\.service$/u.test(request.identity.unitName)
    || typeof request.identity.description !== "string" || !/^rlh-v1:[a-f0-9]{64}$/u.test(request.identity.description)) invalid("unit identity");
  fields(request.expectedHost, ["machineId", "bootId"]); bootId(request.expectedHost.bootId);
  if (typeof request.expectedHost.machineId !== "string" || !/^[a-f0-9]{32}$/u.test(request.expectedHost.machineId)
    || /^0+$/u.test(request.expectedHost.machineId)) invalid("machine identity");
  if (anchor.bootId !== request.expectedHost.bootId) invalid("anchor belongs to another boot");
  fields(request.command, ["executable", "args", "cwd", "environment"]);
  path(request.command.executable); path(request.command.cwd);
  if (!Array.isArray(request.command.args) || request.command.args.length > 512) invalid("argument count");
  for (const arg of request.command.args) literal(arg, 16_384);
  object(request.command.environment);
  if (Object.keys(request.command.environment).length > 128) invalid("environment count");
  for (const [key, value] of Object.entries(request.command.environment)) {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(key) || key === "NOTIFY_SOCKET") invalid("environment key");
    literal(value, 8192);
  }
  fields(request.limits, ["runtimeMs", "startTimeoutMs", "stopTimeoutMs", "memoryMaxBytes", "tasksMax"]);
  const limits = request.limits;
  integer(limits.runtimeMs, 1, 31_536_000_000); integer(limits.startTimeoutMs, 1, 300_000);
  integer(limits.stopTimeoutMs, 1, 300_000); integer(limits.memoryMaxBytes, 1, Number.MAX_SAFE_INTEGER); integer(limits.tasksMax, 1, 1_000_000);
  if (config.barrierTimeoutMs > limits.startTimeoutMs) invalid("barrier timeout exceeds activation timeout");
  if (typeof request.deadlineAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(request.deadlineAt)
    || !Number.isFinite(Date.parse(request.deadlineAt)) || Date.parse(request.deadlineAt) < 0
    || new Date(request.deadlineAt).toISOString() !== request.deadlineAt) invalid("deadline must be canonical UTC");
  const environment = JSON.stringify(request.command.environment);
  if (Buffer.byteLength(environment) > 64_000) invalid("trainer environment exceeds 64 KB");
  const args = ["-I", "-S", config.scriptPath, "notify-v1", request.deadlineAt, String(limits.runtimeMs), String(limits.stopTimeoutMs),
    String(config.safetyMarginMs), String(config.barrierTimeoutMs), String(anchor.utcMs), String(anchor.bootTimeMs), anchor.bootId,
    environment, "--", request.command.executable, ...request.command.args];
  if (args.reduce((total, value) => total + Buffer.byteLength(value) + 1, 0) > MAX_BYTES) invalid("gate arguments exceed 128 KB");
  // Even Python's isolated mode cannot neutralize its native dynamic loader.
  // Trainer loader variables belong only to the final execve, never the gate.
  return { executable: config.pythonExecutable, args, cwd: request.command.cwd, environment: {} };
}

async function kernelText(pathname: string, maximum: number): Promise<string> {
  const file = await open(pathname, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) invalid("clock source is not a regular kernel file");
    const buffer = Buffer.alloc(maximum + 1), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maximum) invalid("clock source exceeds bound");
    return buffer.subarray(0, bytesRead).toString("ascii").trim();
  } finally { await file.close(); }
}

/** Native Linux clock sample; no executable, shell, network or user file is read.
 * /proc/uptime includes suspend. Systemd's later runtime timer does not. */
export async function readTrustedDispatchClock(expectedBootId: string): Promise<DispatchClockAnchor> {
  bootId(expectedBootId);
  if (process.platform !== "linux") throw new Error("Dispatch clock anchor requires Linux");
  const before = await kernelText("/proc/sys/kernel/random/boot_id", 64);
  if (before !== expectedBootId) invalid("boot changed before clock sampling");
  const uptime = await kernelText("/proc/uptime", 128);
  const utcMs = Date.now(); // Must follow the boot-time sample, not precede it.
  const after = await kernelText("/proc/sys/kernel/random/boot_id", 64);
  if (after !== before) invalid("boot changed during clock sampling");
  const match = /^([0-9]+)\.([0-9]{2}) [0-9]+\.[0-9]{2}$/u.exec(uptime);
  if (!match) invalid("unexpected kernel uptime format");
  const bootTimeMs = Number(BigInt(match[1]!) * 1000n + BigInt(match[2]!) * 10n);
  integer(bootTimeMs, 0, Number.MAX_SAFE_INTEGER); integer(utcMs, 0, 253_402_300_799_999);
  return { bootId: before, utcMs, bootTimeMs };
}
