# Bounded primary-literature discovery

`src/literature/` retrieves an explicit, bounded arXiv search page and turns its archived metadata into source-linked evidence. It provides a current-paper retrieval foundation, not a full-paper research review. No model call, training operation, polling loop or unattended service starts through these APIs.

## Source choice and evidence scope

The first source is arXiv's Atom API. Its documented interface exposes queries, pagination, date sorting, abstracts, identifiers and revision dates without an account-specific integration. The implementation defaults to descending submission date and records the exact query and page offset. The source reports the first version's date in `published` and the retrieved version's date in `updated`; an entry without an explicit version suffix remains `version: null`. A recent retrieval timestamp records when this controller obtained the response, not a guarantee of index freshness or exhaustive coverage. [arXiv API manual](https://info.arxiv.org/help/api/user-manual.html)

Journal references and DOI values remain reported metadata. A journal reference can change without a new paper version, so each captured paper belongs to a particular response and retrieval, rather than overwriting a global record keyed only by paper/version. The implementation never infers accepted venue status from these fields. [arXiv journal-reference guidance](https://info.arxiv.org/help/jref.html)

OpenReview is a useful later source for venue-specific decisions, but it is not implemented here. Its current API differs from legacy API1, and its notes distinguish accepted submissions from other states through venue-specific identifiers. A future adapter needs to preserve those distinctions and the relevant note revisions; merely finding a submission page is insufficient evidence of acceptance. [OpenReview API introduction](https://docs.openreview.net/getting-started/using-the-api), [retrieving submission and decision notes](https://docs.openreview.net/how-to-guides/data-retrieval-and-modification/how-to-get-all-notes-for-submissions-reviews-rebuttals-etc)

## Public API

```ts
import {
  discoverArxiv,
  loadArxivDiscovery,
  buildLiteratureEvidencePacket,
  getArxivAvailability,
  releaseArxivHold,
} from "../src/literature/index.ts";

const discovery = await discoverArxiv(ledger, {
  projectId: "example-project",
  discoveryId: "reward-verifier-search-2026-11-02",
  query: 'ti:"reinforcement learning" AND cat:cs.LG',
  maxResults: 5,
  start: 0,
  sortBy: "submittedDate",
  timeoutMs: 20_000,
  maxResponseBytes: 262_144,
}, { signal: abortController.signal });

// Reads and verifies saved observations; makes no request.
const saved = loadArxivDiscovery(ledger, discovery.queryObservationId);

// Requires a complete discovery. No model is called.
const packet = buildLiteratureEvidencePacket(ledger, saved.queryObservationId, {
  packetId: "reward-verifier-candidates",
  question: "Which reported mechanisms merit full-paper review and discriminating tests?",
  proposal: "Identify source-supported candidates and missing evidence before changing the experiment.",
  requiredCriteria: ["claim-provenance", "relevant-comparison", "next-verification-step"],
});
```

`discoverArxiv` returns `complete`, `failed` or `uncertain`. A complete result includes the normalized query, total results reported, returned page, explicit paper/version/date fields, retrieval time, raw response SHA-256, and query/response/result/paper observation IDs. `failed` preserves HTTP, parser or transport failure without automatic retry; `uncertain` means a committed attempt has no saved complete response. Both prevent packet construction.

The evidence packet quotes no full-paper content: it contains source-provided titles, abstracts and metadata with their capture references. Its checks for full-paper inspection, independently verified venue status and established novelty/coverage stay `unknown`. Those checks cannot become passed merely because a reviewer finds the abstract plausible. Methods, controls, leakage, uncertainty, code correctness and claimed results still need independent inspection and, where relevant, reproduction.

## Persistence and recovery

The ledger stores query intent before a transport attempt, then the complete raw response as base64 bytes plus its SHA-256 and retrieval time, then derived paper and result observations. Every observation has null experiment run/action/job links. No experiment validation or execution state is inferred from a paper.

The request identity binds project, discovery ID, query, page, sorting and retrieval limits. Reusing it with different inputs fails. Once raw bytes have been committed, repeating discovery repairs missing derived observations without another network request. Loading an incomplete archive reports the missing derivation rather than silently presenting partial results; repeating discovery performs the repair. Result and packet construction verify observation digests and regenerate projections from the saved raw response.

A crash between starting a request and saving the complete response leaves an unresolved attempt. That identity never refetches, because a later response could represent a different literature snapshot. A new explicit discovery ID requests another retrieval after cooldown and any service hold. A transport failure is also retained under its identity; there is no hot retry path. This is conservative source-capture behavior, not an assertion that a read-only HTTP request created a remote experiment effect.

## Network and parser bounds

The only network endpoint is `https://export.arxiv.org/api/query`. The implementation makes one GET with redirects rejected and credentials omitted; it does not follow feed links, fetch PDFs/DOIs or contact arbitrary origins. Limits are explicit: 1–20 results, page start at most 1000, timeout at most 60 seconds, and response body at most 512 KiB. Default timeout and body bounds are 20 seconds and 256 KiB. Byte counting covers streamed response data even without `Content-Length`; cancellation and timeout apply to the body as well as connection setup. A transport that ignores cancellation remains quarantined in its process until it actually settles.

The strict namespace-aware parser rejects malformed XML/UTF-8, DTDs, processing instructions, nested/duplicate scalar fields, duplicate paper identities, excessive depth/nodes, inconsistent page counters and Atom error entries. It decodes ordinary XML character entities without resolving external entities. Unknown version suffixes are not invented. Unsupported structures fail the capture instead of producing apparently complete evidence.

The parser dependency is pinned to `saxes@6.0.0`. Its upstream repository was archived on 2025-12-31. The narrow wrapper, input bounds and rejection tests reduce the surface accepted here, but do not replace dependency maintenance or a security guarantee. Requalify any parser replacement against the same adverse fixtures. [saxes source and documented behavior](https://github.com/lddubeau/saxes)

## Request spacing and remaining operational limits

arXiv's published limit is one connection and no more than one request every three seconds across all machines under an operator's control. This adapter serializes connections within the process and saves cooldown observations in the reserved ledger project `system.literature.arxiv`, shared across projects using that ledger. Each attempt conservatively holds admission for its configured timeout plus three seconds, including after restart. An early request fails locally; it does not wait or schedule a retry. [arXiv API terms](https://info.arxiv.org/help/api/tou.html)

These controls do not coordinate unrelated processes using separate ledgers or other machines. Route all deployment requests through one authoritative retrieval controller before claiming deployment-wide compliance. No multi-host admission protocol or background literature schedule is implemented.

## Shared HTTP429 availability holds

An observed HTTP429 first produces a durable header receipt, before body size checks or streaming. That receipt creates an immutable availability hold in `system.literature.arxiv`, even if the body subsequently stalls, exceeds its bound or cannot be saved. A header-backed hold explicitly carries `responseEvidenceScope: "headers_only"`: it does not imply a complete body or support paper extraction. A later complete body capture must agree with the receipt and does not create a second hold for the attempt.

The hold binds the exact source observation ID and digest, originating project/query, receipt time and supported `Retry-After` interpretation. Earlier complete-response captures without header receipts remain supported, preserving their original hold identity and payload; recovery never invents a historical header receipt. New discovery IDs in every project using that ledger must pass the hold before query or attempt records are written. Reading cached discoveries, repairing their derived records and building packets from already complete captures remain possible while held.

`getArxivAvailability(ledger, { now? })` returns `{ available, checkedAt, holds }`. It verifies source records and repairs a missing derived hold, including after a crash between committing a header receipt or older complete response and writing its hold/result. It makes no network request, but status inspection can write that deterministic recovery record. `available` describes saved429 holds only; the connection gate and ordinary cooldown can still deny a request. Network receipt and database commit are separate events: a process crash before its first receipt commit can still lose evidence of the status. That unavoidable gap is not represented as a successful capture.

Decimal delay-seconds produce `retryAt` relative to the header receipt time, or the saved complete-response time for an older capture lacking a header receipt. A canonical HTTP-date in GMT produces that exact timestamp. Invalid calendar/weekday values, unsupported date syntax, overflow, absent headers and oversized headers produce `retryAt: null`; there is no guessed reset. Oversized headers are recorded as unavailable rather than truncated into a potentially valid prefix. A known hold has `blocked: false` once the current clock reaches `retryAt`, while `released` remains false unless an operator release was recorded. Even a legally recorded release cannot bypass a known retry time if the clock subsequently moves backwards. Expiry does not replay a failed query or schedule a new one.

Unknown retry times stay blocked until an explicit operator assertion:

```ts
const status = getArxivAvailability(ledger);
const hold = status.holds.find(item => item.blocked && item.retryAt === null);
// Call only after an operator has supplied evidence and authorized a controlled retry.
const release = releaseArxivHold(ledger, {
  holdObservationId: hold!.holdObservationId,
  releaseId: "operator-availability-check-001",
  evidence: { reason: "Operator assessed availability and authorized one controlled new discovery." },
});
```

The release is an immutable ledger observation that binds the hold's digest. Reusing its release ID and exact input recovers the original observation; changing the assertion under that ID fails. Releases before a known `retryAt` are denied. A release is an operator's authorization to try again, **not provider proof of restored availability**, and cannot clear a later hold produced by another429. The caller must still request a new discovery identity, satisfy local spacing, and stay within its configured authority. No status or cached-export operation automatically releases a hold.

Offline qualification covers parser failures, streamed-size and deadline enforcement, cancellation, exact request identity, source/version uncertainty, raw-response recovery after reopening the ledger, response-loss uncertainty, per-response metadata revisions, local rate limits and scientific scope checks. Hold tests cover cross-project admission, restart recovery, known and unknown retry times, invalid headers, clock regression, source/digest binding and explicit release idempotency. Any separate live check must report its actual query, retrieval time, status and limited coverage; a successful request does not qualify the quality of an autonomous literature assessment.
