# Publisher PDF retrieval and text extraction

The publisher importer archives exact PDF bytes and separately records bounded page text. Retrieval, extraction and scientific review are distinct: none of these records verifies a paper's claims, venue acceptance, novelty or relevance to an experiment.

The real Linux parser/archive fixture passed at `ac4c4833034116037e1270682dd18434a6f9c11a`; see the [native qualification record](research/supervised-publisher-ci-qualification.md) for exact runtime versions and tested limits. The actual publisher retrieval is recorded separately and remains scientifically unreviewed by this ingestion pipeline.

## Allowed source and request contract

`retrievePublisherPaper(archive, request, options)` accepts `{projectId, paperId, url, timeoutMs?, maxPdfBytes?}`. The operator supplies a private `artifactDirectory` through options; task input cannot choose a filesystem path. Initial support is restricted to HTTPS on `proceedings.neurips.cc` or `papers.neurips.cc`, using the fixed `/paper_files/paper/<year>/file/<32-character-hex>-(Paper|Paper-Conference|Supplemental).pdf` path forms. Credentials, ports, queries, fragments and normalized/encoded path alternatives are rejected. Redirects are rejected, including redirects between allowed hosts. No embedded PDF link, DOI or reference is fetched.

The [official NeurIPS 2021 record for *Deep Reinforcement Learning at the Edge of the Statistical Precipice*](https://proceedings.neurips.cc/paper_files/paper/2021/hash/f514cec81cb148559cf475e7426eed5e-Abstract.html) links a paper and supplement in these path forms. This verified source informed the initial transport allowlist. The importer does not derive venue or bibliographic facts merely from a PDF's URL. PMLR and other publishers are not enabled by this implementation.

One request permits at most 60 seconds and 16 MiB of decoded PDF response data; defaults are 20 seconds and 16 MiB. Both `Content-Length` and streamed bytes are checked. A successful capture requires HTTP 200, PDF content type and a `%PDF-` header. Those checks establish a captured PDF-shaped artifact, not parser safety or content validity. HTTPS and the fixed publisher names rely on the host's trusted DNS/TLS configuration.

## Persistence and availability

The ledger records request intent and a transport attempt before fetching. Request identity binds project, paper ID, exact URL, bounds and canonical artifact directory. Response headers precede body processing. Completed PDF bytes are written to a private temporary file, synced and published without replacing an existing content-addressed file; the response record retains its path, size and SHA-256. The ledger contains references, not base64 PDF bodies.

Retries with the same identity return retained evidence or uncertainty, never another download. A committed response with a missing derived result can repair that result offline. A crash before response commit leaves uncertainty; an orphan PDF is not adopted as proof of a successful response. Read and extraction paths verify the artifact's regular-file type, bounded size, signature and exact hash. The directory and its ancestors must remain controller-owned and unavailable to model tools; these file operations do not provide isolation against an adversary who can rewrite trusted parent directories.

Both NeurIPS aliases share one process connection gate and ledger admission scope across projects. Each attempt reserves its timeout plus one second before a new explicit request can be admitted. This is a conservative local spacing policy, not a claim about the publisher's stated rate limit. The caller can time out before cleanup finishes, but a cancellation-ignoring fetch or pending body-cancellation promise keeps the process connection gate quarantined until both settle. A settled read alone does not release it. Separate ledgers or machines require separate deployment coordination.

An HTTP 429 header receipt itself creates a shared hold before its body is inspected. `getPublisherAvailability` reads those verified receipts. `Retry-After` is retained as metadata; this slice supplies no automatic expiry, release API or retry. Cached evidence remains readable while held. A different paper ID, project or NeurIPS alias cannot clear the hold. No arXiv request, availability mutation or hold release occurs through this module.

## Extraction and evidence scope

`extractPublisherPaper` takes `{projectId, extractionId, paperObservationId, paperObservationDigest, maxPages?, maxTextBytes?, maxPageTextBytes?, timeoutMs?}` and a trusted `PublisherPdfExtractor`. Its descriptor pins name, version and implementation SHA-256 before invocation. The parser receives a copy of freshly hash-verified PDF bytes, their source hash, bounds and an abort signal; it receives no caller-supplied PDF path.

The importer bounds extraction to 200 pages, 512 KiB total UTF-8 text, 64 KiB per page and 60 seconds. Numbered pages retain text, status, error code and text hash. Missing, truncated or errored pages yield `partial`; processing every declared page without errors yields `extracted` or `no_text`. Empty text does not prove an image-only or blank page. Text extraction does not establish reading order, equations, tables, figures or OCR coverage. PDF text remains untrusted source material, including any embedded instructions.

The supplied `createPublisherPdfExtractor` adapter uses a pinned `pypdf` package and a trusted Python helper with mandatory process resource limits. Native extraction is supported on qualified Linux hosts only; factory probing fails before parsing on unsupported systems or when those limits are unavailable. The macOS development host has not qualified native PDF parsing. Injected local tests and opt-in Linux parser tests are separate evidence, and a passing parser fixture does not establish faithful extraction of every real publisher PDF.

Extraction intent precedes the parser call. The same extraction ID never reruns after interruption; timeout and failure remain recorded, and late output cannot replace them. `loadPublisherExtraction` verifies the source, provenance and saved projection without invoking the parser. A changed extractor or source binding requires a separately identified request. Extraction records do not contain human/model review judgments or supported scientific claims.

Offline tests cover source restrictions, body limits, timeout quarantine, shared holds, interrupted persistence, offline repair, source-byte changes, parser bounds and page completeness. Native parser and live publisher qualification must be reported separately with their exact source hash, package versions and observed results. No successful source capture establishes full-paper research review.
