import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { runProcess } from "../workers/process.ts";
import type { ProcessRequest, ProcessResult } from "../workers/process.ts";
import { keys } from "../ledger/validation.ts";
import type { PublisherPdfExtractor, PublisherExtractedPages } from "./publisher-paper.ts";

export const PYPDF_VERSION = "6.10.0";
export interface PdfExtractorOptions {
  pythonExecutable: string;
  /** Trusted offline test seam, not an operator or model-supplied executable. */
  execute?: (request: ProcessRequest) => Promise<ProcessResult>;
}
function sha(value: Uint8Array | string) { return createHash("sha256").update(value).digest("hex"); }
const environment = { PATH: "/usr/bin:/bin", PYTHONIOENCODING: "utf-8" };

/** Pins the observed interpreter/parser versions and exact helper bytes before use. */
export async function createPublisherPdfExtractor(options: PdfExtractorOptions): Promise<PublisherPdfExtractor> {
  const python = options.pythonExecutable, execute = options.execute ?? runProcess;
  if (typeof python !== "string" || !isAbsolute(python) || /[\0\r\n]/.test(python)) throw new Error("Select a trusted absolute Python executable");
  const source = await readFile(new URL("./pdf-extractor.py", import.meta.url), "utf8"), sourceSha256 = sha(source);
  const probe = await execute({ executable: python, args: ["-I", "-B", "-c", source, "--probe"],
    cwd: tmpdir(), env: { ...environment }, input: "", timeoutMs: 5000, maxOutputBytes: 4096 });
  if (probe.stopped || probe.exitCode !== 0) throw new Error("Bounded PDF parser requires Linux, process resource limits and pinned pypdf");
  const versions: unknown = JSON.parse(probe.stdout);
  keys(versions, ["python", "pypdf"]);
  if (versions.pypdf !== PYPDF_VERSION || typeof versions.python !== "string" || !/^3\.(11|12|13)\.\d+$/.test(versions.python)) throw new Error("PDF parser runtime is not qualified");
  const pythonVersion = versions.python;
  return Object.freeze({ name: "pypdf-page-text", version: `1+pypdf.${PYPDF_VERSION}+python.${pythonVersion}`, sourceSha256,
    async extract(input): Promise<PublisherExtractedPages> {
      // Snapshot bytes and bounds before filesystem awaits; neither the caller nor
      // a changed source path can substitute the PDF after its hash is checked.
      const bytes = Buffer.from(input.pdfBytes), { sourceSha256: expected, maxPages, maxTextBytes, maxPageTextBytes, timeoutMs, signal } = input;
      if (bytes.length < 1 || bytes.length > 16 * 1024 * 1024 || sha(bytes) !== expected) throw new Error("PDF source digest or size mismatch");
      for (const [value, max] of [[maxPages, 200], [maxTextBytes, 512 * 1024], [maxPageTextBytes, 64 * 1024], [timeoutMs, 60_000]]) {
        if (!Number.isSafeInteger(value) || value! < 1 || value! > max!) throw new Error("PDF extraction bound is invalid");
      }
      if (signal.aborted) throw new Error("PDF extraction cancelled");
      const directory = await mkdtemp(join(tmpdir(), "harness-pdf-"));
      try {
        const path = join(directory, "source.pdf");
        await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
        const process = await execute({ executable: python, args: ["-I", "-B", "-c", source], cwd: directory,
          env: { ...environment }, input: JSON.stringify({ path, sourceSha256: expected, maxPages, maxTextBytes, maxPageTextBytes, timeoutMs, pythonVersion }),
          timeoutMs, maxOutputBytes: 2 * 1024 * 1024, signal });
        if (process.stopped || process.exitCode !== 0) throw new Error(`PDF extraction incomplete: ${process.stopped ?? "worker_failed"}`);
        if (Buffer.byteLength(process.stdout) + Buffer.byteLength(process.stderr) > 2 * 1024 * 1024) throw new Error("PDF extraction output limit");
        // The publisher archive independently validates page shape, coverage and
        // text limits before accepting this untrusted parser observation.
        return JSON.parse(process.stdout) as PublisherExtractedPages;
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
  } satisfies PublisherPdfExtractor);
}
