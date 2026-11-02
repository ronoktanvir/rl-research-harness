import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { posix } from "node:path";
import { encode, keys } from "../ledger/validation.ts";
import { runProcess } from "../workers/process.ts";
import type { ProcessRequest, ProcessResult } from "../workers/process.ts";
import type { HostIdentity, ServiceLaunchRequest, ServiceLimits, ServiceQueryRequest, ServiceQueryResult,
  ServiceSnapshot, ServiceStartResult, ServiceStopResult, SystemdProfile, SystemdTransport, UnitIdentity } from "./types.ts";

export interface SystemdTransportOptions {
  profile: SystemdProfile;
  execute?: typeof runProcess;
  hostIdentity?: () => Promise<HostIdentity>;
  readCgroupPopulated?: (controlGroup: string) => Promise<boolean | null>;
  now?: () => Date;
}

const RUN = "/usr/bin/systemd-run", CTL = "/usr/bin/systemctl", ENV = "/usr/bin/env", SUDO = "/usr/bin/sudo";
const OUTPUT_LIMIT = 32_768;
const QUERY_MS = 10_000;
const PROPERTIES = ["Id", "Description", "InvocationID", "LoadState", "ActiveState", "SubState", "Result", "MainPID", "ExecMainCode", "ExecMainStatus", "ControlGroup"];
const ENVIRONMENT = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C", SYSTEMD_PAGER: "cat", SYSTEMD_COLORS: "0" };

function invalid(message: string): never { throw new TypeError(`Invalid systemd transport input: ${message}`); }
function plainCopy<T>(value: T): T {
  let nodes = 0;
  function copy(input: unknown, depth: number): unknown {
    if (++nodes > 20_000 || depth > 24) invalid("input exceeds structural bounds");
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== (Array.isArray(input) ? Array.prototype : Object.prototype)) invalid("input must be inert JSON data");
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Object.getOwnPropertySymbols(input).length || Object.values(descriptors).some(field => !Object.hasOwn(field, "value"))) invalid("input cannot contain accessors or symbols");
    if (Array.isArray(input)) {
      if (input.length > 20_000 || Object.keys(descriptors).length !== input.length + 1) invalid("arrays must be dense");
      return Array.from({ length: input.length }, (_, index) => {
        const field = descriptors[index]; if (!field?.enumerable) invalid("arrays must be dense");
        return copy(field.value, depth + 1);
      });
    }
    return Object.fromEntries(Object.entries(descriptors).map(([key, field]) => {
      if (!field.enumerable) invalid("input fields must be enumerable");
      return [key, copy(field.value, depth + 1)];
    }));
  }
  const result = copy(value, 0);
  if (Buffer.byteLength(encode(result)) > 128_000) invalid("request exceeds 128 KB");
  return result as T;
}
function bounded(value: unknown, maximum: number, label: string, empty = false): asserts value is string {
  if (typeof value !== "string" || (!empty && !value.length) || value.includes("\0") || Buffer.byteLength(value) > maximum || Buffer.from(value).toString("utf8") !== value) invalid(label);
}
function integer(value: unknown, minimum: number, maximum: number, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(label);
}
function path(value: unknown): asserts value is string {
  // Paths enter systemd's property syntax. This first transport rejects quoting,
  // specifier and list syntax instead of pretending shell escaping handles it.
  if (typeof value !== "string" || value === "/" || value.length > 2048 || !/^\/[A-Za-z0-9_./-]+$/u.test(value) || posix.normalize(value) !== value || value.endsWith("/")) invalid("expected a canonical absolute path without property syntax");
}
function contains(root: string, value: string): boolean { return root === value || value.startsWith(`${root}/`); }
function identity(value: unknown): asserts value is UnitIdentity {
  keys(value, ["unitName", "description"]);
  if (typeof value.unitName !== "string" || !/^rlh-[a-f0-9]{64}\.service$/u.test(value.unitName)) invalid("unit identity");
  bounded(value.description, 512, "unit description");
  if (!/^rlh-v1:[a-f0-9]{64}$/u.test(value.description)) invalid("description must bind the complete declaration SHA-256");
}
function host(value: unknown): asserts value is HostIdentity {
  keys(value, ["machineId", "bootId"]);
  if (typeof value.machineId !== "string" || !/^[a-f0-9]{32}$/u.test(value.machineId) || /^0+$/u.test(value.machineId)) invalid("machine ID");
  if (typeof value.bootId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value.bootId) || /^0+$/u.test(value.bootId.replaceAll("-", ""))) invalid("boot ID");
}
function sameHost(a: HostIdentity, b: HostIdentity): boolean { return a.machineId === b.machineId && a.bootId === b.bootId; }
function limits(value: unknown): asserts value is ServiceLimits {
  keys(value, ["runtimeMs", "startTimeoutMs", "stopTimeoutMs", "memoryMaxBytes", "tasksMax"]);
  integer(value.runtimeMs, 1, 31_536_000_000, "runtime limit");
  integer(value.startTimeoutMs, 1, 300_000, "start limit"); integer(value.stopTimeoutMs, 1, 300_000, "stop limit");
  integer(value.memoryMaxBytes, 1, Number.MAX_SAFE_INTEGER, "memory limit"); integer(value.tasksMax, 1, 1_000_000, "task limit");
}
function strings(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.length || value.length > 64 || new Set(value).size !== value.length || value.some(item => typeof item !== "string")) invalid(label);
}
function validateProfile(value: unknown): asserts value is SystemdProfile {
  keys(value, ["userId", "groupId", "executables", "readOnlyPaths", "writableRoot", "allowedEnvironment", "maxima", "useSudo"]);
  integer(value.userId, 1, 0xffff_fffe, "trainer UID must be non-root"); integer(value.groupId, 1, 0xffff_fffe, "trainer GID must be non-root");
  strings(value.executables, "executable allowlist"); strings(value.readOnlyPaths, "read-only roots");
  for (const executable of value.executables) path(executable);
  for (const root of value.readOnlyPaths) path(root);
  path(value.writableRoot);
  for (const declared of [value.writableRoot, ...value.readOnlyPaths, ...value.executables]) {
    if (["/home", "/root", "/run/systemd", "/run/dbus", "/run/containerd"].some(root => contains(root, declared))) invalid("declared path is hidden by the fixed service protections");
  }
  for (const root of [...value.readOnlyPaths, ...value.executables]) if (contains(value.writableRoot, root) || contains(root, value.writableRoot)) invalid("writable root overlaps executable/read-only roots");
  if (!Array.isArray(value.allowedEnvironment) || value.allowedEnvironment.length > 64 || new Set(value.allowedEnvironment).size !== value.allowedEnvironment.length || value.allowedEnvironment.some(item => typeof item !== "string" || !/^[A-Z_][A-Z0-9_]*$/u.test(item))) invalid("environment allowlist");
  limits(value.maxima); if (typeof value.useSudo !== "boolean") invalid("sudo policy");
}
function validateQuery(value: unknown): asserts value is ServiceQueryRequest {
  keys(value, ["identity", "expectedHost", "expectedInvocationId"], ["identity", "expectedHost"]);
  identity(value.identity); host(value.expectedHost);
  if (value.expectedInvocationId !== undefined && (typeof value.expectedInvocationId !== "string" || !/^[a-f0-9]{32}$/u.test(value.expectedInvocationId) || /^0+$/u.test(value.expectedInvocationId))) invalid("invocation identity");
}
function validateLaunch(value: unknown, profile: SystemdProfile): asserts value is ServiceLaunchRequest {
  keys(value, ["identity", "expectedHost", "command", "limits", "deadlineAt"]); identity(value.identity); host(value.expectedHost); limits(value.limits);
  keys(value.command, ["executable", "args", "cwd", "environment"]); path(value.command.executable); path(value.command.cwd);
  if (!profile.executables.includes(value.command.executable)) invalid("executable is not allowed");
  const cwd = value.command.cwd;
  if (![profile.writableRoot, ...profile.readOnlyPaths].some(root => contains(root, cwd))) invalid("working directory is outside allowed roots");
  if (!Array.isArray(value.command.args) || value.command.args.length > 512) invalid("argument list");
  for (const arg of value.command.args) bounded(arg, 16_384, "argument", true);
  if (!value.command.environment || typeof value.command.environment !== "object" || Array.isArray(value.command.environment)) invalid("environment object");
  for (const [name, val] of Object.entries(value.command.environment)) {
    if (!profile.allowedEnvironment.includes(name)) invalid(`environment variable ${name} is not allowed`);
    bounded(val, 8192, "environment value", true);
  }
  for (const name of Object.keys(profile.maxima) as Array<keyof ServiceLimits>) if (value.limits[name] > profile.maxima[name]) invalid(`${name} exceeds trusted profile`);
  if (typeof value.deadlineAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value.deadlineAt) || !Number.isFinite(Date.parse(value.deadlineAt))) invalid("deadline must be canonical UTC");
}

async function boundedFile(filename: string, maximum = 4096): Promise<string> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat(); if (!stat.isFile()) throw new Error("Expected regular kernel/host file");
    const buffer = Buffer.alloc(maximum + 1), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maximum) throw new Error("Kernel/host file exceeds bound");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await file.close(); }
}
async function nativeHost(): Promise<HostIdentity> {
  const [machineId, bootId] = await Promise.all([boundedFile("/etc/machine-id", 64), boundedFile("/proc/sys/kernel/random/boot_id", 64)]);
  const value = { machineId: machineId.trim(), bootId: bootId.trim() }; host(value); return value;
}
async function nativeCgroup(controlGroup: string): Promise<boolean | null> {
  // This path is kernel-owned; no training cgroup delegation is enabled.
  if (!/^\/system\.slice\/rlh-[a-f0-9]{64}\.service$/u.test(controlGroup)) return null;
  try {
    const text = await boundedFile(`/sys/fs/cgroup${controlGroup}/cgroup.events`);
    const values = text.trim().split("\n").filter(line => line.startsWith("populated "));
    if (values.length !== 1 || !/^populated [01]$/u.test(values[0]!)) return null;
    return values[0] === "populated 1";
  } catch { return null; } // Removed/unreadable cgroup is not proof of completed cleanup.
}
function properties(stdout: string): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const at = line.indexOf("="), name = line.slice(0, at), value = line.slice(at + 1);
    if (at < 1 || !PROPERTIES.includes(name) || Object.hasOwn(result, name) || /[\x00-\x1f\x7f]/u.test(value)) return null;
    result[name] = value;
  }
  return result;
}
function processResult(raw: unknown): ProcessResult | null {
  try {
    const value = plainCopy(raw); keys(value, ["exitCode", "stdout", "stderr", "stopped"]);
    if (value.exitCode !== null) integer(value.exitCode, 0, 255, "process exit code");
    bounded(value.stdout, OUTPUT_LIMIT, "process stdout", true); bounded(value.stderr, OUTPUT_LIMIT, "process stderr", true);
    if (Buffer.byteLength(value.stdout) + Buffer.byteLength(value.stderr) > OUTPUT_LIMIT || ![null, "timeout", "cancelled", "output_limit", "spawn_error"].includes(value.stopped as null)) return null;
    return value as unknown as ProcessResult;
  } catch { return null; }
}

/** Requires systemd >=254 and cgroup v2. Never retries or resets a unit.
 * Official command semantics: https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html
 * This is a transport, not authority, artifact verification or an absolute-deadline exec gate.
 */
export function createSystemdTransport(options: SystemdTransportOptions): SystemdTransport {
  const profile = plainCopy(options.profile); validateProfile(profile);
  const execute = options.execute ?? runProcess, hostReader = options.hostIdentity ?? nativeHost;
  const cgroupReader = options.readCgroupPopulated ?? nativeCgroup, now = options.now ?? (() => new Date());
  if (!options.execute && process.platform !== "linux") throw new Error("The native systemd transport requires Linux");
  const observedAt = () => now().toISOString();
  async function currentHost(): Promise<HostIdentity> { const value = plainCopy(await hostReader()); host(value); return value; }
  async function call(executable: string, args: string[], timeoutMs: number, signal: AbortSignal): Promise<ProcessResult | null> {
    if (signal.aborted) return { exitCode: null, stdout: "", stderr: "", stopped: "cancelled" };
    const request: ProcessRequest = { executable: profile.useSudo ? SUDO : executable,
      args: profile.useSudo ? ["-n", "--", executable, ...args] : args, cwd: "/", env: { ...ENVIRONMENT }, input: "",
      timeoutMs, maxOutputBytes: OUTPUT_LIMIT, signal };
    try { return processResult(await execute(request)); } catch { return null; }
  }
  async function query(raw: ServiceQueryRequest, signal: AbortSignal): Promise<ServiceQueryResult> {
    const request = plainCopy(raw); validateQuery(request);
    try {
      if (signal.aborted) return { kind: "unknown", reason: "cancelled" };
      const before = await currentHost(); if (!sameHost(before, request.expectedHost)) return { kind: "unknown", reason: "host_identity_changed" };
      const result = await call(CTL, ["--system", "--no-pager", "--no-ask-password", "show", "--all", `--property=${PROPERTIES.join(",")}`, "--", request.identity.unitName], QUERY_MS, signal);
      if (!result || result.stopped || result.exitCode === null) return { kind: "unknown", reason: "query_incomplete" };
      const values = properties(result.stdout);
      if (!values || values.Id !== request.identity.unitName) return { kind: "unknown", reason: "unit_snapshot_invalid" };
      if (values.LoadState === "not-found") {
        const after = await currentHost();
        return sameHost(before, after) ? { kind: "absent", host: after, observedAt: observedAt() } : { kind: "unknown", reason: "host_identity_changed" };
      }
      if (result.exitCode !== 0 || PROPERTIES.some(name => !Object.hasOwn(values, name)) || values.Description !== request.identity.description || values.LoadState !== "loaded"
        || !/^[a-f0-9]{32}$/u.test(values.InvocationID!) || /^0+$/u.test(values.InvocationID!)
        || (request.expectedInvocationId !== undefined && values.InvocationID !== request.expectedInvocationId)) return { kind: "unknown", reason: "unit_identity_mismatch" };
      if (!["active", "inactive", "failed", "activating", "deactivating", "reloading", "maintenance", "refreshing"].includes(values.ActiveState!)
        || !/^[a-z][a-z-]{0,63}$/u.test(values.SubState!) || !/^[a-z][a-z-]{0,63}$/u.test(values.Result!)) return { kind: "unknown", reason: "unit_state_invalid" };
      const number = (name: string, maximum: number): number => { const text = values[name]!; if (!/^(0|[1-9][0-9]*)$/u.test(text)) invalid("snapshot number"); const value = Number(text); integer(value, 0, maximum, "snapshot number"); return value; };
      const controlGroup = values.ControlGroup!;
      if (controlGroup !== "" && controlGroup !== `/system.slice/${request.identity.unitName}`) return { kind: "unknown", reason: "unit_cgroup_mismatch" };
      let populated: boolean | null = null;
      if (controlGroup) { try { const value = await cgroupReader(controlGroup); if (typeof value === "boolean") populated = value; } catch { /* Unreadable remains unestablished. */ } }
      const after = await currentHost(); if (!sameHost(before, after)) return { kind: "unknown", reason: "host_identity_changed" };
      const snapshot: ServiceSnapshot = { identity: request.identity, host: after, observedAt: observedAt(), invocationId: values.InvocationID!, loadState: values.LoadState!,
        activeState: values.ActiveState!, subState: values.SubState!, result: values.Result!, mainPid: number("MainPID", 0xffff_ffff),
        execMainCode: number("ExecMainCode", 6), execMainStatus: number("ExecMainStatus", 255), controlGroup, cgroupPopulated: populated };
      return { kind: "present", snapshot };
    } catch { return { kind: "unknown", reason: "query_failed" }; }
  }
  async function start(raw: ServiceLaunchRequest, signal: AbortSignal, authorize: () => boolean): Promise<ServiceStartResult> {
    const request = plainCopy(raw); validateLaunch(request, profile);
    try {
      const before = await currentHost(); if (!sameHost(before, request.expectedHost)) return { kind: "unknown", reason: "host_identity_changed" };
      const l = request.limits, remaining = Date.parse(request.deadlineAt) - now().getTime();
      if (!Number.isFinite(remaining) || remaining < l.runtimeMs + l.startTimeoutMs + l.stopTimeoutMs) return { kind: "unknown", reason: "insufficient_deadline_budget" };
      const args = ["--system", "--no-ask-password", "--quiet", `--unit=${request.identity.unitName}`, `--description=${request.identity.description}`, "--expand-environment=no", "--remain-after-exit",
        "--property=Type=exec", "--property=ExitType=cgroup", "--property=Restart=no", `--uid=${profile.userId}`, `--gid=${profile.groupId}`,
        `--working-directory=${request.command.cwd}`, `--property=RuntimeMaxSec=${l.runtimeMs}ms`, `--property=TimeoutStartSec=${l.startTimeoutMs}ms`,
        `--property=JobTimeoutSec=${l.startTimeoutMs}ms`, `--property=TimeoutStopSec=${l.stopTimeoutMs}ms`, "--property=TimeoutStopFailureMode=kill",
        "--property=KillMode=control-group", "--property=KillSignal=SIGTERM", "--property=FinalKillSignal=SIGKILL", "--property=SendSIGKILL=yes", "--property=Delegate=no",
        `--property=MemoryMax=${l.memoryMaxBytes}`, `--property=TasksMax=${l.tasksMax}`, "--property=TasksAccounting=yes", "--property=NoNewPrivileges=yes",
        "--property=ProtectSystem=strict", "--property=ProtectHome=yes", "--property=ProtectControlGroups=yes", "--property=ProtectKernelTunables=yes", "--property=ProtectKernelModules=yes",
        "--property=RestrictSUIDSGID=yes", "--property=CapabilityBoundingSet=", "--property=SupplementaryGroups=", "--property=UMask=0077",
        `--property=ReadOnlyPaths=${profile.readOnlyPaths.join(" ")}`, `--property=ReadWritePaths=${profile.writableRoot}`,
        "--property=InaccessiblePaths=-/run/systemd -/run/dbus -/run/docker.sock -/run/containerd",
        "--property=StandardInput=null", "--property=StandardOutput=journal", "--property=StandardError=journal",
        "--", ENV, "-i", "--", ...Object.keys(request.command.environment).sort().map(name => `${name}=${request.command.environment[name]}`), request.command.executable, ...request.command.args];
      // env -i drops the manager's environment too. Type=exec therefore acknowledges
      // this wrapper; it does not prove Python/model/native preflight completed.
      // No await may intervene between the trusted revocation check and execute.
      if (signal.aborted || authorize() !== true) return { kind: "unknown", reason: "authority_revoked_before_submit" };
      const result = await call(RUN, args, Math.min(300_000, l.startTimeoutMs + 1000), signal);
      if (!result || result.stopped || result.exitCode !== 0) return { kind: "unknown", reason: "start_not_confirmed" };
      const after = await currentHost(); if (!sameHost(before, after)) return { kind: "unknown", reason: "host_identity_changed" };
      return { kind: "accepted", evidence: { source: "systemd-run", unitName: request.identity.unitName, description: request.identity.description,
        machineId: after.machineId, bootId: after.bootId, observedAt: observedAt(), acceptedScope: "environment_wrapper_start", absoluteDeadlineEnforced: false } };
    } catch { return { kind: "unknown", reason: "start_failed" }; }
  }
  async function stop(raw: ServiceQueryRequest, signal: AbortSignal): Promise<ServiceStopResult> {
    const request = plainCopy(raw); validateQuery(request);
    const before = await query(request, signal);
    if (before.kind !== "present") return { command: "not_sent", observation: before };
    const pinned = { ...request, expectedInvocationId: before.snapshot.invocationId };
    const result = await call(CTL, ["--system", "--no-pager", "--no-ask-password", "stop", "--", request.identity.unitName], Math.min(300_000, profile.maxima.stopTimeoutMs + 1000), signal);
    return { command: result && !result.stopped && result.exitCode === 0 ? "sent" : "unknown", observation: await query(pinned, signal) };
  }
  return { hostIdentity: currentHost, start, query, stop };
}
