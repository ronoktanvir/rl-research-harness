import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import type { ObservationRecord } from "../../src/ledger/types.ts";
import { hash } from "../../src/ledger/validation.ts";
import { discoverArxiv, getArxivAvailability, loadArxivDiscovery, releaseArxivHold } from "../../src/literature/index.ts";
import type { ArxivDiscoveryRequest, LiteratureArchive } from "../../src/literature/types.ts";
import { feed } from "./fixtures.ts";
import { arxivQueryUrl } from "../../src/literature/transport.ts";

const scope = "system.literature.arxiv";
let tick = Date.parse("2300-01-01T00:00:00Z");
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "arxiv-hold-review-")), path = join(dir, "ledger.sqlite");
  let ledger = openExperimentLedger({ path });
  t.after(async () => { ledger.close(); await rm(dir, { recursive: true, force: true }); });
  tick += 1_000_000; let current = tick;
  const request: ArxivDiscoveryRequest = { projectId: "study", discoveryId: "first", query: "cat:cs.LG", maxResults: 1, timeoutMs: 1000 };
  return { get ledger() { return ledger; }, request, now: () => new Date(current),
    set(value: string) { current = Date.parse(value); tick = Math.max(tick, current); },
    advance(ms = 100_000) { current += ms; tick = Math.max(tick, current); },
    reopen() { ledger.close(); ledger = openExperimentLedger({ path }); } };
}
function quota(retryAfter: string | null = null): typeof fetch {
  return async () => new Response("Too many requests", { status: 429,
    headers: retryAfter === null ? {} : { "retry-after": retryAfter } });
}
const noFetch: typeof fetch = async () => { throw new Error("Network invocation is forbidden in held or cached path"); };

function legacyCapture(f: Awaited<ReturnType<typeof fixture>>, includeHold: boolean): ObservationRecord {
  const request = { ...f.request, start: 0, sortBy: "submittedDate" as const, timeoutMs: 1000, maxResponseBytes: 262_144 }, token = hash([request.projectId, request.discoveryId]);
  const queryId = `arxiv-query:${token}`, observedAt = f.now().toISOString();
  const append = (eventId: string, source: string, projectId: string, payload: import("../../src/ledger/types.ts").JsonObject) => f.ledger.appendObservation({ eventId, source, projectId,
    runId: null, actionId: null, jobId: null, sequence: 0, observedAt, payload });
  append(queryId, "arxiv-query.v1", request.projectId, { schemaVersion: 1, request, requestDigest: hash(request), url: arxivQueryUrl(request) });
  append(`arxiv-attempt:${token}`, "arxiv-retrieval-attempt.v1", scope, { schemaVersion: 1, queryObservationId: queryId, projectId: request.projectId,
    cooldownUntil: new Date(f.now().getTime() + request.timeoutMs + 3000).toISOString() });
  const bytes = Buffer.from("Too many requests"), response = append(`arxiv-response:${token}`, "arxiv-response.v1", request.projectId,
    { schemaVersion: 1, queryObservationId: queryId, requestDigest: hash(request), url: arxivQueryUrl(request), status: 429,
      contentType: "text/plain", retryAfter: null, rawBase64: bytes.toString("base64"), rawSha256: createHash("sha256").update(bytes).digest("hex"), rawBytes: bytes.length, retrievedAt: observedAt });
  if (includeHold) append(`arxiv-hold:${hash(response.eventId)}`, "arxiv-availability-hold.v1", scope,
    { schemaVersion: 1, holdObservationId: `arxiv-hold:${hash(response.eventId)}`, queryObservationId: queryId, responseObservationId: response.eventId,
      responseDigest: response.digest, projectId: request.projectId, receivedAt: observedAt, retryAfter: null, retryAt: null, retryBasis: "unknown" });
  return response;
}

test("unknown reset survives reopen and blocks changed IDs/projects while cached evidence stays readable", async t => {
  const f = await fixture(t);
  const completed = await discoverArxiv(f.ledger, f.request, { now: f.now, fetch: async () => new Response(feed(), { headers: { "content-type": "application/atom+xml" } }) });
  f.advance();
  const request = { ...f.request, discoveryId: "quota" };
  const limited = await discoverArxiv(f.ledger, request, { now: f.now, fetch: quota() });
  f.reopen(); f.advance(10_000_000);
  const held = getArxivAvailability(f.ledger, { now: f.now });
  assert.equal(held.available, false); assert.equal(held.holds[0]!.retryAt, null);
  for (const next of [{ ...request, discoveryId: "another" }, { ...request, projectId: "another-project" }]) {
    await assert.rejects(discoverArxiv(f.ledger, next, { now: f.now, fetch: noFetch }), { code: "arxiv_service_held" });
  }
  assert.equal(f.ledger.listObservations("another-project").length, 0);
  assert.deepEqual(await discoverArxiv(f.ledger, f.request, { now: f.now, fetch: noFetch }), completed);
  assert.deepEqual(await discoverArxiv(f.ledger, request, { now: f.now, fetch: noFetch }), limited);
  assert.deepEqual(loadArxivDiscovery(f.ledger, completed.queryObservationId), completed);
});

test("a committed429 header receipt with failed derived writes repairs its hold before another request", async t => {
  const f = await fixture(t), append = f.ledger.appendObservation.bind(f.ledger);
  f.ledger.appendObservation = value => { if (["arxiv-availability-hold.v1", "arxiv-discovery-result.v1"].includes(value.source)) throw new Error("crash before derived hold"); return append(value); };
  await assert.rejects(discoverArxiv(f.ledger, f.request, { now: f.now, fetch: quota() }), /crash before derived hold/u);
  assert.equal(f.ledger.listObservations("study").filter(value => value.source === "arxiv-response-headers.v1").length, 1);
  assert.equal(f.ledger.listObservations("study").filter(value => value.source === "arxiv-response.v1").length, 0);
  assert.equal(f.ledger.listObservations(scope).filter(value => value.source === "arxiv-availability-hold.v1").length, 0);
  f.reopen(); f.advance();
  await assert.rejects(discoverArxiv(f.ledger, { ...f.request, projectId: "another" }, { now: f.now, fetch: noFetch }), { code: "arxiv_service_held" });
  assert.equal(f.ledger.listObservations(scope).filter(value => value.source === "arxiv-availability-hold.v1").length, 1);
  assert.equal(f.ledger.listObservations("another").length, 0);
});

test("known delta time is anchored to response receipt and cannot be released early or extended by reopen", async t => {
  const f = await fixture(t), receivedAt = f.now().toISOString();
  await discoverArxiv(f.ledger, f.request, { now: f.now, fetch: quota("120") });
  const first = getArxivAvailability(f.ledger, { now: f.now }).holds[0]!;
  assert.equal(first.retryAt, new Date(Date.parse(receivedAt) + 120_000).toISOString());
  assert.equal(first.retryBasis, "delay_seconds"); f.advance(60_000); f.reopen();
  assert.equal(getArxivAvailability(f.ledger, { now: f.now }).holds[0]!.retryAt, first.retryAt);
  assert.throws(() => releaseArxivHold(f.ledger, { holdObservationId: first.holdObservationId, releaseId: "too-early", evidence: { reason: "Operator would like to retry" } }, { now: f.now }), { code: "release_too_early" });
  assert.equal(f.ledger.listObservations(scope).filter(value => value.source === "arxiv-availability-release.v1").length, 0);
  f.set(first.retryAt!); assert.equal(getArxivAvailability(f.ledger, { now: f.now }).available, true);
});

test("malformed, nonstandard, overflow and truncated-prefix Retry-After values never become zero-delay release", async t => {
  for (const header of ["", "1.5", "-1", "NaN", "999999999999999999999999999", "2300-01-01T00:00:00Z", "Sun, 31 Feb 2300 00:00:00 GMT", `${"0".repeat(256)}garbage`]) {
    const f = await fixture(t);
    await discoverArxiv(f.ledger, f.request, { now: f.now, fetch: quota(header) });
    const state = getArxivAvailability(f.ledger, { now: f.now });
    assert.equal(state.available, false, `Header ${header} must hold`);
    assert.equal(state.holds[0]!.retryBasis, "unknown"); assert.equal(state.holds[0]!.retryAt, null);
  }
});

test("canonical HTTP-date uses its exact absolute time and expiry does not certify provider availability", async t => {
  const f = await fixture(t), retryAt = new Date(f.now().getTime() + 90_000);
  await discoverArxiv(f.ledger, f.request, { now: f.now, fetch: quota(retryAt.toUTCString()) });
  const initial = getArxivAvailability(f.ledger, { now: f.now });
  assert.equal(initial.holds[0]!.retryAt, retryAt.toISOString()); assert.equal(initial.holds[0]!.retryBasis, "http_date");
  f.set(retryAt.toISOString()); const expired = getArxivAvailability(f.ledger, { now: f.now });
  assert.equal(expired.available, true); assert.equal(expired.holds[0]!.released, false);
});

test("release identity binds evidence and one exact hold; an old release cannot clear a later429", async t => {
  const f = await fixture(t); await discoverArxiv(f.ledger, f.request, { now: f.now, fetch: quota() });
  const hold = getArxivAvailability(f.ledger, { now: f.now }).holds[0]!;
  const input = { holdObservationId: hold.holdObservationId, releaseId: "operator-release", evidence: { reason: "Operator authorizes a new bounded probe" } };
  const released = releaseArxivHold(f.ledger, input, { now: f.now }); f.advance(); f.reopen();
  assert.deepEqual(releaseArxivHold(f.ledger, input, { now: f.now }), released);
  assert.throws(() => releaseArxivHold(f.ledger, { ...input, evidence: { reason: "Changed assertion" } }, { now: f.now }), { code: "release_conflict" });
  await discoverArxiv(f.ledger, { ...f.request, discoveryId: "second" }, { now: f.now, fetch: quota() });
  const state = getArxivAvailability(f.ledger, { now: f.now });
  assert.equal(state.available, false); assert.equal(state.holds.filter(item => item.blocked).length, 1);
  const next = state.holds.find(item => item.blocked)!;
  assert.throws(() => releaseArxivHold(f.ledger, { ...input, holdObservationId: next.holdObservationId }, { now: f.now }), { code: "release_conflict" });
});

test("rehashing a release with another source digest fails closed", async t => {
  const f = await fixture(t); await discoverArxiv(f.ledger, f.request, { now: f.now, fetch: quota() });
  const hold = getArxivAvailability(f.ledger, { now: f.now }).holds[0]!;
  const record = releaseArxivHold(f.ledger, { holdObservationId: hold.holdObservationId, releaseId: "release", evidence: { reason: "Explicit bounded probe" } }, { now: f.now });
  const changed = structuredClone(record); changed.payload.holdDigest = "a".repeat(64);
  const { digest: _digest, ...body } = changed; changed.digest = hash(body);
  const archive: LiteratureArchive = { getObservation: id => id === changed.eventId ? changed : f.ledger.getObservation(id),
    appendObservation: value => f.ledger.appendObservation(value), listObservations: project => f.ledger.listObservations(project).map(value => value.eventId === changed.eventId ? changed : value) };
  assert.throws(() => getArxivAvailability(archive, { now: f.now }), { code: "archive_conflict" });
});

test("known retry time remains binding after a legal release if the clock moves backward", async t => {
  const f = await fixture(t); await discoverArxiv(f.ledger, f.request, { now: f.now, fetch: quota("60") });
  const hold = getArxivAvailability(f.ledger, { now: f.now }).holds[0]!;
  f.set(hold.retryAt!);
  releaseArxivHold(f.ledger, { holdObservationId: hold.holdObservationId, releaseId: "after-expiry", evidence: { reason: "Known delay has elapsed" } }, { now: f.now });
  f.set(new Date(Date.parse(hold.retryAt!) - 1000).toISOString());
  assert.equal(getArxivAvailability(f.ledger, { now: f.now }).available, false);
});

test("observed429 headers retain a service hold even when its response body exceeds the capture bound", async t => {
  const f = await fixture(t);
  const result = await discoverArxiv(f.ledger, { ...f.request, maxResponseBytes: 1024 }, { now: f.now,
    fetch: async () => new Response("x".repeat(1025), { status: 429 }) });
  assert.equal(result.status, "failed");
  f.advance();
  assert.equal(getArxivAvailability(f.ledger, { now: f.now }).available, false);
  await assert.rejects(discoverArxiv(f.ledger, { ...f.request, discoveryId: "new-after-failed-body" }, { now: f.now, fetch: noFetch }), { code: "arxiv_service_held" });
});

test("observed429 headers block new requests after a body timeout without claiming a complete body", async t => {
  const f = await fixture(t); let cancelled = false;
  const result = await discoverArxiv(f.ledger, { ...f.request, timeoutMs: 10 }, { now: f.now,
    fetch: async () => new Response(new ReadableStream({ start(control) { control.enqueue(new TextEncoder().encode("partial")); }, cancel() { cancelled = true; } }), { status: 429 }) });
  assert.equal(result.status, "failed"); assert.equal(cancelled, true);
  assert.equal(result.rawSha256, null); assert.equal(result.responseObservationId, null);
  f.advance(); const available = getArxivAvailability(f.ledger, { now: f.now });
  assert.equal(available.available, false); assert.equal(available.holds.length, 1);
  assert.equal(available.holds[0]!.responseEvidenceScope, "headers_only");
  const headers = f.ledger.getObservation(available.holds[0]!.responseObservationId)!;
  assert.equal(headers.source, "arxiv-response-headers.v1"); assert.equal(headers.payload.bodyScope, "not_captured_at_header_receipt");
  assert.equal(Object.hasOwn(headers.payload, "rawSha256"), false);
  await assert.rejects(discoverArxiv(f.ledger, { ...f.request, discoveryId: "after-timeout", projectId: "another" }, { now: f.now, fetch: noFetch }), { code: "arxiv_service_held" });
});

test("a captured429 body and its header receipt create exactly one releasable service hold", async t => {
  const f = await fixture(t);
  await discoverArxiv(f.ledger, f.request, { now: f.now, fetch: quota() });
  const first = getArxivAvailability(f.ledger, { now: f.now }); assert.equal(first.holds.length, 1);
  const record = releaseArxivHold(f.ledger, { holdObservationId: first.holds[0]!.holdObservationId,
    releaseId: "one-receipt-release", evidence: { reason: "One explicit bounded follow-up" } }, { now: f.now });
  f.reopen();
  const second = getArxivAvailability(f.ledger, { now: f.now });
  assert.equal(second.holds.length, 1); assert.equal(second.available, true);
  assert.deepEqual(second.holds[0]!.releaseObservationIds, [record.eventId]);
});

test("legacy raw-only429 captures remain held without inventing new header observations", async t => {
  for (const includeHold of [false, true]) {
    const f = await fixture(t), response = legacyCapture(f, includeHold);
    const saved = f.ledger.listObservations(scope).find(record => record.source === "arxiv-availability-hold.v1");
    f.reopen(); const available = getArxivAvailability(f.ledger, { now: f.now });
    assert.equal(available.available, false); assert.equal(available.holds.length, 1);
    assert.equal(available.holds[0]!.responseObservationId, response.eventId);
    assert.equal(available.holds[0]!.responseDigest, response.digest);
    assert.deepEqual(f.ledger.listObservations("study").map(record => record.source), ["arxiv-query.v1", "arxiv-response.v1"]);
    assert.deepEqual(f.ledger.listObservations(scope).map(record => record.source), ["arxiv-retrieval-attempt.v1", "arxiv-availability-hold.v1"]);
    if (saved) assert.deepEqual(f.ledger.getObservation(saved.eventId), saved);
  }
});
