# Coworker v2 observed-replay adapter boundary

**Call the existing v2 `build_observed_replay` with its production validators, then join native extraction observations to separately declared labels.** Reimplementing its event logic would discard a tested contract. Its replay reconstructs memory pages, maps positions to original message IDs and requires a later policy inference to contain the observation. This is stronger than the legacy Run-1 same-channel value-arrival proxy.

Status: the [local adapter](../observed-replay.md) is implemented and [qualified](../research/observed-replay-adapter-qualification.md); queue/ledger integration and unattended deployment remain pending. Earlier [native qualification](../research/observed-replay-qualification.md) passed 58 existing tests and two harness extensions on 2026-11-02. CoworkeRL HEAD is `84b219f64f1152f8b02babea388bfbbfff41e75a`; the inspected source remained unchanged. Initial inspection was read-only; subsequent qualification executed its staged source with fake provider transports.

## Native contract

[completion_bridge.py:224](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/src/probing/completion_bridge.py:224) exposes `build_observed_replay(episode, result, trace, provenance) -> ObservedReplay`. It accepts the exact instantiated `Episode`, original persisted **raw and unjudged** result, original linked trace, and explicit `MemoryReadProvenance`.

The bridge calls `validate_result_trace_pair`, then checks the retained complete episode, supported OpenAI Mattermost driver, world fingerprint and metadata, runtime/tool contract, initial prompt and owned per-message disclosure ledger ([257–336](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/src/probing/completion_bridge.py:257)). Do not repair rejected artifacts by inventing IDs, clearing judge fields, substituting a world, or copying a prompt from the trace into “external provenance.”

`MemoryReadProvenance` requires `backend`, `read_page_size`, `system_prompt` and `contract_version`. Backend must explicitly be `mem` and page size must match the supported constant. A producer can capture these separately in `cell-identity.json:provenance.rollout_session` and `provenance.policy.system_prompt`, as exercised by [the staged test](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/tests/test_staged_completion_integration.py:65). Matching declarations detect inconsistency, not forged provenance or historical process custody.

The replay accounts for ordered posts, helper replies, private channels, page windows, posting limits, rejected calls and identical replies. Read positions resolve to original `mem-NNNNNN` messages. A final-turn read has no subsequent inference witness and is not policy-observed ([80–200](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/src/probing/completion_bridge.py:80)). Public factual disclosures, policy echoes and unowned ledger entries cannot become authorized fact evidence. All world facts, including nonrequired facts, remain private evaluator inputs.

The returned `ObservedReplay` contains `brief`, `world_facts`, `evidence`, `memo`, `terminal_valid`, `terminal_status`, `required_fact_ids`, `source_bindings` and `observed_context`. The last retains witnessed messages and read pages. A supported call-cap termination can yield a valid replay with `terminal_status = invalid_policy` and an empty memo. Replay completion is not task success; this entry calls no semantic judge.

## Minimal adapter request

The implemented local command accepts one bounded persisted pair under an operator-selected artifact root. Its operator request includes explicit source/artifact roots; future queue integration must obtain that authority from trusted project configuration. Queue requests should contain relative references, not import paths, executables or caller-built episodes:

- Stable project/investigation identity and expected source-closure manifest digest.
- Episode selection `{registry: "pinned_catalog", configId, seed}`. Resolve the native config and call its actual `instantiate` inside the pinned package.
- Raw-result and trace references with expected file hashes, bounded record selectors and original result/trace IDs. Preserve both file and selected-record identity; reject missing, duplicate or cross-linked matches.
- Separately captured provenance reference/hash, including exact system-prompt bytes. Publish neither the prompt nor unrelated endpoint metadata.
- A separate frozen annotation/rubric reference. Native replay and extraction receive no expected labels or rationales.

The first profile should reject task-package-only configurations. Later package support must verify original manifest/config bytes, package revision and interpretation-notes identity before instantiation: IDs can recur across package revisions. See [faithful_bridge.py:16](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/src/probing/faithful_bridge.py:16) and [semantic_instruments.py:16](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/src/probing/semantic_instruments.py:16).

Persist immutable intent before the bounded worker, then its outcome and derived assessment. Bind normalized request, source/data closure, wrapper/interpreter identity and limits. Read selected artifact bytes with strict JSON/type validation and no truncation. Keep interrupted read-only attempts separately identified; completed receipts reload without files or another subprocess.

Pinning only `completion_bridge.py` is insufficient. Direct imports include `completion_judge`, `extraction`, `mattermost_direct`, `mattermost_llm`, `observed_context`, `prompts`, `redaction`, `trace` and `world`; catalog resolution adds config modules/data. Transitive imports reach provider-capable modules even though replay calls no provider. Qualify the complete staged import/data closure and import-time behavior. Exclude the historical `probing` namespace, user site packages, ambient credentials and unreviewed import locations. A subprocess bound or Python isolation flag is not a general sandbox. The local qualification retains its exact staged inventory and recorded imports; it does not qualify a production import boundary.

## Join observations without creating approval

Keep the complete replay private and bounded. Ledger projections should retain its hash, exact input identities, world fingerprint, terminal status, required-fact universe, source bindings, evidence message/source/fact IDs, content hashes and page/next-inference witnesses.

Native extraction must receive exactly `ObservedReplay.memo` and the corresponding episode fact definitions. `ObservedReplay.world_facts` omits aliases: obtain them from the same instantiated episode fact, verifying ID/value/unit/source ownership. Do not infer aliases from labels or accept annotation-supplied replacements. The implemented adapter executes extraction in that same pinned worker and binds its result to the request, exact memo and complete fact-definition digests. A separate credit-probe call would need to bind this exact packet through its `probeInputDigest`.

Each planned required fact needs distinct observed-evidence status, native credit Boolean or scorer error, expected semantic label or `unknown`, rubric identity, terminal status and stage errors. Repeated disclosures must not multiply its numerator. Failed replay and missing results remain unresolved, not negative policy outcomes. Derive `observed && credited` only with complete applicable evidence, and label it a producer predicate, not semantic correctness or task success.

The existing 17-case synthetic labels cannot automatically assess a different memo. New persisted fixture captures need annotations bound to exact memo/fact-definition digests before inspecting scorer outputs. Historical memos without those annotations remain `expected: unknown`. A future semantic instrument requires separate explicit identity and qualification; this adapter should neither call a judge nor infer a completion rubric.

## Reuse the actual persisted-capture tests

[test_completion_bridge.py:1–145](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/tests/test_completion_bridge.py:1) is the strongest starting qualification. Only provider transports are substituted. The actual memory backend, helper validation, driver, trace recorder, grading, group reservation and `JsonlStore` persistence run; records are reloaded from written raw files before replay.

| Boundary | Existing tests and lines in that file |
|---|---|
| Original identity and unchanged inputs/files | private message/source binding (159) |
| Disclosure versus policy observation | unread reply (187), final read/call cap (193), read before disclosure (255), next-inference witness (574) |
| Message identity rather than text matching | repeated reads (201), identical replies/page positions (210), cross-swapped ledgers (264) |
| Authorization | profiles/referrals/own echoes (224), echoed policy guess (239), forged public fact (336) |
| Execution and replay integrity | unexecuted parallel read (282), schema-valid corruption (366), corrupt/nonraw artifacts (376), Boolean counter (469) |
| Applicability and complete fact universe | provenance mismatch (418), missing nonrequired metadata (442), changed definition (454) |
| Context distinct from fact evidence | contextual public/own messages (542), empty pages (561), retained page witnesses with deduplication (584) |

Add harness boundary tests for closure drift, file/record substitution, exact stripped-input digests, resource limits, failure persistence and offline receipt reload. A passing pytest summary alone is not the adapter: retain an actual persisted fixture pair, replay receipt, native credit receipt and joined assessment, then reload those identities without repeating native work.

The staged integration test additionally exercises `run_cell`'s provenance writer, but patches catalog entries and depends on historical staged files outside the ordinary package. It cannot substitute for current-catalog qualification. Package-binding tests are useful for later same-ID/different-package rejection.

## Inspected byte anchors

Paths are relative to `/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2`. This is an inspected-file inventory, **not the complete executable closure**.

| File | SHA-256 |
|---|---|
| `src/probing/completion_bridge.py` | `47b9db082584fce8469897d52fc8279cbfa9a5a6511a80f073affbba69ac7087` |
| `src/probing/trace.py` | `43eb618be8e93d743a0b81d0ce5166806b83feb75808f3d9f1ad02c0d5d2cb43` |
| `src/probing/world.py` | `7445b1d3829697f6fcefd0a758f4047bc47b1c4605a14d8c932eab2cb9011a73` |
| `src/probing/extraction.py` | `4d3e2e36737b822f07386e95f047d8e261946ed732502e2e24ff6d9344381101` |
| `src/probing/observed_context.py` | `b32f1ab69abb6ee5c1a7dbad7eb132e34d550904a0323dc0e5c7802a60b45b46` |
| `src/probing/catalog.py` | `7a59d7c1092e9325a8e77b09764eb63b1219146cebb8a984c0f9d79e1773f16e` |
| `src/probing/faithful_bridge.py` | `404a7d1e5ae076a1534b61ee61acc1aec84956e7a82cfda490f0f06cab6bde86` |
| `src/probing/semantic_instruments.py` | `e48da130af123925ea3925b312f4bb3d5e7a52a10186d803bca8a689a8d7b565` |
| `tests/test_completion_bridge.py` | `5fdd557acdb865273cc64d9af9e1110c41a6f8f69bdaa409bf2ebac489c4034d` |
| `tests/test_package_binding_failclosed.py` | `00d0733f32eb65f1dc5af36b065ab8ee8e9159414615554c8b0c5d1b7f7ec70a` |
| `tests/test_staged_completion_integration.py` | `237a03a11d70965cf864f6e5b50ffea85cc9ad2dfa0d6bbb09559eba3991db06` |

The pinned staged-package and local adapter qualifications are complete, with raw fixture pairs, complete observation projections and independently verified local receipts. The next step is research-ledger integration and separately bound semantic assessment. Current-v2 success must not be presented as retrospective Run-1 validation.
