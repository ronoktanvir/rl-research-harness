import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir, writeFile, symlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { hash } from "../../src/ledger/validation.ts";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { openJobJournal } from "../../src/execution/journal.ts";
import { createSupervisedExperimentBackend } from "../../src/execution/backend.ts";
import type { ServiceLaunchRequest, SystemdTransport } from "../../src/execution/types.ts";
import { dispatchNext, reconcileAction } from "../../src/controller/dispatcher.ts";
import { CONVENTIONAL_SUPERVISED_BACKEND, createConventionalLaunchResolver, prepareConventionalAttempt } from "../../src/integrations/conventional/supervised.ts";
import { conventionalManifest, supervisedFixture, supervisedSpec } from "./supervised-fixtures.ts";

const now = () => new Date("2026-11-02T12:00:00.000Z");
const deadlineAt = "2026-11-02T12:00:30.000Z";
function register(f: Awaited<ReturnType<typeof supervisedFixture>>) {
  const ledger = openExperimentLedger({ path: join(f.directory, "ledger.sqlite"), now });
  for (const scopeId of ["global", "project:frozenlake"]) {
    ledger.configureBudget({ scopeId, parentScopeId: scopeId === "global" ? null : "global", expectedRevision: 0, limitMicrodollars: 1000n });
    ledger.configurePolicy({ scopeId, expectedVersion: 0, allowedBackends: [CONVENTIONAL_SUPERVISED_BACKEND], allowedOperations: ["launch", "cancel"], requiredChecks: [] });
  }
  ledger.registerManifest(f.input.manifest.manifest); ledger.createRun(f.input.run);
  const action = ledger.admitAction({ runId: f.input.run.runId, operation: "launch", operationRevision: 1,
    backend: CONVENTIONAL_SUPERVISED_BACKEND, payload: { attemptPlanDigest: f.plan.digest },
    reservation: { amountMicrodollars: 1n, category: "compute", basis: "offline fixture" } });
  return { ledger, action };
}

test("supervised plan binds one replica, exact sources/profile/request and deterministic action outputs", async t => {
  const f = await supervisedFixture(); t.after(f.close);
  const { digest, ...body } = f.plan;
  assert.equal(digest, hash(body)); assert.equal(f.plan.binding.actionId, `action:${hash(["run-one", "launch", 1])}`);
  assert.deepEqual(f.plan.command.args.slice(0, 4), ["-I", "-B", f.input.deployment.code.entry.path, "envelope-v1"]);
  const envelope = JSON.parse(Buffer.from(f.plan.command.args.slice(5).join(""), "base64").toString("utf8"));
  assert.equal(envelope.binding.actionId, f.plan.binding.actionId); assert.deepEqual(JSON.parse(envelope.requestJson), f.plan.request);
  assert.equal(envelope.output.directoryName, f.plan.outputs.directoryName);
  assert.equal(f.plan.profileDigest, hash(f.input.deployment.profile)); assert.ok(Object.isFrozen(f.plan.command.args));
  assert.deepEqual(await readdir(f.input.deployment.outputRoot), []);
});

test("scientific identity, replica count, seed scope and profile cannot silently drift", async t => {
  const f = await supervisedFixture(); t.after(f.close);
  const alter = (change: (value: typeof f.input) => void) => {
    const value = structuredClone(f.input); change(value);
    value.manifest.digest = hash(value.manifest.manifest); value.run.manifestDigest = value.manifest.digest;
    assert.throws(() => prepareConventionalAttempt(value));
  };
  alter(value => { value.run.replicaId = "other"; });
  alter(value => { value.manifest.manifest.seeds.pop(); });
  alter(value => { value.manifest.manifest.evaluator.version = "other-evaluator"; });
  alter(value => { value.manifest.manifest.resources.maxDurationSeconds = 1; });
  alter(value => { value.deployment.profile.readOnlyPaths = ["/unrelated"]; });
  alter(value => { value.deployment.profile.writableRoot = "/other"; });
  alter(value => { value.deployment.environment.dependenciesDigest = "0".repeat(64); });
  alter(value => { value.run.lineage = { parentRunId: "parent", checkpointDigest: "0".repeat(64) }; });
  alter(value => {
    const spec = structuredClone(supervisedSpec); spec.replicates.push({ replicateId: "second", policySeed: 32, trainingEpisodeSeeds: [21] });
    value.manifest.manifest = conventionalManifest(spec, value.deployment);
  });
  let calls = 0;
  assert.throws(() => prepareConventionalAttempt({ ...f.input, get deployment() { calls++; return f.input.deployment; } }));
  assert.equal(calls, 0);
});

test("resolver is read-only, hashes current files and keeps image/deployment assumptions explicit", async t => {
  const f = await supervisedFixture(); t.after(f.close);
  const { ledger } = register(f); t.after(() => ledger.close());
  const claim = ledger.claimDispatch({ workerId: f.input.deployment.workerId, deadlineAt })!;
  let allowed = true;
  const resolver = createConventionalLaunchResolver({ ledger, deployment: f.input.deployment, authorizeDeployment: () => allowed });
  const prepared = (await resolver(claim, new AbortController().signal))!;
  assert.equal(prepared.declaration.planDigest, f.plan.digest); assert.deepEqual(prepared.declaration.request.command, f.plan.command);
  assert.equal(prepared.evidence.imageMeaning, "operator_declaration_not_oci_attestation");
  assert.equal(prepared.evidence.sourceMeaning, "bounded_current_byte_observations_not_immutability_proof");
  assert.deepEqual(await readdir(f.input.deployment.outputRoot), []);
  allowed = false; assert.equal(prepared.authorizeDeployment(), false);
  assert.equal(await resolver(claim, new AbortController().signal), null);
});

test("changed source bytes or alias substitution deny preparation without creating outputs", async t => {
  const f = await supervisedFixture(); t.after(f.close);
  const { ledger } = register(f); t.after(() => ledger.close());
  const claim = ledger.claimDispatch({ workerId: f.input.deployment.workerId, deadlineAt })!;
  const resolver = createConventionalLaunchResolver({ ledger, deployment: f.input.deployment, authorizeDeployment: () => true });
  const path = f.input.deployment.code.runner.path, original = await readFile(path);
  await writeFile(path, "changed");
  await assert.rejects(resolver(claim, new AbortController().signal), /hash mismatch/);
  await writeFile(path, original); await rename(path, `${path}.real`); await symlink(`${path}.real`, path);
  await assert.rejects(resolver(claim, new AbortController().signal), /alias/);
  assert.deepEqual(await readdir(f.input.deployment.outputRoot), []);
});

test("real ledger/journal lost start response reconciles by querying without another resolver or start", async t => {
  const f = await supervisedFixture(); t.after(f.close);
  let { ledger, action } = register(f);
  let journal = openJobJournal({ path: join(f.directory, "jobs.sqlite"), now });
  t.after(() => { ledger.close(); journal.close(); });
  let starts = 0, prepares = 0, launched: ServiceLaunchRequest | undefined, known = false;
  const transport: SystemdTransport = { async hostIdentity() { return f.input.deployment.host; },
    async start(request, _signal, authorize) { assert.equal(authorize(), true); starts++; launched = request; return { kind: "unknown", reason: "fixture_reply_lost" }; },
    async query() {
      if (!known || !launched) return { kind: "unknown", reason: "fixture_temporarily_unavailable" };
      return { kind: "present", snapshot: { identity: launched.identity, host: launched.expectedHost, observedAt: now().toISOString(),
        invocationId: "d".repeat(32), loadState: "loaded", activeState: "active", subState: "running", result: "success", mainPid: 123,
        execMainCode: 0, execMainStatus: 0, controlGroup: `/system.slice/${launched.identity.unitName}`, cgroupPopulated: true } };
    }, async stop() { return { command: "not_sent", observation: { kind: "unknown", reason: "unused" } }; } };
  function backend(recoverOnly = false) {
    const resolver = createConventionalLaunchResolver({ ledger, deployment: f.input.deployment, authorizeDeployment: () => true });
    return createSupervisedExperimentBackend({ name: CONVENTIONAL_SUPERVISED_BACKEND, workerId: f.input.deployment.workerId,
      ledger, journal, transport, now, prepareLaunch: async (claim, signal) => { prepares++; assert.equal(recoverOnly, false); return resolver(claim, signal); } });
  }
  assert.equal((await dispatchNext(ledger, [backend()], { workerId: f.input.deployment.workerId, deadlineAt, timeoutMs: 1000 }))?.state, "unknown");
  ledger.close(); journal.close();
  ledger = openExperimentLedger({ path: join(f.directory, "ledger.sqlite"), now }); journal = openJobJournal({ path: join(f.directory, "jobs.sqlite"), now }); known = true;
  assert.equal((await reconcileAction(ledger, backend(true), action.actionId)).state, "acknowledged");
  assert.equal(starts, 1); assert.equal(prepares, 1);
  assert.equal(ledger.getRun(action.runId).evaluation, "unassessed"); assert.equal(ledger.getAction(action.actionId).allocation, "unknown");
});
