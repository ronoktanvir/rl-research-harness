import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { digestValue, encode, hash, id, keys, snapshot, timestamp } from "../ledger/validation.ts";
import type { JsonObject, ObservationRecord } from "../ledger/types.ts";
import type { LiteratureArchive } from "./types.ts";
import { freezeSnapshot } from "../research/evidence.ts";

export interface PublisherPaperRequest {
  projectId: string; paperId: string; url: string; timeoutMs?: number; maxPdfBytes?: number;
}
export interface NormalizedPublisherPaperRequest extends PublisherPaperRequest { timeoutMs: number; maxPdfBytes: number }
export interface PublisherPdfArtifact { path: string; sha256: string; bytes: number }
export interface PublisherPaper {
  schemaVersion: 1; status: "retrieved" | "failed" | "uncertain";
  publisher: "neurips"; request: NormalizedPublisherPaperRequest;
  requestObservationId: string; paperObservationId: string; responseObservationId: string | null;
  retrievedAt: string | null; artifact: PublisherPdfArtifact | null; failureCode: string | null;
  scope: "publisher_pdf_bytes_not_reviewed"; venueVerification: "unverified";
}
export interface PublisherPaperOptions {
  /** Private controller-owned directory. Never a queued/model-supplied path. */
  artifactDirectory: string; signal?: AbortSignal; fetch?: typeof globalThis.fetch; now?: () => Date;
}
export interface PublisherExtractionRequest {
  projectId: string; extractionId: string; paperObservationId: string; paperObservationDigest: string;
  maxPages?: number; maxTextBytes?: number; maxPageTextBytes?: number; timeoutMs?: number;
}
export interface PublisherPdfExtractionInput {
  pdfBytes: Uint8Array; sourceSha256: string; maxPages: number; maxTextBytes: number;
  maxPageTextBytes: number; timeoutMs: number; signal: AbortSignal;
}
export interface PublisherExtractedPage {
  pageNumber: number; text: string; status: "text" | "empty" | "truncated" | "failed"; errorCode: string | null;
}
export interface PublisherExtractedPages {
  schemaVersion: 1; sourceSha256: string; totalPages: number | null;
  pages: PublisherExtractedPage[]; errorCode: string | null;
}
export interface PublisherPdfExtractor {
  name: string; version: string; sourceSha256: string;
  extract(input: PublisherPdfExtractionInput): Promise<PublisherExtractedPages>;
}
export interface PublisherExtractionOptions { extractor: PublisherPdfExtractor; signal?: AbortSignal; now?: () => Date }
export interface PublisherPaperExtraction {
  schemaVersion: 1; status: "extracted" | "partial" | "no_text" | "failed" | "uncertain";
  extractionObservationId: string; paperObservationId: string; paperObservationDigest: string;
  sourceSha256: string; extractor: { name: string; version: string; sourceSha256: string };
  extractedAt: string | null;
  totalPages: number | null; pages: (PublisherExtractedPage & { textSha256: string })[];
  textBytes: number; failureCode: string | null; scope: "pdf_text_extraction_not_scientific_review";
  limitations: string[];
}

const REQUEST = "publisher-paper-request.v1", ATTEMPT = "publisher-paper-attempt.v1", HEADERS = "publisher-paper-headers.v1";
const RESPONSE = "publisher-paper-response.v1", PAPER = "publisher-paper-result.v1", EXTRACTION = "publisher-paper-extraction.v1";
const EXTRACT_INTENT = "publisher-paper-extraction-intent.v1", SCOPE = "system.literature.publisher.neurips";
const MAX_PDF = 16 * 1024 * 1024;
const active = new Set<string>();
const extractionLimitations = ["All page numbers refer to PDF page order, not printed numbering.",
  "Extracted text does not establish reading order, equations, tables, figures, OCR coverage or scientific claim validity.",
  "Empty text does not establish an image-only or blank page. No embedded link or executable content is followed.",
  "Publisher origin and successful extraction do not verify title, authorship, venue acceptance, novelty or research conclusions."];
class PublisherError extends Error { constructor(readonly code: string) { super(code); this.name = "PublisherError"; } }
function fail(code: string): never { throw new PublisherError(code); }
function bytesHash(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function clock(now: () => Date): string { const result = now().toISOString(); timestamp(result); return result; }
function bound(value: unknown, fallback: number, min: number, max: number): number {
  const number = value ?? fallback;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < min || number > max) fail("invalid_bound");
  return number;
}
function flat(raw: unknown, allowed: string[], required: string[]): Record<string, unknown> {
  keys(raw, allowed, required);
  const fields = Object.getOwnPropertyDescriptors(raw);
  if (Object.getOwnPropertySymbols(raw).length || Object.values(fields).some(field => !Object.hasOwn(field, "value") || !field.enumerable
    || !["string", "number"].includes(typeof field.value) || typeof field.value === "string" && field.value.length > 4096)) fail("invalid_request");
  return snapshot(raw);
}
export function publisherPdfUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 2048) fail("unsupported_publisher_url");
  let url: URL; try { url = new URL(raw); } catch { return fail("unsupported_publisher_url"); }
  if (url.protocol !== "https:" || !["proceedings.neurips.cc", "papers.neurips.cc"].includes(url.hostname)
    || url.username || url.password || url.port || url.search || url.hash || url.href !== raw
    || !/^\/paper_files\/paper\/\d{4}\/file\/[a-f0-9]{32}-(?:Paper|Paper-Conference|Supplemental)\.pdf$/u.test(url.pathname)) fail("unsupported_publisher_url");
  return url.href;
}
function normalize(raw: PublisherPaperRequest): NormalizedPublisherPaperRequest {
  const value = flat(raw, ["projectId", "paperId", "url", "timeoutMs", "maxPdfBytes"], ["projectId", "paperId", "url"]);
  id(value.projectId); id(value.paperId);
  if (value.projectId.startsWith("system.literature.")) fail("reserved_project");
  return { projectId: value.projectId, paperId: value.paperId, url: publisherPdfUrl(value.url),
    timeoutMs: bound(value.timeoutMs, 20_000, 1, 60_000), maxPdfBytes: bound(value.maxPdfBytes, MAX_PDF, 1024, MAX_PDF) };
}
function ids(request: NormalizedPublisherPaperRequest) {
  const suffix = hash([request.projectId, request.paperId]);
  return { request: `publisher-request:${suffix}`, attempt: `publisher-attempt:${suffix}`, headers: `publisher-headers:${suffix}`,
    response: `publisher-response:${suffix}`, paper: `publisher-paper:${suffix}` };
}
function verified(archive: LiteratureArchive, eventId: string, source: string): ObservationRecord | null {
  const raw = archive.getObservation(eventId); if (!raw) return null;
  const record = snapshot(raw), { digest, ...body } = record;
  if (record.eventId !== eventId || record.source !== source || record.runId !== null || record.actionId !== null || record.jobId !== null
    || record.sequence !== 0 || hash(body) !== digest) fail("archive_conflict");
  timestamp(record.observedAt); return record;
}
function append(archive: LiteratureArchive, eventId: string, projectId: string, source: string, observedAt: string, payload: unknown): ObservationRecord {
  return archive.appendObservation({ eventId, projectId, source, sequence: 0, observedAt, runId: null, actionId: null, jobId: null, payload: payload as JsonObject });
}
function requestRecord(archive: LiteratureArchive, requestId: string) {
  const record = verified(archive, requestId, REQUEST); if (!record) fail("missing_request");
  const payload = record.payload;
  keys(payload, ["schemaVersion", "request", "artifactDirectory", "requestDigest"]);
  const request = normalize(payload.request as unknown as PublisherPaperRequest);
  if (typeof payload.artifactDirectory !== "string" || !isAbsolute(payload.artifactDirectory) || resolve(payload.artifactDirectory) !== payload.artifactDirectory
    || payload.schemaVersion !== 1 || record.projectId !== request.projectId || ids(request).request !== requestId
    || payload.requestDigest !== hash({ request, artifactDirectory: payload.artifactDirectory })) fail("archive_conflict");
  return { record, request, artifactDirectory: payload.artifactDirectory, requestDigest: payload.requestDigest as string };
}
function headerRecord(archive: LiteratureArchive, requestId: string): ObservationRecord | null {
  const context = requestRecord(archive, requestId), record = verified(archive, ids(context.request).headers, HEADERS);
  if (!record) return null;
  const payload = record.payload;
  keys(payload, ["schemaVersion", "requestObservationId", "requestDigest", "url", "status", "contentType", "retryAfter", "bodyScope"]);
  if (record.projectId !== SCOPE || payload.schemaVersion !== 1 || payload.requestObservationId !== requestId
    || payload.requestDigest !== context.requestDigest || payload.url !== context.request.url || payload.bodyScope !== "headers_only"
    || !Number.isInteger(payload.status) || (payload.status as number) < 100 || (payload.status as number) > 599
    || typeof payload.contentType !== "string" || payload.contentType.length > 256
    || payload.retryAfter !== null && (typeof payload.retryAfter !== "string" || payload.retryAfter.length > 256)) fail("archive_conflict");
  return record;
}
/** Both NeurIPS host aliases share this saved denial. No release or automatic retry exists here. */
export function getPublisherAvailability(archive: LiteratureArchive, now: () => Date = () => new Date()) {
  const checkedAt = clock(now), holds: { observationId: string; digest: string; receivedAt: string; retryAfter: string | null }[] = [];
  let busyUntil: string | null = null;
  for (const item of archive.listObservations(SCOPE)) {
    if (item.source === HEADERS) {
      if (typeof item.payload.requestObservationId !== "string") fail("archive_conflict");
      const record = headerRecord(archive, item.payload.requestObservationId); if (!record || record.eventId !== item.eventId) fail("archive_conflict");
      if (record.payload.status === 429) holds.push({ observationId: record.eventId, digest: record.digest, receivedAt: record.observedAt, retryAfter: record.payload.retryAfter as string | null });
    } else if (item.source === ATTEMPT) {
      const record = verified(archive, item.eventId, ATTEMPT)!;
      keys(record.payload, ["requestObservationId", "requestDigest", "busyUntil"]);
      if (typeof record.payload.requestObservationId !== "string") fail("archive_conflict");
      const context = requestRecord(archive, record.payload.requestObservationId);
      const expected = new Date(Date.parse(record.observedAt) + context.request.timeoutMs + 1000).toISOString();
      if (record.eventId !== ids(context.request).attempt || record.payload.requestDigest !== context.requestDigest || record.payload.busyUntil !== expected) fail("archive_conflict");
      if (Date.parse(expected) > Date.parse(checkedAt) && (!busyUntil || expected > busyUntil)) busyUntil = expected;
    }
  }
  return { publisher: "neurips" as const, checkedAt, available: !holds.length && !busyUntil && !active.has("neurips"),
    holds, busyUntil, connectionActive: active.has("neurips"), meaning: "Saved publisher availability only; no provider reset or service recovery is inferred." };
}
async function readArtifact(artifact: PublisherPdfArtifact, maximum: number): Promise<Uint8Array> {
  const handle = await open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== artifact.bytes || stat.size > maximum || stat.size < 5) fail("artifact_unavailable_or_changed");
    const bytes = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    const result = bytes.subarray(0, length);
    if (length !== artifact.bytes || bytesHash(result) !== artifact.sha256 || result.subarray(0, 5).toString() !== "%PDF-") fail("artifact_unavailable_or_changed");
    return result;
  } finally { await handle.close(); }
}
async function writeArtifact(directory: string, bytes: Uint8Array): Promise<PublisherPdfArtifact> {
  const sha256 = bytesHash(bytes), path = join(directory, `${sha256}.pdf`), temporary = join(directory, `.pdf-${randomUUID()}`);
  const artifact = { path, sha256, bytes: bytes.byteLength };
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await link(temporary, path); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; await readArtifact(artifact, MAX_PDF); }
  } finally { await rm(temporary, { force: true }); }
  return artifact;
}
function base(request: NormalizedPublisherPaperRequest): PublisherPaper {
  return { schemaVersion: 1, status: "uncertain", publisher: "neurips", request, requestObservationId: ids(request).request,
    paperObservationId: ids(request).paper, responseObservationId: null, retrievedAt: null, artifact: null, failureCode: "attempt_without_complete_response",
    scope: "publisher_pdf_bytes_not_reviewed", venueVerification: "unverified" };
}
async function savedPaper(archive: LiteratureArchive, context: ReturnType<typeof requestRecord>, repair: boolean): Promise<PublisherPaper> {
  const identity = ids(context.request), saved = verified(archive, identity.paper, PAPER), response = verified(archive, identity.response, RESPONSE);
  let expected = base(context.request);
  if (response) {
    const payload = response.payload;
    keys(payload, ["requestObservationId", "requestDigest", "headersObservationId", "headersDigest", "artifact"]);
    const header = headerRecord(archive, identity.request);
    if (response.projectId !== context.request.projectId || payload.requestObservationId !== identity.request || payload.requestDigest !== context.requestDigest
      || !header || header.payload.status !== 200 || !/^application\/pdf(?:\s*;|$)/iu.test(header.payload.contentType as string)
      || payload.headersObservationId !== header.eventId || payload.headersDigest !== header.digest) fail("archive_conflict");
    keys(payload.artifact, ["path", "sha256", "bytes"]); digestValue(payload.artifact.sha256);
    const artifact = payload.artifact as unknown as PublisherPdfArtifact;
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 5 || artifact.bytes > context.request.maxPdfBytes
      || artifact.path !== join(context.artifactDirectory, `${artifact.sha256}.pdf`)) fail("archive_conflict");
    await readArtifact(artifact, context.request.maxPdfBytes);
    expected = { ...expected, status: "retrieved", responseObservationId: identity.response, retrievedAt: response.observedAt, artifact, failureCode: null };
    if (saved && (saved.projectId !== context.request.projectId || encode(saved.payload) !== encode(expected))) fail("archive_conflict");
    if (!saved && repair) append(archive, identity.paper, context.request.projectId, PAPER, response.observedAt, expected);
    else if (!saved) fail("incomplete_archive");
  } else if (saved) {
    const payload = saved.payload;
    keys(payload, Object.keys(expected));
    if (saved.projectId !== context.request.projectId || payload.status !== "failed" || typeof payload.failureCode !== "string"
      || !/^[a-z][a-z0-9_]{0,63}$/u.test(payload.failureCode)) fail("archive_conflict");
    expected = { ...expected, status: "failed", failureCode: payload.failureCode };
    if (encode(payload) !== encode(expected)) fail("archive_conflict");
  }
  return freezeSnapshot(expected) as PublisherPaper;
}
export async function loadPublisherPaper(archive: LiteratureArchive, paperObservationId: string): Promise<PublisherPaper> {
  if (!/^publisher-paper:[a-f0-9]{64}$/u.test(paperObservationId)) fail("invalid_paper_identity");
  return savedPaper(archive, requestRecord(archive, paperObservationId.replace("publisher-paper:", "publisher-request:")), false);
}

/** Fetch exactly once after durable intent. An interrupted identity never refetches. */
export async function retrievePublisherPaper(archive: LiteratureArchive, raw: PublisherPaperRequest, options: PublisherPaperOptions): Promise<PublisherPaper> {
  const request = normalize(raw), identity = ids(request), now = options.now ?? (() => new Date()), fetcher = options.fetch ?? globalThis.fetch, signal = options.signal;
  if (typeof options.artifactDirectory !== "string" || !isAbsolute(options.artifactDirectory) || options.artifactDirectory.includes("\0")) fail("invalid_artifact_directory");
  const selectedDirectory = resolve(options.artifactDirectory);
  if (signal?.aborted) fail("cancelled");
  await mkdir(selectedDirectory, { recursive: true, mode: 0o700 });
  const artifactDirectory = await realpath(selectedDirectory), requestDigest = hash({ request, artifactDirectory });
  const existing = verified(archive, identity.request, REQUEST);
  if (existing) {
    const context = requestRecord(archive, identity.request);
    if (context.requestDigest !== requestDigest) fail("request_identity_conflict");
    if (verified(archive, identity.attempt, ATTEMPT)) return savedPaper(archive, context, true);
  }
  const availability = getPublisherAvailability(archive, now);
  if (!availability.available) fail(availability.holds.length ? "publisher_held" : "publisher_busy");
  if (signal?.aborted) fail("cancelled");
  const at = clock(now);
  if (!existing) append(archive, identity.request, request.projectId, REQUEST, at, { schemaVersion: 1, request, artifactDirectory, requestDigest });
  append(archive, identity.attempt, SCOPE, ATTEMPT, at, { requestObservationId: identity.request, requestDigest,
    busyUntil: new Date(Date.parse(at) + request.timeoutMs + 1000).toISOString() });
  active.add("neurips");
  const controller = new AbortController(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let body: ReadableStream<Uint8Array> | null = null, bodyCancellation: Promise<void> | undefined;
  // Cancel only once: read() may settle as soon as cancellation starts, while
  // the underlying connection teardown promise remains pending.
  const cancelBody = () => {
    if (!bodyCancellation && body) {
      try { bodyCancellation = (reader ? reader.cancel() : body.cancel()).then(() => {}, () => {}); }
      catch { bodyCancellation = Promise.resolve(); }
    }
    return bodyCancellation;
  };
  let reject!: (error: Error) => void;
  const interruption = new Promise<never>((_, rejecter) => { reject = rejecter; });
  const abort = (code: string) => { const error = new PublisherError(code); controller.abort(error); void cancelBody(); reject(error); };
  const cancel = () => abort("cancelled"), timer = setTimeout(() => abort("timeout"), request.timeoutMs);
  signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
  const operation = (async () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    const response = await fetcher(request.url, { method: "GET", redirect: "error", credentials: "omit", signal: controller.signal,
      headers: { Accept: "application/pdf", "User-Agent": "rl-research-harness/0.1 (bounded primary-paper archival)" } });
    body = response.body;
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (response.redirected || response.url && response.url !== request.url) fail("redirect_rejected");
      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) fail("invalid_http_status");
      const retry = response.headers.get("retry-after"), content = response.headers.get("content-type") ?? "";
      const header = append(archive, identity.headers, SCOPE, HEADERS, clock(now), { schemaVersion: 1, requestObservationId: identity.request,
        requestDigest, url: request.url, status: response.status, contentType: content.length <= 256 ? content : "",
        retryAfter: retry !== null && retry.length <= 256 ? retry : null, bodyScope: "headers_only" });
      if (response.status !== 200) fail(`http_${response.status}`);
      if (!/^application\/pdf(?:\s*;|$)/iu.test(content)) fail("unexpected_content_type");
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > request.maxPdfBytes)) fail("pdf_too_large");
      if (!body) fail("empty_response");
      reader = body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      while (true) { const next = await reader.read(); if (controller.signal.aborted) throw controller.signal.reason; if (next.done) break;
        length += next.value.byteLength; if (length > request.maxPdfBytes) fail("pdf_too_large"); chunks.push(next.value.slice()); }
      const bytes = Buffer.concat(chunks, length); if (bytes.subarray(0, 5).toString() !== "%PDF-") fail("invalid_pdf_signature");
      return { bytes, header };
    } finally { void cancelBody(); reader?.releaseLock(); reader = undefined; }
  })();
  const releaseConnection = async () => { await bodyCancellation; active.delete("neurips"); };
  void operation.then(releaseConnection, releaseConnection);
  try {
    const response = await Promise.race([operation, interruption]);
    const artifact = await writeArtifact(artifactDirectory, response.bytes);
    const receivedAt = clock(now);
    append(archive, identity.response, request.projectId, RESPONSE, receivedAt, { requestObservationId: identity.request,
      requestDigest, headersObservationId: response.header.eventId, headersDigest: response.header.digest, artifact });
    return await savedPaper(archive, requestRecord(archive, identity.request), true);
  } catch (error) {
    // Response bytes are authoritative once committed. A later projection failure
    // must remain repairable from those bytes, never become a conflicting failure.
    if (verified(archive, identity.response, RESPONSE)) throw error;
    // A failed DB commit must not be disguised as a successful persistence boundary.
    if (!(error instanceof PublisherError) && error instanceof Error && "code" in error && ["conflict", "closed", "invalid"].includes(String(error.code))) throw error;
    const result: PublisherPaper = { ...base(request), status: "failed", failureCode: error instanceof PublisherError ? error.code : "retrieval_or_artifact_failed" };
    append(archive, identity.paper, request.projectId, PAPER, clock(now), result); return freezeSnapshot(result) as PublisherPaper;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}

interface NormalizedExtractionRequest extends PublisherExtractionRequest {
  maxPages: number; maxTextBytes: number; maxPageTextBytes: number; timeoutMs: number;
}
function extractionRequest(raw: PublisherExtractionRequest): NormalizedExtractionRequest {
  const value = flat(raw, ["projectId", "extractionId", "paperObservationId", "paperObservationDigest", "maxPages", "maxTextBytes", "maxPageTextBytes", "timeoutMs"],
    ["projectId", "extractionId", "paperObservationId", "paperObservationDigest"]);
  id(value.projectId); id(value.extractionId); digestValue(value.paperObservationDigest);
  if (value.projectId.startsWith("system.literature.") || typeof value.paperObservationId !== "string"
    || !/^publisher-paper:[a-f0-9]{64}$/u.test(value.paperObservationId)) fail("invalid_extraction_request");
  return { projectId: value.projectId, extractionId: value.extractionId, paperObservationId: value.paperObservationId,
    paperObservationDigest: value.paperObservationDigest, maxPages: bound(value.maxPages, 100, 1, 200),
    maxTextBytes: bound(value.maxTextBytes, 524_288, 1, 524_288), maxPageTextBytes: bound(value.maxPageTextBytes, 65_536, 1, 65_536),
    timeoutMs: bound(value.timeoutMs, 30_000, 1, 60_000) };
}
function extractorIdentity(extractor: Pick<PublisherPdfExtractor, "name" | "version" | "sourceSha256">) {
  const value = flat(extractor, ["name", "version", "sourceSha256"], ["name", "version", "sourceSha256"]);
  id(value.name);
  if (typeof value.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$/u.test(value.version)) fail("invalid_extractor");
  digestValue(value.sourceSha256);
  return { name: value.name, version: value.version, sourceSha256: value.sourceSha256 };
}
function extractionIds(request: NormalizedExtractionRequest) {
  const suffix = hash([request.projectId, request.extractionId]);
  return { intent: `publisher-extraction-intent:${suffix}`, result: `publisher-extraction:${suffix}` };
}
function inert(raw: unknown): unknown {
  let nodes = 200_000, size = 1_500_000;
  const copy = (value: unknown, depth: number): unknown => {
    if (--nodes < 0 || depth > 12) fail("invalid_extractor_result");
    size -= typeof value === "string" ? Buffer.byteLength(value) + 2 : 2;
    if (size < 0) fail("invalid_extractor_result");
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype)) fail("invalid_extractor_result");
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length || Object.values(fields).some(field => !Object.hasOwn(field, "value"))) fail("invalid_extractor_result");
    if (Array.isArray(value)) {
      if (value.length > 200 || Object.keys(fields).length !== value.length + 1) fail("invalid_extractor_result");
      return Array.from({ length: value.length }, (_, index) => {
        if (!fields[index]?.enumerable) fail("invalid_extractor_result"); return copy(fields[index]!.value, depth + 1);
      });
    }
    return Object.fromEntries(Object.entries(fields).map(([key, field]) => {
      size -= Buffer.byteLength(key) + 3; if (!field.enumerable || size < 0) fail("invalid_extractor_result");
      return [key, copy(field.value, depth + 1)];
    }));
  };
  const result = copy(raw, 0);
  if (Buffer.byteLength(encode(result)) > 1_500_000) fail("invalid_extractor_result");
  return result;
}
function errorCode(value: unknown): asserts value is string | null {
  if (value !== null && (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(value))) fail("invalid_extractor_result");
}
function extractionBase(request: NormalizedExtractionRequest, sourceSha256: string, extractor: ReturnType<typeof extractorIdentity>): PublisherPaperExtraction {
  return { schemaVersion: 1, status: "uncertain", extractionObservationId: extractionIds(request).result,
    paperObservationId: request.paperObservationId, paperObservationDigest: request.paperObservationDigest, sourceSha256, extractor,
    extractedAt: null, totalPages: null, pages: [], textBytes: 0, failureCode: "extraction_attempt_without_result",
    scope: "pdf_text_extraction_not_scientific_review", limitations: [...extractionLimitations] };
}
function checkedExtraction(raw: unknown, request: NormalizedExtractionRequest, base: PublisherPaperExtraction, at: string): PublisherPaperExtraction {
  const value = inert(raw); keys(value, ["schemaVersion", "sourceSha256", "totalPages", "pages", "errorCode"]);
  if (value.schemaVersion !== 1 || value.sourceSha256 !== base.sourceSha256) fail("invalid_extractor_result");
  const total = value.totalPages;
  if (total !== null && (typeof total !== "number" || !Number.isSafeInteger(total) || total < 1 || total > 100_000)) fail("invalid_extractor_result");
  if (!Array.isArray(value.pages) || value.pages.length > request.maxPages || total === null && value.pages.length || total !== null && value.pages.length > total) fail("invalid_extractor_result");
  errorCode(value.errorCode); let textBytes = 0;
  const pages = value.pages.map((page, index) => {
    keys(page, ["pageNumber", "text", "status", "errorCode"]); errorCode(page.errorCode);
    if (page.pageNumber !== index + 1 || typeof page.text !== "string" || !["text", "empty", "truncated", "failed"].includes(page.status as string)) fail("invalid_extractor_result");
    const length = Buffer.byteLength(page.text); textBytes += length;
    if (length > request.maxPageTextBytes || textBytes > request.maxTextBytes
      || ["empty", "failed"].includes(page.status as string) && length !== 0
      || page.status === "text" && !page.text.trim()) fail("invalid_extractor_result");
    return { ...(page as unknown as PublisherExtractedPage), textSha256: bytesHash(page.text) };
  });
  let status: PublisherPaperExtraction["status"];
  if (total === null || !pages.length) status = "failed";
  else if (pages.length !== total || value.errorCode !== null || pages.some(page => page.errorCode !== null || ["truncated", "failed"].includes(page.status))) status = "partial";
  else status = pages.some(page => page.status === "text") ? "extracted" : "no_text";
  return { ...base, status, extractedAt: at, totalPages: total as number | null, pages, textBytes,
    failureCode: value.errorCode ?? (status === "failed" ? "no_pages_extracted" : null) };
}
async function extractionContext(archive: LiteratureArchive, intentId: string) {
  const record = verified(archive, intentId, EXTRACT_INTENT); if (!record) fail("missing_extraction_intent");
  keys(record.payload, ["request", "requestDigest", "extractor", "sourceSha256"]);
  const request = extractionRequest(record.payload.request as unknown as PublisherExtractionRequest);
  const extractor = extractorIdentity(record.payload.extractor as unknown as PublisherPdfExtractor);
  const paper = await loadPublisherPaper(archive, request.paperObservationId), paperRecord = verified(archive, request.paperObservationId, PAPER);
  if (record.projectId !== request.projectId || extractionIds(request).intent !== intentId || !paperRecord || paperRecord.projectId !== request.projectId
    || paperRecord.digest !== request.paperObservationDigest || paper.status !== "retrieved" || !paper.artifact
    || record.payload.sourceSha256 !== paper.artifact.sha256
    || record.payload.requestDigest !== hash({ request, extractor, sourceSha256: paper.artifact.sha256 })) fail("archive_conflict");
  return { record, request, extractor, paper, base: extractionBase(request, paper.artifact.sha256, extractor) };
}
/** Load verified page text without calling the parser or any network endpoint. */
export async function loadPublisherExtraction(archive: LiteratureArchive, extractionObservationId: string): Promise<PublisherPaperExtraction> {
  if (!/^publisher-extraction:[a-f0-9]{64}$/u.test(extractionObservationId)) fail("invalid_extraction_identity");
  const context = await extractionContext(archive, extractionObservationId.replace("publisher-extraction:", "publisher-extraction-intent:"));
  const saved = verified(archive, extractionObservationId, EXTRACTION);
  if (!saved) return freezeSnapshot(context.base) as PublisherPaperExtraction;
  const data = saved.payload;
  if (saved.projectId !== context.request.projectId || data.extractedAt !== saved.observedAt) fail("archive_conflict");
  let expected: PublisherPaperExtraction;
  if (data.status === "failed" && data.totalPages === null) {
    errorCode(data.failureCode); if (!data.failureCode) fail("archive_conflict");
    expected = { ...context.base, status: "failed", extractedAt: saved.observedAt, failureCode: data.failureCode };
  } else {
    if (!Array.isArray(data.pages)) fail("archive_conflict");
    expected = checkedExtraction({ schemaVersion: 1, sourceSha256: data.sourceSha256, totalPages: data.totalPages,
      pages: data.pages.map(page => { keys(page, ["pageNumber", "text", "status", "errorCode", "textSha256"]); const { textSha256: _hash, ...body } = page; return body; }),
      errorCode: data.failureCode }, context.request, context.base, saved.observedAt);
  }
  if (encode(expected) !== encode(data)) fail("archive_conflict");
  return freezeSnapshot(expected) as PublisherPaperExtraction;
}
/** The injected trusted parser receives verified bytes, never a mutable source pathname.
 * Once extraction intent exists, a retry loads its result/uncertainty without invoking it again.
 */
export async function extractPublisherPaper(archive: LiteratureArchive, raw: PublisherExtractionRequest,
  options: PublisherExtractionOptions): Promise<PublisherPaperExtraction> {
  const request = extractionRequest(raw), identity = extractionIds(request), now = options.now ?? (() => new Date()), signal = options.signal;
  const { name, version, sourceSha256, extract } = options.extractor, extractor = extractorIdentity({ name, version, sourceSha256 });
  if (typeof extract !== "function") fail("invalid_extractor");
  const paper = await loadPublisherPaper(archive, request.paperObservationId), paperRecord = verified(archive, request.paperObservationId, PAPER);
  if (paper.status !== "retrieved" || !paper.artifact || !paperRecord || paperRecord.projectId !== request.projectId
    || paperRecord.digest !== request.paperObservationDigest) fail("paper_not_available_for_extraction");
  const payload = { request, requestDigest: hash({ request, extractor, sourceSha256: paper.artifact.sha256 }), extractor, sourceSha256: paper.artifact.sha256 };
  let previous = verified(archive, identity.intent, EXTRACT_INTENT);
  if (previous) {
    if (encode(previous.payload) !== encode(payload)) fail("extraction_identity_conflict");
    return loadPublisherExtraction(archive, identity.result);
  }
  const pdfBytes = await readArtifact(paper.artifact, paper.request.maxPdfBytes);
  // Recheck after awaited filesystem work: two simultaneous callers share one intent.
  previous = verified(archive, identity.intent, EXTRACT_INTENT);
  if (previous) {
    if (encode(previous.payload) !== encode(payload)) fail("extraction_identity_conflict");
    return loadPublisherExtraction(archive, identity.result);
  }
  if (signal?.aborted) fail("cancelled");
  append(archive, identity.intent, request.projectId, EXTRACT_INTENT, clock(now), payload);
  const base = extractionBase(request, paper.artifact.sha256, extractor), controller = new AbortController();
  let reject!: (error: Error) => void;
  const interruption = new Promise<never>((_, rejecter) => { reject = rejecter; });
  const abort = (code: string) => { const error = new PublisherError(code); controller.abort(error); reject(error); };
  const cancel = () => abort("cancelled"), timer = setTimeout(() => abort("extraction_timeout"), request.timeoutMs);
  signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
  let result: PublisherPaperExtraction;
  try {
    const output = await Promise.race([Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return extract({ pdfBytes: new Uint8Array(pdfBytes), sourceSha256: base.sourceSha256, maxPages: request.maxPages,
        maxTextBytes: request.maxTextBytes, maxPageTextBytes: request.maxPageTextBytes, timeoutMs: request.timeoutMs, signal: controller.signal });
    }), interruption]);
    result = checkedExtraction(output, request, base, clock(now));
  } catch (error) {
    result = { ...base, status: "failed", extractedAt: clock(now), failureCode: error instanceof PublisherError ? error.code : "extractor_failed" };
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
  append(archive, identity.result, request.projectId, EXTRACTION, result.extractedAt!, result);
  return freezeSnapshot(result) as PublisherPaperExtraction;
}
