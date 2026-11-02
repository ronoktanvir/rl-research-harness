import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { dispatchNext, reconcileAction } from "../../src/controller/dispatcher.ts";
import { openJobJournal } from "../../src/execution/journal.ts";
import { createSystemdTransport } from "../../src/execution/systemd.ts";
import { createSupervisedExperimentBackend } from "../../src/execution/backend.ts";
import { PACKAGED_DEADLINE_GATE_PATH } from "../../src/execution/deadline-gate.ts";
import { hash } from "../../src/ledger/validation.ts";
import { CONVENTIONAL_SUPERVISED_BACKEND, createConventionalLaunchResolver, prepareConventionalAttempt } from "../../src/integrations/conventional/supervised.ts";
import { conventionalManifest, supervisedFixture } from "./supervised-fixtures.ts";
import { collectConventionalSupervised } from "../../src/integrations/conventional/supervised-collection.ts";

const python = process.env.HARNESS_TEST_CONVENTIONAL_SUPERVISED_PYTHON;
const enabled = process.env.HARNESS_TEST_SYSTEMD === "1" && !!python;
const executeFile = promisify(execFile);
test("actual bounded Gymnasium worker survives controller reopening under the native Linux supervisor", { skip: !enabled, timeout: 60_000 }, async () => {
  assert.equal(process.platform, "linux"); assert.notEqual(process.getuid!(), 0);
  const f = await supervisedFixture();
  let ledger = openExperimentLedger({ path: join(f.directory, "ledger.sqlite") });
  let journal = openJobJournal({ path: join(f.directory, "jobs.sqlite") });
  let unitName: string | undefined;
  try {
    const deployment = structuredClone(f.input.deployment), code = dirname(deployment.code.entry.path);
    const interpreter = await realpath(python!);
    assert.equal(interpreter, python, "CI must use a canonical copied venv interpreter outside /home");
    assert.ok(interpreter.startsWith("/tmp/"));
    const gatePython = await realpath("/usr/bin/python3"), gateScript = join(code, "deadline-gate.py");
    await copyFile(PACKAGED_DEADLINE_GATE_PATH, gateScript);
    deployment.environment.pythonExecutable = interpreter;
    deployment.profile.userId = process.getuid!(); deployment.profile.groupId = process.getgid!();
    deployment.profile.executables = [interpreter];
    deployment.profile.readOnlyPaths = [code, dirname(dirname(interpreter)), "/usr/bin"];
    deployment.profile.useSudo = true;
    deployment.profile.deadlineGate = { pythonExecutable: gatePython, scriptPath: gateScript, safetyMarginMs: 1000, barrierTimeoutMs: 1000 };
    deployment.trust.operatorReference = "Isolated CI fixture: staged source and pinned venv protected from the child by systemd. Image digest is a synthetic declaration, not observed OCI identity.";
    const native = createSystemdTransport({ profile: deployment.profile });
    deployment.host = await native.hostIdentity();
    const spec = structuredClone(f.plan.request);
    const { requestDigest: _digest, ...rawSpec } = spec;
    const manifest = conventionalManifest(rawSpec, deployment), registered = ledger.registerManifest(manifest);
    const run = { ...f.input.run, manifestDigest: registered.digest };
    const plan = prepareConventionalAttempt({ manifest: registered, run, operationRevision: 1, deployment });
    for (const scopeId of ["global", "project:frozenlake"]) {
      ledger.configureBudget({ scopeId, parentScopeId: scopeId === "global" ? null : "global", expectedRevision: 0, limitMicrodollars: 1000n });
      ledger.configurePolicy({ scopeId, expectedVersion: 0, allowedBackends: [CONVENTIONAL_SUPERVISED_BACKEND], allowedOperations: ["launch", "cancel"], requiredChecks: [] });
    }
    ledger.createRun(run);
    const action = ledger.admitAction({ runId: run.runId, operation: "launch", operationRevision: 1, backend: CONVENTIONAL_SUPERVISED_BACKEND,
      payload: { attemptPlanDigest: plan.digest }, reservation: { amountMicrodollars: 1n, category: "compute", basis: "One bounded native CI fixture; accounting assertion only." } });
    let starts = 0;
    const transport = { ...native, async start(...args: Parameters<typeof native.start>) { starts++; return native.start(...args); } };
    const backend = (reopened = false) => createSupervisedExperimentBackend({ name: CONVENTIONAL_SUPERVISED_BACKEND, workerId: deployment.workerId,
      ledger, journal, transport, prepareLaunch: reopened ? async () => { throw new Error("Recovery must never prepare another launch"); }
        : createConventionalLaunchResolver({ ledger, deployment, authorizeDeployment: () => true }) });
    const dispatched = await dispatchNext(ledger, [backend()], { workerId: deployment.workerId,
      deadlineAt: new Date(Date.now() + 40_000).toISOString(), timeoutMs: 15_000 });
    const job = journal.readByAction(action.actionId);
    assert.ok(job, `No supervised intent: ${JSON.stringify(dispatched)}`); unitName = job.declaration.request.identity.unitName;
    ledger.close(); journal.close();
    ledger = openExperimentLedger({ path: join(f.directory, "ledger.sqlite") });
    journal = openJobJournal({ path: join(f.directory, "jobs.sqlite") });
    const recovered = backend(true), deadline = Date.now() + 15_000;
    if (ledger.getAction(action.actionId).state === "unknown") await reconcileAction(ledger, recovered, action.actionId);
    let terminal: Awaited<ReturnType<typeof recovered.observe>> | undefined;
    while (Date.now() < deadline) {
      terminal = await recovered.observe(action.actionId, new AbortController().signal);
      if (terminal.result.execution === "succeeded" || terminal.result.execution === "failed") break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(terminal?.result.execution, "succeeded", JSON.stringify(terminal?.result));
    assert.equal(ledger.getRun(run.runId).execution, "succeeded");
    assert.equal(ledger.getRun(run.runId).evaluation, "unassessed");
    assert.equal(starts, 1);
    assert.equal(journal.readByAction(action.actionId)!.declaration.planDigest, plan.digest);
    assert.equal(hash(plan.declarations.manifest.manifest), run.manifestDigest);
    const saved = journal.observations(job.declaration.jobId).find(observation => observation.observationId === terminal!.result.observationId);
    assert.ok(saved); assert.equal(saved.observation.operation, "query");
    if (saved.observation.operation === "query" && saved.observation.result.kind === "present") {
      assert.equal(saved.observation.result.snapshot.cgroupPopulated, false);
      assert.ok(saved.observation.result.snapshot.cleanupEvidence);
    } else { assert.fail("Expected owned terminal service observation"); }
    const beforeCollection = ledger.getAction(action.actionId);
    const collected = await collectConventionalSupervised({ ledger, journal }, { collectionId: "native-complete",
      actionId: action.actionId, plan, observationId: saved.observationId, observationDigest: saved.digest });
    assert.equal(collected.payload.status, "completed", JSON.stringify(collected.payload));
    assert.equal(collected.payload.scientificReplicationCount, 1);
    assert.equal(collected.payload.scientificEvaluation, "unassessed");
    assert.equal(ledger.getRun(run.runId).evaluation, "unassessed");
    assert.deepEqual(ledger.getAction(action.actionId), beforeCollection);
  } finally {
    ledger.close(); journal.close();
    if (unitName) {
      assert.match(unitName, /^rlh-[a-f0-9]{64}\.service$/);
      for (const operation of ["stop", "reset-failed"]) {
        await executeFile("/usr/bin/sudo", ["-n", "--", "/usr/bin/systemctl", "--system", "--no-pager", "--no-ask-password", operation, "--", unitName],
          { timeout: 4000, maxBuffer: 4096 }).catch(() => {});
      }
    }
    await f.close();
  }
});
