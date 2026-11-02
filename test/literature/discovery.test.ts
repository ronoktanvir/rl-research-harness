import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { buildLiteratureEvidencePacket, discoverArxiv, loadArxivDiscovery } from "../../src/literature/index.ts";
import type { ArxivDiscoveryRequest } from "../../src/literature/types.ts";
import { bytes, entry, feed } from "./fixtures.ts";

let tick = Date.parse("2100-01-01T00:00:00Z");
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "arxiv-discovery-"));
  const path = join(directory, "ledger.sqlite");
  const ledger = openExperimentLedger({ path });
  t.after(async () => { ledger.close(); await rm(directory, { recursive: true, force: true }); });
  tick += 100_000; let current = tick;
  const request: ArxivDiscoveryRequest = { projectId: "study", discoveryId: "recent-rewards", query: 'ti:"reinforcement learning" AND cat:cs.LG', maxResults: 2, timeoutMs: 2000 };
  return { ledger, path, request, now: () => new Date(current), advance: () => { current += 100_000; tick = current; } };
}
function fake(body = feed(), inspect?: (url: string, init: RequestInit) => void): typeof fetch {
  return async (input, init) => { inspect?.(String(input), init!); return new Response(body, { status: 200, headers: { "content-type": "application/atom+xml; charset=utf-8" } }); };
}

test("discovery persists exact query and raw response before independent paper records, then reuses them without a request", async t => {
  const f = await fixture(t); let calls = 0;
  const transport = fake(feed(), (url, init) => {
    calls++;
    assert.ok(f.ledger.listObservations("study").some(item => item.source === "arxiv-query.v1"));
    assert.ok(f.ledger.listObservations("system.literature.arxiv").some(item => item.source === "arxiv-retrieval-attempt.v1"));
    assert.equal(new URL(url).origin, "https://export.arxiv.org"); assert.equal(new URL(url).searchParams.get("sortBy"), "submittedDate");
    assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit"); assert.equal(Object.hasOwn(init.headers!, "Authorization"), false);
  });
  const result = await discoverArxiv(f.ledger, f.request, { fetch: transport, now: f.now });
  assert.equal(result.status, "complete"); assert.equal(result.feed!.papers.length, 1); assert.equal(calls, 1);
  const observations = f.ledger.listObservations("study");
  assert.deepEqual(observations.map(item => item.source), ["arxiv-query.v1", "arxiv-response.v1", "arxiv-paper.v1", "arxiv-discovery-result.v1"]);
  assert.ok(observations.every(item => item.runId === null));
  assert.deepEqual(await discoverArxiv(f.ledger, f.request, { fetch: transport, now: f.now }), result);
  assert.deepEqual(loadArxivDiscovery(f.ledger, result.queryObservationId), result); assert.equal(calls, 1);
  assert.equal(result.rawSha256!.length, 64); assert.equal(result.retrievedAt, f.now().toISOString());
});

test("saved raw response repairs incomplete paper records after store reopen without fetching again", async t => {
  const f = await fixture(t); const append = f.ledger.appendObservation.bind(f.ledger);
  f.ledger.appendObservation = input => { if (input.source === "arxiv-paper.v1") throw new Error("crash after response commit"); return append(input); };
  await assert.rejects(discoverArxiv(f.ledger, f.request, { fetch: fake(), now: f.now }), /crash after response/u);
  const query = f.ledger.listObservations("study").find(item => item.source === "arxiv-query.v1")!;
  assert.throws(() => loadArxivDiscovery(f.ledger, query.eventId), { code: "incomplete_archive" });
  f.ledger.close(); const reopened = openExperimentLedger({ path: f.path });
  try {
    const result = await discoverArxiv(reopened, f.request, { fetch: async () => { throw new Error("Refetch forbidden"); }, now: f.now });
    assert.equal(result.status, "complete"); assert.equal(result.paperObservationIds.length, 1);
    assert.deepEqual(loadArxivDiscovery(reopened, result.queryObservationId), result);
  } finally { reopened.close(); }
});

test("lost response before durable capture stays unresolved and never replays that identity", async t => {
  const f = await fixture(t); const append = f.ledger.appendObservation.bind(f.ledger); let calls = 0;
  f.ledger.appendObservation = input => { if (input.source === "arxiv-response.v1") throw new Error("lost response commit"); return append(input); };
  const transport = fake(feed(), () => { calls++; });
  await assert.rejects(discoverArxiv(f.ledger, f.request, { fetch: transport, now: f.now }), /lost response/u);
  f.ledger.appendObservation = append;
  const recovered = await discoverArxiv(f.ledger, f.request, { fetch: transport, now: f.now });
  assert.equal(recovered.status, "uncertain"); assert.equal(recovered.failure?.code, "retrieval_unresolved"); assert.equal(calls, 1);
  assert.throws(() => buildLiteratureEvidencePacket(f.ledger, recovered.queryObservationId, { packetId: "blocked", question: "What is supported?", proposal: "Audit", requiredCriteria: ["sources"] }));
});

test("same discovery cannot change query, limits or project and current metadata never overwrites a prior version capture", async t => {
  const f = await fixture(t);
  const first = await discoverArxiv(f.ledger, f.request, { fetch: fake(), now: f.now });
  await assert.rejects(discoverArxiv(f.ledger, { ...f.request, query: "changed" }, { fetch: fake(), now: f.now }), { code: "request_conflict" });
  await assert.rejects(discoverArxiv(f.ledger, { ...f.request, maxResults: 1 }, { fetch: fake(), now: f.now }), { code: "request_conflict" });
  f.advance();
  const second = await discoverArxiv(f.ledger, { ...f.request, discoveryId: "new-explicit-capture" }, { fetch: fake(feed().replace("Example Conference 2026", "Updated Journal 2026")), now: f.now });
  assert.equal(second.feed!.papers[0]!.version, first.feed!.papers[0]!.version);
  assert.notEqual(second.paperObservationIds[0], first.paperObservationIds[0]);
  assert.match(loadArxivDiscovery(f.ledger, first.queryObservationId).feed!.papers[0]!.journalReference!, /Example Conference/u);
});

test("query mutation during an await cannot change the retained request or paper scope", async t => {
  const f = await fixture(t); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = discoverArxiv(f.ledger, f.request, { fetch: async () => { await gate; return new Response(feed(), { headers: { "content-type": "application/atom+xml" } }); }, now: f.now });
  f.request.query = "mutated after admission"; f.request.maxResults = 20; release();
  const result = await pending;
  assert.notEqual(result.request.query, f.request.query); assert.equal(result.request.maxResults, 2);
  const packet = buildLiteratureEvidencePacket(f.ledger, result.queryObservationId, { packetId: "literature-review", question: "Which reported claims merit testing?", proposal: "Assess evidence gaps", requiredCriteria: ["method-evidence"] });
  assert.ok(packet.checks.every(item => item.status === "unknown")); assert.equal(packet.evidence.length, 2);
  assert.match(packet.evidence[1]!.summary, /methods and reported results were not verified/u); assert.ok(Object.isFrozen(packet));
});

test("persistent cooldown applies across projects and survives a reopened controller", async t => {
  const f = await fixture(t); await discoverArxiv(f.ledger, f.request, { fetch: fake(), now: f.now });
  f.ledger.close(); const reopened = openExperimentLedger({ path: f.path });
  try {
    await assert.rejects(discoverArxiv(reopened, { ...f.request, projectId: "other-project" }, { fetch: async () => { throw new Error("Must not request"); }, now: f.now }), { code: "rate_limited_locally" });
    assert.equal(reopened.listObservations("other-project").length, 0);
  } finally { reopened.close(); }
});

test("HTTP quota and malformed feeds persist failure evidence and never hot-retry", async t => {
  const f = await fixture(t); let calls = 0;
  const quota = await discoverArxiv(f.ledger, f.request, { fetch: async () => { calls++; return new Response("rate limited", { status: 429, headers: { "retry-after": "60" } }); }, now: f.now });
  assert.equal(quota.status, "failed"); assert.equal(quota.failure!.code, "http_429"); assert.equal(quota.failure!.retryAfter, "60");
  assert.equal((await discoverArxiv(f.ledger, f.request, { fetch: fake(), now: f.now })).status, "failed"); assert.equal(calls, 1);
  f.advance();
  const malformed = await discoverArxiv(f.ledger, { ...f.request, discoveryId: "malformed" }, { fetch: fake("<feed>bad XML"), now: f.now });
  assert.equal(malformed.status, "failed"); assert.ok(malformed.rawSha256); assert.deepEqual(malformed.paperObservationIds, []);
});

test("stream size limits count bytes without Content-Length and abort the body", async t => {
  const f = await fixture(t); let cancelled = false;
  const oversized = await discoverArxiv(f.ledger, { ...f.request, maxResponseBytes: 1024 }, { now: f.now,
    fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1025)); }, cancel() { cancelled = true; } }), { headers: { "content-type": "application/atom+xml" } }) });
  assert.equal(oversized.failure!.code, "response_too_large"); assert.equal(cancelled, true); assert.equal(oversized.rawSha256, null);
});

test("timeout covers body streaming and cancellation before admission creates no records", async t => {
  const f = await fixture(t), cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(discoverArxiv(f.ledger, f.request, { fetch: fake(), now: f.now, signal: cancelled.signal }), { code: "cancelled" });
  assert.equal(f.ledger.listObservations("study").length, 0);
  let bodyCancelled = false;
  const result = await discoverArxiv(f.ledger, { ...f.request, timeoutMs: 10 }, { now: f.now,
    fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes("<feed>")); }, cancel() { bodyCancelled = true; } })) });
  assert.equal(result.status, "failed"); assert.equal(result.failure!.code, "timeout"); assert.equal(bodyCancelled, true);
});

test("redirected or off-endpoint responses are rejected without following their links", async t => {
  const f = await fixture(t);
  const response = new Response(feed()); Object.defineProperty(response, "url", { value: "https://elsewhere.example/data" });
  const result = await discoverArxiv(f.ledger, f.request, { fetch: async () => response, now: f.now });
  assert.equal(result.failure!.code, "redirect");
});
