import { createHash } from "node:crypto";
import type { JsonObject, ObservationRecord } from "../ledger/types.ts";
import { encode, enumValue, hash, id, integer, jsonObject, keys, snapshot, text, timestamp } from "../ledger/validation.ts";
import { createEvidencePacket } from "../research/evidence.ts";
import { LiteratureError, parseArxivAtom } from "./atom.ts";
import { arxivQueryUrl, retrieveArxiv } from "./transport.ts";
import type { ArxivResponseHeaders } from "./transport.ts";
import type { ArxivAvailability, ArxivAvailabilityOptions, ArxivDiscovery, ArxivDiscoveryOptions, ArxivDiscoveryRequest, ArxivHold, DiscoveryFailure, LiteratureArchive, LiteraturePacketRequest, NormalizedArxivRequest, ReleaseArxivHoldRequest } from "./types.ts";

export type * from "./types.ts";
export { LiteratureError, parseArxivAtom } from "./atom.ts";
const QUERY = "arxiv-query.v1", RESPONSE = "arxiv-response.v1", RESULT = "arxiv-discovery-result.v1", PAPER = "arxiv-paper.v1", ATTEMPT = "arxiv-retrieval-attempt.v1";
const HOLD = "arxiv-availability-hold.v1", RELEASE = "arxiv-availability-release.v1";
const HEADERS = "arxiv-response-headers.v1";
const TRANSPORT_SCOPE = "system.literature.arxiv";
const limitations = [
  "This is a bounded arXiv result page, not an exhaustive or guaranteed latest literature review.",
  "Only source metadata and abstracts were retrieved. Full papers, methods, tables, code and results were not inspected or independently verified.",
  "Abstract claims, journal references and DOI fields are reported metadata; venue acceptance and research validity remain unverified.",
  "An absent version suffix stays unknown. A paper version can acquire updated bibliographic metadata without a new paper version.",
];

function normalize(raw: ArxivDiscoveryRequest): NormalizedArxivRequest {
  const input = snapshot(raw);
  keys(input, ["projectId", "discoveryId", "query", "maxResults", "start", "sortBy", "timeoutMs", "maxResponseBytes"], ["projectId", "discoveryId", "query", "maxResults"]);
  id(input.projectId); id(input.discoveryId); text(input.query);
  if (input.projectId === TRANSPORT_SCOPE || input.query.length > 2048 || /[\u0000-\u001f\u007f]/u.test(input.query)) throw new LiteratureError("invalid_request", "Query and project identity exceed supported bounds");
  const request = { ...input, start: input.start ?? 0, sortBy: input.sortBy ?? "submittedDate", timeoutMs: input.timeoutMs ?? 20_000, maxResponseBytes: input.maxResponseBytes ?? 262_144 };
  integer(request.maxResults, 1); integer(request.start); integer(request.timeoutMs, 1); integer(request.maxResponseBytes, 1024);
  enumValue(request.sortBy, ["submittedDate", "lastUpdatedDate", "relevance"]);
  if (request.maxResults > 20 || request.start > 1000 || request.timeoutMs > 60_000 || request.maxResponseBytes > 524_288) throw new LiteratureError("invalid_request", "Discovery requires at most 20 results, start <=1000, timeout <=60s and response <=512KiB");
  encode(request); return request;
}
function identities(request: NormalizedArxivRequest) {
  const digest = hash([request.projectId, request.discoveryId]);
  return { query: `arxiv-query:${digest}`, response: `arxiv-response:${digest}`, result: `arxiv-result:${digest}`, attempt: `arxiv-attempt:${digest}`, headers: `arxiv-headers:${digest}` };
}
function digestBytes(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function verified(ledger: LiteratureArchive, eventId: string, source: string, projectId?: string): ObservationRecord | null {
  const found = ledger.getObservation(eventId); if (!found) return null;
  const record = snapshot(found), { digest, ...body } = record;
  if (record.eventId !== eventId || record.source !== source || record.runId !== null || record.actionId !== null || record.jobId !== null || record.sequence !== 0
    || (projectId !== undefined && record.projectId !== projectId) || hash(body) !== digest) throw new LiteratureError("archive_conflict", "Literature observation identity or content digest is inconsistent");
  timestamp(record.observedAt); return record;
}
function append(ledger: LiteratureArchive, eventId: string, projectId: string, source: string, observedAt: string, payload: unknown): ObservationRecord {
  return ledger.appendObservation({ eventId, projectId, source, sequence: 0, observedAt, runId: null, actionId: null, jobId: null, payload: payload as JsonObject });
}
function queryRecord(ledger: LiteratureArchive, queryObservationId: string): { record: ObservationRecord; request: NormalizedArxivRequest } {
  const record = verified(ledger, queryObservationId, QUERY); if (!record) throw new LiteratureError("missing_query", "Archived query is missing");
  const request = normalize(record.payload.request as unknown as ArxivDiscoveryRequest);
  const expected = { schemaVersion: 1, request, requestDigest: hash(request), url: arxivQueryUrl(request) };
  if (record.projectId !== request.projectId || identities(request).query !== queryObservationId || encode(record.payload) !== encode(expected)) throw new LiteratureError("archive_conflict", "Query archive does not match its immutable request");
  return { record, request };
}
function base(request: NormalizedArxivRequest): ArxivDiscovery {
  return { schemaVersion: 1, status: "uncertain", request, queryObservationId: identities(request).query, responseObservationId: null, resultObservationId: null,
    paperObservationIds: [], retrievedAt: null, rawSha256: null, feed: null, failure: null, limitations: [...limitations] };
}
function responseBytes(request: NormalizedArxivRequest, record: ObservationRecord): Buffer {
  const ids = identities(request), payload = record.payload;
  keys(payload, ["schemaVersion", "queryObservationId", "requestDigest", "url", "status", "contentType", "retryAfter", "rawBase64", "rawSha256", "rawBytes", "retrievedAt"]);
  if (payload.schemaVersion !== 1 || payload.queryObservationId !== ids.query || payload.requestDigest !== hash(request) || payload.url !== arxivQueryUrl(request)
    || payload.retrievedAt !== record.observedAt || typeof payload.rawBase64 !== "string" || typeof payload.contentType !== "string"
    || (payload.retryAfter !== null && typeof payload.retryAfter !== "string")) throw new LiteratureError("archive_conflict", "Raw response provenance is inconsistent");
  integer(payload.status, 100); integer(payload.rawBytes);
  const bytes = Buffer.from(payload.rawBase64, "base64");
  if (payload.status > 599 || bytes.toString("base64") !== payload.rawBase64 || bytes.length !== payload.rawBytes || bytes.length > request.maxResponseBytes || digestBytes(bytes) !== payload.rawSha256) throw new LiteratureError("archive_conflict", "Raw response bytes or hash are inconsistent");
  return bytes;
}

function retryTime(raw: string | null, receivedAt: string): Pick<ArxivHold, "retryAt" | "retryBasis"> {
  const value = raw?.trim();
  if (value && /^\d+$/u.test(value)) {
    const seconds = Number(value), instant = Date.parse(receivedAt) + seconds * 1000;
    if (Number.isSafeInteger(seconds) && Number.isSafeInteger(instant) && Math.abs(instant) <= 8_640_000_000_000_000) return { retryAt: new Date(instant).toISOString(), retryBasis: "delay_seconds" };
  }
  // A canonical HTTP-date is checked against its round-trip representation. This
  // rejects impossible calendar dates and wrong weekdays instead of normalizing them.
  if (value && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(value)) {
    const instant = Date.parse(value);
    if (Number.isFinite(instant) && new Date(instant).toUTCString() === value) return { retryAt: new Date(instant).toISOString(), retryBasis: "http_date" };
  }
  return { retryAt: null, retryBasis: "unknown" };
}
function verifyHeaders(request: NormalizedArxivRequest, record: ObservationRecord): void {
  const payload = record.payload;
  keys(payload, ["schemaVersion", "queryObservationId", "requestDigest", "url", "status", "contentType", "retryAfter", "receivedAt", "bodyScope"]);
  if (record.source !== HEADERS || record.eventId !== identities(request).headers || payload.schemaVersion !== 1 || payload.status !== 429
    || payload.queryObservationId !== identities(request).query || payload.requestDigest !== hash(request) || payload.url !== arxivQueryUrl(request)
    || payload.receivedAt !== record.observedAt || typeof payload.contentType !== "string" || (payload.retryAfter !== null && typeof payload.retryAfter !== "string")
    || payload.bodyScope !== "not_captured_at_header_receipt") throw new LiteratureError("archive_conflict", "Header receipt differs from its bound query or provenance");
}
function quotaSource(ledger: LiteratureArchive, request: NormalizedArxivRequest, response: ObservationRecord | null): ObservationRecord | null {
  const header = verified(ledger, identities(request).headers, HEADERS, request.projectId);
  if (header) {
    verifyHeaders(request, header);
    if (response && (response.payload.status !== header.payload.status || response.payload.contentType !== header.payload.contentType
      || response.payload.retryAfter !== header.payload.retryAfter || Date.parse(response.observedAt) < Date.parse(header.observedAt))) throw new LiteratureError("archive_conflict", "Complete response disagrees with its earlier header receipt");
    return header;
  }
  return response?.payload.status === 429 ? response : null;
}
function holdForResponse(request: NormalizedArxivRequest, response: ObservationRecord): ArxivHold {
  if (response.source === HEADERS) verifyHeaders(request, response); else responseBytes(request, response);
  if (response.payload.status !== 429) throw new LiteratureError("archive_conflict", "An availability hold requires a saved HTTP429 response");
  const retryAfter = response.payload.retryAfter as string | null;
  return { schemaVersion: 1, holdObservationId: `arxiv-hold:${hash(response.eventId)}`, queryObservationId: identities(request).query,
    responseObservationId: response.eventId, responseDigest: response.digest, projectId: request.projectId,
    receivedAt: response.observedAt, retryAfter, ...retryTime(retryAfter, response.observedAt),
    ...(response.source === HEADERS ? { responseEvidenceScope: "headers_only" as const } : {}) };
}
function saveHold(ledger: LiteratureArchive, request: NormalizedArxivRequest, response: ObservationRecord): ObservationRecord {
  const data = holdForResponse(request, response), saved = verified(ledger, data.holdObservationId, HOLD, TRANSPORT_SCOPE);
  if (saved) {
    if (saved.observedAt !== data.receivedAt || encode(saved.payload) !== encode(data)) throw new LiteratureError("archive_conflict", "Availability hold differs from its source response");
    return saved;
  }
  return append(ledger, data.holdObservationId, TRANSPORT_SCOPE, HOLD, data.receivedAt, data);
}

/** No network access. Repairs a missing derived hold after a committed429 response.
 * A hold is source-derived; release is an explicit operator assertion, not proof
 * that arXiv has actually restored service or granted additional quota.
 */
export function getArxivAvailability(ledger: LiteratureArchive, options: ArxivAvailabilityOptions = {}): ArxivAvailability {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString(), instant = Date.parse(checkedAt);
  const records = ledger.listObservations(TRANSPORT_SCOPE), held = new Map<string, ObservationRecord>();
  for (const item of records) {
    if (item.source !== ATTEMPT) continue;
    const attempt = verified(ledger, item.eventId, ATTEMPT, TRANSPORT_SCOPE)!;
    keys(attempt.payload, ["schemaVersion", "queryObservationId", "projectId", "cooldownUntil"]);
    if (typeof attempt.payload.queryObservationId !== "string") throw new LiteratureError("archive_conflict", "Transport attempt query identity is invalid");
    const { request } = queryRecord(ledger, attempt.payload.queryObservationId), ids = identities(request);
    const expected = { schemaVersion: 1, queryObservationId: ids.query, projectId: request.projectId,
      cooldownUntil: new Date(Date.parse(attempt.observedAt) + request.timeoutMs + 3000).toISOString() };
    if (attempt.eventId !== ids.attempt || encode(attempt.payload) !== encode(expected)) throw new LiteratureError("archive_conflict", "Transport attempt differs from its bound query");
    const response = verified(ledger, ids.response, RESPONSE, request.projectId);
    if (response) responseBytes(request, response);
    const quota = quotaSource(ledger, request, response);
    if (quota) { const hold = saveHold(ledger, request, quota); held.set(hold.eventId, hold); }
  }
  const releases = new Map<string, string[]>();
  // Existing derived records must agree with source evidence, including records
  // not encountered through the normal attempt index. Orphans fail closed.
  for (const item of records) {
    if (item.source === HOLD) {
      const record = verified(ledger, item.eventId, HOLD, TRANSPORT_SCOPE)!;
      if (!held.has(record.eventId)) throw new LiteratureError("archive_conflict", "Availability hold has no authoritative429 source");
    } else if (item.source === RELEASE) {
      const record = verified(ledger, item.eventId, RELEASE, TRANSPORT_SCOPE)!, payload = record.payload;
      keys(payload, ["schemaVersion", "holdObservationId", "holdDigest", "releaseId", "evidence", "meaning"]);
      id(payload.releaseId); id(payload.holdObservationId); jsonObject(payload.evidence);
      const hold = held.get(payload.holdObservationId);
      if (!hold || payload.schemaVersion !== 1 || record.eventId !== `arxiv-release:${hash(payload.releaseId)}` || payload.holdDigest !== hold.digest
        || payload.meaning !== "operator_assertion_not_provider_availability_proof" || !Object.keys(payload.evidence).length
        || Buffer.byteLength(encode(payload.evidence)) > 65_536 || Date.parse(record.observedAt) < Date.parse(hold.observedAt)
        || (typeof hold.payload.retryAt === "string" && Date.parse(record.observedAt) < Date.parse(hold.payload.retryAt))) {
        throw new LiteratureError("archive_conflict", "Availability release has an invalid source binding, evidence or time");
      }
      const ids = releases.get(hold.eventId) ?? []; ids.push(record.eventId); releases.set(hold.eventId, ids);
    }
  }
  const holds = [...held.values()].map(record => {
    const hold = record.payload as unknown as ArxivHold, releaseObservationIds = releases.get(record.eventId) ?? [], released = releaseObservationIds.length > 0;
    // A stored release cannot move a known server retry time earlier, including
    // when the local wall clock moves backwards after an otherwise legal release.
    return { ...structuredClone(hold), released, releaseObservationIds, blocked: hold.retryAt === null ? !released : instant < Date.parse(hold.retryAt) };
  });
  return { available: !holds.some(hold => hold.blocked), checkedAt, holds };
}

/** Explicit release is replay-safe by releaseId and cannot bypass a known retryAt. */
export function releaseArxivHold(ledger: LiteratureArchive, raw: ReleaseArxivHoldRequest, options: ArxivAvailabilityOptions = {}): ObservationRecord {
  const input = snapshot(raw); keys(input, ["holdObservationId", "releaseId", "evidence"]); id(input.holdObservationId); id(input.releaseId); jsonObject(input.evidence);
  if (!Object.keys(input.evidence).length || Buffer.byteLength(encode(input.evidence)) > 65_536) throw new LiteratureError("invalid_release", "A bounded nonempty operator evidence object is required");
  const availability = getArxivAvailability(ledger, options), state = availability.holds.find(hold => hold.holdObservationId === input.holdObservationId);
  if (!state) throw new LiteratureError("missing_hold", "No verified arXiv hold has this identity");
  const hold = verified(ledger, state.holdObservationId, HOLD, TRANSPORT_SCOPE)!, eventId = `arxiv-release:${hash(input.releaseId)}`;
  const payload = { schemaVersion: 1, holdObservationId: state.holdObservationId, holdDigest: hold.digest, releaseId: input.releaseId,
    evidence: input.evidence, meaning: "operator_assertion_not_provider_availability_proof" };
  const previous = verified(ledger, eventId, RELEASE, TRANSPORT_SCOPE);
  if (previous) {
    if (encode(previous.payload) !== encode(payload)) throw new LiteratureError("release_conflict", "Release identity already belongs to another assertion");
    return previous;
  }
  const releasedAt = availability.checkedAt;
  if (Date.parse(releasedAt) < Date.parse(state.receivedAt) || (state.retryAt !== null && Date.parse(releasedAt) < Date.parse(state.retryAt))) throw new LiteratureError("release_too_early", "Release cannot precede the response or the server-provided retry time");
  return append(ledger, eventId, TRANSPORT_SCOPE, RELEASE, releasedAt, payload);
}

function finishResponse(ledger: LiteratureArchive, request: NormalizedArxivRequest, record: ObservationRecord, repair: boolean): ArxivDiscovery {
  const ids = identities(request), payload = record.payload, bytes = responseBytes(request, record);
  const quota = quotaSource(ledger, request, record);
  if (repair && quota) saveHold(ledger, request, quota);
  const result = base(request);
  result.responseObservationId = ids.response; result.resultObservationId = ids.result; result.retrievedAt = record.observedAt; result.rawSha256 = payload.rawSha256 as string;
  try {
    if (payload.status !== 200) throw new LiteratureError(`http_${payload.status}`, "arXiv returned an unsuccessful HTTP status; no automatic retry was made");
    if (!/^(application\/(atom\+xml|xml)|text\/xml)(?:\s*;|$)/iu.test(payload.contentType as string)) throw new LiteratureError("unexpected_content_type", "Response is not declared as XML/Atom");
    result.feed = parseArxivAtom(bytes, request.maxResults, request.maxResponseBytes);
    if (result.feed.startIndex !== request.start) throw new LiteratureError("pagination_mismatch", "Returned page offset differs from the requested offset");
    result.status = "complete";
  } catch (error) {
    if (!(error instanceof LiteratureError)) throw error;
    result.status = "failed"; result.feed = null; result.failure = { code: error.code, detail: error.message, retryAfter: payload.retryAfter as string | null };
  }
  if (result.feed) for (const paper of result.feed.papers) {
    const eventId = `arxiv-paper:${hash([ids.query, result.rawSha256, paper.arxivId, paper.version])}`;
    const paperPayload = { schemaVersion: 1, queryObservationId: ids.query, responseObservationId: ids.response, rawSha256: result.rawSha256,
      retrievedAt: record.observedAt, paper, limitations: [...limitations] };
    const saved = verified(ledger, eventId, PAPER, request.projectId);
    if (saved && (saved.observedAt !== record.observedAt || encode(saved.payload) !== encode(paperPayload))) throw new LiteratureError("archive_conflict", "Paper capture differs from its saved response");
    if (!saved) { if (!repair) throw new LiteratureError("incomplete_archive", "Paper records are incomplete; repeat discovery to repair from saved bytes"); append(ledger, eventId, request.projectId, PAPER, record.observedAt, paperPayload); }
    result.paperObservationIds.push(eventId);
  }
  const saved = verified(ledger, ids.result, RESULT, request.projectId);
  if (saved && (saved.observedAt !== record.observedAt || encode(saved.payload) !== encode(result))) throw new LiteratureError("archive_conflict", "Discovery result differs from saved evidence");
  if (!saved) { if (!repair) throw new LiteratureError("incomplete_archive", "Result record is incomplete; repeat discovery to repair from saved bytes"); append(ledger, ids.result, request.projectId, RESULT, record.observedAt, result); }
  return structuredClone(result);
}
function cached(ledger: LiteratureArchive, request: NormalizedArxivRequest, repair: boolean): ArxivDiscovery | null {
  const ids = identities(request);
  const response = verified(ledger, ids.response, RESPONSE, request.projectId);
  if (response) return finishResponse(ledger, request, response, repair);
  const failure = verified(ledger, ids.result, RESULT, request.projectId);
  if (failure) {
    const data = failure.payload as unknown as ArxivDiscovery;
    const expected = { ...base(request), status: "failed", resultObservationId: ids.result, failure: data.failure };
    if (!data.failure || typeof data.failure.code !== "string" || typeof data.failure.detail !== "string" || data.failure.retryAfter !== null || encode(data) !== encode(expected)) throw new LiteratureError("archive_conflict", "Retrieval failure record is inconsistent");
    return structuredClone(data);
  }
  if (verified(ledger, ids.attempt, ATTEMPT, TRANSPORT_SCOPE)) return { ...base(request), failure: { code: "retrieval_unresolved", detail: "A retrieval attempt exists without a complete saved response. This identity will not refetch; use a new explicit discovery identity after cooldown.", retryAfter: null } };
  return null;
}

/** Read and verify an existing capture; this function cannot access the network. */
export function loadArxivDiscovery(ledger: LiteratureArchive, queryObservationId: string): ArxivDiscovery {
  const { request } = queryRecord(ledger, queryObservationId);
  return cached(ledger, request, false) ?? { ...base(request), failure: { code: "not_started", detail: "Query intent exists but retrieval has not started", retryAfter: null } };
}

/** One explicitly requested bounded retrieval, or recovery from its saved response. */
export async function discoverArxiv(ledger: LiteratureArchive, raw: ArxivDiscoveryRequest, options: ArxivDiscoveryOptions = {}): Promise<ArxivDiscovery> {
  const request = normalize(raw), ids = identities(request);
  const { signal, fetch: fetcher, now = () => new Date() } = options;
  const previous = verified(ledger, ids.query, QUERY, request.projectId);
  if (previous) {
    if (encode(queryRecord(ledger, ids.query).request) !== encode(request)) throw new LiteratureError("request_conflict", "Discovery identity already belongs to a different request");
    const found = cached(ledger, request, true); if (found) return found;
  }
  if (signal?.aborted) throw new LiteratureError("cancelled", "Retrieval was cancelled before admission");
  let admitted = false;
  const admission = () => {
    const startedAt = now().toISOString(), started = Date.parse(startedAt);
    if (!getArxivAvailability(ledger, { now: () => new Date(startedAt) }).available) throw new LiteratureError("arxiv_service_held", "A saved429 response blocks new retrievals until its retry time or an explicit operator release");
    for (const observation of ledger.listObservations(TRANSPORT_SCOPE)) {
      if (observation.source !== ATTEMPT) continue;
      const prior = verified(ledger, observation.eventId, ATTEMPT, TRANSPORT_SCOPE)!;
      const { queryObservationId, cooldownUntil } = prior.payload;
      if (typeof queryObservationId !== "string") throw new LiteratureError("archive_conflict", "Transport attempt identity is invalid");
      timestamp(cooldownUntil);
      if (started < Date.parse(cooldownUntil)) throw new LiteratureError("rate_limited_locally", "Persistent arXiv cooldown has not elapsed; no request was sent");
    }
    if (!previous) append(ledger, ids.query, request.projectId, QUERY, startedAt, { schemaVersion: 1, request, requestDigest: hash(request), url: arxivQueryUrl(request) });
    // Conservatively include the whole timeout plus a spacing interval. A restart
    // cannot know whether an interrupted request retained its old connection.
    append(ledger, ids.attempt, TRANSPORT_SCOPE, ATTEMPT, startedAt, { schemaVersion: 1, queryObservationId: ids.query, projectId: request.projectId,
      cooldownUntil: new Date(started + request.timeoutMs + 3000).toISOString() });
    admitted = true;
  };
  let response;
  const receiveHeaders = (headers: ArxivResponseHeaders) => {
    if (headers.status !== 429) return;
    const receivedAt = now().toISOString();
    const record = append(ledger, ids.headers, request.projectId, HEADERS, receivedAt, { schemaVersion: 1,
      queryObservationId: ids.query, requestDigest: hash(request), url: arxivQueryUrl(request), ...headers, receivedAt,
      bodyScope: "not_captured_at_header_receipt" });
    saveHold(ledger, request, record);
  };
  try { response = await retrieveArxiv(request, { now, ...(signal ? { signal } : {}), ...(fetcher ? { fetch: fetcher } : {}) }, admission, receiveHeaders); }
  catch (error) {
    if (!admitted) throw error;
    const failure: DiscoveryFailure = error instanceof LiteratureError ? { code: error.code, detail: error.message, retryAfter: null }
      : { code: "transport_failed", detail: "No complete response was saved; a new discovery identity is required for another retrieval", retryAfter: null };
    const result: ArxivDiscovery = { ...base(request), status: "failed", resultObservationId: ids.result, failure };
    append(ledger, ids.result, request.projectId, RESULT, now().toISOString(), result); return result;
  }
  const retrievedAt = now().toISOString();
  const stored = append(ledger, ids.response, request.projectId, RESPONSE, retrievedAt, { schemaVersion: 1, queryObservationId: ids.query, requestDigest: hash(request), url: arxivQueryUrl(request),
    status: response.status, contentType: response.contentType, retryAfter: response.retryAfter, rawBase64: Buffer.from(response.bytes).toString("base64"),
    rawSha256: digestBytes(response.bytes), rawBytes: response.bytes.length, retrievedAt });
  return finishResponse(ledger, request, stored, true);
}

/** Build source-linked evidence without converting abstract claims into verified results. */
export function buildLiteratureEvidencePacket(ledger: LiteratureArchive, queryObservationId: string, raw: LiteraturePacketRequest) {
  const input = snapshot(raw); keys(input, ["packetId", "question", "proposal", "requiredCriteria"]);
  const discovery = loadArxivDiscovery(ledger, queryObservationId);
  if (discovery.status !== "complete" || !discovery.feed || !discovery.retrievedAt) throw new LiteratureError("discovery_unavailable", "A complete verified discovery is required for an evidence packet");
  const metadata = { query: discovery.request.query, sortBy: discovery.request.sortBy, sortOrder: "descending", start: discovery.request.start,
    requestedResults: discovery.request.maxResults, returnedResults: discovery.feed.papers.length, totalResultsReported: discovery.feed.totalResults,
    retrievedAt: discovery.retrievedAt, rawSha256: discovery.rawSha256, limitations: discovery.limitations };
  const evidence = [{ id: "literature:search", kind: "artifact" as const, locator: `ledger-observation:${queryObservationId}`, version: discovery.rawSha256!, summary: encode(metadata) },
    ...discovery.feed.papers.map((paper, index) => ({ id: `literature:paper:${index + 1}`, kind: "source" as const, locator: paper.abstractUrl,
      version: `${paper.versionedId ?? `${paper.arxivId}:version-unspecified`}; response-sha256:${discovery.rawSha256}`,
      summary: encode({ paper, observationId: discovery.paperObservationIds[index], retrievedAt: discovery.retrievedAt,
        scope: "Author-reported abstract and metadata only; methods and reported results were not verified." }) }))];
  return createEvidencePacket({ schemaVersion: 1, packetId: input.packetId, revision: 1, question: input.question, proposal: input.proposal,
    createdAt: discovery.retrievedAt, requiredCriteria: input.requiredCriteria, evidence,
    checks: [{ id: "full-paper-methods-and-results-reviewed", status: "unknown", evidenceIds: ["literature:search"] },
      { id: "venue-status-independently-verified", status: "unknown", evidenceIds: ["literature:search"] },
      { id: "novelty-and-literature-coverage-established", status: "unknown", evidenceIds: ["literature:search"] }] });
}
