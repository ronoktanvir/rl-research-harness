import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { buildLiteratureEvidencePacket, discoverArxiv, getArxivAvailability, loadArxivDiscovery, releaseArxivHold } from "../../src/literature/index.ts";
import type { ArxivDiscoveryRequest, LiteratureArchive } from "../../src/literature/types.ts";
import { hash } from "../../src/ledger/validation.ts";
import { feed } from "./fixtures.ts";

let clock = Date.parse("2300-01-01T00:00:00.000Z");
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "arxiv-holds-")), path = join(directory, "ledger.sqlite");
  const ledger = openExperimentLedger({ path });
  t.after(async () => { ledger.close(); await rm(directory, { recursive: true, force: true }); });
  clock += 1_000_000; let instant = clock;
  const request: ArxivDiscoveryRequest = { projectId: "study", discoveryId: "quota", query: "cat:cs.LG", maxResults: 1, timeoutMs: 10 };
  return { ledger, path, request, now: () => new Date(instant), advance(ms: number) { instant += ms; clock = Math.max(clock, instant); } };
}
const quota = (retryAfter: string | null): typeof fetch => async () => new Response("Too many requests", { status: 429, headers: retryAfter === null ? {} : { "retry-after": retryAfter } });
const okay: typeof fetch = async () => new Response(feed(), { headers: { "content-type": "application/atom+xml" } });
const evidence = { operator: "Explicit controlled retry approved; provider recovery is not independently confirmed" };

test("unknown429 hold blocks new identities across projects while cached evidence remains readable", async t => {
  const f = await fixture(t);
  const captured = await discoverArxiv(f.ledger, { ...f.request, discoveryId: "before-quota" }, { fetch: okay, now: f.now });
  f.advance(5000);
  const failed = await discoverArxiv(f.ledger, f.request, { fetch: quota(null), now: f.now });
  const availability = getArxivAvailability(f.ledger, { now: f.now });
  assert.equal(availability.available, false); assert.equal(availability.holds[0]!.retryAt, null); assert.equal(availability.holds[0]!.retryBasis, "unknown");
  f.advance(86_400_000); let calls = 0;
  await assert.rejects(discoverArxiv(f.ledger, { ...f.request, projectId: "other-project", discoveryId: "new" }, { now: f.now, fetch: async () => { calls++; return new Response(feed()); } }), { code: "arxiv_service_held" });
  assert.equal(calls, 0); assert.equal(f.ledger.listObservations("other-project").length, 0);
  assert.deepEqual(await discoverArxiv(f.ledger, f.request, { now: f.now, fetch: okay }), failed);
  assert.deepEqual(loadArxivDiscovery(f.ledger, captured.queryObservationId), captured);
  assert.equal(buildLiteratureEvidencePacket(f.ledger, captured.queryObservationId, { packetId: "cached", question: "What is supported?", proposal: "Inspect known evidence", requiredCriteria: ["evidence"] }).evidence.length, 2);
});

test("status repairs missing hold from header429 after restart even when result persistence never finished", async t => {
  const f = await fixture(t), append = f.ledger.appendObservation.bind(f.ledger);
  f.ledger.appendObservation = input => { if (["arxiv-availability-hold.v1", "arxiv-discovery-result.v1"].includes(input.source)) throw new Error("crash before hold"); return append(input); };
  await assert.rejects(discoverArxiv(f.ledger, f.request, { fetch: quota(null), now: f.now }), /crash before hold/u);
  const raw = f.ledger.listObservations("study").find(item => item.source === "arxiv-response-headers.v1")!;
  assert.ok(raw); assert.equal(f.ledger.listObservations("study").some(item => item.source === "arxiv-discovery-result.v1"), false);
  f.ledger.close(); const reopened = openExperimentLedger({ path: f.path });
  try {
    const availability = getArxivAvailability(reopened, { now: f.now });
    assert.equal(availability.available, false); assert.equal(availability.holds[0]!.responseObservationId, raw.eventId);
    assert.equal(reopened.listObservations("system.literature.arxiv").filter(item => item.source === "arxiv-availability-hold.v1").length, 1);
    assert.deepEqual(getArxivAvailability(reopened, { now: f.now }), availability);
    f.advance(10_000);
    await assert.rejects(discoverArxiv(reopened, { ...f.request, discoveryId: "another" }, { now: f.now, fetch: okay }), { code: "arxiv_service_held" });
  } finally { reopened.close(); }
});

test("delay-seconds preserves exact earliest time, prevents early release and expires without marking released", async t => {
  const f = await fixture(t), received = f.now().getTime();
  await discoverArxiv(f.ledger, f.request, { fetch: quota("60"), now: f.now });
  const hold = getArxivAvailability(f.ledger, { now: f.now }).holds[0]!;
  assert.equal(hold.retryAt, new Date(received + 60_000).toISOString()); assert.equal(hold.retryBasis, "delay_seconds");
  assert.throws(() => releaseArxivHold(f.ledger, { holdObservationId: hold.holdObservationId, releaseId: "early", evidence }, { now: f.now }), { code: "release_too_early" });
  f.advance(59_999); assert.equal(getArxivAvailability(f.ledger, { now: f.now }).available, false);
  f.advance(1); const expired = getArxivAvailability(f.ledger, { now: f.now });
  assert.equal(expired.available, true); assert.equal(expired.holds[0]!.released, false); assert.equal(expired.holds[0]!.blocked, false);
  assert.equal((await discoverArxiv(f.ledger, { ...f.request, discoveryId: "after-known-time" }, { now: f.now, fetch: okay })).status, "complete");
});

test("strict HTTP-date records the exact date and does not add invented delay", async t => {
  const f = await fixture(t), retryAt = new Date(f.now().getTime() + 120_000);
  await discoverArxiv(f.ledger, f.request, { fetch: quota(retryAt.toUTCString()), now: f.now });
  const hold = getArxivAvailability(f.ledger, { now: f.now }).holds[0]!;
  assert.equal(hold.retryAt, retryAt.toISOString()); assert.equal(hold.retryBasis, "http_date");
  f.advance(120_000); assert.equal(getArxivAvailability(f.ledger, { now: f.now }).available, true);
});

test("invalid date, ambiguous syntax, oversized and overflowing retry headers remain unknown", async t => {
  for (const header of ["tomorrow", "2026-11-03", "1.5", "-1", "99999999999999999999999999999", "Mon, 30 Feb 2026 12:00:00 GMT", "Wed, 01 Jan 2300 00:00:00 GMT" + " ".repeat(260) + "invalid"]) {
    await t.test(header.slice(0, 40), async sub => {
      const f = await fixture(sub); await discoverArxiv(f.ledger, f.request, { fetch: quota(header), now: f.now });
      const hold = getArxivAvailability(f.ledger, { now: f.now }).holds[0]!;
      assert.equal(hold.retryAt, null); assert.equal(hold.retryBasis, "unknown");
      f.advance(86_400_000); assert.equal(getArxivAvailability(f.ledger, { now: f.now }).available, false);
    });
  }
});

test("explicit unknown-hold release is immutable, replay-safe and recorded as an operator assertion", async t => {
  const f = await fixture(t); await discoverArxiv(f.ledger, f.request, { fetch: quota(null), now: f.now });
  const hold = getArxivAvailability(f.ledger, { now: f.now }).holds[0]!, input = { holdObservationId: hold.holdObservationId, releaseId: "operator-checked", evidence: structuredClone(evidence) };
  const released = releaseArxivHold(f.ledger, input, { now: f.now });
  input.evidence.operator = "mutated"; f.advance(5000);
  assert.equal(released.payload.meaning, "operator_assertion_not_provider_availability_proof");
  assert.deepEqual(releaseArxivHold(f.ledger, { ...input, evidence }, { now: f.now }), released);
  assert.throws(() => releaseArxivHold(f.ledger, input, { now: f.now }), { code: "release_conflict" });
  assert.throws(() => releaseArxivHold(f.ledger, { ...input, releaseId: "empty", evidence: {} }, { now: f.now }), { code: "invalid_release" });
  const availability = getArxivAvailability(f.ledger, { now: f.now });
  assert.equal(availability.available, true); assert.equal(availability.holds[0]!.released, true);
  assert.deepEqual(availability.holds[0]!.releaseObservationIds, [released.eventId]);
  assert.equal((await discoverArxiv(f.ledger, { ...f.request, projectId: "another", discoveryId: "explicit-new-read" }, { now: f.now, fetch: okay })).status, "complete");
});

test("rehashing a weakened hold or unrelated release cannot bypass its source429", async t => {
  const f = await fixture(t); await discoverArxiv(f.ledger, f.request, { fetch: quota(null), now: f.now });
  const hold = getArxivAvailability(f.ledger, { now: f.now }).holds[0]!, original = f.ledger.getObservation(hold.holdObservationId)!;
  const changed = structuredClone(original); changed.payload.retryAt = "2000-01-01T00:00:00.000Z";
  const { digest: _digest, ...data } = changed; changed.digest = hash(data);
  const archive: LiteratureArchive = { getObservation: id => id === changed.eventId ? changed : f.ledger.getObservation(id),
    listObservations: project => f.ledger.listObservations(project), appendObservation: value => f.ledger.appendObservation(value) };
  assert.throws(() => getArxivAvailability(archive, { now: f.now }), { code: "archive_conflict" });
});
