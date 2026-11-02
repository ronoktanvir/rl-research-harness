# Run-1 evaluation: recovered source contract

**Run-1’s diagnostic measures deterministic fact credit, separately audits acquisition events, and applies a model judge to selected memos. These are different outcomes.** The archived entry point resolves to scripted helpers and the `banded` reward composition. Reading the optional LLM-helper module or the generic judge default in isolation would misidentify the protocol.

This read-only inspection was completed on 2026-11-02. No CoworkeRL code was imported or executed; no provider, network, training or runtime-ledger operation occurred. Source and selected records were read through the harness’s bounded, descriptor-relative readers. Large traces were streamed without exporting their prompts or content. The inspection recovers implementation semantics and saved declarations; it does not independently replay the acquisition audit or validate historical task success.

## Identity before interpretation

The evaluator revision is **`cb1bfd8b92abd4c23941300d653f61caf93ae3fb`**, distinct from Run-1’s training revision `ccfd25df63f55e408b67e984710eb6d3dd9e609f`. The [saved revision mapping, lines 231–236](/Users/ronoktanvir/CoworkeRL/history/halluminate/revisions.json:231) names the archive inventory [6a01c562…ccc62](/Users/ronoktanvir/CoworkeRL/history/halluminate/trees/6a01c56214b9f459b2b02aa340c7b6ecbdefa6f7035f492638167d5dcafccc62.json). Its 26,305 raw bytes hash to `6a01c56214b9f459b2b02aa340c7b6ecbdefa6f7035f492638167d5dcafccc62`. This is the SHA-256 of a saved JSON inventory, **not a Git tree-object ID**. The revision-map SHA-256 is `868d684018555914d8daae7f2f9ab00f1f8dcf862db0ddfdba5c67496dbba45f`.

Seventeen relevant archived blobs were independently checked using Git’s `SHA1("blob " + byte_length + NUL + bytes)` convention. The table lists original logical paths relative to `experiments/probing/`; each linked file is the verified archived blob, with its full Git identity in the filename. The private [verification manifest](/Users/ronoktanvir/Documents/ChatGPT/RL-harness/.harness/run1-protocol-source-evidence.json) records every selected blob’s SHA-256, length and original path. Its own 9,801 bytes hash to `0e61df8597c47b0a976d2e88c0617c95c7857426e7459fea6f4d40648af69344`.

| Original logical path | Verified archive and relevant lines |
|---|---|
| `src/probing/heldout_diagnostic.py` | [28b461d07dcf07e4dcde18acd05f20ba6a3fb43d, 374–420](/Users/ronoktanvir/CoworkeRL/history/halluminate/blobs/28b461d07dcf07e4dcde18acd05f20ba6a3fb43d:374) |
| `src/probing/engine.py` | [a23e702f4c0a1dff82c6b555c1531b43dfb9f1d4, 122–146](/Users/ronoktanvir/CoworkeRL/history/halluminate/blobs/a23e702f4c0a1dff82c6b555c1531b43dfb9f1d4:122) |
| `src/probing/rollout.py` | [a742629d7dcc5ad7f127e147a65168362cef37a8, 735–764](/Users/ronoktanvir/CoworkeRL/history/halluminate/blobs/a742629d7dcc5ad7f127e147a65168362cef37a8:735) |
| `src/probing/helpers.py` | [a629f69c5fe1d34e85d32cf414f0bb34fd06fe78, 205–249](/Users/ronoktanvir/CoworkeRL/history/halluminate/blobs/a629f69c5fe1d34e85d32cf414f0bb34fd06fe78:205) |
| `src/probing/extraction.py` | [1c6ed01e7b2650f42f9a7259206a555cac188962, 182–240](/Users/ronoktanvir/CoworkeRL/history/halluminate/blobs/1c6ed01e7b2650f42f9a7259206a555cac188962:182) |
| `src/probing/reward.py` | [34f6a24e70dda609c0f50cca9ebdcb5c7481af6f, 261–359](/Users/ronoktanvir/CoworkeRL/history/halluminate/blobs/34f6a24e70dda609c0f50cca9ebdcb5c7481af6f:261) |
| `src/probing/judge.py` | [c96aff449a66ee635073d00616be78870393c5bb, 287–382](/Users/ronoktanvir/CoworkeRL/history/halluminate/blobs/c96aff449a66ee635073d00616be78870393c5bb:287) |
| `src/probing/verl/fit_loop.py` | [8c07929354b2922f576622179e63e2490cead2f4, 337–345](/Users/ronoktanvir/CoworkeRL/history/halluminate/blobs/8c07929354b2922f576622179e63e2490cead2f4:337) |
| `scripts/disclosure_audit_v4.py` | [833f30d6453c85743819a1d20b4a03ee6af353fa, 225–254 and 319–375](/Users/ronoktanvir/CoworkeRL/history/halluminate/blobs/833f30d6453c85743819a1d20b4a03ee6af353fa:225) |
| `scripts/heldout_funnel.py` | [c5ecf10fd5f5f8249d5fd83abad425e070668ad1, 50–140](/Users/ronoktanvir/CoworkeRL/history/halluminate/blobs/c5ecf10fd5f5f8249d5fd83abad425e070668ad1:50) |
| `src/probing/mattermost_llm.py` | [c128c6dc22e40603b05b36407713eeedec2f0a51, 155–165 and 452–490](/Users/ronoktanvir/CoworkeRL/history/halluminate/blobs/c128c6dc22e40603b05b36407713eeedec2f0a51:155) |
| `src/probing/openai_policy.py` | [e8e6cda079b308d1e82581f1e7148ce71af5a539, 25–65 and 88–108](/Users/ronoktanvir/CoworkeRL/history/halluminate/blobs/e8e6cda079b308d1e82581f1e7148ce71af5a539:25) |

The mapping and blobs establish internal byte correspondence. They do not authenticate the historical process, its imported dependencies or the provider that served a response. Current checkout HEAD was separately observed as `84b219f64f1152f8b02babea388bfbbfff41e75a`; it was not substituted for the archived evaluator.

## Resolved execution path

The [diagnostic, lines 164–176](/Users/ronoktanvir/CoworkeRL/history/halluminate/blobs/28b461d07dcf07e4dcde18acd05f20ba6a3fb43d:164) constructs local-vLLM sampling with the cell’s model and derived rollout seeds. `run_cell` supplies no `helper_backend` when constructing `RolloutEngine`. The engine default is `None`; the rollout forwards a helper backend only when supplied; `helper_turn` resolves `None` to `SCRIPTED_HELPER_BACKEND`. Its replies follow holder/referrer/disclosure rules, rather than an LLM call.

This is a source-level routing conclusion, corroborated by the absence of helper-usage/fallback fields in the inspected judged rows. Absence alone would not prove scripted execution. Conversely, the optional [LLM helper defaults, lines 63–66](/Users/ronoktanvir/CoworkeRL/history/halluminate/blobs/08bff55c50d809e2136113b5fffc7830f8f20e76:63), including Claude Haiku, do not show that this entry point selected them.

The fixed plan comprises six configurations and seeds 1000–1063: 384 episodes per cell, group size one. The trained model selector is `run1-s11-step29`; baseline is `Qwen/Qwen3-8B`. Both trace files declare provider `openai` **and serving backend `local_vllm`**. Here `openai` identifies the compatible policy protocol, not evidence that a hosted OpenAI model generated the policy actions. The separate judge uses the hosted OpenAI transport in the inspected source.

## Credit, acquisition and quality are separate predicates

**Raw fact credit is deterministic textual matching constrained by disclosure.** The grader first identifies values in helper messages. A required fact earns credit only when disclosed and `credited()` finds its value and a metric alias in a sentence-like segment of the memo, without a recognized negator in a bounded window. The window extends 40 characters before and 25 after the matched value. Rendering equivalences are finite; this is not a semantic entailment model. A fluent, mistaken interpretation can therefore require an independent semantic test even when the parser accepts its metric/value surface.

**The acquisition funnel adds event attribution.** `disclosure_audit_v4` associates a ledgered helper disclosure with its triggering post, requires a subsequent successful `read_channel` of the same channel, and tests whether that read’s own posts payload contains the value. `ARRIVED_CREDITED` combines such arrival with the same deterministic memo-credit predicate. The funnel counts a required fact if any matching record qualifies and divides by all required facts, including facts never disclosed. Its contact stage is an episode-level category-relevance diagnostic applied to each fact. Merely finding a value in the final model request is explicitly not evidence of use. These are recovered **producer predicates**; this inspection did not independently replay each event attribution.

**`clean_success` is another deterministic producer flag.** It requires status `OK`, every required target credited, and no irrelevant fact in the memo. Undisclosed assertions can zero an episode; ledger drift or helper speculation can drop it. `clean_success` is not a calibrated verdict that the complete task was substantively solved. It remains distinct from both the number of credited facts and judge quality.

**Judging occurs after deterministic grading and does not award credit.** The judge scores correctness given credited facts, synthesis, clarity, usefulness and selectivity. The diagnostic calls `judge_group_results`, whose explicit composition is `banded`, overriding the generic `min` default. With two required facts, clean zero-credit episodes retain 0.4 without a judge call; one credited fact constrains the judged reward to [0.4, 0.8], and two constrain it to [0.8, 1]. Policy-zeroed and dropped cases bypass judging; judge failure drops an otherwise eligible case. Consequently, a composed reward is not an unconstrained quality score, and the judge cannot independently validate the credit on which its prompt and reward band depend.

## Limits and what the saved records preserve

The policy driver exposes five tools: `list_channels`, `read_channel`, `post`, `open_private` and `submit_memo`. Both inspected cells record a call cap of 40, maximum post length 16,383 characters, read pages of 20 posts and the same tool-contract hash `ccf807598431f1df3118debbcaf3970dad42ae91a8044fb9a2a5cf152c4f5950`. Each cell has 256 episodes with six allowed posts and 128 with four; none records an override.

The saved decoding declarations agree across cells: maximum completion 4,096 tokens; temperature 0.6; top-p 0.95; top-k 20; min-p zero; thinking enabled; chosen-token logprobs/token IDs requested; seed derived per request with training seed 11 and step index zero. The driver sends `tool_choice="auto"` and disables parallel tool calls. These are recorded/requested settings, not independent proof of the server’s actual sampling or loaded weights. The common transport has a 300-second timeout per attempt and two transient-error retries with 5/20-second backoffs. The diagnostic supplies no engine group timeout. Thus the 40-call limit is not a provider-request count, spending cap or hard episode wall-clock bound.

The judge source selects `gpt-5.5-2026-04-23`, prompt `judge-v4`, in-memory cache `judge-cache-v3`, JSON-object output and a 2,048-token completion bound. It allows three parse attempts and uses the same retrying transport; no explicit judge temperature or seed is supplied. Neither saved model names nor the source constants authenticate the remote implementation or establish reproducible judge decisions.

The two judged JSONL files were rehashed and their selected metadata recounted:

| Saved output | Trained | Bare base |
|---|---:|---:|
| Episodes | 384 | 384 |
| Episodes with positive deterministic credit | 21 | 17 |
| Rows recording the stated judge model, `judge-v4`, and `banded` | 21 | 17 |
| Rows with non-null judge system fingerprint | 0 | 0 |

The positive-credit rows are exactly those with judge metadata. The remaining 363/367 rows have null judge fields. This corroborates conditional judging; it does not reveal transport retry counts or authenticate individual provider calls. The trained judged-file SHA-256 is `71da9bb7a4ab6725a4bafdbcccf709c9891408156d2e5783aefcd8ac9597a071`; baseline is `3a3847145427f7ef6be38928a302fd12b005b26a9f9d43730ad9e15a90cc995b`.

**The trace judge field alone is misleading for the final result.** All 384 traces in each cell record `judge.consulted=false` and null judge identifiers. The source initializes [TraceCapture without judge metadata](/Users/ronoktanvir/CoworkeRL/history/halluminate/blobs/28b461d07dcf07e4dcde18acd05f20ba6a3fb43d:374), writes rollout traces, then judges and [overlays the result fields into separate linked rows](/Users/ronoktanvir/CoworkeRL/history/halluminate/blobs/8c07929354b2922f576622179e63e2490cead2f4:699). The sidecar must therefore be joined to the trace before interpreting final reward. Fresh streaming hashes reproduced trained trace `d4acf0dba875fd043d2ab34f31827c5b40556746b9d719438006a6af9d16444c` and baseline `7237a0b62120e2ba46a53f2429cb701a6dd655e6e73dd7d6e4ab32dfc5a773a3`.

## Applicability and the remaining audit

The [previous historical investigation](historical-evidence-followup.md) binds this evaluation to the original Run-1 report hash `8d73572a…80c5a` and final adapter `8f90ce05…bd6a`, rather than Phase 2’s similarly named `main-s11`. Its 23-versus-17 credited-fact sums and 1-versus-0 `clean_success` flags remain producer measurements. Source recovery explains those measurements; it does not validate their semantics, supply a matched training control, or turn 384 episodes into independent trained replicas.

Active [coworkerl-v2’s documented contract, lines 3–8 and 30–62](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/README.md:3) explicitly separates repaired tasks, metric-bound scoring and LLM-only collaboration, with no scripted fallback. Its [documented sampling and transport, lines 74–79](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/README.md:74) also differ from this legacy evaluation. Those are current-version declarations, not a qualification performed here. Shared Python namespaces do not make the protocols equivalent; no Run-1 helper, scorer, training or scientific qualification transfers to v2.

The next discriminating check is a version-specific semantic audit: independently label metric/value use, negation and hypothetical assertions; separately verify disclosure and read attribution; then compare each label to the recovered producer predicate. Judge quality and overall task success need their own criteria. Historical process custody, exact remote judge behavior, complete deployed dependency identity and prospective evaluation protection remain unresolved by these byte checks.
