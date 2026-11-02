# Historical CoworkeRL evidence follow-up

**Existing files partially answer the provenance and evaluation requests, but they do not close the three scientific follow-ups.** The captured run has recoverable source bytes, a matching final adapter and a held-out bare-base comparison. It lacks a matched training control and independent validation of the success measure.

Inspection was read-only at CoworkeRL checkout `84b219f64f1152f8b02babea388bfbbfff41e75a`. No project code was imported, and the investigation made no training, model, network or runtime-ledger operation. The bounded [local investigation artifact](../../.harness/historical-followup-evidence.json) contains exact paths/hashes, classified assertions, remaining checks and the standalone standard-library verification script. It is private, ignored evidence rather than a committed artifact. The separate controller archival step is recorded below.

## Establish the correct historical identity

The controller supplied capture `historical-main-s11`, digest `45a2895985fcef74a2cf3596cf76f4ddfd00b2625fa22e7158a8727390e8e5bd`, project `coworker`. Its original report is **Run-1**, `artifacts/probing-helper-artifacts/grpo-run1/main-s11/report.json`: 58,876 bytes, SHA-256 `8d73572a733f05bcdf9eacda9af3bb5f92394745c6cd77c00786fe245df80c5a`. Rehashing the current file reproduces that supplied capture identity.

The later `phase2-bundle/main-s11/report.json` is a different experiment, with hash `9bfd2664…eba9`, source commit `52ef847e…` and final adapter `8679d8b5…`. Its matched-control findings cannot be joined to this capture by the repeated `main-s11` label. Current v2 is also separate: [README lines 5–13](/Users/ronoktanvir/CoworkeRL/README.md:5) explicitly distinguishes its environment and scorer from the older experiments.

## Provenance recovered from bytes

The [Run-1 manifest, lines 3–17](/Users/ronoktanvir/CoworkeRL/artifacts/probing-helper-artifacts/grpo-run1/main-s11/run-manifest.json:3) records the base-model revision, tokenizer/chat-template hashes, initial adapter, training seed 11 and 30 authorized steps. Shared top-level fields agree with the report. Manifest SHA-256 is `e04fdfe9e502e83edde009be0f3c96e4d8cecd801ae0a9a694ca5eb5be644b73`.

The reported runtime commit `ccfd25df63f55e408b67e984710eb6d3dd9e609f` maps to [archived tree `e8018cd9…`, revisions lines 463–468](/Users/ronoktanvir/CoworkeRL/history/halluminate/revisions.json:463). Independent byte checks verified all **75 Python Git blob identities**, totaling 1,037,901 bytes. Applying the [archived digest algorithm, lines 623–635](/Users/ronoktanvir/CoworkeRL/history/halluminate/blobs/4e943995aac2f2e0dcd4ece8fb77adefb5ce00b2:623) reproduces `739f568e0d8f481c8f9237809d83d39248d2f79a20e68cb2dcba8e82f23a7275`, exactly the reported source digest. Its scope is path-ordered Python files, not a complete deployment inventory.

The local final adapter contains 349,243,752 bytes; its SHA-256 is `8f90ce0566954ee99ac5c852f05aad551462ac5d7d179fcc8a00726cbc53bd6a`. This matches [report step 29, line 1900](/Users/ronoktanvir/CoworkeRL/artifacts/probing-helper-artifacts/grpo-run1/main-s11/report.json:1900), the [evaluation guard, lines 145–152](/Users/ronoktanvir/CoworkeRL/experiments/probing/src/probing/heldout_diagnostic.py:145), and every retained `s11-trained` trace. This establishes byte agreement, not tensor correctness, optimizer-state recovery or original execution custody.

## Evaluation and the available baseline

Both `heldout-diagnostic/s11-trained` and `s11-baseline` contain 384 unique judged outcomes and 384 unique trace records marked complete by the producer, joined exactly by configuration, world seed and trace ID. Streamed trace hashes and judged-result hashes match the preserved checksum manifest. The cells share the same worlds, tokenizer, decoding settings and evaluation-source declaration `cb1bfd8b92abd4c23941300d653f61caf93ae3fb`. Six evaluation configurations are disjoint from the report's twelve training configurations.

| Existing producer evidence, recounted here | Run-1 trained | Bare base |
|---|---:|---:|
| Evaluation episodes; `ok` statuses | 384 | 384 |
| `targets_credited` sum | 23 | 17 |
| `clean_success` flags | 1 | 0 |

The credit sums agree with the [stored funnel, lines 4–58](/Users/ronoktanvir/CoworkeRL/artifacts/probing-helper-artifacts/heldout-diagnostic/funnel.json:4): 23 versus 17 of 768 required-fact opportunities. These are recounted **producer labels**, not independent semantic rescoring or a new benchmark result. The grounded event-by-event funnel audit was not rerun. A summary's 376 `OK` entries describe its resumed segment: [the file records eight earlier episodes and 384 scored in total](/Users/ronoktanvir/CoworkeRL/artifacts/probing-helper-artifacts/heldout-diagnostic/s11-trained/cell-summary.json:5).

## Disposition of the requests

- **Recover manifest: partially answered.** Source and checkpoint correspondence are now checkable. Complete environment/dependency/model-byte identity and historical execution attestation remain unestablished; current checkout hashes must not replace them.
- **Independent evaluation: partially answered.** Fixed held-out measurements and failure accounting exist. Scorer validity, blindness and substantive task success remain separate checks. Fact credit is not overall task success.
- **Matched baseline: bare-base comparison recovered; training control absent.** The [Run-1 specification, lines 156–165](/Users/ronoktanvir/CoworkeRL/experiments/probing/SPEC-RUN1-HELDOUT-DIAGNOSTIC.md:156) explicitly disclaims a matched control and causal attribution. One trained run does not become 384 independent training replicas. Phase 2 provides a later design example, not a retroactive control.

## Controller receipt and review

A second agent independently reproduced the report/source/adapter hashes, trace joins, counts, resumed coverage and disjoint configuration identities. No material correction remained. This validates the stated byte/arithmetic checks, not the original scorer's semantic judgments.

The controller subsequently checked the original capture's own digest, re-read its exact report through the bounded reader, and appended an evidence-only observation at `2026-11-02T07:59:33.132Z`:

- Observation: `historical-investigation:8287ba791d7b28559d1d546e963d770dd02434ee911807c22de3977a79c2dca9`.
- Observation digest: `dc6c4daaf00ae78d78f3e22b25dc828bc4c11d31f81a8c9bb61e619d646e998b`.
- Embedded investigation artifact: 21,485 bytes, SHA256 `a5b881be1502709ed39b5367efccc77b716716c8a21429e4fbdb70ea3845e71a`.

Before/after checks confirmed that project runs, actions and follow-up observations were unchanged. All three requests remain unresolved. The receipt explicitly records a manual evidence investigation, not an automated handler result, scientific approval, executable historical manifest or authorization for another experiment. The arXiv hold remains active.

A subsequent [automated investigation](automated-investigation-qualification.md) reproduced these byte/count checks through the fixed reader, persistent queue and archive. Its separate receipt preserves the same scientific limitations; it does not relabel this manual observation as an automated result.
