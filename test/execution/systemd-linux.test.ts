import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, copyFile, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openJobJournal } from "../../src/execution/journal.ts";
import { createSystemdTransport } from "../../src/execution/systemd.ts";
import { createJobDeclaration, createSupervisedWorker } from "../../src/execution/worker.ts";
import { runProcess } from "../../src/workers/process.ts";
import type { HostIdentity, JobDeclaration, ServiceLimits, ServiceQueryResult, ServiceSnapshot,
  SystemdTransport } from "../../src/execution/types.ts";

const executeFile = promisify(execFile);
const enabled = process.env.HARNESS_TEST_SYSTEMD === "1";
const fixtureSource = fileURLToPath(new URL("./fixtures/service-child.cjs", import.meta.url));
const literalArgument = "literal $HOME ${HARNESS_UNSET_FIXTURE} %n";
const limits: ServiceLimits = { runtimeMs: 6_000, startTimeoutMs: 2_000, stopTimeoutMs: 1_000,
  memoryMaxBytes: 256 * 1024 * 1024, tasksMax: 32 };

interface FixtureEvent {
  event: string;
  pid: number;
  parentPid: number;
  uid: number;
  processStartTicks: string;
  mode: string;
  literal?: string;
  cgroup?: string;
  privateEndpointDenied?: boolean;
}
interface Fixture {
  directory: string;
  journalPath: string;
  marker: string;
  transport: SystemdTransport;
  declaration: JobDeclaration;
  query(): Promise<ServiceQueryResult>;
  events(): Promise<FixtureEvent[]>;
}

async function ctl(args: string[]): Promise<void> {
  await executeFile("/usr/bin/sudo", ["-n", "--", "/usr/bin/systemctl", "--system", "--no-pager", "--no-ask-password", ...args],
    { timeout: 4_000, maxBuffer: 16_384, encoding: "utf8" });
}
function errorCode(error: unknown): unknown { return error && typeof error === "object" && "code" in error ? error.code : null; }
function diagnosticText(value: unknown, maximum = 2_048): string {
  return typeof value === "string" ? value.replace(/[^\x20-\x7e\n\t]/gu, "?").slice(0, maximum) : "";
}
function observedState(value: ServiceQueryResult): object {
  if (value.kind !== "present") return { kind: value.kind, ...(value.kind === "unknown" ? { reason: value.reason } : {}) };
  const s = value.snapshot;
  return { kind: "present", activeState: s.activeState, subState: s.subState, result: s.result,
    mainPid: s.mainPid, execMainCode: s.execMainCode, execMainStatus: s.execMainStatus,
    controlGroup: s.controlGroup, cgroupPopulated: s.cgroupPopulated };
}
async function fixtureStatus(unitName: string): Promise<string> {
  assert.match(unitName, /^rlh-[a-f0-9]{64}\.service$/u);
  try {
    const result = await executeFile("/usr/bin/sudo", ["-n", "--", "/usr/bin/systemctl", "--system", "--no-pager", "--no-ask-password",
      "status", "--lines=8", "--output=cat", "--", unitName], { timeout: 2_000, maxBuffer: 8_192, encoding: "utf8" });
    return diagnosticText(result.stdout, 4_096);
  } catch (error) {
    // Nonzero status is expected for failed/inactive units. This is the exact
    // nonsecret fixture's bounded output, never a host-wide journal dump.
    const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
    return JSON.stringify({ code: errorCode(error), stdout: diagnosticText(value.stdout, 4_096), stderr: diagnosticText(value.stderr, 1_024) });
  }
}
async function until<T>(read: () => Promise<T | undefined>, message: string, milliseconds = 5_000): Promise<T> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(message);
}
async function events(path: string): Promise<FixtureEvent[]> {
  let content: string;
  try { content = await readFile(path, "utf8"); } catch (error) { if (errorCode(error) === "ENOENT") return []; throw error; }
  assert.ok(Buffer.byteLength(content) <= 16_384, "Fixture must not produce unbounded output");
  // A concurrently written final line is not an event until its newline arrives.
  return content.split("\n").slice(0, -1).map(line => {
    const value = JSON.parse(line) as FixtureEvent;
    assert.equal(typeof value.event, "string");
    assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0);
    assert.match(value.processStartTicks, /^\d+$/u);
    return value;
  });
}
async function originalProcessAlive(event: FixtureEvent): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${event.pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] === event.processStartTicks;
  } catch (error) { if (errorCode(error) === "ENOENT") return false; throw error; }
}
async function cgroupGoneOrEmpty(unitName: string): Promise<boolean> {
  assert.match(unitName, /^rlh-[a-f0-9]{64}\.service$/u);
  try {
    const value = await readFile(`/sys/fs/cgroup/system.slice/${unitName}/cgroup.events`, "utf8");
    assert.ok(Buffer.byteLength(value) < 4096);
    return /^populated 0$/mu.test(value);
  } catch (error) { if (errorCode(error) === "ENOENT") return true; throw error; }
}
async function assertEnded(fixture: Fixture, started: FixtureEvent[]): Promise<void> {
  assert.ok(started.length > 0, "Cleanup proof requires previously observed fixture processes");
  for (const event of started) {
    assert.equal(event.uid, process.getuid!());
    assert.equal(event.privateEndpointDenied, true, "Fixture UID must not access the private manager endpoint");
    assert.equal(event.cgroup, `0::/system.slice/${fixture.declaration.request.identity.unitName}\n`,
      "Process must have been observed in the owned service cgroup");
  }
  await until(async () => {
    if ((await Promise.all(started.map(originalProcessAlive))).some(Boolean)) return undefined;
    return await cgroupGoneOrEmpty(fixture.declaration.request.identity.unitName) ? true : undefined;
  }, "Original fixture processes or their service cgroup remained populated", 4_000);
  assert.equal((await fixture.events()).some(event => event.event === "fallback_exit"), false,
    "Fixture fallback expiry must not be mistaken for supervisor cleanup");
}
async function snapshot(fixture: Fixture, predicate: (value: ServiceSnapshot) => boolean): Promise<ServiceSnapshot> {
  return until(async () => {
    const query = await fixture.query();
    if (query.kind !== "present" || !predicate(query.snapshot)) return undefined;
    assert.deepEqual(query.snapshot.identity, fixture.declaration.request.identity);
    assert.deepEqual(query.snapshot.host, fixture.declaration.request.expectedHost);
    return query.snapshot;
  }, "Expected owned systemd snapshot was not observed");
}

async function withFixture(t: TestContext, host: HostIdentity, mode: string,
  body: (fixture: Fixture) => Promise<void>, overrides: Partial<ServiceLimits> = {}): Promise<void> {
  // The checkout is under /home on GitHub runners; ProtectHome=yes intentionally
  // hides it. Stage only this fixed source in a separate read-only /tmp root.
  const sourceDirectory = await mkdtemp("/tmp/rlh-systemd-source-");
  const directory = await mkdtemp("/tmp/rlh-systemd-fixture-");
  const controllerDirectory = await mkdtemp("/tmp/rlh-systemd-controller-");
  const marker = join(directory, "events.jsonl");
  let unitName: string | undefined;
  const commandResults: Array<{ operation: string; exitCode: number | null; stopped: string | null; stderr: string; stdout: string }> = [];
  try {
    const source = join(sourceDirectory, "service-child.cjs");
    await copyFile(fixtureSource, source); await chmod(source, 0o644);
    const executable = await realpath(process.execPath);
    const transport = createSystemdTransport({ execute: async request => {
      const result = await runProcess(request);
      const operation = request.args.includes("/usr/bin/systemd-run") ? "start" : request.args.includes("stop") ? "stop" : "query";
      commandResults.push({ operation, exitCode: result.exitCode, stopped: result.stopped,
        stderr: diagnosticText(result.stderr), stdout: diagnosticText(result.stdout, 1_024) });
      // Preserve the first start and a few recent results. This wrapper changes
      // no request, return value, timeout or cancellation signal.
      if (commandResults.length > 5) commandResults.splice(1, 1);
      return result;
    }, profile: {
      userId: process.getuid!(), groupId: process.getgid!(), executables: [executable],
      readOnlyPaths: [sourceDirectory], writableRoot: directory, allowedEnvironment: [], maxima: limits, useSudo: true,
    } });
    const key = randomUUID(), digest = (label: string) => createHash("sha256").update(`${key}:${label}`).digest("hex");
    const declaration = createJobDeclaration({ actionId: `fixture-action-${key}`, backendKey: `fixture-key-${key}`,
      manifestDigest: digest("manifest"), planDigest: digest("plan"), workerId: "linux-ci-fixture",
      command: { executable, args: [source, mode, marker, literalArgument], cwd: sourceDirectory, environment: {} },
      limits: { ...limits, ...overrides }, deadlineAt: new Date(Date.now() + 30_000).toISOString(), host });
    unitName = declaration.request.identity.unitName;
    assert.deepEqual(await transport.hostIdentity(), host, "Native bounded host-identity reading must match the CI host");
    await body({ directory, marker, journalPath: join(controllerDirectory, "jobs.sqlite"), transport, declaration,
      query: () => transport.query({ identity: declaration.request.identity, expectedHost: host }, AbortSignal.timeout(2_000)),
      events: () => events(marker) });
  } catch (error) {
    t.diagnostic(`Fixture-only manager results: ${JSON.stringify(commandResults)}`);
    if (unitName) t.diagnostic(`Owned fixture status: ${await fixtureStatus(unitName)}`);
    throw error;
  } finally {
    if (unitName) {
      assert.match(unitName, /^rlh-[a-f0-9]{64}\.service$/u);
      // Test-only cleanup is scoped to the exact randomly derived owned unit.
      // Reconciliation/production code must never reset its execution history.
      try { await ctl(["stop", "--", unitName]); }
      catch (error) { if (errorCode(error) !== 5) throw error; }
      try { await ctl(["reset-failed", "--", unitName]); }
      catch (error) { if (errorCode(error) !== 1 && errorCode(error) !== 5) throw error; }
    }
    await Promise.all([sourceDirectory, directory, controllerDirectory].map(path => rm(path, { recursive: true, force: true })));
    t.diagnostic("Only the owned fixture unit and temporary files were cleaned up.");
  }
}

test("real Linux systemd qualification (explicit CPU-only opt-in)", { skip: !enabled, timeout: 120_000 }, async t => {
  assert.equal(process.platform, "linux", "Explicit systemd qualification requires Linux; do not silently skip");
  assert.ok(process.getuid!() > 0 && process.getgid!() > 0, "Tests and fixtures must run as a non-root user");
  await access("/sys/fs/cgroup/cgroup.controllers");
  const version = await executeFile("/usr/bin/systemctl", ["--version"], { timeout: 2_000, maxBuffer: 4096 });
  const firstLine = version.stdout.split("\n")[0]!;
  const match = /^systemd (\d+)/u.exec(firstLine);
  assert.ok(match && Number(match[1]) >= 254, "systemd >=254 is required for literal argument handling");
  t.diagnostic(firstLine);
  // A missing noninteractive system-manager path is a failed prerequisite, never
  // an excuse to fall back to a different supervisor or privileged trainer.
  await ctl(["show", "--property=Version", "--value"]);
  const host = { machineId: (await readFile("/etc/machine-id", "utf8")).trim(),
    bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() };

  await t.test("successful exit retains identity, literal argv and the real exit status", { timeout: 15_000 }, async t => {
    await withFixture(t, host, "success", async fixture => {
      const start = await fixture.transport.start(fixture.declaration.request, AbortSignal.timeout(4_000), () => true);
      assert.equal(start.kind, "accepted", `Start outcome: ${JSON.stringify(start)}`);
      const ended = await snapshot(fixture, value => value.subState === "exited" && value.execMainCode === 1);
      t.diagnostic(`Successful terminal transport state: ${JSON.stringify(observedState({ kind: "present", snapshot: ended }))}`);
      assert.equal(ended.activeState, "active"); assert.equal(ended.result, "success"); assert.equal(ended.execMainStatus, 0);
      const starts = (await fixture.events()).filter(event => event.event === "started");
      assert.equal(starts.length, 1); assert.equal(starts[0]!.literal, literalArgument);
      await assertEnded(fixture, starts);
    });
  });

  await t.test("nonzero exit remains a failed process observation after acceptance", { timeout: 15_000 }, async t => {
    await withFixture(t, host, "failure", async fixture => {
      const start = await fixture.transport.start(fixture.declaration.request, AbortSignal.timeout(4_000), () => true);
      assert.equal(start.kind, "accepted", `Start outcome: ${JSON.stringify(start)}`);
      const ended = await snapshot(fixture, value => value.activeState === "failed");
      t.diagnostic(`Nonzero terminal transport state: ${JSON.stringify(observedState({ kind: "present", snapshot: ended }))}`);
      assert.equal(ended.result, "exit-code"); assert.equal(ended.execMainCode, 1); assert.equal(ended.execMainStatus, 23);
      await assertEnded(fixture, (await fixture.events()).filter(event => event.event === "started"));
    });
  });

  await t.test("relative runtime expiry kills a SIGTERM-ignoring fixture before its fallback", { timeout: 15_000 }, async t => {
    await withFixture(t, host, "wait", async fixture => {
      const start = await fixture.transport.start(fixture.declaration.request, AbortSignal.timeout(4_000), () => true);
      assert.equal(start.kind, "accepted", `Start outcome: ${JSON.stringify(start)}`);
      const running = await snapshot(fixture, value => value.activeState === "active" && value.cgroupPopulated === true);
      assert.ok(running.mainPid > 0);
      const ended = await snapshot(fixture, value => value.activeState === "failed");
      t.diagnostic(`Runtime terminal transport state: ${JSON.stringify(observedState({ kind: "present", snapshot: ended }))}`);
      assert.equal(ended.invocationId, running.invocationId); assert.equal(ended.result, "timeout");
      const rows = await fixture.events();
      assert.ok(rows.some(event => event.event === "ignored_sigterm"));
      await assertEnded(fixture, rows.filter(event => event.event === "started"));
    }, { runtimeMs: 2_000, stopTimeoutMs: 500 });
  });

  await t.test("explicit stop kills both the ignoring parent and its detached child", { timeout: 15_000 }, async t => {
    await withFixture(t, host, "tree", async fixture => {
      const start = await fixture.transport.start(fixture.declaration.request, AbortSignal.timeout(4_000), () => true);
      assert.equal(start.kind, "accepted", `Start outcome: ${JSON.stringify(start)}`);
      const starts = await until(async () => { const rows = (await fixture.events()).filter(event => event.event === "started");
        return rows.length === 2 ? rows : undefined; }, "Both fixture processes must start before cancellation");
      assert.deepEqual(starts.map(event => event.mode).sort(), ["child", "tree"]);
      const running = await snapshot(fixture, value => value.activeState === "active" && value.cgroupPopulated === true);
      const stopped = await fixture.transport.stop({ identity: fixture.declaration.request.identity, expectedHost: host,
        expectedInvocationId: running.invocationId }, AbortSignal.timeout(4_000));
      t.diagnostic(`Stop transport state: ${JSON.stringify({ command: stopped.command, observation: observedState(stopped.observation) })}`);
      assert.equal(stopped.command, "sent");
      await assertEnded(fixture, starts);
      const ignored = new Set((await fixture.events()).filter(event => event.event === "ignored_sigterm").map(event => event.pid));
      for (const process of starts) assert.ok(ignored.has(process.pid), "Both processes must demonstrate ignored SIGTERM");
    });
  });

  await t.test("a lost acceptance reply and journal reopening only query the original service", { timeout: 15_000 }, async t => {
    await withFixture(t, host, "wait", async fixture => {
      let startCalls = 0;
      let acceptedBeforeReplyLoss = false;
      const transport: SystemdTransport = { ...fixture.transport, async start(request, signal, authorize) {
        startCalls++;
        const start = await fixture.transport.start(request, signal, authorize);
        assert.equal(start.kind, "accepted", `Start outcome before injected reply loss: ${JSON.stringify(start)}`);
        acceptedBeforeReplyLoss = true;
        throw new Error("Injected response loss after actual manager acceptance");
      } };
      let journal = openJobJournal({ path: fixture.journalPath });
      try {
        const worker = createSupervisedWorker({ journal, transport, workerId: "linux-ci-fixture", authorize: () => true, callTimeoutMs: 4_000 });
        const result = await worker.launch(fixture.declaration, AbortSignal.timeout(7_000));
        t.diagnostic(`Worker launch classification: ${JSON.stringify({ acceptance: result.acceptance, execution: result.execution, reason: result.reason, observation: result.observation ? observedState(result.observation) : null })}`);
        assert.equal(acceptedBeforeReplyLoss, true, "Reply-loss fixture requires an actual accepted start before discarding its reply");
        assert.equal(result.acceptance, "accepted", "A matching real query can resolve the lost reply");
        assert.ok(journal.observations(fixture.declaration.jobId).some(value => value.observation.operation === "start"
          && value.observation.result.kind === "unknown"));
        assert.equal(result.observation?.kind, "present");
        const invocation = result.observation?.kind === "present" ? result.observation.snapshot.invocationId : null;
        journal.close();
        journal = openJobJournal({ path: fixture.journalPath });
        const reopened = createSupervisedWorker({ journal, transport, workerId: "linux-ci-fixture", authorize: () => true, callTimeoutMs: 4_000 });
        const repeated = await reopened.launch(fixture.declaration, AbortSignal.timeout(4_000));
        assert.equal(repeated.acceptance, "accepted"); assert.equal(repeated.jobId, fixture.declaration.jobId);
        assert.equal(repeated.observation?.kind === "present" ? repeated.observation.snapshot.invocationId : null, invocation);
        assert.equal(startCalls, 1, "An existing intent cannot authorize a second start call");
        const starts = await until(async () => { const rows = (await fixture.events()).filter(event => event.event === "started");
          return rows.length ? rows : undefined; }, "Original service marker missing");
        assert.equal(starts.length, 1);
        const cancelled = await reopened.cancel(fixture.declaration.jobId, AbortSignal.timeout(4_000));
        t.diagnostic(`Worker cancel classification: ${JSON.stringify({ acceptance: cancelled.acceptance, execution: cancelled.execution, reason: cancelled.reason, observation: cancelled.observation ? observedState(cancelled.observation) : null })}`);
        await assertEnded(fixture, starts);
        assert.equal((await fixture.events()).filter(event => event.event === "started").length, 1);
      } finally { journal.close(); }
    });
  });
});
