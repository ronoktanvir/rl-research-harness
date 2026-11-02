import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { extractPublisherPaper, getPublisherAvailability, loadPublisherExtraction, loadPublisherPaper, publisherPdfUrl, retrievePublisherPaper } from "../../src/literature/publisher-paper.ts";
import type { PublisherExtractionRequest, PublisherPdfExtractor, PublisherPaper, PublisherExtractedPages } from "../../src/literature/publisher-paper.ts";

const URL = "https://proceedings.neurips.cc/paper_files/paper/2021/file/f514cec81cb148559cf475e7426eed5e-Paper.pdf";
const PDF = new TextEncoder().encode("%PDF-1.7\nsynthetic bytes for transport tests; not a parsed paper\n%%EOF\n");
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "publisher-paper-")), ledgerPath = join(directory, "ledger.sqlite"), artifactDirectory = join(directory, "pdfs");
  let current = new Date("2026-11-02T12:00:00.000Z"), ledger = openExperimentLedger({ path: ledgerPath, now: () => current });
  let calls = 0;
  const now = () => new Date(current), request = { projectId: "study", paperId: "paper-one", url: URL, timeoutMs: 100, maxPdfBytes: 1024 };
  const fetch: typeof globalThis.fetch = async (url, options) => {
    calls++; assert.equal(url, URL); assert.equal(options?.redirect, "error"); assert.equal(options?.credentials, "omit");
    assert.ok(ledger.listObservations("study").some(item => item.source === "publisher-paper-request.v1"));
    assert.ok(ledger.listObservations("system.literature.publisher.neurips").some(item => item.source === "publisher-paper-attempt.v1"));
    return new Response(PDF, { headers: { "content-type": "application/pdf" } });
  };
  t.after(async () => { ledger.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, artifactDirectory, request, now, fetch, calls: () => calls, ledger: () => ledger,
    advance(ms = 5000) { current = new Date(current.getTime() + ms); },
    retrieve() { return retrievePublisherPaper(ledger, request, { artifactDirectory, now, fetch }); },
    reopen() { ledger.close(); ledger = openExperimentLedger({ path: ledgerPath, now }); },
  };
}
function extractionRequest(f: Awaited<ReturnType<typeof fixture>>, paper: PublisherPaper): PublisherExtractionRequest {
  return { projectId: "study", extractionId: "extract-one", paperObservationId: paper.paperObservationId,
    paperObservationDigest: f.ledger().getObservation(paper.paperObservationId)!.digest, timeoutMs: 100, maxPages: 4, maxTextBytes: 1024, maxPageTextBytes: 256 };
}
function extractor(output?: (sha256: string) => PublisherExtractedPages): PublisherPdfExtractor {
  return { name: "offline-text-fixture", version: "1.0", sourceSha256: "a".repeat(64), async extract(input) {
    assert.deepEqual(input.pdfBytes, PDF);
    return output ? output(input.sourceSha256) : { schemaVersion: 1, sourceSha256: input.sourceSha256, totalPages: 2,
      pages: [{ pageNumber: 1, text: "Synthetic methods text.", status: "text", errorCode: null },
        { pageNumber: 2, text: "", status: "empty", errorCode: null }], errorCode: null };
  } };
}

test("publisher intent precedes one fetch; exact PDF remains outside the ledger and reloads without network", async t => {
  const f = await fixture(t), paper = await f.retrieve();
  assert.equal(paper.status, "retrieved"); assert.equal(paper.scope, "publisher_pdf_bytes_not_reviewed"); assert.equal(paper.venueVerification, "unverified");
  assert.deepEqual(new Uint8Array(await readFile(paper.artifact!.path)), PDF);
  assert.ok(f.ledger().listObservations("study").every(item => !JSON.stringify(item.payload).includes("synthetic bytes for transport")));
  f.reopen();
  assert.deepEqual(await f.retrieve(), paper); assert.deepEqual(await loadPublisherPaper(f.ledger(), paper.paperObservationId), paper);
  assert.equal(f.calls(), 1); assert.equal(f.ledger().listRuns().length, 0);
});

test("URL policy rejects nonpublisher, private, credential, query and redirect destinations", async t => {
  const f = await fixture(t);
  for (const url of [URL.replace("https:", "http:"), URL.replace("proceedings.neurips.cc", "127.0.0.1"), `${URL}?token=secret`,
    URL.replace("https://", "https://user:pass@"), URL.replace("proceedings.neurips.cc", "proceedings.neurips.cc.evil.example"),
    URL.replace("/paper_files/", "/%2e%2e/paper_files/"), URL.replace("Paper.pdf", "Paper.pdf#ignored")]) assert.throws(() => publisherPdfUrl(url));
  let calls = 0;
  const paper = await retrievePublisherPaper(f.ledger(), f.request, { artifactDirectory: f.artifactDirectory, now: f.now, fetch: async () => {
    calls++; const response = new Response(PDF, { headers: { "content-type": "application/pdf" } });
    Object.defineProperty(response, "url", { value: "http://127.0.0.1/private" }); return response;
  } });
  assert.equal(paper.status, "failed"); assert.equal(paper.failureCode, "redirect_rejected"); assert.equal(calls, 1);
});

test("429 headers hold every NeurIPS alias and project without reading or waiting for the response body", async t => {
  const f = await fixture(t); let calls = 0, read = false;
  const stream = new ReadableStream<Uint8Array>({ pull() { read = true; return new Promise(() => {}); } }, { highWaterMark: 0 });
  const paper = await retrievePublisherPaper(f.ledger(), f.request, { artifactDirectory: f.artifactDirectory, now: f.now,
    fetch: async () => { calls++; return new Response(stream, { status: 429, headers: { "retry-after": "60" } }); } });
  assert.equal(paper.failureCode, "http_429"); assert.equal(read, false);
  f.advance(120_000); f.reopen(); const availability = getPublisherAvailability(f.ledger(), f.now);
  assert.equal(availability.available, false); assert.equal(availability.holds[0]!.retryAfter, "60");
  await assert.rejects(retrievePublisherPaper(f.ledger(), { ...f.request, projectId: "different", paperId: "bypass", url: URL.replace("proceedings", "papers") },
    { artifactDirectory: f.artifactDirectory, now: f.now, fetch: async () => { calls++; throw new Error("Must not fetch"); } }), /publisher_held/u);
  assert.deepEqual(await f.retrieve(), paper); assert.equal(calls, 1); assert.equal(f.calls(), 0);
});

test("declared and streamed byte limits, non-PDF data and unsuccessful responses never become artifacts", async t => {
  const cases: [() => Response, string][] = [
    [() => new Response(PDF, { headers: { "content-type": "application/pdf", "content-length": "2048" } }), "pdf_too_large"],
    [() => new Response(new Uint8Array(1025), { headers: { "content-type": "application/pdf" } }), "pdf_too_large"],
    [() => new Response("HTML error", { headers: { "content-type": "application/pdf" } }), "invalid_pdf_signature"],
    [() => new Response(PDF, { headers: { "content-type": "text/html" } }), "unexpected_content_type"],
    [() => new Response("missing", { status: 404 }), "http_404"],
  ];
  for (const [response, code] of cases) {
    const f = await fixture(t), paper = await retrievePublisherPaper(f.ledger(), f.request, { artifactDirectory: f.artifactDirectory, now: f.now, fetch: async () => response() });
    assert.equal(paper.failureCode, code); assert.equal(paper.artifact, null);
  }
});

test("a saved response repairs a missing derived result without a second retrieval", async t => {
  const f = await fixture(t), append = f.ledger().appendObservation.bind(f.ledger()); let fail = true;
  f.ledger().appendObservation = input => { if (fail && input.source === "publisher-paper-result.v1") { fail = false; throw new Error("simulated projection write failure"); } return append(input); };
  await assert.rejects(f.retrieve(), /projection write failure/u);
  assert.equal(f.ledger().listObservations("study").filter(item => item.source === "publisher-paper-result.v1").length, 0);
  f.reopen(); assert.equal((await f.retrieve()).status, "retrieved"); assert.equal(f.calls(), 1);
});

test("a crash before response commit preserves uncertainty and never adopts an orphan PDF or refetches", async t => {
  const f = await fixture(t), append = f.ledger().appendObservation.bind(f.ledger());
  f.ledger().appendObservation = input => { if (input.source === "publisher-paper-response.v1") throw Object.assign(new Error("simulated process loss"), { code: "closed" }); return append(input); };
  await assert.rejects(f.retrieve(), /process loss/u); f.reopen();
  assert.equal((await f.retrieve()).status, "uncertain"); assert.equal(f.calls(), 1);
});

test("timeout quarantines a cancellation-ignoring connection and drops its late response", async t => {
  const f = await fixture(t); let complete!: (response: Response) => void, calls = 0;
  const request = { ...f.request, timeoutMs: 5 };
  const paper = await retrievePublisherPaper(f.ledger(), request, { artifactDirectory: f.artifactDirectory, now: f.now,
    fetch: async () => { calls++; return new Promise(resolve => { complete = resolve; }); } });
  assert.equal(paper.failureCode, "timeout"); f.advance();
  assert.equal(getPublisherAvailability(f.ledger(), f.now).connectionActive, true);
  await assert.rejects(retrievePublisherPaper(f.ledger(), { ...request, paperId: "another" }, { artifactDirectory: f.artifactDirectory, now: f.now, fetch: f.fetch }), /publisher_busy/u);
  complete(new Response(PDF, { headers: { "content-type": "application/pdf" } })); await new Promise(resolve => setImmediate(resolve));
  assert.equal(getPublisherAvailability(f.ledger(), f.now).connectionActive, false);
  assert.equal(await readFile(join(f.artifactDirectory, "absent.pdf")).then(() => true, () => false), false); assert.equal(calls, 1);
});

test("settled reads and HTTP failures retain the publisher gate until body cancellation settles", async t => {
  for (const status of [200, 404]) {
    const f = await fixture(t); let completeCancellation!: () => void, cancellations = 0, reads = 0;
    const teardown = new Promise<void>(resolve => { completeCancellation = resolve; });
    const stream = new ReadableStream<Uint8Array>({
      pull() { reads++; return new Promise(() => {}); },
      cancel() { cancellations++; return teardown; },
    }, { highWaterMark: 0 });
    try {
      const paper = await retrievePublisherPaper(f.ledger(), { ...f.request, timeoutMs: 10 }, {
        artifactDirectory: f.artifactDirectory, now: f.now,
        fetch: async () => new Response(stream, { status, headers: { "content-type": "application/pdf" } }),
      });
      assert.equal(paper.failureCode, status === 200 ? "timeout" : "http_404");
      assert.equal(cancellations, 1); assert.equal(reads, status === 200 ? 1 : 0);
      f.advance(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(getPublisherAvailability(f.ledger(), f.now).connectionActive, true);
      await assert.rejects(retrievePublisherPaper(f.ledger(), { ...f.request, paperId: "blocked-during-teardown" },
        { artifactDirectory: f.artifactDirectory, now: f.now, fetch: f.fetch }), /publisher_busy/u);
      assert.equal(f.calls(), 0);
    } finally {
      completeCancellation(); await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(cancellations, 1);
    assert.equal(getPublisherAvailability(f.ledger(), f.now).connectionActive, false);
  }
});

test("page extraction receives verified bytes and archives page hashes with no scientific approval", async t => {
  const f = await fixture(t), paper = await f.retrieve(); let calls = 0; const parser = extractor(), extract = parser.extract;
  parser.extract = input => { calls++; return extract(input); };
  const request = extractionRequest(f, paper), saved = await extractPublisherPaper(f.ledger(), request, { extractor: parser, now: f.now });
  assert.equal(saved.status, "extracted"); assert.equal(saved.pages.length, 2); assert.equal(saved.pages[1]!.status, "empty");
  assert.equal(saved.scope, "pdf_text_extraction_not_scientific_review"); assert.equal(saved.sourceSha256, paper.artifact!.sha256);
  assert.equal(saved.pages[0]!.textSha256.length, 64); assert.match(saved.limitations.join(" "), /OCR|scientific/u);
  f.reopen(); assert.deepEqual(await loadPublisherExtraction(f.ledger(), saved.extractionObservationId), saved);
  assert.deepEqual(await extractPublisherPaper(f.ledger(), request, { extractor: parser, now: f.now }), saved); assert.equal(calls, 1);
});

test("partial pages, empty text and failed extraction retain different scopes", async t => {
  for (const kind of ["partial", "no_text", "failed"] as const) {
    const f = await fixture(t), paper = await f.retrieve(), request = extractionRequest(f, paper);
    const result = await extractPublisherPaper(f.ledger(), request, { now: f.now, extractor: extractor(sourceSha256 => ({ schemaVersion: 1, sourceSha256,
      totalPages: kind === "failed" ? null : kind === "partial" ? 3 : 1,
      pages: kind === "failed" ? [] : [{ pageNumber: 1, text: "", status: "empty", errorCode: null }], errorCode: kind === "failed" ? "parse_failed" : null })) });
    assert.equal(result.status, kind); assert.deepEqual(await loadPublisherExtraction(f.ledger(), result.extractionObservationId), result);
  }
});

test("changed PDF bytes and changed extractor identity cannot borrow an existing extraction identity", async t => {
  const f = await fixture(t), paper = await f.retrieve(), request = extractionRequest(f, paper), parser = extractor();
  await extractPublisherPaper(f.ledger(), request, { extractor: parser, now: f.now });
  await assert.rejects(extractPublisherPaper(f.ledger(), request, { extractor: { ...parser, sourceSha256: "b".repeat(64) }, now: f.now }), /identity_conflict/u);
  await writeFile(paper.artifact!.path, new Uint8Array(PDF.length)); let called = false;
  await assert.rejects(extractPublisherPaper(f.ledger(), { ...request, extractionId: "changed-source" }, { extractor: { ...parser, async extract() { called = true; throw new Error("Must not parse"); } }, now: f.now }), /artifact_unavailable_or_changed/u);
  assert.equal(called, false); await assert.rejects(f.retrieve(), /artifact_unavailable_or_changed/u); assert.equal(f.calls(), 1);
});

test("page-local extraction errors cannot become complete extraction even when status says text", async t => {
  const f = await fixture(t), paper = await f.retrieve();
  const result = await extractPublisherPaper(f.ledger(), extractionRequest(f, paper), { now: f.now,
    extractor: extractor(sourceSha256 => ({ schemaVersion: 1, sourceSha256, totalPages: 1,
      pages: [{ pageNumber: 1, text: "Incomplete page.", status: "text", errorCode: "page_parse_failed" }], errorCode: null })) });
  assert.equal(result.status, "partial"); assert.equal(result.pages[0]!.errorCode, "page_parse_failed");
  assert.deepEqual(await loadPublisherExtraction(f.ledger(), result.extractionObservationId), result);
});

test("extraction output bounds and source mismatch fail without repairing or inventing page text", async t => {
  const f = await fixture(t), paper = await f.retrieve(), request = extractionRequest(f, paper);
  let called = false;
  const result = await extractPublisherPaper(f.ledger(), request, { now: f.now, extractor: extractor(sourceSha256 => {
    const value = { schemaVersion: 1 as const, sourceSha256, totalPages: 1, pages: [{ pageNumber: 1, text: "valid", status: "text" as const, errorCode: null }], errorCode: null };
    Object.defineProperty(value.pages[0], "text", { enumerable: true, get() { called = true; return "changed"; } }); return value;
  }) });
  assert.equal(result.status, "failed"); assert.equal(called, false); assert.deepEqual(result.pages, []);
  for (const [extractionId, make] of [
    ["wrong-source", (sha: string) => ({ schemaVersion: 1 as const, sourceSha256: "f".repeat(64), totalPages: 1, pages: [{ pageNumber: 1, text: "Text", status: "text" as const, errorCode: null }], errorCode: null })],
    ["oversized-page", (sha: string) => ({ schemaVersion: 1 as const, sourceSha256: sha, totalPages: 1, pages: [{ pageNumber: 1, text: "x".repeat(257), status: "text" as const, errorCode: null }], errorCode: null })],
    ["page-gap", (sha: string) => ({ schemaVersion: 1 as const, sourceSha256: sha, totalPages: 2, pages: [{ pageNumber: 2, text: "Page two", status: "text" as const, errorCode: null }], errorCode: null })],
  ] as const) {
    const invalid = await extractPublisherPaper(f.ledger(), { ...request, extractionId }, { now: f.now, extractor: extractor(make) });
    assert.equal(invalid.status, "failed"); assert.deepEqual(invalid.pages, []);
  }
});

test("archived arXiv state is untouched and publisher request identity cannot change URL or storage", async t => {
  const f = await fixture(t);
  const arxiv = f.ledger().appendObservation({ eventId: "untouched-arxiv-hold-fixture", projectId: "system.literature.arxiv",
    source: "arxiv-availability-hold.v1", sequence: 0, observedAt: f.now().toISOString(), runId: null, actionId: null, jobId: null,
    payload: { fixture: "Existing independent source state; publisher code must not inspect or modify it" } });
  await f.retrieve();
  await assert.rejects(retrievePublisherPaper(f.ledger(), { ...f.request, url: URL.replace("proceedings", "papers") },
    { artifactDirectory: f.artifactDirectory, now: f.now, fetch: f.fetch }), /request_identity_conflict/u);
  await assert.rejects(retrievePublisherPaper(f.ledger(), f.request,
    { artifactDirectory: join(f.directory, "different-store"), now: f.now, fetch: f.fetch }), /request_identity_conflict/u);
  assert.deepEqual(f.ledger().getObservation(arxiv.eventId), arxiv); assert.equal(f.calls(), 1);
});

test("interrupted extraction never reruns or archives a late parser result", async t => {
  const f = await fixture(t), paper = await f.retrieve(), request = { ...extractionRequest(f, paper), timeoutMs: 5 };
  let late!: (value: PublisherExtractedPages) => void, calls = 0; const parser = extractor();
  parser.extract = async () => { calls++; return new Promise(resolve => { late = resolve; }); };
  const result = await extractPublisherPaper(f.ledger(), request, { extractor: parser, now: f.now });
  assert.equal(result.failureCode, "extraction_timeout");
  late({ schemaVersion: 1, sourceSha256: paper.artifact!.sha256, totalPages: 1, pages: [{ pageNumber: 1, text: "Late", status: "text", errorCode: null }], errorCode: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await extractPublisherPaper(f.ledger(), request, { extractor: parser, now: f.now }), result); assert.equal(calls, 1);
});
