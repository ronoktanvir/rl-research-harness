import { openExperimentLedger } from "../ledger/index.ts";
import { readBoundedJson } from "../scheduler/config.ts";
import { createPublisherPdfExtractor } from "./pdf-extractor.ts";
import { extractPublisherPaper, getPublisherAvailability, loadPublisherExtraction, retrievePublisherPaper } from "./publisher-paper.ts";
import type { PublisherExtractionRequest, PublisherPaperRequest } from "./publisher-paper.ts";

export const PUBLISHER_USAGE = `Primary publisher papers (one explicit request, no model calls):
  npm run harness -- publisher-get <ledger.sqlite> <request.json> <private-artifact-directory>
  npm run harness -- publisher-extract <ledger.sqlite> <request.json> <absolute-python-executable>
  npm run harness -- publisher-read <ledger.sqlite> <extraction-observation-id>
  npm run harness -- publisher-status <ledger.sqlite>

publisher-get currently accepts exact NeurIPS PDF URLs. It archives intent before
one bounded request and saves any provider denial. It never follows redirects.
publisher-extract requires Linux and the pinned parser; pages retain their source
hash and PDF page number. Extracted text remains scientifically unreviewed.
These commands neither change arXiv holds nor release publisher holds.`;

export async function publisherCommand(args: string[]): Promise<number | null> {
  const [command, ...rest] = args;
  const arity: Record<string, number> = { "publisher-get": 3, "publisher-extract": 3, "publisher-read": 2, "publisher-status": 1 };
  if (!command || !Object.hasOwn(arity, command)) return null;
  if (rest.length !== arity[command]) throw new Error(PUBLISHER_USAGE);
  // Probe the trusted parser before taking ownership or recording extraction
  // intent: an unsupported platform must not consume a paper's extraction ID.
  const request = command === "publisher-get" || command === "publisher-extract"
    ? await readBoundedJson(rest[1]!, 16_384) : null;
  const extractor = command === "publisher-extract" ? await createPublisherPdfExtractor({ pythonExecutable: rest[2]! }) : null;
  const ledger = openExperimentLedger({ path: rest[0]! });
  const abort = new AbortController(), stop = () => abort.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    let result: unknown, complete = true;
    if (command === "publisher-get") {
      const paper = await retrievePublisherPaper(ledger, request as PublisherPaperRequest,
        { artifactDirectory: rest[2]!, signal: abort.signal });
      result = paper; complete = paper.status === "retrieved";
    } else if (command === "publisher-extract") {
      const extraction = await extractPublisherPaper(ledger, request as PublisherExtractionRequest,
        { extractor: extractor!, signal: abort.signal });
      result = extraction; complete = extraction.status === "extracted";
    } else if (command === "publisher-read") {
      result = await loadPublisherExtraction(ledger, rest[1]!);
    } else { result = getPublisherAvailability(ledger); }
    console.log(JSON.stringify(result, null, 2));
    return complete ? 0 : 2;
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    ledger.close();
  }
}
