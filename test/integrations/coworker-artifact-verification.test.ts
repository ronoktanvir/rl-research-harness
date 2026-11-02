import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, mkdir, writeFile, rm, chmod, symlink, link, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { hash } from "../../src/ledger/validation.ts";
import { runProcess } from "../../src/workers/process.ts";
import { prepareCoworkerAttempt } from "../../src/integrations/coworker/attempt-plan.ts";
import { inventoryCoworkerSource, verifyCoworkerArtifacts, COWORKER_SOURCE_INVENTORY_ALGORITHM as algorithm } from "../../src/integrations/coworker/artifact-verification.ts";
import type { ArtifactVerificationOptions, SourceInventoryResult } from "../../src/integrations/coworker/artifact-verification.ts";
import { coworkerAttemptFixture, rebindCoworkerFixture } from "./coworker-attempt-fixtures.ts";

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const request = { sourceInventoryAlgorithm: algorithm } as const;
const now = () => new Date("2026-11-02T12:00:00.000Z");
function inventory(result: SourceInventoryResult) { if (!result.ok) assert.fail(result.problem); return result.inventory; }
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rlh-artifacts-")));
  const source = join(root, "source"), inputs = join(root, "inputs");
  await mkdir(join(source, "empty"), { recursive: true });
  await mkdir(join(source, "src"));
  await mkdir(join(inputs, "tasks"), { recursive: true });
  await mkdir(join(inputs, "qualification"));
  await writeFile(join(source, "src", "fit_loop.py"), "raise RuntimeError('must never import')\n");
  await writeFile(join(source, "binary"), Buffer.from([0, 255, 254, 17]));
  await writeFile(join(inputs, "tasks", "manifest.json"), "{not even valid JSON}");
  await writeFile(join(inputs, "qualification", "receipt.json"), "untrusted scientific assertion");
  const input = coworkerAttemptFixture();
  input.configuration.source.root = source;
  input.configuration.source.treeSha256 = inventory(await inventoryCoworkerSource(source)).sha256;
  input.configuration.paths.inputRoot = inputs;
  input.configuration.paths.outputRoot = join(root, "output");
  input.configuration.inputs.experimentManifest.sha256 = sha("{not even valid JSON}");
  input.configuration.inputs.numericalQualificationReceipt.sha256 = sha("untrusted scientific assertion");
  return { root, source, inputs, input, plan: () => prepareCoworkerAttempt(rebindCoworkerFixture(input)), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("whole-tree hash is reproducible, includes binary bytes, empty directories and executable bits", async () => {
  const f = await fixture();
  try {
    const first = inventory(await inventoryCoworkerSource(f.source));
    const second = inventory(await inventoryCoworkerSource(f.source));
    assert.deepEqual(second, first);
    assert.equal(first.entries.find(entry => entry.path === "empty")?.kind, "directory");
    const binary = first.entries.find(entry => entry.path === "binary");
    assert.equal(binary?.kind, "file"); if (binary?.kind === "file") assert.equal(binary.sha256, sha(Buffer.from([0, 255, 254, 17])));
    const { sha256, ...body } = first; assert.equal(hash(body), sha256);
    await chmod(join(f.source, "binary"), 0o755);
    assert.notEqual(inventory(await inventoryCoworkerSource(f.source)).sha256, first.sha256);
    await mkdir(join(f.source, ".git")); await writeFile(join(f.source, ".git", "HEAD"), "not a revision proof");
    assert.ok(inventory(await inventoryCoworkerSource(f.source)).entries.some(entry => entry.path === ".git/HEAD"));
  } finally { await f.cleanup(); }
});

test("matching bytes produce a bound frozen receipt while every unsupported execution check stays pending", async () => {
  const f = await fixture();
  try {
    const plan = f.plan(); const receipt = await verifyCoworkerArtifacts(plan, request, { now });
    assert.equal(receipt.byteChecks, "matched"); assert.equal(receipt.launchSupported, false);
    assert.equal(receipt.qualification, "byte_observation_only");
    assert.deepEqual(receipt.binding, { planDigest: plan.digest, actionId: plan.binding.actionId, manifestDigest: plan.binding.manifestDigest });
    assert.equal(receipt.pending.length, 8); assert.ok(receipt.pending.every(check => check.status === "pending"));
    assert.ok(receipt.pending.some(check => check.check === "native_preflight"));
    assert.equal(receipt.inputs[0]?.matched, true, "malformed JSON is byte evidence only, never semantic approval");
    assert.ok(Object.isFrozen(receipt.source.inventory?.entries));
    const { digest, ...body } = receipt; assert.equal(digest, hash(body));
  } finally { await f.cleanup(); }
});

test("modified source or explicit input bytes produce mismatches rather than passing declarations", async () => {
  const f = await fixture();
  try {
    const plan = f.plan();
    await writeFile(join(f.source, "binary"), "changed");
    await writeFile(join(f.inputs, "tasks", "manifest.json"), "changed input");
    const receipt = await verifyCoworkerArtifacts(plan, request);
    assert.equal(receipt.byteChecks, "mismatched"); assert.equal(receipt.source.matched, false);
    assert.equal(receipt.inputs[0]?.matched, false); assert.equal(receipt.inputs[1]?.matched, true);
  } finally { await f.cleanup(); }
});

test("native adapter fingerprint remains unsupported and its directory is not silently read", async () => {
  const f = await fixture();
  try {
    f.input.configuration.inputs.initialAdapter = { directory: "not-present", fingerprintSha256: "f".repeat(64) };
    const receipt = await verifyCoworkerArtifacts(f.plan(), request);
    assert.equal(receipt.byteChecks, "matched");
    assert.ok(receipt.pending.some(check => check.check === "initial_adapter_fingerprint"));
    assert.equal(receipt.launchSupported, false);
  } finally { await f.cleanup(); }
});

test("resume hashes checkpoint and origin JSON bytes without claiming tensor or boundary validity", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.inputs, "prior", "step-1"), { recursive: true });
    await writeFile(join(f.inputs, "prior", "step-1", "checkpoint.json"), "checkpoint metadata only");
    await writeFile(join(f.inputs, "prior", "run-evidence.json"), "origin metadata only");
    const checkpoint = { relativePath: "prior/step-1/checkpoint.json", sha256: sha("checkpoint metadata only") };
    f.input.configuration.inputs.resume = { parentRunId: "prior", checkpoint,
      originRunEvidence: { relativePath: "prior/run-evidence.json", sha256: sha("origin metadata only") } };
    f.input.run.lineage = { parentRunId: "prior", checkpointDigest: checkpoint.sha256 };
    const receipt = await verifyCoworkerArtifacts(f.plan(), request);
    assert.equal(receipt.byteChecks, "matched"); assert.equal(receipt.inputs.length, 4);
    assert.ok(receipt.pending.some(check => check.check === "checkpoint_tensors_and_identity"));
    assert.ok(receipt.pending.some(check => check.check === "resume_boundary"));
  } finally { await f.cleanup(); }
});

test("source file, nested directory and root-ancestor symlinks are refused", async () => {
  const f = await fixture();
  try {
    await symlink(join(f.source, "binary"), join(f.source, "linked"));
    assert.deepEqual(await inventoryCoworkerSource(f.source), { ok: false, problem: "unsafe_path" });
    await rm(join(f.source, "linked"));
    await symlink(join(f.source, "empty"), join(f.source, "linked"));
    assert.deepEqual(await inventoryCoworkerSource(f.source), { ok: false, problem: "unsafe_path" });
    await rm(join(f.source, "linked"));
    await symlink(f.root, join(f.root, "ancestor"));
    assert.deepEqual(await inventoryCoworkerSource(join(f.root, "ancestor", "source")), { ok: false, problem: "unsafe_path" });
  } finally { await f.cleanup(); }
});

test("hardlinked source or input files are refused even when their bytes match", async () => {
  const f = await fixture();
  try {
    const plan = f.plan();
    await link(join(f.source, "binary"), join(f.root, "outside-hardlink"));
    assert.deepEqual(await inventoryCoworkerSource(f.source), { ok: false, problem: "unsafe_path" });
    await rm(join(f.root, "outside-hardlink"));
    await link(join(f.inputs, "tasks", "manifest.json"), join(f.root, "outside-hardlink"));
    const receipt = await verifyCoworkerArtifacts(plan, request);
    assert.equal(receipt.byteChecks, "unavailable"); assert.equal(receipt.readProblem, "unsafe_path");
    assert.equal(receipt.source.inventory, null, "a failed combined observation does not publish a partial passing inventory");
  } finally { await f.cleanup(); }
});

test("explicit input parent symlinks and missing files fail closed", async () => {
  const f = await fixture();
  try {
    const plan = f.plan(); await rm(join(f.inputs, "tasks"), { recursive: true });
    await symlink(join(f.inputs, "qualification"), join(f.inputs, "tasks"));
    assert.equal((await verifyCoworkerArtifacts(plan, request)).readProblem, "unsafe_path");
    await rm(join(f.inputs, "tasks"));
    assert.equal((await verifyCoworkerArtifacts(plan, request)).readProblem, "missing");
  } finally { await f.cleanup(); }
});

test("file, aggregate, count and depth bounds cannot be bypassed by malformed limits", async () => {
  const f = await fixture();
  try {
    for (const limits of [{ maxFileBytes: 2 }, { maxTotalBytes: 3 }, { maxFiles: 1 }, { maxDirectories: 1 }]) {
      assert.deepEqual(await inventoryCoworkerSource(f.source, { limits }), { ok: false, problem: "limit_exceeded" });
    }
    await mkdir(join(f.source, "empty", "deeper"));
    assert.deepEqual(await inventoryCoworkerSource(f.source, { limits: { maxDepth: 1 } }), { ok: false, problem: "limit_exceeded" });
    for (const maxFiles of [NaN, Infinity, 0, 1.5, 4097]) await assert.rejects(inventoryCoworkerSource(f.source, { limits: { maxFiles } }));
    await assert.rejects(inventoryCoworkerSource(`${f.source}/../source`));
  } finally { await f.cleanup(); }
});

test("tampered preview, omitted algorithm and accessors fail before invoking a reader", async () => {
  const f = await fixture(); let calls = 0;
  const options: ArtifactVerificationOptions = { execute: async () => { calls++; throw new Error("must not execute"); } };
  try {
    const plan = structuredClone(f.plan());
    (plan.command.args as string[]).push("--unbound");
    await assert.rejects(verifyCoworkerArtifacts(plan, request, options), /preview/u);
    await assert.rejects(verifyCoworkerArtifacts(f.plan(), {} as typeof request, options));
    await assert.rejects(verifyCoworkerArtifacts(f.plan(), { sourceInventoryAlgorithm: [algorithm] } as unknown as typeof request, options));
    const getterPlan = { ...f.plan(), get digest() { calls++; return "x"; } };
    await assert.rejects(verifyCoworkerArtifacts(getterPlan, request, options), /accessors/u);
    const oversized = { ...f.plan(), digest: "x".repeat(1024 * 1024) };
    await assert.rejects(verifyCoworkerArtifacts(oversized, request, options), /byte bounds/u);
    assert.equal(calls, 0);
  } finally { await f.cleanup(); }
});

test("configured depth also bounds explicit input ancestors, including interpreted reader output", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.inputs, "nested", "deeper"), { recursive: true });
    await writeFile(join(f.inputs, "nested", "deeper", "manifest.json"), "{not even valid JSON}");
    f.input.configuration.inputs.experimentManifest.relativePath = "nested/deeper/manifest.json";
    const plan = f.plan();
    const receipt = await verifyCoworkerArtifacts(plan, request, { limits: { maxDepth: 1 } });
    assert.equal(receipt.byteChecks, "unavailable"); assert.equal(receipt.readProblem, "limit_exceeded");
    // The trusted-reader boundary is validated too; a forged success cannot ignore lower bounds.
    const bypass = await verifyCoworkerArtifacts(plan, request, { limits: { maxDepth: 1 }, execute: async input => {
      const parsed = JSON.parse(input.input); parsed.limits.maxDepth = 32;
      return runProcess({ ...input, input: JSON.stringify(parsed) });
    } });
    assert.equal(bypass.readProblem, "invalid_reader_output");
  } finally { await f.cleanup(); }
});

test("caller mutation after invocation cannot alter the retained plan, limits or receipt", async () => {
  const f = await fixture();
  try {
    const plan = structuredClone(f.plan()); const digest = plan.digest;
    const limits = { maxFiles: 100 }; let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const pending = verifyCoworkerArtifacts(plan, request, { limits, execute: async input => { await ready; return runProcess(input); } });
    (plan as unknown as { digest: string }).digest = "0".repeat(64);
    (plan.declarations.configuration.source as unknown as { root: string }).root = "/not-the-root";
    limits.maxFiles = 1; release();
    const receipt = await pending;
    assert.equal(receipt.binding.planDigest, digest); assert.equal(receipt.limits.maxFiles, 100); assert.equal(receipt.byteChecks, "matched");
  } finally { await f.cleanup(); }
});

test("reader cancellation, timeout and malformed output never become passing byte evidence", async () => {
  const f = await fixture();
  try {
    let calls = 0; const abort = new AbortController(); abort.abort();
    assert.deepEqual(await inventoryCoworkerSource(f.source, { signal: abort.signal, execute: async () => { calls++; throw new Error(); } }), { ok: false, problem: "cancelled" });
    assert.equal(calls, 0);
    for (const stopped of ["timeout", "cancelled", "output_limit", "spawn_error"] as const) {
      const receipt = await verifyCoworkerArtifacts(f.plan(), request, { execute: async () => ({ exitCode: null, stdout: "", stderr: "", stopped }) });
      assert.equal(receipt.byteChecks, "unavailable"); assert.equal(receipt.launchSupported, false);
    }
    const receipt = await verifyCoworkerArtifacts(f.plan(), request, { execute: async () => ({ exitCode: 0, stdout: '{"ok":true}', stderr: "", stopped: null }) });
    assert.equal(receipt.readProblem, "invalid_reader_output");
  } finally { await f.cleanup(); }
});

test("actual confined reader rejects FIFO without blocking and detects mutation during a read", async () => {
  const f = await fixture();
  const helper = fileURLToPath(new URL("../../src/integrations/coworker/artifact-verification-reader.py", import.meta.url));
  const python = (script: string) => runProcess({ executable: "python3", args: ["-I", "-S", "-c", script, helper, f.source],
    cwd: f.root, env: { PATH: process.env.PATH }, input: "", timeoutMs: 5000, maxOutputBytes: 5000 });
  try {
    const fifo = await python("import os,sys; os.mkfifo(os.path.join(sys.argv[2],'fifo'))"); assert.equal(fifo.exitCode, 0);
    assert.deepEqual(await inventoryCoworkerSource(f.source), { ok: false, problem: "unsafe_path" });
    await rm(join(f.source, "fifo"));
    const result = await python(`import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location('trusted_reader',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
original=m.os.read
changed=False
def mutate(fd,size):
 global changed
 data=original(fd,size)
 if data and not changed:
  changed=True
  with open(os.path.join(sys.argv[2],'binary'),'wb') as out: out.write(b'changed while reading')
 return data
m.os.read=mutate
try: print(json.dumps(m.run({'sourceRoot':sys.argv[2],'inputRoot':None,'inputs':[],'limits':m.CAPS})))
except m.Rejected as error: print(json.dumps({'ok':False,'problem':error.problem}))`);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, problem: "changed_during_read" });
    assert.equal(await readFile(join(f.source, "src", "fit_loop.py"), "utf8"), "raise RuntimeError('must never import')\n");
  } finally { await f.cleanup(); }
});
