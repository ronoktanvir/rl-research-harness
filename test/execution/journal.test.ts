import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { link, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TestContext } from "node:test";
import { openJobJournal } from "../../src/execution/journal.ts";
import type { JobDeclaration, JobObservationInput, JobRecord, ServiceSnapshot } from "../../src/execution/types.ts";
import { hash } from "../../src/ledger/validation.ts";

const at = "2026-11-02T00:00:00.000Z";
function declaration(): JobDeclaration {
  const unitName = `rlh-${"b".repeat(64)}.service`;
  return { jobId: `fixture-worker:${unitName}`, actionId: `action:${"a".repeat(64)}`, backendKey: `action:${"a".repeat(64)}`,
    manifestDigest: "c".repeat(64), planDigest: "d".repeat(64), workerId: "fixture-worker",
    request: { identity: { unitName, description: "rlh-v1:fixture" }, expectedHost: { machineId: "fixture-machine", bootId: "fixture-boot" },
      command: { executable: "/usr/bin/node", args: ["--fixture", "literal $VALUE", "with spaces"], cwd: "/srv/jobs/fixture", environment: { FIXTURE: "literal" } },
      limits: { runtimeMs: 10_000, startTimeoutMs: 1000, stopTimeoutMs: 250, memoryMaxBytes: 67_108_864, tasksMax: 8 },
      deadlineAt: "2100-01-01T00:00:00.000Z" } };
}
function accepted(record: JobRecord, observationId = "receipt-one"): JobObservationInput {
  return { observationId, jobId: record.declaration.jobId, actionId: record.declaration.actionId, declarationDigest: record.digest, observedAt: at,
    observation: { operation: "start", result: { kind: "accepted", evidence: { identity: { ...record.declaration.request.identity },
      host: { ...record.declaration.request.expectedHost }, invocationId: "1".repeat(32) } } } };
}
function present(record: JobRecord, observationId = "query-one"): JobObservationInput {
  const snapshot: ServiceSnapshot = { identity: record.declaration.request.identity, host: record.declaration.request.expectedHost, observedAt: at,
    invocationId: "1".repeat(32), loadState: "loaded", activeState: "active", subState: "running", result: "success",
    mainPid: 1234, execMainCode: 0, execMainStatus: 0, controlGroup: `/system.slice/${record.declaration.request.identity.unitName}`, cgroupPopulated: true };
  return { observationId, jobId: record.declaration.jobId, actionId: record.declaration.actionId, declarationDigest: record.digest, observedAt: at,
    observation: { operation: "query", result: { kind: "present", snapshot } } };
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "job-journal-")), path = join(directory, "journal.sqlite");
  let journal = openJobJournal({ path, now: () => new Date(at) });
  t.after(async () => { journal.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, path, get journal() { return journal; }, reopen() { journal.close(); journal = openJobJournal({ path, now: () => new Date("2026-11-03T00:00:00.000Z") }); } };
}

test("immutable intent survives reopen and duplicate preparation never creates new start authority", async t => {
  const f = await fixture(t), input = declaration(), first = f.journal.prepareIntent(input);
  assert.equal(first.created, true); assert.equal(first.record.digest, hash(input)); assert.equal(first.record.latestObservation, null);
  input.request.command.args.push("changed-after-submit"); first.record.declaration.request.command.environment.FIXTURE = "changed-return";
  const stored = f.journal.read(input.jobId)!;
  assert.equal(stored.declaration.request.command.args.length, 3); assert.equal(stored.declaration.request.command.environment.FIXTURE, "literal");
  const repeated = f.journal.prepareIntent(declaration()); assert.equal(repeated.created, false);
  assert.throws(() => f.journal.prepareIntent(input), { code: "conflict" });
  const differentJob = declaration(); differentJob.jobId = "another-job";
  assert.throws(() => f.journal.prepareIntent(differentJob), { code: "conflict" });
  f.reopen(); const recovered = f.journal.prepareIntent(declaration());
  assert.equal(recovered.created, false); assert.deepEqual(recovered.record, stored);
  assert.deepEqual(f.journal.readByAction(input.actionId), stored); assert.equal(f.journal.read("missing"), null);
  f.journal.close(); assert.throws(() => f.journal.read(input.jobId), { code: "closed" }); f.journal.close();
});

test("receipts are immutable, bound, sequenced, detached and retained without synthesizing job success", async t => {
  const f = await fixture(t), { record } = f.journal.prepareIntent(declaration()), input = accepted(record);
  const first = f.journal.recordObservation(input);
  assert.equal(first.sequence, 1); const { digest: _digest, ...body } = first; assert.equal(first.digest, hash(body));
  assert.deepEqual(f.journal.recordObservation(input), first);
  const changed = structuredClone(input); changed.observedAt = "2026-11-03T00:00:00.000Z";
  assert.throws(() => f.journal.recordObservation(changed), { code: "conflict" });
  const second = f.journal.recordObservation({ ...input, observationId: "absence", observation: { operation: "query", result: { kind: "absent", host: record.declaration.request.expectedHost, observedAt: at } } });
  assert.equal(second.sequence, 2); assert.equal(f.journal.observations(input.jobId).length, 2);
  first.observedAt = "changed";
  f.reopen(); assert.equal(f.journal.observations(input.jobId)[0]!.observedAt, at);
  assert.equal(f.journal.read(input.jobId)!.latestObservation!.observation.operation, "query");
  assert.equal(f.journal.prepareIntent(declaration()).created, false);
});

test("wrong action, declaration, host, unit, receipt identity and replacement invocation roll back", async t => {
  const f = await fixture(t), { record } = f.journal.prepareIntent(declaration());
  const initial = f.journal.recordObservation(accepted(record));
  const mutations: ((value: JobObservationInput) => void)[] = [
    value => { value.actionId = "another-action"; }, value => { value.declarationDigest = "0".repeat(64); },
    value => { if (value.observation.operation === "query" && value.observation.result.kind === "present") value.observation.result.snapshot.host.bootId = "another-boot"; },
    value => { if (value.observation.operation === "query" && value.observation.result.kind === "present") value.observation.result.snapshot.identity.description = "another-description"; },
    value => { if (value.observation.operation === "query" && value.observation.result.kind === "present") value.observation.result.snapshot.invocationId = "2".repeat(32); },
  ];
  for (const mutate of mutations) { const input = structuredClone(present(record)); mutate(input); assert.throws(() => f.journal.recordObservation(input), { code: "conflict" }); }
  const malformed = accepted(record, "forged-acceptance");
  if (malformed.observation.operation === "start" && malformed.observation.result.kind === "accepted") malformed.observation.result.evidence.unitName = "another.service";
  assert.throws(() => f.journal.recordObservation(malformed), { code: "conflict" });
  assert.deepEqual(f.journal.observations(record.declaration.jobId), [initial]);
  assert.equal(f.journal.recordObservation(present(record)).sequence, 2);
});

test("accessors, cyclic values, sparse arguments and coercible result enums are rejected before storage", async t => {
  const f = await fixture(t); let read = false;
  const accessor = declaration(); Object.defineProperty(accessor, "jobId", { enumerable: true, get() { read = true; return "getter-job"; } });
  assert.throws(() => f.journal.prepareIntent(accessor), /Accessors/u); assert.equal(read, false);
  const sparse = declaration(); sparse.request.command.args = new Array(2) as string[];
  assert.throws(() => f.journal.prepareIntent(sparse), /dense/u);
  const cyclic = declaration(); (cyclic.request.command.environment as unknown as Record<string, unknown>).LOOP = cyclic;
  assert.throws(() => f.journal.prepareIntent(cyclic), /acyclic/u);
  const { record } = f.journal.prepareIntent(declaration());
  const invalid = accepted(record); (invalid.observation as unknown as { operation: unknown }).operation = ["start"];
  assert.throws(() => f.journal.recordObservation(invalid), /enumeration/u);
  assert.deepEqual(f.journal.observations(record.declaration.jobId), []);
  const proto = accepted(record);
  if (proto.observation.operation === "start" && proto.observation.result.kind === "accepted") proto.observation.result.evidence = {
    ...proto.observation.result.evidence, ...JSON.parse('{"__proto__":{"observed":"literal JSON"}}') };
  const kept = f.journal.recordObservation(proto);
  assert.equal(Object.getPrototypeOf(kept.observation.result), Object.prototype);
});

test("accepted receipts require complete matching unit and host identity", async t => {
  const f = await fixture(t), { record } = f.journal.prepareIntent(declaration());
  const { identity, expectedHost } = record.declaration.request;
  for (const evidence of [{}, { invocationId: "1".repeat(32) }, { identity: { ...identity } }, { host: { ...expectedHost } },
    { unitName: identity.unitName, description: identity.description, machineId: expectedHost.machineId }]) {
    const input = accepted(record);
    if (input.observation.operation === "start" && input.observation.result.kind === "accepted") input.observation.result.evidence = evidence;
    assert.throws(() => f.journal.recordObservation(input), { code: "invalid" });
  }
  assert.equal(f.journal.observations(record.declaration.jobId).length, 0);
  f.journal.recordObservation(accepted(record));
  const scalar = accepted(record, "receipt-scalar");
  if (scalar.observation.operation === "start" && scalar.observation.result.kind === "accepted") scalar.observation.result.evidence = {
    unitName: identity.unitName, description: identity.description, machineId: expectedHost.machineId, bootId: expectedHost.bootId };
  assert.equal(f.journal.recordObservation(scalar).sequence, 2);
});

test("unsupported schemas fail without changing main bytes or retaining ownership", async t => {
  const directory = await mkdtemp(join(tmpdir(), "foreign-job-journal-")); t.after(async () => rm(directory, { recursive: true, force: true }));
  for (const [name, sql] of [["foreign", "CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES('schema_version','1')"],
    ["future", "CREATE TABLE journal_meta(key TEXT,value TEXT); INSERT INTO journal_meta VALUES('journal_kind','linux-supervisor-job-journal'),('schema_version','999')"]]) {
    const path = join(directory, `${name}.sqlite`), db = new DatabaseSync(path); db.exec(sql!); db.close();
    const before = await readFile(path);
    for (let attempt = 0; attempt < 2; attempt++) assert.throws(() => openJobJournal({ path }), { code: "invalid" });
    assert.deepEqual(await readFile(path), before);
  }
});

test("one live owner excludes canonical aliases and preserves its crash-safe lock file", async t => {
  const f = await fixture(t);
  assert.throws(() => openJobJournal({ path: f.path }), { code: "owned" });
  const directoryAlias = `${f.directory}-alias`; await symlink(f.directory, directoryAlias);
  t.after(async () => rm(directoryAlias, { force: true }));
  assert.throws(() => openJobJournal({ path: join(directoryAlias, "journal.sqlite") }), { code: "owned" });
  const fileAlias = join(f.directory, "alias.sqlite"); await symlink(f.path, fileAlias);
  assert.throws(() => openJobJournal({ path: fileAlias }), { code: "invalid" });
  const hardLink = join(f.directory, "hard.sqlite"); await link(f.path, hardLink);
  assert.throws(() => openJobJournal({ path: hardLink }), { code: "invalid" }); await rm(hardLink);
  f.journal.close(); const owner = await readFile(`${f.path}.owner.sqlite`);
  f.reopen(); assert.deepEqual(await readFile(`${f.path}.owner.sqlite`), owner);
});

async function crashWorker(path: string, phase: string) {
  const child = spawn(process.execPath, ["--import", "tsx", resolve("test/execution/fixtures/journal-crash-worker.ts"), path, phase, JSON.stringify(declaration())],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += String(chunk); });
  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Crash fixture timed out: ${stderr}`)); }, 10_000);
    child.stdout.on("data", chunk => { if (String(chunk).includes("ready")) { clearTimeout(timeout); resolveReady(); } });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Crash fixture exited early (${code}): ${stderr}`)); });
  });
  return child;
}

test("SIGKILL releases exclusive ownership and preserves only committed intents without replay", async t => {
  const directory = await mkdtemp(join(tmpdir(), "job-journal-crash-")); t.after(async () => rm(directory, { recursive: true, force: true }));
  for (const phase of ["before-commit", "after-commit"]) {
    const path = join(directory, `${phase}.sqlite`), child = await crashWorker(path, phase);
    try {
      assert.throws(() => openJobJournal({ path }), { code: "owned" });
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      const recovered = openJobJournal({ path, now: () => new Date(at) });
      try {
        const saved = recovered.read(declaration().jobId);
        assert.equal(saved !== null, phase === "after-commit");
        assert.equal(recovered.prepareIntent(declaration()).created, phase === "before-commit");
        assert.equal(recovered.read(declaration().jobId)!.latestObservation, null);
      } finally { recovered.close(); }
    } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } }
  }
});

test("clock errors roll back insertion, and constructor option errors never acquire an owner", async t => {
  const f = await fixture(t); f.journal.close();
  const path = f.path;
  assert.throws(() => openJobJournal({ path, get now(): () => Date { throw new Error("clock getter"); } }), /clock getter/u);
  const journal = openJobJournal({ path, now: () => new Date(NaN) });
  try { assert.throws(() => journal.prepareIntent(declaration())); assert.equal(journal.read(declaration().jobId), null); }
  finally { journal.close(); }
  f.reopen(); assert.equal(f.journal.prepareIntent(declaration()).created, true);
});

test("empty or invalid invocation/state and unbound cgroup evidence cannot establish execution", async t => {
  const f = await fixture(t), { record } = f.journal.prepareIntent(declaration());
  const variants = [{ invocationId: "" }, { invocationId: "0".repeat(32) }, { loadState: "" }, { activeState: "invented" },
    { subState: "" }, { result: "" }, { controlGroup: "", cgroupPopulated: false }, { controlGroup: "/system.slice/other.service", cgroupPopulated: false },
    { execMainCode: 7 }, { execMainStatus: 256 }, { mainPid: 0x1_0000_0000 }];
  for (const changes of variants) {
    const input = present(record);
    if (input.observation.operation === "query" && input.observation.result.kind === "present") Object.assign(input.observation.result.snapshot, changes);
    assert.throws(() => f.journal.recordObservation(input), { code: "invalid" });
  }
  assert.equal(f.journal.observations(record.declaration.jobId).length, 0);
  // Manager properties and cgroup membership can race; preserve the raw fact
  // without claiming that a nonzero PID and empty cgroup establish termination.
  const raced = present(record);
  if (raced.observation.operation === "query" && raced.observation.result.kind === "present") raced.observation.result.snapshot.cgroupPopulated = false;
  assert.equal(f.journal.recordObservation(raced).observation.operation, "query");
});
