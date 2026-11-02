# Native acquisition and semantic-use acceptance rubric, v1

Reuse the current v2 `build_observed_replay` path with real driver capture and persistence, while replacing only policy/helper provider transports with deterministic test doubles. Its acceptance evidence should establish one coherent path from an authorized disclosure to a policy-visible observation, separately from numeric text credit and intended semantic use. Neither arrival nor a correct number establishes comprehension or task success. This document specifies independent acceptance criteria; it does not introduce a competing event oracle or fixture JSON schema.

Reviewed read-only on 2026-11-02 against CoworkeRL checkout `84b219f64f1152f8b02babea388bfbbfff41e75a`. No project code, native scorer, provider, service or training workload was run. The existing native tests were read, not run. New harness qualification and source-bound result integration remain implementation work.

## What the existing sources support

The archived Run-1 v4 audit requires a uniquely attributed tool observation, exact channel, a read after the disclosure's triggering post, and the value in that read's posts payload. It explicitly cannot identify the emitting message from the receiving payload: the latter contains only `from` and `text`. Its check of a value in the final request is also explicitly not evidence of use or memory. See archived `disclosure_audit_v4.py` 6–65, 176–255 and the [protocol review](run1-protocol-validity.md).

Current v2 `mattermost_mem.py` 110–125 still returns posts without message IDs. However, `completion_bridge.py` supplies a stronger **conditional reconstruction**: it replays the pinned memory-session state, checks exact returned pages and counters, and checks the subsequent inference history before attaching transcript message IDs. It also verifies the world, runtime, prompt, original unjudged result/trace, source ownership and per-message disclosure ledger. These reconstructed IDs are not IDs directly observed on the wire. They are justified only under the bridge's specific supported premises, which must not be transferred automatically to Run-1 or a live/remote backend.

Current v2 reward disclosure is sender-owned and metric-bound; `reward.py` 264–275 scans only each sender's facts, and 432–451 checks per-message ledger identity rather than a union of fact IDs. The semantic input contract separately requires authorized observed evidence to match source ownership and observed context. Those are useful invariants to reuse. Their existence does not establish that any arbitrary input claiming `authorized: true` has satisfied them.

## Verdicts and the decisive join

Keep the following per-fact reporting distinctions, using `true | false | unknown`, explicit reason codes and witness references where supported. These are acceptance criteria, not a claim that the existing bridge directly exports every field or a requirement for a new event schema.

| Field | Meaning |
| --- | --- |
| `lawfulDisclosure` | At least one fact-bearing message came from the supplied contract's authorized holder/source and an allowed exact channel. This is lawfulness under the experiment contract, not a legal judgment. |
| `attributableRead` | At least one eligible fact-bearing message/content occurrence has a successful later read tied to its own call and posts payload. This field alone does not assert authorization. |
| `observedByPolicy` | A subsequent inference contains that same read observation, with matching content identity. A result merely returned by a tool is insufficient. |
| `messageArrival` | Exact message identity is established by a wire ID or a qualified reconstruction; otherwise it remains unknown when only content arrival is supported. |
| `authorizedObservedContent` | One complete witness chain satisfies authorization, matching read and later-inference visibility for this fact. |
| `numericTextCredit` | The separately bound native extraction verdict; a scorer exception or missing result remains unknown with its error. |
| `intendedSemanticUse` | A separately prepared annotation for the memo under an explicit rubric. In this synthetic slice it is an authored expectation, not a machine-discovered semantic truth. |
| `taskSuccess` | Always unknown in this contract. |

**Do not AND independently aggregated stage flags.** An authorized message that was never read and an unauthorized message that was read may make several marginal flags true. They do not form a valid authorized acquisition. Retain witnesses as:

`required fact → disclosure message → owning source/allowed channel → triggering post → read call → its observation/posts entry → later inference containing that observation`.

Compute `authorizedObservedContent` by existence of one complete chain, then deduplicate by `(episodeId, factId)`. Preserve alternative chains as evidence without increasing the numerator. A supplied memo annotation cannot repair a missing chain.

Arrival evidence must name its basis: `wire_message_id`, `validated_state_reconstruction`, or `content_only`. A content-only chain can establish observed authorized content under a declared proxy, but not exact emitting-message identity. Reconstruction requires a separately verified contract and receipt; inventing IDs for normalized rows does not supply that proof. Never pool these bases into a metric described as exact message arrival.

## Reuse the native bridge without broadening its premises

The native entry point already accepts the exact instantiated episode, original raw result, paired trace and explicit `MemoryReadProvenance`. It checks the world fingerprint, helper/source ownership, required facts, tool/runtime surface, initial prompt, per-message ledger and reconstructed pages before returning observed evidence. Preserve those original inputs and their hashes. Do not replace them with a simplified normalized event DTO that bypasses a native check.

Qualification must use a bounded source snapshot and interpreter/dependency identity. The test fixture's fake model labels and placeholder source declarations must remain labelled synthetic; they are not historical model/deployment attestations. The existing `capture` fixture uses the real memory session, helper validator, tool driver, trace recorder, `JsonlStore` reservation and persisted raw records, with only the two provider transports replaced. Its network prohibition is an engineering guard, not proof of real helper difficulty. See native test lines 1–6 and 79–146.

A source-backed output should retain exact required-fact IDs, observed evidence message/source/fact IDs, read-page witnesses and terminal validity, together with original result/trace identities. Record arrival basis as **validated state reconstruction**. Wire payloads do not directly contain message IDs. A reference to a newly assigned row ID is not a substitute for the native bridge's reconstruction proof.

Bridge rejection means the selected records cannot establish the supported acquisition claim. It is not a negative policy performance verdict. Preserve its reason and the original planned required-fact set when that set is independently valid; do not infer a denominator from only the successful returned evidence. Missing/duplicate/malformed links must never be repaired by choosing a convenient matching row.

## Twelve event scenarios and existing coverage

This is an acceptance matrix, not a demand to implement twelve duplicate fixtures. Existing coverage below was inspected in `experiments/coworkerl-v2/tests/test_completion_bridge.py`; reading a test is not evidence of its current execution passing. Use the source-bound native tests and add the missing combinations.

A semantic cross-check selects a required fact from the actual instantiated world. Prepare a memo correctly assigning that fact's value to its metric and a memo assigning it to another metric. Preserve all native `required_fact_ids`; choosing one target for a counterexample must not silently reduce the episode's denominator. A denied-quotation memo adds the already-observed extraction failure class: “The draft states that [metric] is [value]. That statement is false.” Intended affirmative credit is false, independently of the observed native verdict.

| ID | Event scenario and acceptance criterion | Existing coverage / remaining work |
| --- | --- | --- |
| E01 | Authorized disclosure, correct later read and subsequent inference: retain the original source/message identity and fact set. | `test_real_private_read_binds_original_message_and_source_without_mutating_inputs` 159–184. Add correct versus misbound/denied memo outputs without changing acquisition. |
| E02 | Complete no-contact episode: no authorized evidence; all required facts remain in the planned denominator. A correct guess is not acquisition. | `test_raw_legacy_zeroed_is_judged_independently_after_verified_submit` 485–493 covers a direct guessed memo and retained valid submission with no evidence. Preserve its native status separately from task success. |
| E03 | Authorized disclosure with no later read: no observed evidence. | `test_disclosed_but_unread_reply_has_no_evidence` 187–190. |
| E04 | An earlier read followed by disclosure, with no later read: the later message was not observed. | `test_read_before_disclosure_does_not_observe_a_later_reply` 255–261. |
| E05 | An authorized holder's message remains unread; the policy copies the same value into another channel and reads its own echo there. No authorized acquisition of that fact. | **Priority addition.** Existing unread-disclosure and policy-guess tests cover the ingredients separately, not this composed mixed-witness case. It prevents AND-ing unrelated disclosure/read marginals. |
| E06 | Fact text/value in envelope metadata or non-post material must not establish a received fact. | Source reconstruction checks exact payload/counters; corruption cases 366–370 and 469–482 exercise these constraints. A dedicated metadata-only target-value case was not found in this file; add only if the wrapper risks flattening payload/context text. |
| E07 | Read policy-authored guesses, public profiles or referrals: preserve context, without promoting it to authorized fact evidence. | `test_policy_guess_reappearing_in_read_page_is_not_authorized_evidence` 239–252; public/context cases 224–236 and 542–558. An impossible forged public holder disclosure instead rejects under 336–355; do not misclassify that rejection as ordinary negative performance. |
| E08 | An empty/missing-content read followed by a later valid read: retain the later complete witness. | Empty pages 561–570 and chronological reads 255–261 are covered separately. A single composed empty-then-valid sequence was not found; useful follow-up after E05 and semantic cross-checks. |
| E09 | Repeated reads and identical message texts: deduplicate evidence by original message identity and each fact numerator, while retaining read-page witnesses. | Repeated reads 201–206 and 584–592; identical-text page-position binding 210–221. The harness still needs a per-fact aggregation check because multiple authorized messages may carry the same fact. |
| E10 | Content-only pages without the supported memory provenance/reconstruction premises must not acquire exact-message status. | Explicit provenance failures 418–422 include live backend, wrong page size and altered prompt. This slice should reject unsupported inputs, not add a generic content-only fallback. |
| E11 | A final read returns at call cap, with no subsequent inference: retain invalid terminal state, empty submitted memo and no observed evidence. | 193–198, 528–533 and 574–581. Do not attach a fabricated post-read submitted memo merely to complete a cross-product. |
| E12 | An invalid/failed or unexecuted read cannot establish acquisition. | Ignored parallel read 282–288; invalid and oversized page cases 300–316. Explicit error observations differ from missing observations. |

Cross valid submitted trajectories with the correct and misbound memos; prioritize a correctly acquired fact followed by the denied-quotation memo. The acquisition bridge should remain insensitive to memo correctness while the separately labelled semantic-use result changes. Capture the actual native extraction verdict rather than presupposing every new world-specific sentence reproduces the earlier ratio example. A counterexample is an observed disagreement with the fixed rubric, not a scorer output substituted for its expected label.

A full conceptual twelve-by-two table has 24 selected target checks, not 24 independent experiments. Some native terminal/unsupported scenarios cannot legitimately carry both submitted-memo variants. Keep those exceptions explicit rather than manufacturing missing policy inferences or modifying persisted results to look valid. The harness denominator follows the frozen native required-fact set in each actual case, not the number of selected semantic annotations.

## Malformed evidence acceptance

Most required failure paths already have native tests. Reuse them before adding new ones:

- Cross-swapped ledgers whose global fact union stays unchanged reject at 264–279. This directly guards the per-message ownership join.
- Corrupt/missing result links, cross-linked records, changed worlds, missing ledgers, duplicate message IDs, wrong ownership, dangling ledger entries, absent replay history, judged inputs, wrong recipients, missing/extra transcript posts and dropped records reject in 376–411.
- Schema-valid read corruption, including altered sender/text, pagination, Boolean counters and reversed page order, rejects in 366–370 and 469–482 even when later request history is edited consistently.
- Wrong rubric/task/required-set identities reject in 426–439. The faithful bridge can use an explicit required-fact projection 519–525, but a wrapper must never create that projection implicitly to remove missed facts.

Additional wrapper tests must preserve rejection as unassessable and bind each retained output to its source/result/trace. Missing or ambiguous call-to-observation evidence cannot become false credit. Repeated legitimate calls have distinct identities; duplicate identities are not a deduplication opportunity. An explicit tool error is a known failed read, while an absent observation is missing evidence.

## Denominators and claims

Always report planned required-fact opportunities, assessed positive/negative counts, unassessable count and reasons. No-contact/nondisclosure cases stay in the planned denominator. Missing evidence must not disappear from a success rate or be relabeled a policy failure. If any planned opportunity is unassessable, an exact overall success rate is unavailable; one may instead report the count of established positives over the planned set with that lower-bound meaning stated, plus the unresolved count. Deduplicate facts, not messages or reads.

A qualified native fixture demonstrates mechanical evidence binding under the tested memory-runtime/source contract with fake provider transports. It does not qualify live logging, Run-1 acquisition, current-v2 helper difficulty, semantic-judge accuracy or training benefit. Keep numeric extraction, prospective semantic annotations and acquisition evidence separately inspectable. Task success remains unknown even if those narrower checks agree.

## Exact source scope

Paths are under `/Users/ronoktanvir/CoworkeRL`; line ranges refer to inspected bytes.

| Source | SHA256 | Relevant lines |
| --- | --- | --- |
| `history/halluminate/blobs/833f30d6453c85743819a1d20b4a03ee6af353fa` (Run-1 audit) | `57d7c1c66bcbdb99d567738ae751c997ca395d70470afcea14f90ea61b8282e3` | 6–65, 176–255 |
| `experiments/coworkerl-v2/src/probing/mattermost_mem.py` | `3b873a53cac9c4af78d1e764c5b6b818c70e1a68e4d45278dc9a4f6132979eaa` | 110–179 |
| V2 `src/probing/completion_bridge.py` | `47b9db082584fce8469897d52fc8279cbfa9a5a6511a80f073affbba69ac7087` | 93–200, 257–346 |
| V2 `src/probing/observed_context.py` | `b32f1ab69abb6ee5c1a7dbad7eb132e34d550904a0323dc0e5c7802a60b45b46` | 1–7, 12–62 |
| V2 `src/probing/reward.py` | `8910daf0b97f4e960a6c50659db7b773679d2a4253f7ccdd6596b311c08a1af4` | 264–275, 432–451 |
| V2 `src/probing/faithful_semantic.py` | `a15474694f010566de7caff545dacc4dca4ea3d1e8cc16e61e4d7ec4d408e7f0` | 348–420 |

The inspected native test file has SHA256 `5fdd557acdb865273cc64d9af9e1110c41a6f8f69bdaa409bf2ebac489c4034d`. The coverage assessment above is limited to that file and its inspected implementation path; it does not assert that missing combined cases are absent from every other repository test.
