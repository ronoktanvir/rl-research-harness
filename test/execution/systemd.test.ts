import assert from "node:assert/strict";
import test from "node:test";
import { cgroupMountFingerprint, createSystemdTransport } from "../../src/execution/systemd.ts";
import type { CgroupState } from "../../src/execution/systemd.ts";
import type { HostIdentity, ServiceLaunchRequest, SystemdProfile } from "../../src/execution/types.ts";
import type { ProcessRequest, ProcessResult } from "../../src/workers/process.ts";

const HOST: HostIdentity = { machineId: "a".repeat(32), bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
const INVOCATION = "b".repeat(32), NOW = new Date("2026-11-02T12:00:00.000Z");
const signal = () => new AbortController().signal;
const ok = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "", stopped: null });
test("native cgroup mount verification rejects partial, masked, foreign and ambiguous hierarchy views", () => {
  const input = { filesystemType: 0x63677270, descriptor: "pos:\t0\nflags:\t02300000\nmnt_id:\t24\n",
    mounts: "20 1 0:1 / / rw - ext4 /dev/root rw\n24 20 0:29 / /sys/fs/cgroup ro,nosuid,nodev,noexec - cgroup2 cgroup2 rw\n",
    ownNamespace: "cgroup:[4026531835]", managerCgroup: "0::/init.scope\n" };
  assert.equal(typeof cgroupMountFingerprint(input), "string");
  for (const change of [
    { filesystemType: 0x01021994 }, { descriptor: "mnt_id:\t25\n" }, { descriptor: "mnt_id:\t24\nmnt_id:\t24\n" },
    { managerCgroup: "0::/\n" }, { managerCgroup: "0::/../init.scope\n" }, { managerCgroup: "0::/init.scope\n0::/init.scope\n" },
    { mounts: input.mounts.replace("0:29 / /sys", "0:29 /private /sys") },
    { mounts: input.mounts.replace("- cgroup2 cgroup2", "- tmpfs tmpfs") },
    { mounts: input.mounts + "25 24 0:30 / /sys/fs/cgroup/system.slice ro - tmpfs tmpfs ro\n" },
    { mounts: input.mounts + input.mounts.split("\n")[1] + "\n" }, { ownNamespace: "invalid" },
  ]) assert.equal(cgroupMountFingerprint({ ...input, ...change }), null, JSON.stringify(change));
  assert.notEqual(cgroupMountFingerprint(input), cgroupMountFingerprint({ ...input, ownNamespace: "cgroup:[4026532000]" }));
});

function profile(): SystemdProfile {
  return { userId: 1001, groupId: 1001, executables: ["/usr/bin/node"], readOnlyPaths: ["/opt/fixture"], writableRoot: "/srv/fixture",
    allowedEnvironment: ["PATH", "FIXTURE"], useSudo: false, maxima: { runtimeMs: 60_000, startTimeoutMs: 5000, stopTimeoutMs: 2000, memoryMaxBytes: 536_870_912, tasksMax: 64 } };
}
function request(): ServiceLaunchRequest {
  return { identity: { unitName: `rlh-${"c".repeat(64)}.service`, description: `rlh-v1:${"d".repeat(64)}` }, expectedHost: { ...HOST },
    command: { executable: "/usr/bin/node", args: ["/opt/fixture/main.cjs", "$HOME", "literal %n", "semi;colon", "quoted \" argument"], cwd: "/srv/fixture",
      environment: { FIXTURE: "literal $HOME %n spaces=equal", PATH: "/usr/bin" } },
    limits: { runtimeMs: 12_000, startTimeoutMs: 2000, stopTimeoutMs: 1000, memoryMaxBytes: 268_435_456, tasksMax: 16 }, deadlineAt: "2026-11-02T12:01:00.000Z" };
}
function queryRequest() { const { identity, expectedHost } = request(); return { identity, expectedHost }; }
function show(overrides: Record<string, string> = {}): string {
  const r = request();
  return Object.entries({ Id: r.identity.unitName, Description: r.identity.description, InvocationID: INVOCATION,
    LoadState: "loaded", ActiveState: "active", SubState: "running", Result: "success", MainPID: "123", ExecMainCode: "0", ExecMainStatus: "0",
    ControlGroup: `/system.slice/${r.identity.unitName}`, ...overrides }).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
}
function setup(responses: Array<ProcessResult | Error>, options: { profile?: SystemdProfile; hosts?: HostIdentity[]; cgroup?: boolean | null; cgroupState?: CgroupState } = {}) {
  const calls: ProcessRequest[] = [], cgroups: string[] = [], hosts = [...(options.hosts ?? [HOST])];
  const transport = createSystemdTransport({ profile: options.profile ?? profile(), now: () => new Date(NOW),
    hostIdentity: async () => structuredClone(hosts.length > 1 ? hosts.shift()! : hosts[0]!),
    ...(options.cgroupState ? { readCgroupState: async (path: string) => { cgroups.push(path); return options.cgroupState!; } }
      : { readCgroupPopulated: async (path: string) => { cgroups.push(path); return options.cgroup ?? null; } }),
    execute: async call => { calls.push(call); const result = responses.shift(); if (!result) throw new Error("unexpected process call"); if (result instanceof Error) throw result; return result; } });
  return { transport, calls, cgroups };
}

test("start uses literal argv, fixed env clearing, bounded cgroup policy and no shell or inherited credentials", async () => {
  const fixture = setup([ok()]), r = request();
  const result = await fixture.transport.start(r, signal(), () => true);
  assert.equal(result.kind, "accepted");
  if (result.kind === "accepted") { assert.equal(result.evidence.acceptedScope, "environment_wrapper_start"); assert.equal(result.evidence.absoluteDeadlineEnforced, false); }
  assert.equal(fixture.calls.length, 1);
  const call = fixture.calls[0]!;
  assert.equal(call.executable, "/usr/bin/systemd-run"); assert.equal(call.cwd, "/"); assert.equal(call.input, "");
  assert.equal(call.timeoutMs, 3000); assert.equal(call.maxOutputBytes, 32_768);
  assert.deepEqual(call.env, { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C", SYSTEMD_PAGER: "cat", SYSTEMD_COLORS: "0" });
  for (const arg of ["--system", "--expand-environment=no", "--property=Type=exec", "--property=ExitType=cgroup", "--remain-after-exit", "--property=Restart=no", "--property=Slice=system.slice", "--uid=1001", "--gid=1001",
    "--property=RuntimeMaxSec=12000ms", "--property=TimeoutStartSec=2000ms", "--property=TimeoutStopSec=1000ms", "--property=KillMode=control-group",
    "--property=SendSIGKILL=yes", "--property=Delegate=no", "--property=MemoryMax=268435456", "--property=TasksMax=16", "--property=NoNewPrivileges=yes",
    "--property=ProtectSystem=strict", "--property=ReadOnlyPaths=/opt/fixture", "--property=ReadWritePaths=/srv/fixture"]) assert.ok(call.args.includes(arg), arg);
  const end = call.args.indexOf("--");
  assert.deepEqual(call.args.slice(end), ["--", "/usr/bin/env", "-i", "--", "FIXTURE=literal $HOME %n spaces=equal", "PATH=/usr/bin", r.command.executable, ...r.command.args]);
  assert.ok(!call.args.some(arg => /--(scope|shell|wait|collect|user)$/u.test(arg)));
  // Real systemd 255 rejects JobTimeoutUSec on transient creation. A running-job
  // timeout is not a substitute for a queue deadline, so neither is advertised.
  assert.ok(!call.args.some(arg => /^--property=Job(?:Running)?Timeout/u.test(arg)));
});

test("control socket masks preserve systemd's required namespace setup paths", async () => {
  const fixture = setup([ok()]);
  await fixture.transport.start(request(), signal(), () => true);
  const masks = fixture.calls[0]!.args.filter(arg => arg.startsWith("--property=InaccessiblePaths="));
  assert.deepEqual(masks, ["--property=InaccessiblePaths=-/run/systemd/private -/run/dbus -/run/docker.sock -/run/containerd"]);
  const paths = masks[0]!.split("=").at(-1)!.split(" ").map(value => value.replace(/^-/, ""));
  for (const required of ["/run/systemd", "/run/systemd/incoming", "/run/systemd/inaccessible", "/run/systemd/journal"]) {
    assert.ok(!paths.includes(required), required);
  }
});

test("sudo is a fixed noninteractive prefix and never changes the trainer to root", async () => {
  const p = profile(); p.useSudo = true;
  const fixture = setup([ok(), ok(show())], { profile: p });
  await fixture.transport.start(request(), signal(), () => true); await fixture.transport.query(queryRequest(), signal());
  assert.equal(fixture.calls[0]!.executable, "/usr/bin/sudo");
  assert.deepEqual(fixture.calls[0]!.args.slice(0, 3), ["-n", "--", "/usr/bin/systemd-run"]);
  assert.deepEqual(fixture.calls[1]!.args.slice(0, 3), ["-n", "--", "/usr/bin/systemctl"]);
  assert.ok(fixture.calls[0]!.args.includes("--uid=1001"));
});

test("profile and request are snapshotted before the first asynchronous host lookup", async () => {
  const p = profile(), r = request(), calls: ProcessRequest[] = [];
  let resolve!: (value: HostIdentity) => void;
  let first = true;
  const transport = createSystemdTransport({ profile: p, now: () => new Date(NOW),
    hostIdentity: () => first ? (first = false, new Promise(done => { resolve = done; })) : Promise.resolve(HOST),
    execute: async value => { calls.push(value); return ok(); } });
  const pending = transport.start(r, signal(), () => true);
  p.userId = 0; p.writableRoot = "/etc"; r.command.args.push("mutation"); r.command.environment.FIXTURE = "changed"; r.limits.runtimeMs = 1;
  resolve(HOST); assert.equal((await pending).kind, "accepted");
  const args = calls[0]!.args;
  assert.ok(args.includes("--uid=1001")); assert.ok(args.includes("--property=ReadWritePaths=/srv/fixture"));
  assert.ok(args.includes("--property=RuntimeMaxSec=12000ms")); assert.ok(!args.includes("mutation")); assert.ok(args.includes("FIXTURE=literal $HOME %n spaces=equal"));
});

test("authority revoked during asynchronous host verification prevents the manager call", async () => {
  let resolve!: (value: HostIdentity) => void, authorized = true, calls = 0, checks = 0;
  const transport = createSystemdTransport({ profile: profile(), now: () => new Date(NOW),
    hostIdentity: () => new Promise(done => { resolve = done; }),
    execute: async () => { calls++; return ok(); } });
  const pending = transport.start(request(), signal(), () => { checks++; return authorized; });
  authorized = false; resolve(HOST);
  assert.deepEqual(await pending, { kind: "unknown", reason: "authority_revoked_before_submit" });
  assert.equal(checks, 1); assert.equal(calls, 0);
});

test("query is read-only and returns strict host, invocation, state and confined cgroup evidence", async () => {
  const fixture = setup([ok(show())], { cgroup: true });
  const result = await fixture.transport.query({ identity: request().identity, expectedHost: HOST, expectedInvocationId: INVOCATION }, signal());
  assert.equal(result.kind, "present");
  if (result.kind === "present") {
    assert.equal(result.snapshot.mainPid, 123); assert.equal(result.snapshot.cgroupPopulated, true); assert.equal(result.snapshot.invocationId, INVOCATION);
    assert.equal(result.snapshot.observedAt, NOW.toISOString()); assert.deepEqual(result.snapshot.host, HOST);
  }
  assert.deepEqual(fixture.cgroups, [`/system.slice/${request().identity.unitName}`]);
  assert.equal(fixture.calls[0]!.executable, "/usr/bin/systemctl"); assert.ok(fixture.calls[0]!.args.includes("show"));
  assert.ok(!fixture.calls[0]!.args.some(arg => ["start", "stop", "restart", "reset-failed"].includes(arg)));
});

test("retained exited service differs from running, and unreadable cgroup remains unestablished", async () => {
  const ended = show({ SubState: "exited", MainPID: "0", ExecMainCode: "1", ExecMainStatus: "0" });
  const fixture = setup([ok(ended), ok(ended)], { cgroup: false });
  const result = await fixture.transport.query(queryRequest(), signal());
  assert.equal(result.kind, "present"); if (result.kind === "present") { assert.equal(result.snapshot.subState, "exited"); assert.equal(result.snapshot.cgroupPopulated, false); }
  const uncertain = setup([ok(show({ MainPID: "0", ControlGroup: "" }))]);
  const other = await uncertain.transport.query(queryRequest(), signal());
  assert.equal(other.kind, "present"); if (other.kind === "present") assert.equal(other.snapshot.cgroupPopulated, null);
  assert.equal(uncertain.cgroups.length, 0);
});

test("terminal cleanup proof brackets exact cgroup absence or emptiness without inventing a manager path", async () => {
  for (const cgroupState of ["empty", "absent"] as const) {
    const ended = show({ SubState: "exited", MainPID: "0", ExecMainCode: "1", ExecMainStatus: "0", ControlGroup: "" });
    const fixture = setup([ok(ended), ok(ended)], { cgroupState });
    const result = await fixture.transport.query(queryRequest(), signal());
    assert.equal(result.kind, "present");
    if (result.kind === "present") {
      assert.equal(result.snapshot.controlGroup, ""); assert.equal(result.snapshot.cgroupPopulated, false);
      assert.deepEqual(result.snapshot.cleanupEvidence, { kind: cgroupState === "empty" ? "cgroup_v2_empty" : "cgroup_v2_absent",
        controlGroup: `/system.slice/${request().identity.unitName}`, invocationId: INVOCATION, observedAt: NOW.toISOString(), confirmedAt: NOW.toISOString() });
    }
    assert.deepEqual(fixture.cgroups, [`/system.slice/${request().identity.unitName}`]);
    assert.equal(fixture.calls.length, 2); assert.ok(fixture.calls.every(call => call.args.includes("show")));
  }
});

test("cleanup permits manager path removal but rejects replacement, state changes, loss or malformed confirmation", async () => {
  const fields = { SubState: "exited", MainPID: "0", ExecMainCode: "1", ExecMainStatus: "0" };
  const first = show(fields), last = show({ ...fields, ControlGroup: "" });
  const good = setup([ok(first), ok(last)], { cgroupState: "absent" });
  const result = await good.transport.query(queryRequest(), signal());
  assert.equal(result.kind, "present"); if (result.kind === "present") assert.equal(result.snapshot.cleanupEvidence?.kind, "cgroup_v2_absent");
  for (const changed of [show(), show({ ...fields, InvocationID: "f".repeat(32) }), show({ ...fields, Result: "exit-code", ExecMainStatus: "1" }),
    show({ ...fields, MainPID: "123" }), show({ ...fields, Description: `rlh-v1:${"f".repeat(64)}` }),
    `Id=${request().identity.unitName}\nLoadState=not-found\n`, "malformed"]) {
    const fixture = setup([ok(first), ok(changed)], { cgroupState: "absent" });
    assert.equal((await fixture.transport.query(queryRequest(), signal())).kind, "unknown");
  }
});

test("kernel uncertainty and incomplete execution never become terminal absence proof", async () => {
  const ended = show({ SubState: "exited", MainPID: "0", ExecMainCode: "1", ControlGroup: "" });
  const unreadable = setup([ok(ended)], { cgroupState: "unknown" });
  const result = await unreadable.transport.query(queryRequest(), signal());
  assert.equal(result.kind, "present");
  if (result.kind === "present") { assert.equal(result.snapshot.cgroupPopulated, null); assert.equal(result.snapshot.cleanupEvidence, undefined); }
  assert.equal(unreadable.calls.length, 1);
  for (const fields of [{}, { SubState: "exited", MainPID: "0", ExecMainCode: "0" }, { ActiveState: "deactivating", SubState: "stop-sigterm", MainPID: "0", ExecMainCode: "2" }]) {
    const fixture = setup([ok(show(fields))], { cgroupState: "absent" });
    const value = await fixture.transport.query(queryRequest(), signal());
    assert.equal(value.kind, "present");
    if (value.kind === "present") { assert.equal(value.snapshot.cgroupPopulated, null); assert.equal(value.snapshot.cleanupEvidence, undefined); }
  }
  const conflict = setup([ok(ended)], { cgroupState: "populated" });
  assert.deepEqual(await conflict.transport.query(queryRequest(), signal()), { kind: "unknown", reason: "terminal_cgroup_populated" });
});

test("terminal proof fails closed on reboot, cancellation and backward clock movement", async () => {
  const ended = show({ SubState: "exited", MainPID: "0", ExecMainCode: "1", ControlGroup: "" });
  const changedHost = { ...HOST, bootId: "11111111-2222-3333-4444-555555555555" };
  const reboot = setup([ok(ended), ok(ended)], { cgroupState: "absent", hosts: [HOST, changedHost] });
  assert.equal((await reboot.transport.query(queryRequest(), signal())).kind, "unknown");
  const controller = new AbortController();
  const aborted = createSystemdTransport({ profile: profile(), now: () => new Date(NOW), hostIdentity: async () => HOST,
    execute: async () => ok(ended), readCgroupState: async () => { controller.abort(); return "absent"; } });
  assert.equal((await aborted.query(queryRequest(), controller.signal)).kind, "unknown");
  let clockCalls = 0;
  const clock = createSystemdTransport({ profile: profile(), now: () => new Date(NOW.getTime() - clockCalls++), hostIdentity: async () => HOST,
    execute: async () => ok(ended), readCgroupState: async () => "absent" });
  assert.deepEqual(await clock.query(queryRequest(), signal()), { kind: "unknown", reason: "observation_clock_changed" });
});

test("absence after an issued intent is only absence, not nonacceptance or successful cleanup", async () => {
  const r = request(), absent = { ...ok(`Id=${r.identity.unitName}\nLoadState=not-found\n`), exitCode: 1 };
  const fixture = setup([absent, absent]);
  assert.deepEqual(await fixture.transport.query({ identity: r.identity, expectedHost: r.expectedHost }, signal()), { kind: "absent", host: HOST, observedAt: NOW.toISOString() });
  const stopped = await fixture.transport.stop({ identity: r.identity, expectedHost: r.expectedHost }, signal());
  assert.equal(stopped.command, "not_sent"); assert.equal(stopped.observation.kind, "absent");
  assert.equal(fixture.calls.length, 2); assert.ok(fixture.calls.every(call => call.args.includes("show")));
});

test("malformed, duplicate, mismatched or replacement snapshots cannot establish job state", async () => {
  const bad = [show({ Description: `rlh-v1:${"f".repeat(64)}` }), show({ Id: "other.service" }), show({ InvocationID: "0".repeat(32) }),
    show({ MainPID: "-1" }), show({ MainPID: "1e3" }), show({ ExecMainCode: "99" }), show({ ControlGroup: "/system.slice/../../private" }),
    show() + "MainPID=999\n", show() + "UnknownProperty=foo\n", show().replace("Result=success\n", ""), show({ ActiveState: "invented" })];
  for (const stdout of bad) { const fixture = setup([ok(stdout)]); assert.equal((await fixture.transport.query(queryRequest(), signal())).kind, "unknown"); }
  const fixture = setup([ok(show())]);
  assert.equal((await fixture.transport.query({ identity: request().identity, expectedHost: HOST, expectedInvocationId: "f".repeat(32) }, signal())).kind, "unknown");
});

test("host changes before or across a command preserve uncertainty", async () => {
  const other = { ...HOST, bootId: "11111111-2222-3333-4444-555555555555" };
  const before = setup([], { hosts: [other] }); assert.equal((await before.transport.start(request(), signal(), () => true)).kind, "unknown"); assert.equal(before.calls.length, 0);
  const across = setup([ok(show())], { hosts: [HOST, other] }); assert.equal((await across.transport.query(queryRequest(), signal())).kind, "unknown");
  const start = setup([ok()], { hosts: [HOST, other] }); assert.equal((await start.transport.start(request(), signal(), () => true)).kind, "unknown");
});

test("stop verifies ownership, never resets the unit, and queries the same invocation afterward", async () => {
  const stopped = show({ ActiveState: "inactive", SubState: "dead", MainPID: "0", ExecMainCode: "2", ExecMainStatus: "15" });
  const fixture = setup([ok(show()), ok(), ok(stopped), ok(stopped)], { cgroup: false });
  const result = await fixture.transport.stop(queryRequest(), signal());
  assert.equal(result.command, "sent"); assert.equal(result.observation.kind, "present");
  assert.deepEqual(fixture.calls.map(call => call.args.find(arg => ["show", "stop"].includes(arg))), ["show", "stop", "show", "show"]);
  assert.ok(fixture.calls.every(call => !call.args.includes("reset-failed")));
  const replaced = setup([ok(show()), ok(), ok(show({ InvocationID: "f".repeat(32) }))]);
  const changed = await replaced.transport.stop(queryRequest(), signal()); assert.equal(changed.command, "sent"); assert.equal(changed.observation.kind, "unknown");
  const foreign = setup([ok(show({ Description: `rlh-v1:${"f".repeat(64)}` }))]);
  assert.equal((await foreign.transport.stop(queryRequest(), signal())).command, "not_sent"); assert.equal(foreign.calls.length, 1);
});

test("timeouts, exceptions, output overflow, spawn failure and nonzero start exits never trigger retries", async () => {
  const failures: Array<ProcessResult | Error> = [new Error("transport down"), { ...ok(), exitCode: 1 }, { ...ok(), stopped: "timeout" },
    { ...ok(), stopped: "cancelled" }, { ...ok(), stopped: "output_limit" }, { ...ok(), stopped: "spawn_error" }, ok("x".repeat(32_769))];
  for (const failure of failures) { const fixture = setup([failure]); assert.equal((await fixture.transport.start(request(), signal(), () => true)).kind, "unknown"); assert.equal(fixture.calls.length, 1); }
  const abort = new AbortController(); abort.abort();
  const fixture = setup([]); assert.equal((await fixture.transport.start(request(), abort.signal, () => true)).kind, "unknown"); assert.equal(fixture.calls.length, 0);
});

test("invalid policy, paths, identities, env and resource or deadline bounds prevent process invocation", async () => {
  for (const change of [ (p: SystemdProfile) => { p.userId = 0; }, (p: SystemdProfile) => { p.groupId = 0; },
    (p: SystemdProfile) => { p.writableRoot = "/opt"; }, (p: SystemdProfile) => { p.readOnlyPaths = ["/tmp/has space"]; },
    (p: SystemdProfile) => { p.readOnlyPaths = ["/home/runner/source"]; }, (p: SystemdProfile) => { p.writableRoot = "/srv/%n"; } ]) {
    const p = profile(); change(p); assert.throws(() => setup([], { profile: p }));
  }
  const cases: Array<(r: ServiceLaunchRequest) => void> = [r => { r.command.executable = "/usr/bin/bash"; }, r => { r.command.cwd = "/tmp/outside"; },
    r => { r.command.environment.API_KEY = "secret"; }, r => { r.command.args = ["\0"]; }, r => { r.command.args = ["\ud800"]; },
    r => { r.limits.memoryMaxBytes = 999_999_999; }, r => { r.limits.tasksMax = 0; }, r => { r.identity.unitName = "other.service"; },
    r => { r.identity.description = "anything"; }, r => { r.deadlineAt = "tomorrow"; }];
  for (const change of cases) { const r = request(); change(r); const fixture = setup([]); await assert.rejects(fixture.transport.start(r, signal(), () => true)); assert.equal(fixture.calls.length, 0); }
  const expired = request(); expired.deadlineAt = NOW.toISOString(); const fixture = setup([]);
  assert.deepEqual(await fixture.transport.start(expired, signal(), () => true), { kind: "unknown", reason: "insufficient_deadline_budget" }); assert.equal(fixture.calls.length, 0);
});

test("native service operations cannot be enabled accidentally on this non-Linux development host", () => {
  if (process.platform !== "linux") assert.throws(() => createSystemdTransport({ profile: profile() }), /requires Linux/);
});

test("accessors and sparse command arrays are rejected without invoking caller code or a manager", async () => {
  const r = request(); let getterCalled = false;
  Object.defineProperty(r.command, "args", { enumerable: true, get() { getterCalled = true; return []; } });
  const fixture = setup([]);
  await assert.rejects(fixture.transport.start(r, signal(), () => true), /accessors/);
  assert.equal(getterCalled, false); assert.equal(fixture.calls.length, 0);
  const sparse = request(); sparse.command.args = new Array(2) as string[];
  await assert.rejects(fixture.transport.start(sparse, signal(), () => true), /dense/);
});
