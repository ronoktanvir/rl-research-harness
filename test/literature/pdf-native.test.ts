import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import { createPublisherPdfExtractor } from "../../src/literature/pdf-extractor.ts";
import { extractPublisherPaper, loadPublisherExtraction, retrievePublisherPaper } from "../../src/literature/publisher-paper.ts";
import { runProcess } from "../../src/workers/process.ts";

const python = process.env.HARNESS_TEST_PDF_PYTHON;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fixtureSource = `import base64,io,json,sys
from pypdf import PdfWriter
from pypdf.generic import NameObject,DictionaryObject,DecodedStreamObject
config=json.load(sys.stdin); writer=PdfWriter()
for text in ["First page evidence", "   ", "Third page caveat"]:
    page=writer.add_blank_page(width=240,height=160)
    font=DictionaryObject({NameObject("/Type"):NameObject("/Font"),NameObject("/Subtype"):NameObject("/Type1"),NameObject("/BaseFont"):NameObject("/Helvetica")})
    page[NameObject("/Resources")]=DictionaryObject({NameObject("/Font"):DictionaryObject({NameObject("/F1"):writer._add_object(font)})})
    stream=DecodedStreamObject(); stream.set_data(("BT /F1 12 Tf 20 80 Td ("+text+") Tj ET").encode("ascii"))
    page[NameObject("/Contents")]=writer._add_object(stream)
if config["encrypted"]: writer.encrypt("fixture-password",algorithm="RC4-128")
output=io.BytesIO(); writer.write(output); print(base64.b64encode(output.getvalue()).decode("ascii"))`;

test("real Linux PDF parser preserves page provenance and refuses incomplete coverage as complete reading", { skip: !python, timeout: 60_000 }, async () => {
  assert.equal(process.platform, "linux", "Native PDF qualification requires Linux resource limits");
  const directory = await mkdtemp(join(tmpdir(), "pdf-native-"));
  const ledger = openExperimentLedger({ path: join(directory, "evidence.sqlite") });
  try {
    const extractor = await createPublisherPdfExtractor({ pythonExecutable: python! });
    const fixture = async (encrypted: boolean) => {
      const result = await runProcess({ executable: python!, args: ["-I", "-B", "-c", fixtureSource], cwd: directory,
        env: { PATH: "/usr/bin:/bin" }, input: JSON.stringify({ encrypted }), timeoutMs: 5000, maxOutputBytes: 32_768 });
      assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.stopped, null);
      return Buffer.from(result.stdout.trim(), "base64");
    };
    const bytes = await fixture(false);
    let requests = 0;
    const paper = await retrievePublisherPaper(ledger, { projectId: "pdf-native", paperId: "synthetic-layout-fixture",
      url: `https://proceedings.neurips.cc/paper_files/paper/2025/file/${"a".repeat(32)}-Paper-Conference.pdf` },
    { artifactDirectory: join(directory, "papers"), fetch: (async () => { requests++; return new Response(bytes, { headers: { "content-type": "application/pdf" } }); }) as typeof fetch });
    assert.equal(paper.status, "retrieved"); assert.equal(requests, 1);
    const observation = ledger.getObservation(paper.paperObservationId)!;
    const extraction = await extractPublisherPaper(ledger, { projectId: "pdf-native", extractionId: "all-pages",
      paperObservationId: observation.eventId, paperObservationDigest: observation.digest }, { extractor });
    assert.equal(extraction.status, "extracted"); assert.equal(extraction.totalPages, 3);
    assert.deepEqual(extraction.pages.map(page => page.status), ["text", "empty", "text"]);
    assert.equal(extraction.pages[1]!.text, "");
    assert.match(extraction.pages[2]!.text, /Third page caveat/);
    assert.equal(extraction.sourceSha256, sha(bytes));
    assert.equal(extraction.scope, "pdf_text_extraction_not_scientific_review");
    assert.deepEqual(await loadPublisherExtraction(ledger, extraction.extractionObservationId), extraction);
    const onePage = await extractPublisherPaper(ledger, { projectId: "pdf-native", extractionId: "page-bound",
      paperObservationId: observation.eventId, paperObservationDigest: observation.digest, maxPages: 1 }, { extractor });
    assert.equal(onePage.status, "partial"); assert.equal(onePage.totalPages, 3); assert.equal(onePage.pages.length, 1);
    const tiny = await extractPublisherPaper(ledger, { projectId: "pdf-native", extractionId: "text-bound",
      paperObservationId: observation.eventId, paperObservationDigest: observation.digest, maxPageTextBytes: 5 }, { extractor });
    assert.equal(tiny.status, "partial"); assert.equal(tiny.pages[0]!.status, "truncated");
    const input = (pdfBytes: Buffer) => ({ pdfBytes, sourceSha256: sha(pdfBytes), maxPages: 10,
      maxTextBytes: 1024, maxPageTextBytes: 512, timeoutMs: 5000, signal: new AbortController().signal });
    const encrypted = await extractor.extract(input(await fixture(true)));
    assert.equal(encrypted.errorCode, "encrypted_pdf"); assert.equal(encrypted.totalPages, null); assert.deepEqual(encrypted.pages, []);
    await assert.rejects(() => extractor.extract(input(Buffer.from("%PDF-malformed"))), /incomplete/);
    assert.equal(ledger.listRuns("pdf-native").length, 0, "Text extraction must not admit an experiment");
  } finally { ledger.close(); await rm(directory, { recursive: true, force: true }); }
});
