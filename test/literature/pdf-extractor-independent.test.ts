import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { createPublisherPdfExtractor } from "../../src/literature/pdf-extractor.ts";
import type { ProcessRequest, ProcessResult } from "../../src/workers/process.ts";
import type { PublisherPdfExtractionInput } from "../../src/literature/publisher-paper.ts";

const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const probe = (): ProcessResult => ({ exitCode: 0, stopped: null, stderr: "",
  stdout: JSON.stringify({ python: "3.12.14", pypdf: "6.10.0" }) });
function input(): PublisherPdfExtractionInput {
  const bytes = Buffer.from("%PDF-synthetic-transport-fixture");
  return { pdfBytes: bytes, sourceSha256: sha(bytes), maxPages: 2, maxTextBytes: 100,
    maxPageTextBytes: 50, timeoutMs: 1000, signal: new AbortController().signal };
}
function pages(sourceSha256: string) {
  return { schemaVersion: 1, sourceSha256, totalPages: 1,
    pages: [{ pageNumber: 1, text: "Synthetic page observation", status: "text", errorCode: null }], errorCode: null };
}

test("PDF extractor descriptor binds exact helper bytes and observed runtime; unsupported probe cannot extract", async () => {
  const helper = await readFile(new URL("../../src/literature/pdf-extractor.py", import.meta.url), "utf8");
  const extractor = await createPublisherPdfExtractor({ pythonExecutable: "/fixture/python-never-executed", execute: async () => probe() });
  assert.equal(extractor.sourceSha256, sha(helper));
  assert.equal(extractor.name, "pypdf-page-text");
  assert.match(extractor.version, /pypdf\.6\.10\.0\+python\.3\.12\.14/u);
  assert.ok(Object.isFrozen(extractor));
  let calls = 0;
  await assert.rejects(createPublisherPdfExtractor({ pythonExecutable: "/fixture/python-never-executed", execute: async () => {
    calls++; return { exitCode: 1, stopped: null, stdout: "", stderr: "fixture resource limit unavailable" };
  } }), /requires Linux, process resource limits and pinned pypdf/u);
  assert.equal(calls, 1);
  await assert.rejects(createPublisherPdfExtractor({ pythonExecutable: "/fixture/python-never-executed", execute: async () => ({
    ...probe(), stdout: JSON.stringify({ python: "3.12.14", pypdf: "0.0.0" }),
  }) }), /not qualified/u);
});

test("PDF bytes and limits are copied before filesystem awaits and temporary input disappears after extraction", async () => {
  const raw = input(), original = Buffer.from(raw.pdfBytes), digest = raw.sourceSha256;
  let calls = 0, path = "";
  const extractor = await createPublisherPdfExtractor({ pythonExecutable: "/fixture/python-never-executed", execute: async request => {
    if (++calls === 1) return probe();
    assert.deepEqual(request.args.slice(0, 3), ["-I", "-B", "-c"]);
    assert.equal(sha(request.args[3]!), extractor.sourceSha256);
    assert.deepEqual(Object.keys(request.env).sort(), ["PATH", "PYTHONIOENCODING"]);
    assert.equal(request.timeoutMs, 1000);
    assert.equal(request.maxOutputBytes, 2 * 1024 * 1024);
    const config = JSON.parse(request.input);
    path = config.path;
    assert.equal(config.sourceSha256, digest);
    assert.equal(config.maxPages, 2);
    assert.equal(config.maxTextBytes, 100);
    assert.equal(config.maxPageTextBytes, 50);
    assert.deepEqual(await readFile(path), original);
    return { exitCode: 0, stopped: null, stderr: "", stdout: JSON.stringify(pages(digest)) };
  } });
  const pending = extractor.extract(raw);
  raw.pdfBytes.fill(0);
  raw.sourceSha256 = "0".repeat(64);
  raw.maxPages = 200;
  raw.maxTextBytes = 500;
  raw.maxPageTextBytes = 200;
  raw.timeoutMs = 60_000;
  assert.deepEqual(await pending, pages(digest));
  assert.equal(calls, 2);
  await assert.rejects(access(path), { code: "ENOENT" });
});

test("cancelled, timed out, truncated or failed parser processes never return apparently valid pages", async () => {
  for (const stopped of ["cancelled", "timeout", "output_limit", "spawn_error"] as const) {
    let calls = 0;
    const raw = input();
    const extractor = await createPublisherPdfExtractor({ pythonExecutable: "/fixture/python-never-executed", execute: async () => {
      if (++calls === 1) return probe();
      return { exitCode: 0, stopped, stderr: "", stdout: JSON.stringify(pages(raw.sourceSha256)) };
    } });
    await assert.rejects(extractor.extract(raw), /incomplete/u);
  }
  let calls = 0;
  const raw = input();
  const extractor = await createPublisherPdfExtractor({ pythonExecutable: "/fixture/python-never-executed", execute: async () => {
    if (++calls === 1) return probe();
    return { exitCode: 1, stopped: null, stderr: "", stdout: JSON.stringify(pages(raw.sourceSha256)) };
  } });
  await assert.rejects(extractor.extract(raw), /worker_failed/u);
});

test("invalid source digest, invalid bounds and pre-cancelled requests never reach parser invocation", async () => {
  let calls = 0;
  const extractor = await createPublisherPdfExtractor({ pythonExecutable: "/fixture/python-never-executed", execute: async () => {
    calls++; return probe();
  } });
  const wrongHash = input(); wrongHash.sourceSha256 = "f".repeat(64);
  await assert.rejects(extractor.extract(wrongHash), /digest/u);
  for (const maxPages of [0, 201, NaN, 1.5]) {
    await assert.rejects(extractor.extract({ ...input(), maxPages }), /bound/u);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(extractor.extract({ ...input(), signal: controller.signal }), /cancelled/u);
  assert.equal(calls, 1);
});

test("malformed or excessive parser output fails and still removes temporary PDF bytes", async () => {
  for (const mode of ["malformed", "excessive"] as const) {
    let calls = 0, path = "";
    const execute = async (request: ProcessRequest): Promise<ProcessResult> => {
      if (++calls === 1) return probe();
      path = JSON.parse(request.input).path;
      return { exitCode: 0, stopped: null, stderr: "", stdout: mode === "malformed" ? "{" : "x".repeat(2 * 1024 * 1024 + 1) };
    };
    const extractor = await createPublisherPdfExtractor({ pythonExecutable: "/fixture/python-never-executed", execute });
    await assert.rejects(extractor.extract(input()));
    await assert.rejects(access(path), { code: "ENOENT" });
  }
});
