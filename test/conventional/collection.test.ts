import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hash } from "../../src/ledger/validation.ts";
import { collectConventionalSupervised } from "../../src/integrations/conventional/supervised-collection.ts";
import { collectionFixture, collectionNow } from "./collection-fixtures.ts";

test("bound successful collection retains one replica and raw references without promoting scientific or resource state", async t => {
  const f = await collectionFixture(); t.after(f.close);
  await f.writeArtifacts(); const observed = await f.observe("succeeded");
  const actionBefore = f.ledger().getAction(f.action.actionId), runBefore = f.ledger().getRun(f.action.runId);
  const receipt = await collectConventionalSupervised({ ledger: f.ledger(), journal: f.journal() }, {
    collectionId: "complete", actionId: f.action.actionId, plan: f.plan, observationId: observed.observationId, observationDigest: observed.digest }, { now: collectionNow });
  assert.equal(receipt.payload.status, "completed"); assert.equal(receipt.payload.scientificReplicationCount, 1);
  assert.equal(receipt.payload.scientificEvaluation, "unassessed"); assert.equal(receipt.jobId, actionBefore.jobId);
  assert.deepEqual(f.ledger().getAction(f.action.actionId), actionBefore); assert.deepEqual(f.ledger().getRun(f.action.runId), runBefore);
  const summary = receipt.payload.summary as Record<string, any>;
  assert.equal(summary.replicate.policyDigest, hash(f.result().replicates[0]!.qTable));
  assert.equal(summary.replicate.successRateDeltaFromBaseline, 0);
  assert.equal((receipt.payload.workerObservation as Record<string, any>).digest, observed.digest);
  assert.ok(Object.isFrozen(receipt.payload));
});

test("same collection ID recovers its original observation after reopen and deleted artifacts; new ID observes missing data", async t => {
  const f = await collectionFixture(); t.after(f.close);
  await f.writeArtifacts(); const observed = await f.observe("succeeded");
  const request = { collectionId: "once", actionId: f.action.actionId, plan: f.plan, observationId: observed.observationId, observationDigest: observed.digest };
  const first = await collectConventionalSupervised({ ledger: f.ledger(), journal: f.journal() }, request, { now: collectionNow });
  await rm(f.plan.outputs.directory, { recursive: true }); f.reopen();
  assert.deepEqual(await collectConventionalSupervised({ ledger: f.ledger(), journal: f.journal() }, request), first);
  const later = await collectConventionalSupervised({ ledger: f.ledger(), journal: f.journal() }, { ...request, collectionId: "fresh" });
  assert.equal(later.payload.status, "incomplete"); assert.equal(later.payload.reason, "artifact_unavailable_or_unsafe");
  await assert.rejects(collectConventionalSupervised({ ledger: f.ledger(), journal: f.journal() }, { ...request, observationDigest: "0".repeat(64) }), /identity/);
});

test("running and previously failed jobs cannot become complete merely because valid-looking output exists", async t => {
  const f = await collectionFixture(); t.after(f.close); await f.writeArtifacts();
  for (const [index, mode] of ["running", "failed", "succeeded"].entries()) {
    const record = await f.observe(mode as "running" | "failed" | "succeeded");
    const result = await collectConventionalSupervised({ ledger: f.ledger(), journal: f.journal() }, {
      collectionId: `attempt-${index}`, actionId: f.action.actionId, plan: f.plan, observationId: record.observationId, observationDigest: record.digest });
    assert.equal(result.payload.status, "incomplete"); assert.equal(result.payload.reason, "successful_terminal_cleanup_not_established");
  }
});

test("missing cleanup proof, mutated result and duplicate JSON fields remain incomplete evidence", async t => {
  const f = await collectionFixture(); t.after(f.close); await f.writeArtifacts(); const record = await f.observe("succeeded");
  const stores = { ledger: f.ledger(), journal: f.journal() };
  const request = { collectionId: "proof", actionId: f.action.actionId, plan: f.plan, observationId: record.observationId, observationDigest: record.digest };
  if (record.observation.operation !== "query" || record.observation.result.kind !== "present") throw new Error("fixture");
  const snapshot = structuredClone(record.observation.result.snapshot); delete snapshot.cleanupEvidence;
  const noProof = f.journal().recordObservation({ observationId: "no-proof", jobId: record.jobId, actionId: record.actionId,
    declarationDigest: record.declarationDigest, observedAt: record.observedAt, observation: { operation: "query", result: { kind: "present", snapshot } } });
  assert.equal((await collectConventionalSupervised(stores, { ...request, observationId: noProof.observationId, observationDigest: noProof.digest })).payload.status, "incomplete");
  await writeFile(f.plan.outputs.result, "{}");
  assert.equal((await collectConventionalSupervised(stores, { ...request, collectionId: "changed" })).payload.reason, "artifact_identity_or_result_invalid");
  const raw = JSON.stringify(f.result()).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
  await f.writeArtifacts(raw);
  assert.equal((await collectConventionalSupervised(stores, { ...request, collectionId: "duplicate" })).payload.reason, "artifact_identity_or_result_invalid");
});

test("symlinked artifacts are not followed and caller getters cannot run", async t => {
  const f = await collectionFixture(); t.after(f.close); await f.writeArtifacts(); const record = await f.observe("succeeded");
  const request = { collectionId: "unsafe", actionId: f.action.actionId, plan: f.plan, observationId: record.observationId, observationDigest: record.digest };
  const bytes = await readFile(f.plan.outputs.result), other = join(f.directory, "elsewhere.json"); await writeFile(other, bytes);
  await rm(f.plan.outputs.result); await symlink(other, f.plan.outputs.result);
  const result = await collectConventionalSupervised({ ledger: f.ledger(), journal: f.journal() }, request);
  assert.equal(result.payload.status, "incomplete"); assert.equal(result.payload.reason, "artifact_unavailable_or_unsafe");
  let calls = 0;
  await assert.rejects(collectConventionalSupervised({ ledger: f.ledger(), journal: f.journal() }, { ...request,
    get plan() { calls++; return f.plan; } })); assert.equal(calls, 0);
});
