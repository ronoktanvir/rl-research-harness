import assert from "node:assert/strict";
import { appendFile, link, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { encode, hash } from "../../src/ledger/validation.ts";
import type { ObservationInput, ObservationRecord } from "../../src/ledger/types.ts";
import { coworkerReplayEvidenceId, importCoworkerReplayEvidence, loadCoworkerReplayEvidence, prepareReplayEvidenceRequest, summarizeCoworkerReplayEvidence } from "../../src/integrations/coworker/replay-evidence.ts";
import type { ReplayEvidenceRecord } from "../../src/integrations/coworker/replay-evidence.ts";
import { createReplayEvidenceFixture, prepareReplayEvidenceFixture, replayFixtureSha } from "./coworker-replay-evidence-fixtures.ts";

function signed(record: ReplayEvidenceRecord): ReplayEvidenceRecord {
  const { digest: _digest, ...body } = record;
  return { ...body, digest: hash(body) };
}
function archiveWith(record: ReplayEvidenceRecord) {
  return { getObservation: (eventId: string) => eventId === record.eventId ? record as unknown as ObservationRecord : null };
}
function rebindBundle(record: ReplayEvidenceRecord): ReplayEvidenceRecord {
  const bundle = record.payload.bundle, { digest: _digest, ...receipt } = bundle.receipt;
  const nextReceipt = { ...receipt, executionDigest: hash(bundle.execution) };
  bundle.receipt = { ...nextReceipt, digest: hash(nextReceipt) };
  record.payload.request.expected.executionDigest = hash(bundle.execution);
  record.payload.request.expected.receiptDigest = bundle.receipt.digest;
  record.payload.bundleDigest = hash(bundle);
  return signed(record);
}

test("replay import stores one unlinked private observation and exposes only a redacted summary", async t => {
  const f = await createReplayEvidenceFixture(t), record = f.record;
  assert.equal(record.eventId, coworkerReplayEvidenceId("alpha", "episode-1"));
  assert.equal(record.projectId, "alpha");
  assert.deepEqual([record.runId, record.actionId, record.jobId, record.sequence], [null, null, null, 0]);
  assert.equal(f.ledger.listObservations("alpha").length, 1);
  assert.equal(record.payload.bundleDigest, hash(f.bundle));
  assert.equal(record.payload.bundle.execution.output!.result!.worldFacts.length, 2);
  assert.equal(record.payload.bundle.execution.output!.result!.requiredFactIds.length, 2);
  assert.match(record.payload.bundle.execution.output!.result!.memo, /PRIVATE-MEMO/);
  assert.equal(record.payload.originStatus, "operator_declared");
  assert.equal(record.payload.sourceCustody, "not_authenticated");
  assert.equal(record.payload.interventionAuthorized, false);
  const summary = summarizeCoworkerReplayEvidence(record);
  assert.equal(summary.requiredFacts, 2); assert.equal(summary.authorizedObservedFacts, 1);
  assert.equal(summary.observedNumericCredits, 1);
  assert.equal(summary.semanticEvaluation, "unassessed"); assert.equal(summary.taskSuccess, "unassessed");
  assert.equal(summary.scientificEvaluation, "unassessed"); assert.equal(summary.interventionAuthorized, false);
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE-|definitely-missing-python|sourceReference|worldFactsSha256/);
  assert.ok(Object.isFrozen(record) && Object.isFrozen(record.payload.bundle.execution.output!.result!.worldFacts));
});

test("reopen and exact retry recover the archived bundle after every artifact directory is removed", async t => {
  const f = await createReplayEvidenceFixture(t), before = f.record;
  f.ledger.close();
  await rm(f.artifactRoot, { recursive: true });
  const reopened = openExperimentLedger({ path: f.database });
  try {
    assert.deepEqual(loadCoworkerReplayEvidence(reopened, before.eventId), before);
    assert.deepEqual(await importCoworkerReplayEvidence(reopened, f.request, { artifactRoot: f.artifactRoot,
      now() { throw new Error("cached import must not need a fresh clock"); } }), before);
    assert.equal(reopened.listObservations("alpha").length, 1);
  } finally { reopened.close(); }
});

test("cached retry binds root, bundle path, all expected digests and the complete origin claim", async t => {
  const f = await createReplayEvidenceFixture(t);
  await rm(f.artifactRoot, { recursive: true });
  const changes = [
    (r: typeof f.request) => { r.bundlePath = "other/episode"; },
    (r: typeof f.request) => { r.expected.requestDigest = "0".repeat(64); },
    (r: typeof f.request) => { r.expected.executionDigest = "0".repeat(64); },
    (r: typeof f.request) => { r.expected.receiptDigest = "0".repeat(64); },
    (r: typeof f.request) => { r.origin.kind = "saved_episode_unverified"; },
    (r: typeof f.request) => { r.origin.description = "different origin claim"; },
    (r: typeof f.request) => { r.origin.sourceReference.locator = "fixture:another"; },
    (r: typeof f.request) => { r.origin.sourceReference.sha256 = "0".repeat(64); },
  ];
  for (const change of changes) {
    const request = structuredClone(f.request); change(request);
    await assert.rejects(importCoworkerReplayEvidence(f.ledger, request, { artifactRoot: f.artifactRoot }), /identity conflict/);
  }
  await assert.rejects(importCoworkerReplayEvidence(f.ledger, f.request, { artifactRoot: join(f.base, "different-root") }), /identity conflict/);
  assert.equal(f.ledger.listObservations("alpha").length, 1);
});

test("project identity separates imports and cannot be rewritten only in a signed envelope", async t => {
  const f = await createReplayEvidenceFixture(t);
  const other = await importCoworkerReplayEvidence(f.ledger, { ...f.request, projectId: "beta" }, { artifactRoot: f.artifactRoot });
  assert.notEqual(other.eventId, f.record.eventId);
  assert.equal(other.projectId, "beta"); assert.equal(other.payload.request.projectId, "beta");
  const forged = structuredClone(f.record); forged.projectId = "beta";
  assert.throws(() => loadCoworkerReplayEvidence(archiveWith(signed(forged)), forged.eventId), /project or event/);
});

test("request and trusted root are captured before asynchronous artifact reads", async t => {
  const f = await prepareReplayEvidenceFixture(t), original = structuredClone(f.request), root = f.artifactRoot;
  const options = { artifactRoot: root }, pending = importCoworkerReplayEvidence(f.ledger, f.request, options);
  f.request.origin.description = "changed after call";
  f.request.expected.executionDigest = "0".repeat(64);
  options.artifactRoot = join(f.base, "changed");
  const record = await pending;
  assert.deepEqual(record.payload.request, original);
  assert.equal(record.payload.configuredRoot, root);
});

test("inert request normalization rejects accessors, links to run authority and path traversal", async t => {
  const f = await prepareReplayEvidenceFixture(t); let reads = 0;
  const getter = structuredClone(f.request);
  Object.defineProperty(getter.origin.sourceReference, "locator", { enumerable: true, get() { reads++; return "bad"; } });
  assert.throws(() => prepareReplayEvidenceRequest(getter), /non-JSON/); assert.equal(reads, 0);
  for (const bundlePath of ["..", "../outside", "/absolute", "selected/../episode", "selected//episode", "selected\\episode"])
    assert.throws(() => prepareReplayEvidenceRequest({ ...f.request, bundlePath }));
  for (const extra of [{ runId: "invented" }, { interventionAuthorized: true }, { originStatus: "verified" }])
    assert.throws(() => prepareReplayEvidenceRequest({ ...f.request, ...extra }));
  assert.throws(() => prepareReplayEvidenceRequest({ ...f.request, projectId: "p".repeat(129) }));
  assert.equal(f.ledger.listObservations("alpha").length, 0);
});

test("root, relative ancestors, bundle directories and artifact leaves cannot be symlinks", async t => {
  for (const position of ["root", "ancestor", "bundle", "leaf"] as const) {
    await t.test(position, async t => {
      const f = await prepareReplayEvidenceFixture(t), request = structuredClone(f.request);
      let artifactRoot = f.artifactRoot;
      if (position === "root") { artifactRoot = join(f.base, "root-alias"); await symlink(f.artifactRoot, artifactRoot); }
      if (position === "ancestor") { await symlink(join(f.artifactRoot, "selected"), join(f.artifactRoot, "alias")); request.bundlePath = "alias/episode"; }
      if (position === "bundle") { await symlink(f.directory, join(f.artifactRoot, "bundle-alias")); request.bundlePath = "bundle-alias"; }
      if (position === "leaf") { const report = join(f.directory, "report.md"), saved = join(f.directory, "saved-report.md"); await rename(report, saved); await symlink(saved, report); }
      await assert.rejects(importCoworkerReplayEvidence(f.ledger, request, { artifactRoot }));
      assert.equal(f.ledger.listObservations("alpha").length, 0);
    });
  }
});

test("hardlinked artifact leaves and changed report bytes cannot enter the ledger", async t => {
  for (const alteration of ["hardlink", "report"] as const) {
    await t.test(alteration, async t => {
      const f = await prepareReplayEvidenceFixture(t);
      if (alteration === "hardlink") await link(join(f.directory, "execution.json"), join(f.directory, "another-execution.json"));
      else await appendFile(join(f.directory, "report.md"), "Scientific evaluation approved.\n");
      await assert.rejects(importCoworkerReplayEvidence(f.ledger, f.request, { artifactRoot: f.artifactRoot }));
      assert.equal(f.ledger.listObservations("alpha").length, 0);
    });
  }
});

test("all expected bundle digests are enforced before the one atomic append", async t => {
  const f = await prepareReplayEvidenceFixture(t);
  for (const field of ["requestDigest", "executionDigest", "receiptDigest"] as const) {
    const request = structuredClone(f.request); request.expected[field] = "0".repeat(64);
    await assert.rejects(importCoworkerReplayEvidence(f.ledger, request, { artifactRoot: f.artifactRoot }), /bundle identity/);
  }
  const receiptPath = join(f.directory, "receipt.json"), receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.digest = "0".repeat(64); await writeFile(receiptPath, JSON.stringify(receipt));
  await assert.rejects(importCoworkerReplayEvidence(f.ledger, f.request, { artifactRoot: f.artifactRoot }));
  assert.equal(f.ledger.listObservations("alpha").length, 0);
});

test("load recomputes nonapproval fields even when the entire observation digest is replaced", async t => {
  const f = await createReplayEvidenceFixture(t);
  for (const [field, value] of [["originStatus", "verified"], ["sourceCustody", "authenticated"],
    ["taskSuccess", "passed"], ["scientificEvaluation", "approved"], ["interventionAuthorized", true], ["scope", "legacy_run1"]] as const) {
    const forged = structuredClone(f.record);
    (forged.payload as unknown as Record<string, unknown>)[field] = value;
    assert.throws(() => loadCoworkerReplayEvidence(archiveWith(signed(forged)), forged.eventId), /projection mismatch/);
  }
});

test("load revalidates the embedded witness chain after all affected outer digests are recomputed", async t => {
  const f = await createReplayEvidenceFixture(t), forged = structuredClone(f.record);
  const execution = forged.payload.bundle.execution;
  execution.output!.result!.observedMessages[0]!.sender = "Bob";
  const stdout = `${encode(execution.output)}\n`;
  execution.process.stdoutSha256 = replayFixtureSha(stdout); execution.process.stdoutBytes = Buffer.byteLength(stdout);
  const rehashed = rebindBundle(forged);
  assert.throws(() => loadCoworkerReplayEvidence(archiveWith(rehashed), rehashed.eventId), /message source/);
});

test("load rejects run linkage, source substitution and accessor-bearing stored data", async t => {
  const f = await createReplayEvidenceFixture(t);
  for (const mutate of [(r: ReplayEvidenceRecord) => { r.runId = "invented-run"; },
    (r: ReplayEvidenceRecord) => { r.source = "other-source"; },
    (r: ReplayEvidenceRecord) => { r.eventId += "-other"; }]) {
    const changed = structuredClone(f.record); mutate(changed); const forged = signed(changed);
    assert.throws(() => loadCoworkerReplayEvidence({ getObservation: () => forged as unknown as ObservationRecord }, f.record.eventId), /envelope/);
  }
  const getter = structuredClone(f.record); let reads = 0;
  Object.defineProperty(getter.payload.bundle.execution.output!.result!, "memo", { enumerable: true, get() { reads++; return "unexpected"; } });
  assert.throws(() => loadCoworkerReplayEvidence(archiveWith(getter), getter.eventId), /non-JSON/); assert.equal(reads, 0);
});

test("incomplete and cancelled imports retain no invented performance denominators", async t => {
  for (const status of ["rejected", "cancelled"] as const) {
    await t.test(status, async t => {
      const f = await createReplayEvidenceFixture(t, { status }), summary = summarizeCoworkerReplayEvidence(f.record);
      assert.equal(summary.executionStatus, "incomplete");
      assert.deepEqual([summary.requiredFacts, summary.worldFacts, summary.authorizedObservedFacts, summary.observedNumericCredits], [null, null, null, null]);
      assert.equal(summary.semanticEvaluation, "unassessed"); assert.equal(summary.interventionAuthorized, false);
      assert.deepEqual(loadCoworkerReplayEvidence(f.ledger, f.record.eventId), f.record);
    });
  }
});

test("a large valid private context is retained intact and oversized raw evidence rejects before writes", async t => {
  const f = await createReplayEvidenceFixture(t, { mutateObservation(r) { r.brief = "B".repeat(131_072); r.publicTask = "T".repeat(131_072); } });
  assert.equal(f.record.payload.bundle.execution.output!.result!.brief.length, 131_072);
  assert.equal(f.record.payload.bundle.execution.output!.result!.publicTask.length, 131_072);
  assert.deepEqual(loadCoworkerReplayEvidence(f.ledger, f.record.eventId), f.record);
  const oversized = structuredClone(f.record);
  oversized.payload.bundle.execution.output!.result!.memo = "x".repeat(2 * 1024 * 1024);
  assert.throws(() => loadCoworkerReplayEvidence(archiveWith(oversized), oversized.eventId), /JSON|limit/);
  assert.equal(f.ledger.listObservations("alpha").length, 1);
});

test("append failure creates no partial observation and a deliberate retry can import once", async t => {
  const f = await prepareReplayEvidenceFixture(t); let attempts = 0;
  const archive = { getObservation: (id: string) => f.ledger.getObservation(id), appendObservation(value: ObservationInput) {
    attempts++; if (attempts === 1) throw new Error("simulated atomic write failure"); return f.ledger.appendObservation(value);
  } };
  await assert.rejects(importCoworkerReplayEvidence(archive, f.request, { artifactRoot: f.artifactRoot }), /atomic write/);
  assert.equal(f.ledger.listObservations("alpha").length, 0);
  const record = await importCoworkerReplayEvidence(archive, f.request, { artifactRoot: f.artifactRoot });
  assert.equal(f.ledger.listObservations("alpha").length, 1); assert.equal(record.eventId, coworkerReplayEvidenceId("alpha", "episode-1"));
});

test("concurrent identical imports preserve the first committed observation and timestamp", async t => {
  const f = await prepareReplayEvidenceFixture(t);
  const [first, second] = await Promise.all([
    importCoworkerReplayEvidence(f.ledger, f.request, { artifactRoot: f.artifactRoot, now: () => new Date("2026-11-02T01:00:00Z") }),
    importCoworkerReplayEvidence(f.ledger, f.request, { artifactRoot: f.artifactRoot, now: () => new Date("2026-11-02T02:00:00Z") }),
  ]);
  assert.deepEqual(first, second); assert.equal(f.ledger.listObservations("alpha").length, 1);
});
