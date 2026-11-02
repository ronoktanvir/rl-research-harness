import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { buildDeadlineGateCommand, PACKAGED_DEADLINE_GATE_PATH, readTrustedDispatchClock } from "../../src/execution/deadline-gate.ts";
import type { DeadlineGateConfig, DispatchClockAnchor } from "../../src/execution/deadline-gate.ts";
import { workerDeclaration } from "./worker-fixtures.ts";

const execute = promisify(execFile);
const python = "/usr/bin/python3";
const config: DeadlineGateConfig = { pythonExecutable: python, scriptPath: "/opt/harness/deadline-gate.py", safetyMarginMs: 50, barrierTimeoutMs: 500 };
const anchor: DispatchClockAnchor = { bootId: "11111111-1111-1111-1111-111111111111", utcMs: Date.parse("2026-11-02T12:00:00.000Z"), bootTimeMs: 50_000 };
const fixture = new URL("./fixtures/deadline-gate-fixture.py", import.meta.url).pathname;

test("gate builder preserves literal argv and exact declared environment in a detached bounded protocol", () => {
  const request = structuredClone(workerDeclaration().request);
  request.command.args = ["$HOME", "literal %n", "semi;colon", "", "unicode λ"];
  request.command.environment = { FIXTURE: "literal $HOME %n ; value", PYTHONPATH: "/srv/source" };
  const command = buildDeadlineGateCommand(request, config, anchor);
  assert.equal(command.executable, python);
  assert.deepEqual(command.args.slice(0, 4), ["-I", "-S", config.scriptPath, "notify-v1"]);
  assert.deepEqual(command.args.slice(13), ["--", request.command.executable, ...request.command.args]);
  assert.deepEqual(JSON.parse(command.args[12]!), request.command.environment);
  assert.deepEqual(command.environment, {});
  request.command.environment.FIXTURE = "mutated"; request.command.args[0] = "mutated";
  assert.equal(JSON.parse(command.args[12]!).FIXTURE, "literal $HOME %n ; value");
  assert.equal(command.args[15], "$HOME");
});

test("gate builder rejects getters without evaluating them, malformed clocks, hidden notification control and unbounded payloads", () => {
  let reads = 0;
  const request = structuredClone(workerDeclaration().request);
  const getter = { ...request, get deadlineAt() { reads++; return request.deadlineAt; } };
  assert.throws(() => buildDeadlineGateCommand(getter, config, anchor), /accessor/);
  assert.equal(reads, 0);
  for (const changed of [
    { ...anchor, bootId: "22222222-2222-2222-2222-222222222222" },
    { ...anchor, bootTimeMs: -1 }, { ...anchor, utcMs: NaN },
  ]) assert.throws(() => buildDeadlineGateCommand(request, config, changed));
  assert.throws(() => buildDeadlineGateCommand(request, { ...config, barrierTimeoutMs: 1001 }, anchor), /activation/);
  assert.throws(() => buildDeadlineGateCommand(request, { ...config, scriptPath: "/opt/../script.py" }, anchor), /canonical/);
  request.command.environment.NOTIFY_SOCKET = "/tmp/injected";
  assert.throws(() => buildDeadlineGateCommand(request, config, anchor), /environment key/);
  delete request.command.environment.NOTIFY_SOCKET;
  request.command.args = ["x".repeat(16_385)];
  assert.throws(() => buildDeadlineGateCommand(request, config, anchor), /argument/);
});

async function run(mode: string) {
  // macOS AF_UNIX paths have a small limit, so /tmp is deliberate here.
  const directory = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rlh-gate-"));
  try {
    const result = await execute(python, ["-I", "-S", fixture, PACKAGED_DEADLINE_GATE_PATH, mode, directory, python], { timeout: 5000, maxBuffer: 64_000 });
    assert.equal(result.stderr, "");
    const receipt = mode === "exec" ? JSON.parse(await readFile(join(directory, "manager.json"), "utf8")) : null;
    return { output: JSON.parse(result.stdout), receipt };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("notify handshake disables later timeout extensions and waits for a separate one-descriptor barrier before same-PID exec", async () => {
  const { output, receipt } = await run("exec");
  assert.deepEqual(receipt.transcript, [{ data: "READY=1\nNOTIFYACCESS=none", fds: 0 }, { data: "BARRIER=1", fds: 1 }]);
  assert.equal(output.pid, receipt.pid);
  assert.deepEqual(output.args, ["$HOME", "semi;colon", "literal %n", ""]);
  assert.equal(output.value, "literal $HOME %n ; value");
  assert.equal(output.notify, null);
});

test("trainer environment is supplied only to final execve and never to the gate interpreter", async () => {
  const request = structuredClone(workerDeclaration().request);
  request.command.environment = { LD_PRELOAD: "/srv/trainer/lib.so", LD_LIBRARY_PATH: "/srv/trainer/lib", PYTHONPATH: "/srv/trainer" };
  const command = buildDeadlineGateCommand(request, config, anchor);
  assert.deepEqual(command.environment, {});
  assert.deepEqual(JSON.parse(command.args[12]!), request.command.environment);
  const result = (await run("capture")).output;
  assert.equal(result.result, "exec_returned");
  assert.equal(result.executions.length, 1);
  assert.deepEqual(result.executions[0][2], { FIXTURE: "literal $HOME %n ; value" });
});

test("gate refuses before readiness when late and rechecks deadline after manager acknowledgment", async () => {
  const early = (await run("early-expiry")).output;
  assert.equal(early.result, "deadline_insufficient"); assert.deepEqual(early.transcript, []); assert.deepEqual(early.executions, []);
  const late = (await run("late-expiry")).output;
  assert.equal(late.result, "deadline_insufficient"); assert.equal(late.transcript.length, 2); assert.deepEqual(late.executions, []);
});

test("unacknowledged or malformed barriers fail closed without executing the trainer", async () => {
  const timeout = (await run("timeout")).output;
  assert.equal(timeout.result, "notify_timeout"); assert.deepEqual(timeout.executions, []);
  assert.ok(timeout.elapsedMs < 1000, `handshake took ${timeout.elapsedMs}ms`);
  const malformed = (await run("invalid-ack")).output;
  assert.equal(malformed.result, "invalid_barrier_ack"); assert.deepEqual(malformed.executions, []);
});

test("anchored boot time rejects wall-clock rollback, forward jumps, boot changes and insufficient shutdown allowance", async () => {
  assert.deepEqual((await run("eligibility")).output, [
    { name: "eligible", result: "eligible" }, { name: "wall-forward", result: "deadline_insufficient" },
    { name: "wall-backward", result: "deadline_insufficient" }, { name: "boot-backward", result: "boot_changed" },
    { name: "different-boot", result: "boot_changed" }, { name: "exact-boundary", result: "eligible" },
    { name: "one-ms-late", result: "deadline_insufficient" },
  ]);
});

test("the standalone helper validates its own argv boundary before notifying or executing", async () => {
  const results = (await run("parse")).output as Array<{ name: string; result: string }>;
  assert.equal(results.length, 11);
  for (const result of results) assert.notEqual(result.result, "accepted", result.name);
});

test("native dispatch-clock sampling rejects non-Linux and a different boot, and uses real Linux boot time when available", async () => {
  if (process.platform !== "linux") {
    await assert.rejects(readTrustedDispatchClock(anchor.bootId), /requires Linux/);
    return;
  }
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const before = Date.now(), sample = await readTrustedDispatchClock(bootId);
  assert.equal(sample.bootId, bootId); assert.ok(sample.bootTimeMs > 0);
  assert.ok(sample.utcMs >= before && sample.utcMs <= Date.now());
  await assert.rejects(readTrustedDispatchClock("00000000-0000-0000-0000-000000000001"), /boot changed/);
});
