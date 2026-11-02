import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { hash } from "../../src/ledger/validation.ts";
import type { ObservationRecord } from "../../src/ledger/types.ts";
import { discoverArxiv, loadArxivDiscovery, parseArxivAtom } from "../../src/literature/index.ts";
import type { ArxivDiscoveryRequest, LiteratureArchive } from "../../src/literature/types.ts";
import { bytes, entry, feed } from "./fixtures.ts";

let tick = Date.parse("2200-01-01T00:00:00Z");
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "literature-review-")), ledger = openExperimentLedger({ path: join(dir, "ledger.sqlite") });
  t.after(async () => { ledger.close(); await rm(dir, { recursive: true, force: true }); });
  tick += 100_000; let current = tick;
  const request: ArxivDiscoveryRequest = { projectId: "study", discoveryId: "first", query: "cat:cs.LG", maxResults: 1, timeoutMs: 10 };
  return { ledger, request, now: () => new Date(current), advance() { current += 100_000; tick = current; } };
}
const response = () => new Response(feed(), { headers: { "content-type": "application/atom+xml" } });

test("parser cannot bypass its raw-byte and XML-text cap through NaN or invalid maximum", () => {
  const oversized = bytes(feed().replace("</feed>", `<extension>${"x".repeat(524_289)}</extension></feed>`));
  for (const maxBytes of [NaN, 0, -1, 1.5, Infinity]) {
    assert.throws(() => parseArxivAtom(oversized, 1, maxBytes));
  }
});

test("a timed-out fetch that ignores abort quarantines the shared connection until actual settlement", async t => {
  const f = await fixture(t); let release!: (result: Response) => void, calls = 0;
  const pending = discoverArxiv(f.ledger, f.request, { now: f.now, fetch: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const timedOut = await pending;
  assert.equal(timedOut.status, "failed"); assert.equal(timedOut.failure?.code, "timeout");
  f.advance();
  await assert.rejects(discoverArxiv(f.ledger, { ...f.request, discoveryId: "second" }, { now: f.now,
    fetch: async () => { calls++; return response(); } }), { code: "rate_limited_locally" });
  assert.equal(calls, 1); assert.equal(f.ledger.listObservations("study").some(record => record.source === "arxiv-query.v1" && record.payload.request && (record.payload.request as { discoveryId?: string }).discoveryId === "second"), false);
  release(response()); await new Promise(resolve => setImmediate(resolve));
  const next = await discoverArxiv(f.ledger, { ...f.request, discoveryId: "second" }, { now: f.now, fetch: async () => { calls++; return response(); } });
  assert.equal(next.status, "complete"); assert.equal(calls, 2);
  const repeated = await discoverArxiv(f.ledger, f.request, { now: f.now, fetch: async () => { throw new Error("Must not retry failed snapshot"); } });
  assert.deepEqual(repeated, timedOut);
});

test("a self-consistent modified derived paper is rejected against the archived raw feed", async t => {
  const f = await fixture(t);
  const result = await discoverArxiv(f.ledger, f.request, { now: f.now, fetch: async () => response() });
  const paperId = result.paperObservationIds[0]!;
  const original = f.ledger.getObservation(paperId)!;
  const altered = structuredClone(original);
  (altered.payload.paper as { venueVerification: string }).venueVerification = "verified";
  const { digest: _digest, ...body } = altered; altered.digest = hash(body);
  const archive: LiteratureArchive = { getObservation: id => id === paperId ? altered : f.ledger.getObservation(id),
    appendObservation: value => f.ledger.appendObservation(value), listObservations: project => f.ledger.listObservations(project) };
  assert.throws(() => loadArxivDiscovery(archive, result.queryObservationId), { code: "archive_conflict" });
});

test("alternative Atom prefixes preserve identities and namespace-spoofed scalar IDs do not substitute", () => {
  const alternate = feed().replace('<feed xmlns="http://www.w3.org/2005/Atom"', '<a:feed xmlns="http://www.w3.org/2005/Atom" xmlns:a="http://www.w3.org/2005/Atom"')
    .replace("</feed>", "</a:feed>").replaceAll("<entry>", "<a:entry>").replaceAll("</entry>", "</a:entry>");
  assert.equal(parseArxivAtom(bytes(alternate), 1).papers[0]!.version, 2);
  const spoofed = feed(entry().replace("<id>http://arxiv.org/abs/2601.12345v2</id>", '<fake:id xmlns:fake="https://untrusted.example">http://arxiv.org/abs/2601.12345v2</fake:id>'));
  assert.throws(() => parseArxivAtom(bytes(spoofed), 1), /id field/u);
});

test("query IDs, raw snapshot hashes and derived result identities cannot be substituted by rehashing one record", async t => {
  const f = await fixture(t);
  const result = await discoverArxiv(f.ledger, f.request, { now: f.now, fetch: async () => response() });
  const records = new Map<string, ObservationRecord>();
  for (const source of f.ledger.listObservations("study")) records.set(source.eventId, source);
  const raw = structuredClone(records.get(result.responseObservationId!)!);
  raw.payload.queryObservationId = "arxiv-query:another";
  const { digest: _digest, ...body } = raw; raw.digest = hash(body); records.set(raw.eventId, raw);
  const archive: LiteratureArchive = { getObservation: id => records.get(id) ?? null,
    appendObservation: value => f.ledger.appendObservation(value), listObservations: project => f.ledger.listObservations(project) };
  assert.throws(() => loadArxivDiscovery(archive, result.queryObservationId), { code: "archive_conflict" });
});
