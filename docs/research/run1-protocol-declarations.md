# Run-1 evaluation protocol declarations

The selected Run-1 traces preserve substantially more evaluation configuration than the summary reports alone: both cells declare the same decoding settings, tool contract, evaluator source revision, tokenizer and chat template. Their saved model and adapter identities distinguish the trained condition from the selected bare-base comparator. These are recoverable producer declarations and request records, not proof that the historical server loaded the declared bytes or that the scorer measured task success correctly.

This read-only inspection finished at `2026-11-02T08:51:42.134010+00:00`. It covered the original `grpo-run1/main-s11` report and the exact `heldout-diagnostic/s11-trained` and `s11-baseline` files below. It did not join Phase2 artifacts, execute project code, make model calls or evaluate prompt/answer content. The full traces were streamed once with bounded records and lines; only whitelisted scalar values, counts and hashes were retained. All previously qualified source hashes matched. See [the earlier byte-correspondence qualification](automated-investigation-qualification.md).

## Source identity and evidence notation

Paths below are relative to `/Users/ronoktanvir/CoworkeRL`. `R` is `artifacts/probing-helper-artifacts/grpo-run1/main-s11`; `T` and `B` are `artifacts/probing-helper-artifacts/heldout-diagnostic/s11-trained` and `.../s11-baseline`. Trace paths have the additional `.local-artifacts/` prefix. JSON pointers refer to a JSON document or to each JSONL record; `*` denotes an array element, not a literal JSON Pointer token. Counts are per cell unless specified otherwise.

| File | Bytes | SHA-256 |
|---|---:|---|
| `R/report.json` | 58,876 | `8d73572a733f05bcdf9eacda9af3bb5f92394745c6cd77c00786fe245df80c5a` |
| `R/run-manifest.json` | 985 | `e04fdfe9e502e83edde009be0f3c96e4d8cecd801ae0a9a694ca5eb5be644b73` |
| `T/cell-plan.json` and `B/cell-plan.json` | 38,461 each | `d2e2c2f52b6d4215b75deb4d05a168b8cb60a1039d405614f672f4a375fad738` |
| `T/cell-summary.json` | 253 | `c2da3df5f0f1693463c3635bee574119fedebeb9acc9349870aabd77f688921f` |
| `B/cell-summary.json` | 254 | `b3a3884d39d7ef63ec973b2e94983255e6f1a5dd46df24a413cdecfe14c7d975` |
| `T/step0-results.jsonl` | 1,176,357 | `b622ab9a46ab63d9938b9b0e91fd70cf570e169ea2a2df8bb9efead36019894a` |
| `B/step0-results.jsonl` | 1,182,267 | `ffc2be743c063046f3ba0f502385a7a7a0969c060d6c02ed4cae6edfb65a1378` |
| `T/step0-judged-results.jsonl` | 1,253,423 | `71da9bb7a4ab6725a4bafdbcccf709c9891408156d2e5783aefcd8ac9597a071` |
| `B/step0-judged-results.jsonl` | 1,259,108 | `3a3847145427f7ef6be38928a302fd12b005b26a9f9d43730ad9e15a90cc995b` |
| `.local-artifacts/T/step0-trace.jsonl` | 526,261,284 | `d4acf0dba875fd043d2ab34f31827c5b40556746b9d719438006a6af9d16444c` |
| `.local-artifacts/B/step0-trace.jsonl` | 359,944,976 | `7237a0b62120e2ba46a53f2429cb701a6dd655e6e73dd7d6e4ab32dfc5a773a3` |

The prior investigation observation is `coworker-investigation:a183aa8ee43f7c0b05d7f32193b62aa4b873bcc7a7888fa583be44268177513f`, with envelope digest `b01b649f9eb06910ed722ee3419bcb9c773f48e526d3cf7fd3f87347218c8786`. The private sanitized metadata is `.harness/run1-protocol-declarations.json` in this harness workspace: 86,806 bytes, SHA-256 `767ca6ffd4c4288ea03f2b38b6311bf2cb6535afef0ea963d5d074605d6df7d7`. It contains no prompt/answer copies, endpoint addresses or credentials. It is an inspection artifact, not a new ledger assessment or execution authorization.

## Selection and condition identity

Both plans contain 384 entries: six configurations × 64 world seeds, `1000` through `1063`, with `/plan/*/g = 1`. The configurations are `m1-downside-coverage`, `p2-n4-solo`, `p2-n5-solo`, `p2-n5-split`, `p2x-bare` and `p2x-org5`. The plans are byte-identical and declare `/set_fingerprint = f1ad672e9e53e1d9d2fd40336e3409e18fd75655bb59673d2abfb67977e9ae6b`. Result files label 256 rows `heldout_interp` and 128 `heldout_extrap` (`/split`). These six identifiers are disjoint from the 12 identifiers in `R/report.json:/config/config_ids`; this does not establish a protected holdout or absence of prior researcher exposure.

Each trace has 384 records, all declaring `/complete = true`, `/trainer_ready = true` and `/group_size = 1`. These flags describe the producer's artifact contract, not scientific validity. Summaries report `/resumed_from = 8`, `/ran = 376`, `/scored_total = 384`, `/rehearsal = false`. Thus the summaries describe a resumed collection, not a fresh 384-episode invocation. The scan counts 3,846 saved turns in the trained condition and 3,761 in the baseline condition; these are evaluation turns for one selected trained policy, not independent training replicas.

| Trace pointer | Trained: all 384 records | Baseline: all 384 records |
|---|---|---|
| `/policy/model` | `run1-s11-step29` | `Qwen/Qwen3-8B` |
| `/policy/model_revision`, `/policy/policy_version` | `heldout-s11-trained` | `heldout-s11-baseline` |
| `/policy/adapter_sha256` | `8f90ce0566954ee99ac5c852f05aad551462ac5d7d179fcc8a00726cbc53bd6a` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `/policy/base_model_revision` | `b968826d` | `b968826d` |

The baseline adapter value is the empty-byte SHA-256 convention. Together with its model label it declares the selected bare-base comparator; it does not establish a matched training control. The training report and manifest give the longer base revision `b968826d9c46dd6066d109eabc6255188de91218`; the evaluation's eight-character declaration is only a matching prefix, not an independently recovered full serving identity.

## Shared evaluation settings

Every trace record in both conditions declares `/policy/runtime_source_sha = cb1bfd8b92abd4c23941300d653f61caf93ae3fb`, `/policy/driver = mattermost_llm`, `/policy/serving_backend = local_vllm`, `/policy/provider = openai` and `/policy/vllm_version = 0.25.1`. The provider string must not be read as evidence of an OpenAI-hosted inference endpoint: the same records explicitly label the backend local vLLM. The training report and manifest instead declare `/runtime_source_sha = ccfd25df63f55e408b67e984710eb6d3dd9e609f`. A recovered training source tree therefore cannot establish the evaluator's implementation identity.

The following declarations occur in all 384 records per condition:

| Pointers | Recorded value |
|---|---|
| `/policy/chat_template_identity`, `/policy/chat_template_sha256` | `qwen3-upstream`; `a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8` |
| `/policy/tokenizer_identity`, `/policy/tokenizer_sha256` | `qwen3-tokenizer`; `aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4` |
| `/trace_schema_version`, `/schema_contract_hash` | `trace-v1`; `10a4b4238623c314af2a4c51f9b134fccbfef0c6455d9365b84ae442556339e9` |
| `/replay_contract_version`, `/fingerprint_surface_version` | `bounded-replay-v1`; `fingerprint-v3` |
| `/policy/vllm_flags/{enable_auto_tool_choice,runtime_lora_updating,reasoning_parser,tool_call_parser}` | `true`, `true`, `qwen3`, `hermes` |
| `/effective_runtime/{call_cap,max_post_characters,read_page_size}` | `40`, `16383`, `20` |
| `/effective_runtime/{authored_message_budget,effective_message_budget}` | Both `4` on 128 records and `6` on 256 records |
| `/effective_runtime/message_budget_overridden` | `false` |

All saved per-turn requests agree with the declared decoding settings: temperature `0.6`, top-p `0.95`, top-k `20`, min-p `0`, log probabilities and token IDs enabled, thinking enabled, and 4,096 completion tokens. The declaration pointers are `/policy/decoding/{temperature,top_p,top_k,min_p,logprobs,return_token_ids,max_tokens}` and `/policy/decoding/chat_template_kwargs/enable_thinking`; the request pointers are `/turns/*/model_visible_request` with the same names except `max_completion_tokens`. Every request also records `parallel_tool_calls = false` and `tool_choice = auto`. The declared seed contract is `probing/rollout-seed/v1`, mode `derived_per_request`, `training_seed = 11`, `step_index = 0`; the requests contain 3,846 and 3,761 distinct seed values respectively. This confirms presence and diversity of saved seed fields, not reproducibility of GPU sampling.

The declared tool-contract hash is `ccf807598431f1df3118debbcaf3970dad42ae91a8044fb9a2a5cf152c4f5950` (`/effective_runtime/tool_contract_sha256`). A canonical hash of each saved `/turns/*/model_visible_request/tools` array matches that value on every turn in both cells. This establishes consistency of the saved tool schemas without retaining their contents; it does not validate tool behavior.

Every saved `/turns/*/provider_completion/model` agrees with its cell's requested model label. Every completion records `system_fingerprint = vllm-0.25.1-3bee3a24` and a null `service_tier`. Provider `created` values range from `2026-08-12T21:48:40Z` to `23:09:15Z` for trained, and `21:45:46Z` to `22:20:46Z` for baseline. These are recorded response timestamps, not independently authenticated execution times. Observed completion-token counts reach the requested 4,096 cap in both conditions; counts alone do not establish why a particular completion ended.

## Judge and helper declarations

Judge metadata differs between rollout traces and later judged results. In every trace, `/judge/consulted = false` and `/judge/{model,prompt_version,cache_version}` are explicitly null. In both raw `step0-results.jsonl` files, `/judge_model`, `/judge_prompt_version`, `/judge_composition` and `/judge_system_fingerprint` are null on all 384 rows.

| Later `step0-judged-results.jsonl` pointer | Trained | Baseline |
|---|---|---|
| `/judge_model` | `gpt-5.5-2026-04-23`: 21; null: 363 | Same identifier: 17; null: 367 |
| `/judge_prompt_version` | `judge-v4`: 21; null: 363 | `judge-v4`: 17; null: 367 |
| `/judge_composition` | `banded`: 21; null: 363 | `banded`: 17; null: 367 |
| `/judge_system_fingerprint` | null: 384 | null: 384 |

These counts establish which saved rows carry non-null judge declarations; they are not a count of independently verified remote calls. The null rollout judge fields do not negate the separate judged-result metadata. Conversely, the filename “judged” does not mean every row was model-judged. Metadata alone does not recover the judge selection rule, exact prompt bytes, cache identity, decoding settings, response custody or success calibration. The separate [source audit](run1-protocol-source.md) examines the evaluator and scoring/selection implementation; code-level recovery must remain distinct from a captured execution declaration.

No helper model is recorded at the inspected trace pointers `/helper_model`, `/helper/model`, `/helper/model_revision`, turn pointers `/turns/*/helper_model`, or result pointer `/helper_model`. Their absence must remain explicit. A default inferred from source code is a separate source interpretation, not a captured execution declaration. This scan did not examine prompt contents to infer helper behavior.

## Remaining protocol gaps

Metadata leaves the evaluation revision `cb1bfd…` and its scoring/selection implementation to the separate [source audit](run1-protocol-source.md). Reading the two reports together narrows the remaining work to protocol qualification and success validation against adjudicated examples. Matching saved request settings remove a specific configuration uncertainty; they do not resolve historical serving custody, base-weight identity, exact loaded tokenizer/template bytes, helper behavior, protected holdout access, scorer validity or independent replication. Source recovery alone also does not qualify native execution or semantic correctness.

The original report separately declares training group size `8`, 30 steps, learning rate `1e-5`, seed `11`, prompt/response limits `40960/4096`, thinking enabled, recomputed old log probabilities, and no shuffled-control seeds (`R/report.json:/config`). These training declarations must not replace the evaluation's group size `1` and observed request limits. Neither the inspection nor the existing matched artifact identities establish a causal training gain. The original research requests remain unresolved, scientific evaluation remains unassessed, and no execution is authorized by this report.
