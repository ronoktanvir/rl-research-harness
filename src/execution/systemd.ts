import { constants } from "node:fs";
import { open, readlink, statfs } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { posix } from "node:path";
import { encode, keys } from "../ledger/validation.ts";
import { runProcess } from "../workers/process.ts";
import { buildDeadlineGateCommand, readTrustedDispatchClock } from "./deadline-gate.ts";
import type { DispatchClockAnchor } from "./deadline-gate.ts";
import type { ProcessRequest, ProcessResult } from "../workers/process.ts";
import type { HostIdentity, ServiceLaunchRequest, ServiceLimits, ServiceQueryRequest, ServiceQueryResult,
  ServiceSnapshot, ServiceStartResult, ServiceStopResult, SystemdProfile, SystemdTransport, UnitIdentity } from "./types.ts";

export interface SystemdTransportOptions {
  profile: SystemdProfile;
  execute?: typeof runProcess;
  hostIdentity?: () => Promise<HostIdentity>;
  readCgroupPopulated?: (controlGroup: string) => Promise<boolean | null>;
  /** Trusted test/platform boundary; absent means a verified cgroup2 directory absence. */
  readCgroupState?: (controlGroup: string) => Promise<CgroupState>;
  now?: () => Date;
  dispatchClock?: (expectedBootId: string) => Promise<DispatchClockAnchor>;
  managerVersion?: (signal: AbortSignal) => Promise<number>;
}
export type CgroupState = "populated" | "empty" | "absent" | "unknown";

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
  keys(value, ["userId", "groupId", "executables", "readOnlyPaths", "writableRoot", "allowedEnvironment", "maxima", "useSudo", "deadlineGate"]);
  integer(value.userId, 1, 0xffff_fffe, "trainer UID must be non-root"); integer(value.groupId, 1, 0xffff_fffe, "trainer GID must be non-root");
  strings(value.executables, "executable allowlist"); strings(value.readOnlyPaths, "read-only roots");
  for (const executable of value.executables) path(executable);
  for (const root of value.readOnlyPaths) path(root);
  path(value.writableRoot);
  keys(value.deadlineGate, ["pythonExecutable", "scriptPath", "safetyMarginMs", "barrierTimeoutMs"]);
  path(value.deadlineGate.pythonExecutable); path(value.deadlineGate.scriptPath);
  // systemd event timers may each coalesce by 250 ms; allow additional clock,
  // scheduling and kill latency. This minimum is not a hard real-time guarantee.
  integer(value.deadlineGate.safetyMarginMs, 1000, 300_000, "deadline safety margin");
  integer(value.deadlineGate.barrierTimeoutMs, 1, 300_000, "notification barrier timeout");
  const gateScript = value.deadlineGate.scriptPath;
  if (!value.readOnlyPaths.some(root => contains(root, gateScript))) invalid("deadline gate must be in a declared read-only root");
  for (const declared of [value.writableRoot, ...value.readOnlyPaths, ...value.executables, value.deadlineGate.pythonExecutable, value.deadlineGate.scriptPath]) {
    if (["/home", "/root", "/run/systemd", "/run/dbus", "/run/containerd"].some(root => contains(root, declared))) invalid("declared path is reserved or hidden by the fixed service protections");
  }
  for (const root of [...value.readOnlyPaths, ...value.executables, value.deadlineGate.pythonExecutable, value.deadlineGate.scriptPath]) if (contains(value.writableRoot, root) || contains(root, value.writableRoot)) invalid("writable root overlaps executable/read-only roots");
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
  if (profile.deadlineGate.barrierTimeoutMs > value.limits.startTimeoutMs) invalid("notification barrier exceeds activation timeout");
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
async function cgroupMountContext(root: FileHandle): Promise<string> {
  const pinned = `/proc/self/fd/${root.fd}`;
  const [filesystem, descriptor, mounts, ownNamespace, managerCgroup] = await Promise.all([
    statfs(pinned), boundedFile(`/proc/self/fdinfo/${root.fd}`), boundedFile("/proc/self/mountinfo", 262_144),
    readlink("/proc/self/ns/cgroup"), boundedFile("/proc/1/cgroup"),
  ]);
  const fingerprint = cgroupMountFingerprint({ filesystemType: filesystem.type, descriptor, mounts, ownNamespace, managerCgroup });
  if (!fingerprint) throw new Error("Not the system manager's standard cgroup2 root mount");
  return fingerprint;
}
/** Pure verification of bounded native observations; never accesses a filesystem. */
export function cgroupMountFingerprint(input: { filesystemType: number; descriptor: string; mounts: string; ownNamespace: string; managerCgroup: string }): string | null {
  const { filesystemType, descriptor, mounts, ownNamespace, managerCgroup } = input;
  if (filesystemType !== 0x63677270 || !/^cgroup:\[\d+\]$/u.test(ownNamespace)) return null;
  // PID1's documented init.scope must be visible at its real path. Comparing
  // /proc/1/ns links would require ptrace permission for an unprivileged reader.
  const unified = managerCgroup.trim().split("\n").filter(line => line.startsWith("0:"));
  if (unified.length !== 1 || unified[0] !== "0::/init.scope") return null;
  const ids = descriptor.split("\n").filter(line => line.startsWith("mnt_id:"));
  if (ids.length !== 1 || !/^mnt_id:\s+\d+$/u.test(ids[0]!)) return null;
  const id = ids[0]!.split(/\s+/u)[1];
  const records = mounts.split("\n").filter(Boolean).map(line => ({ line, fields: line.split(" ") }));
  const matches = records.filter(record => record.fields[0] === id);
  if (matches.length !== 1) return null;
  const record = matches[0]!, separator = record.fields.indexOf("-");
  if (record.fields[3] !== "/" || record.fields[4] !== "/sys/fs/cgroup" || separator < 6 || record.fields[separator + 1] !== "cgroup2"
    || records.some(item => item.fields[4]?.startsWith("/sys/fs/cgroup/"))) return null;
  return `${ownNamespace}\n${record.line}`;
}
async function nativeCgroup(controlGroup: string): Promise<CgroupState> {
  // cgroup2 exposes kernel-created files/directories, never user-created symlinks.
  // Pin the mount before traversing it; a missing events file alone proves nothing.
  if (!/^\/system\.slice\/rlh-[a-f0-9]{64}\.service$/u.test(controlGroup)) return "unknown";
  let root: FileHandle | undefined, group: FileHandle | undefined;
  try {
    root = await open("/sys/fs/cgroup", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const before = await cgroupMountContext(root);
    let state: CgroupState;
    try { group = await open(`/proc/self/fd/${root.fd}${controlGroup}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
    catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    if (!group) state = "absent";
    else {
      const [rootStat, groupStat] = await Promise.all([root.stat(), group.stat()]);
      if (rootStat.dev !== groupStat.dev) throw new Error("Cgroup directory changed filesystem");
      const text = await boundedFile(`/proc/self/fd/${group.fd}/cgroup.events`);
      const values = text.trim().split("\n").filter(line => line.startsWith("populated "));
      if (values.length !== 1 || !/^populated [01]$/u.test(values[0]!)) throw new Error("Malformed cgroup population");
      state = values[0] === "populated 1" ? "populated" : "empty";
    }
    return before === await cgroupMountContext(root) ? state : "unknown";
  } catch { return "unknown"; }
  finally { await group?.close(); await root?.close(); }
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
 * Composes the required deadline gate. It does not grant authority, attest trainer
 * artifacts or promise unconditional real-time completion under host failure.
 */
export function createSystemdTransport(options: SystemdTransportOptions): SystemdTransport {
  const profile = plainCopy(options.profile); validateProfile(profile);
  const execute = options.execute ?? runProcess, hostReader = options.hostIdentity ?? nativeHost;
  if (options.readCgroupState && options.readCgroupPopulated) invalid("choose only one cgroup reader");
  const legacyReader = options.readCgroupPopulated;
  const cgroupReader = options.readCgroupState ?? (legacyReader ? async (path: string): Promise<CgroupState> => {
    const value = await legacyReader(path); return value === true ? "populated" : value === false ? "empty" : "unknown";
  } : nativeCgroup), now = options.now ?? (() => new Date());
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
  async function nativeManagerVersion(signal: AbortSignal): Promise<number> {
    const result = await call(CTL, ["--system", "--no-pager", "--no-ask-password", "show", "--property=Version", "--value"], QUERY_MS, signal);
    if (!result || result.stopped || result.exitCode !== 0) throw new Error("Manager version unavailable");
    const match = /^(\d+)(?:[.\-+~][A-Za-z0-9.+:~_-]+)?$/u.exec(result.stdout.trim());
    if (!match) throw new Error("Manager version invalid");
    return Number(match[1]);
  }
  async function managerSnapshot(request: ServiceQueryRequest, signal: AbortSignal): Promise<ServiceQueryResult> {
      const result = await call(CTL, ["--system", "--no-pager", "--no-ask-password", "show", "--all", `--property=${PROPERTIES.join(",")}`, "--", request.identity.unitName], QUERY_MS, signal);
      if (!result || result.stopped || result.exitCode === null) return { kind: "unknown", reason: "query_incomplete" };
      const values = properties(result.stdout);
      if (!values || values.Id !== request.identity.unitName) return { kind: "unknown", reason: "unit_snapshot_invalid" };
      if (values.LoadState === "not-found") return { kind: "absent", host: request.expectedHost, observedAt: observedAt() };
      if (result.exitCode !== 0 || PROPERTIES.some(name => !Object.hasOwn(values, name)) || values.Description !== request.identity.description || values.LoadState !== "loaded"
        || !/^[a-f0-9]{32}$/u.test(values.InvocationID!) || /^0+$/u.test(values.InvocationID!)
        || (request.expectedInvocationId !== undefined && values.InvocationID !== request.expectedInvocationId)) return { kind: "unknown", reason: "unit_identity_mismatch" };
      if (!["active", "inactive", "failed", "activating", "deactivating", "reloading", "maintenance", "refreshing"].includes(values.ActiveState!)
        || !/^[a-z][a-z-]{0,63}$/u.test(values.SubState!) || !/^[a-z][a-z-]{0,63}$/u.test(values.Result!)) return { kind: "unknown", reason: "unit_state_invalid" };
      const number = (name: string, maximum: number): number => { const text = values[name]!; if (!/^(0|[1-9][0-9]*)$/u.test(text)) invalid("snapshot number"); const value = Number(text); integer(value, 0, maximum, "snapshot number"); return value; };
      const controlGroup = values.ControlGroup!;
      if (controlGroup !== "" && controlGroup !== `/system.slice/${request.identity.unitName}`) return { kind: "unknown", reason: "unit_cgroup_mismatch" };
      const snapshot: ServiceSnapshot = { identity: request.identity, host: request.expectedHost, observedAt: observedAt(), invocationId: values.InvocationID!, loadState: values.LoadState!,
        activeState: values.ActiveState!, subState: values.SubState!, result: values.Result!, mainPid: number("MainPID", 0xffff_ffff),
        execMainCode: number("ExecMainCode", 6), execMainStatus: number("ExecMainStatus", 255), controlGroup, cgroupPopulated: null };
      return { kind: "present", snapshot };
  }
  function terminal(snapshot: ServiceSnapshot): boolean {
    return snapshot.mainPid === 0 && [1, 2, 3].includes(snapshot.execMainCode)
      && (snapshot.activeState === "active" && snapshot.subState === "exited"
        || snapshot.activeState === "failed" && snapshot.subState === "failed"
        || snapshot.activeState === "inactive" && snapshot.subState === "dead");
  }
  function sameTerminal(a: ServiceSnapshot, b: ServiceSnapshot): boolean {
    return terminal(a) && terminal(b) && a.invocationId === b.invocationId && a.activeState === b.activeState && a.subState === b.subState
      && a.result === b.result && a.execMainCode === b.execMainCode && a.execMainStatus === b.execMainStatus;
  }
  async function query(raw: ServiceQueryRequest, signal: AbortSignal): Promise<ServiceQueryResult> {
    const request = plainCopy(raw); validateQuery(request);
    try {
      if (signal.aborted) return { kind: "unknown", reason: "cancelled" };
      const before = await currentHost(); if (!sameHost(before, request.expectedHost)) return { kind: "unknown", reason: "host_identity_changed" };
      let result = await managerSnapshot(request, signal);
      if (result.kind === "present") {
        const first = result.snapshot, isTerminal = terminal(first), expectedGroup = `/system.slice/${request.identity.unitName}`;
        let state: CgroupState = "unknown";
        if (first.controlGroup || isTerminal) {
          try { const value = await cgroupReader(expectedGroup); if (["populated", "empty", "absent", "unknown"].includes(value)) state = value; }
          catch { /* Failed kernel reads are not absence. */ }
        }
        if (isTerminal && (state === "empty" || state === "absent")) {
          const kernelAt = observedAt();
          const confirmed = await managerSnapshot({ ...request, expectedInvocationId: first.invocationId }, signal);
          if (confirmed.kind !== "present" || !sameTerminal(first, confirmed.snapshot)) return { kind: "unknown", reason: "terminal_observation_changed" };
          const after = await currentHost();
          if (!sameHost(before, after)) return { kind: "unknown", reason: "host_identity_changed" };
          if (signal.aborted) return { kind: "unknown", reason: "cancelled" };
          const confirmedAt = observedAt();
          if (Date.parse(kernelAt) > Date.parse(confirmedAt)) return { kind: "unknown", reason: "observation_clock_changed" };
          const snapshot = confirmed.snapshot;
          snapshot.observedAt = confirmedAt; snapshot.cgroupPopulated = false;
          snapshot.cleanupEvidence = { kind: state === "empty" ? "cgroup_v2_empty" : "cgroup_v2_absent", controlGroup: expectedGroup,
            invocationId: first.invocationId, observedAt: kernelAt, confirmedAt };
          return { kind: "present", snapshot };
        }
        if (isTerminal && state === "populated") return { kind: "unknown", reason: "terminal_cgroup_populated" };
        if (!isTerminal && first.controlGroup) first.cgroupPopulated = state === "populated" ? true : state === "empty" ? false : null;
      }
      const after = await currentHost(); if (!sameHost(before, after)) return { kind: "unknown", reason: "host_identity_changed" };
      if (signal.aborted) return { kind: "unknown", reason: "cancelled" };
      if (result.kind === "present") result.snapshot.observedAt = observedAt();
      return result;
    } catch { return { kind: "unknown", reason: "query_failed" }; }
  }
  async function start(raw: ServiceLaunchRequest, signal: AbortSignal, authorize: () => boolean): Promise<ServiceStartResult> {
    const request = plainCopy(raw); validateLaunch(request, profile);
    try {
      const before = await currentHost(); if (!sameHost(before, request.expectedHost)) return { kind: "unknown", reason: "host_identity_changed" };
      const version = await (options.managerVersion ?? nativeManagerVersion)(signal);
      if (!Number.isSafeInteger(version) || version < 254) return { kind: "unknown", reason: "manager_version_unsupported" };
      const anchor = await (options.dispatchClock ?? readTrustedDispatchClock)(before.bootId);
      const command = buildDeadlineGateCommand(request, profile.deadlineGate, anchor);
      const l = request.limits, remaining = Date.parse(request.deadlineAt) - Math.max(now().getTime(), anchor.utcMs);
      if (!Number.isFinite(remaining) || remaining < l.runtimeMs + l.startTimeoutMs + l.stopTimeoutMs + profile.deadlineGate.safetyMarginMs) return { kind: "unknown", reason: "insufficient_deadline_budget" };
      const args = ["--system", "--no-ask-password", "--quiet", `--unit=${request.identity.unitName}`, `--description=${request.identity.description}`, "--expand-environment=no", "--remain-after-exit",
        "--property=Type=notify", "--property=NotifyAccess=main", "--property=RuntimeRandomizedExtraSec=0", "--property=ExitType=cgroup", "--property=Restart=no", "--property=Slice=system.slice", `--uid=${profile.userId}`, `--gid=${profile.groupId}`,
        `--working-directory=${command.cwd}`, `--property=RuntimeMaxSec=${l.runtimeMs}ms`, `--property=TimeoutStartSec=${l.startTimeoutMs}ms`,
        // v255 rejects transient JobTimeoutUSec despite parsing JobTimeoutSec.
        // TimeoutStartSec bounds activation, not time queued in the manager.
        `--property=TimeoutStopSec=${l.stopTimeoutMs}ms`, "--property=TimeoutStopFailureMode=kill",
        "--property=KillMode=control-group", "--property=KillSignal=SIGTERM", "--property=FinalKillSignal=SIGKILL", "--property=SendSIGKILL=yes", "--property=Delegate=no",
        `--property=MemoryMax=${l.memoryMaxBytes}`, `--property=TasksMax=${l.tasksMax}`, "--property=TasksAccounting=yes", "--property=NoNewPrivileges=yes",
        "--property=ProtectSystem=strict", "--property=ProtectHome=yes", "--property=ProtectControlGroups=yes", "--property=ProtectKernelTunables=yes", "--property=ProtectKernelModules=yes",
        "--property=RestrictSUIDSGID=yes", "--property=CapabilityBoundingSet=", "--property=SupplementaryGroups=", "--property=UMask=0077",
        `--property=ReadOnlyPaths=${profile.readOnlyPaths.join(" ")}`, `--property=ReadWritePaths=${profile.writableRoot}`,
        // The manager requires /run/systemd/incoming while setting up this
        // namespace. Mask its private control socket, not that parent tree.
        "--property=InaccessiblePaths=-/run/systemd/private -/run/dbus -/run/docker.sock -/run/containerd",
        "--property=StandardInput=null", "--property=StandardOutput=journal", "--property=StandardError=journal",
        "--", ENV, "-i", "--", ...Object.keys(command.environment).sort().map(name => `${name}=${command.environment[name]}`), command.executable, ...command.args];
      // The trusted gate notifies readiness, disables later notifications, waits
      // for the manager barrier and checks the deadline again before trainer exec.
      // Manager acceptance is not proof that the trainer or native preflight ran.
      // No await may intervene between the trusted revocation check and execute.
      if (signal.aborted || authorize() !== true) return { kind: "unknown", reason: "authority_revoked_before_submit" };
      const result = await call(RUN, args, Math.min(300_000, l.startTimeoutMs + 1000), signal);
      if (!result || result.stopped || result.exitCode !== 0) return { kind: "unknown", reason: "start_not_confirmed" };
      const after = await currentHost(); if (!sameHost(before, after)) return { kind: "unknown", reason: "host_identity_changed" };
      return { kind: "accepted", evidence: { source: "systemd-run", unitName: request.identity.unitName, description: request.identity.description,
        machineId: after.machineId, bootId: after.bootId, observedAt: observedAt(), acceptedScope: "deadline_gate_ready",
        deadlineGateProtocol: "notify-v1", dispatchClockAnchor: { ...anchor }, deadlineQualification: "conditional_local_host", absoluteDeadlineEnforced: false } };
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
