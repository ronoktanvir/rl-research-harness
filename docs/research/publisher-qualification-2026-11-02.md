# Publisher retrieval qualification

The new importer successfully archived one full NeurIPS PDF through the harness CLI. This qualifies a bounded retrieval and subsequent offline integrity check. It does not establish automated scientific review or coverage of current literature.

## Observed artifact

- Source: [Deep Reinforcement Learning at the Edge of the Statistical Precipice, publisher PDF](https://proceedings.neurips.cc/paper_files/paper/2021/file/f514cec81cb148559cf475e7426eed5e-Paper.pdf).
- Retrieved: `2026-11-02T07:00:19.871Z`; one explicit request with a 20-second bound, CLI exit zero.
- Exact bytes: `10,255,284`.
- SHA-256: `7553e280d4a1560860bc5f6be2d70539fc5b510e0e3bb2d556824e51e9a80252`.
- Paper observation: `publisher-paper:a0d50b06a51c1bb400cc3da6f687bddeefaf7dd89539b9b1dce2c7e645478540`.
- Paper observation digest: `2a13d439a663b7aefd316c73285ff6227acffaf3ce22af02298350b0dffe0580`.
- Project: `coworker-rl`; the existing ignored local experiment ledger retains request, attempt, headers, response and paper records. The PDF remains in the ignored private artifact directory.

The hash matches the previously [manually reviewed publisher copy](paper-qualification-2026-11-02.md). Reopening the ledger and calling `loadPublisherPaper` verified the saved bytes without another network request. The importer correctly retains `publisher_pdf_bytes_not_reviewed` and `venueVerification: unverified`: a historical human/agent review is separate evidence and is not silently assigned to this new ingestion record.

Retrieval occurred during development before the later body-cancellation quarantine correction. This successful request completed normally; it did not exercise cancellation. Subsequent tests qualify the corrected cancellation path separately. No exact-revision deployment claim is made for this development invocation.

## Extraction boundary

The local macOS runtime could not install the required address-space limit. The parser therefore requires Linux and tests its actual resource limits before importing pypdf. No extraction was attempted on this archived PDF through the new parser. Linux CI uses a separate three-page synthetic document to test real parsing, whitespace-only pages, page/text limits, encrypted/malformed input and archive provenance.

Successful text extraction means bounded page text was obtained. Equations, figure interpretation, table fidelity, OCR, venue verification and scientific claim assessment still require separate work. This paper is from 2021; the retrieval is an engineering qualification, not a claim to have discovered the latest research.

## Preserved boundaries

The existing arXiv source remains unavailable with one saved hold. No arXiv request or release occurred. No additional account-backed model call, CoworkerRL training run, cloud allocation or allowance change was part of this qualification. The `coworker-rl` project still had zero registered training runs after retrieval.
