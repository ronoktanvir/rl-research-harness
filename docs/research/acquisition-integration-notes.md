# Acquisition integration: native primitives and replay boundaries

**Use the actual current-v2 observed replay bridge for the next integration.** Its existing offline fixture exercises the real catalog, world, driver, helper validation, store and replay with fake provider transports. The qualified native tests already cover the receipt failures that a separate harness event oracle would otherwise duplicate. Keep native acquisition evidence separate from text credit and independent semantic labels.

Inspection and qualification date: 2026-11-02. Initial inspection read bounded source files and verified archive blob identities. A subsequent authorized run executed staged, unchanged native v2 code: 58 upstream tests and two harness extensions passed. Only the five hash-locked pytest dependencies were fetched before testing; the test process denied network access before imports and made no provider or training calls. The prior [native credit probe](credit-calibration-rubric.md) qualifies a different primitive. See [recovered Run-1 source](run1-protocol-source.md) for the evaluator revision and archive-inventory identity; current-v2 results do not qualify that historical protocol.

## Three mechanisms must retain different names

| Mechanism | Actual callable | What it establishes from valid inputs |
|---|---|---|
| Native v2 disclosure extraction | `disclosed_fact_ids(text, facts)` | Which caller-supplied facts have a matching affirmative metric-bound claim in one message. Caller supplies the sender’s owned facts. |
| Native legacy acquisition audit | `audit_episode(result, trace)` | Legacy read-after-trigger/value-arrival and text-credit buckets for ledgered disclosures in a reconstructed historical world. |
| Native v2 observed replay | `build_observed_replay(episode=…, result=…, trace=…, provenance=…)` | Supported memory-session replay, message/page reconstruction and subsequent-inference observation, with source/world/runtime checks. |

Disclosed, returned by a tool, included in a later inference, textually credited and semantically correct are separate facts. Neither module authenticates the historical artifacts supplied to it.

## The smaller disclosure primitive remains distinct

The already pinned v2 [extraction module, lines 496–521](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/src/probing/extraction.py:496), SHA-256 `4d3e2e36737b822f07386e95f047d8e261946ed732502e2e24ff6d9344381101`, exposes:

```python
disclosed_fact_ids(text: str, facts: tuple[FactLike, ...]) -> tuple[str, ...]
# FactLike fields: fact_id, value, unit, aliases
```

It requires only the same reviewed standard-library module used by the credit probe. Constructing plain fact records that implement this documented `FactLike` interface is a legitimate input adapter; it does not impersonate a native world. The [actual v2 grader, lines 259–272](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/src/probing/reward.py:259) supplies each sender’s owned facts and then intersects disclosed facts with final-memo credit. Its [ledger comparison, lines 432–451](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/src/probing/reward.py:432) requires matching per-message fact sets and unique helper-message IDs. Reward source SHA-256 is `8910daf0b97f4e960a6c50659db7b773679d2a4253f7ccdd6596b311c08a1af4`.

Do not substitute `credited()` for `disclosed_fact_ids()`: the disclosure primitive accepts any matching affirmative claim, whereas memo credit requires all recognized affirmative claims for that metric to match. A message containing conflicting affirmative quantities can therefore produce different native disclosure and credit results. That distinction needs an explicit fixture.

A narrow disclosure-only worker could receive source-bound messages `{id, sender, text, ownedFacts:[{id,value,unit,aliases}]}` and return per-message/per-fact disclosure booleans or sanitized errors. That remains a valid smaller interface, but it cannot establish ownership, delivered pages or later policy observation. The full native replay fixture is now the preferred integration path because it exercises those relationships directly. It does not require a second event oracle.

For legacy conformance, the existing pinned module’s `contains_value(text,value,unit)` is a distinct native presence primitive. Legacy grading scans helper messages for values rather than applying v2’s sender-owned metric binding. Retrofitting v2 ownership or alias rules and calling the result “legacy” would change the measurement. An independent acquisition contract should identify the chosen primitive/version explicitly.

## Why the legacy audit is not a standalone function

The exact archived [audit module](/Users/ronoktanvir/CoworkeRL/history/halluminate/blobs/833f30d6453c85743819a1d20b4a03ee6af353fa:79) is 22,626 bytes; its Git blob ID is `833f30d6453c85743819a1d20b4a03ee6af353fa`, and SHA-256 is `57d7c1c66bcbdb99d567738ae751c997ca395d70470afcea14f90ea61b8282e3`. It imports `POOL_BY_ID`, `instantiate`, `contains_value` and `credited`. `episode_for(config_id,seed)` reconstructs and caches the actual world. Importing `dev_configs` calls filesystem-backed `configs.discover()`, so loading only the audit’s text with invented globals would not execute its original dependency contract.

The archive’s project-module closure is eight modules plus the audit. The inventory below was read and each Git blob identity checked; import inventory is not yet execution qualification.

| Project module | Exact archived Git blob |
|---|---|
| `probing/__init__.py` | `bd345b8602811f69265296e5310b60b139246930` |
| `probing/config.py` | `3fa9017d282182fb769c9b90998da162a22e207f` |
| `probing/world.py` | `4aee0450c3f74648d3757be4e3fdb19a8a0a263b` |
| `probing/extraction.py` | `1c6ed01e7b2650f42f9a7259206a555cac188962` |
| `probing/dev_configs.py` | `eb4591fe4670b34581731b0ac70baaca38257b2b` |
| `probing/configs/__init__.py` | `1e3e649be534e41072d554a914f21558c442ac4d` |
| `probing/configs/m1_downside_coverage.py` | `92a5902fddacc3fef24e57cb5a6948c20c6a4d7f` |
| `probing/configs/m2_retention_arrivals.py` | `45e8dd78975a8d3d44145e6a999c7c514051e2ce` |

A later native integration should stage this exact complete package, including its real configuration discovery, under a private reviewed import boundary. It must not import whichever `probing` package happens to be installed, transplant selected AST functions, override `POOL_BY_ID`, or replace `instantiate` with an arbitrary supplied episode and claim complete native historical replay. Avoid its `main()`/`collect()` file-walking and output-writing interfaces; call the actual `audit_episode` after strict bounded input validation.

The callable needs more than a memo and read receipt. Its [lines 258–380](/Users/ronoktanvir/CoworkeRL/history/halluminate/blobs/833f30d6453c85743819a1d20b4a03ee6af353fa:258) consume configuration/seed/run identity, a disclosure ledger, ordered transcript messages, memo and policy turns. Each executed turn includes a normalized call, a uniquely attributed observation containing a JSON tool envelope, and before/after posting counters. Runtime channel names and the triggering post are derived from the native episode and synchronous helper-reply order.

Required wrapper checks include unique message/result/trace/call IDs, exact result-to-trace joins, strict counter types and successful-post increments, well-formed observation JSON, closed fact/ledger identities and an explicit total planned-fact denominator. The old code uses dictionary assignment for transcript/result IDs and `before != after` for post detection; duplicates or malformed/decreasing counters must not be allowed to masquerade as valid receipts. An empty ledger returns no records and no drops, not proof that the complete planned task population was assessed. Exceptions remain unassessable, never failed policy outcomes.

The native legacy arrival predicate is deliberately limited: an exact-channel read after the triggering post returns a posts payload containing the value. The read has no emitting message ID. This is not exact message delivery or subsequent model consumption, and it is not comprehension. The current fixed investigation’s file/row joins do not replace this per-event audit.

## Current v2 offers a stronger but larger replay contract

The real public entry point is [completion_bridge.build_observed_replay, lines 224–239](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/src/probing/completion_bridge.py:224). The inspected module SHA-256 is `47b9db082584fce8469897d52fc8279cbfa9a5a6511a80f073affbba69ac7087`. It requires an actual `Episode`, the original linked **unjudged** result and complete trace, and `MemoryReadProvenance(backend,read_page_size,system_prompt,contract_version)`. Its validation compares world fingerprints, owned fact metadata, sequential `mem-*` message IDs, disclosure ledger, initial prompts and runtime/tool identity. A saved policy `serving_backend=local_vllm` cannot establish the separate environment backend `mem`.

Its [_MemoryReplay, lines 93–200](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/src/probing/completion_bridge.py:93) reconstructs channel state and page contents, then marks selected message IDs observed only if the exact tool observation appears in the next policy inference. A successful final-turn read without a later inference does not qualify. The typed [observed_context module](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/src/probing/observed_context.py:1), SHA-256 `b32f1ab69abb6ee5c1a7dbad7eb132e34d550904a0323dc0e5c7802a60b45b46`, retains those message/page receipts separately from fact credit. Its constructed-fixture helper explicitly leaves read pages empty rather than inventing historical observations.

This bridge imports the completion-judge types, transport-linked modules, driver/tool construction, redaction, trace validation and world machinery. The reviewed offline fixture imported 49 recorded `probing` modules from the staged package. The source inventory also covers native catalog source loading and data; the 49 imports are not a claim about the complete Python runtime closure. Supplying a raw-result substitute made by deleting judge fields from a judged sidecar would violate the bridge contract. Qualification of its current-v2 fixture does not create a shortcut for the Run-1 judged artifacts.

## Native offline qualification and its boundary

The upstream [completion bridge test module](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/tests/test_completion_bridge.py:78), SHA-256 `5fdd557acdb865273cc64d9af9e1110c41a6f8f69bdaa409bf2ebac489c4034d`, supplied the unchanged `capture` fixture. Its tests cover unread disclosures, reads before disclosure, wrong ownership, policy echoes, duplicate identities, corrupted pages, missing provenance, final-turn reads without subsequent inference, and complete trace/result bindings. No catalog or world substitute was introduced. Native catalog loading was preserved, including the project's own original-source loader.

The [two harness extensions](/Users/ronoktanvir/Documents/ChatGPT/RL-harness/test/integrations/coworker_observed_replay_cases.py:1), 7,441 bytes with SHA-256 `1cbff19b423349c38cec40c3d72a7c23932ba9675a5143e54c2393d341d7f841`, used that same native fixture and semantic expectations reviewed before execution:

| Fixture | Native text credit | Authorized observed fact | Consequence |
|---|---|---|---|
| An unread legitimate disclosure plus a read policy guess in another channel | True | False | Separate partial witnesses cannot establish authorized acquisition. |
| A legitimately observed fact quoted and explicitly denied in the memo | True | True | Acquisition plus native credit still does not establish correct semantic use; the fixed semantic label is false. |

Both records retain all required facts, exact raw result/trace hashes and read-page/call/subsequent-request witnesses. Terminal validity is reported separately; task success and scientific evaluation remain unassessed. The two designed cases establish bounded counterexamples, not an estimated error rate or general semantic calibration.

The combined run passed **60 tests in 2.98 seconds** under Python 3.11.9 and pytest 9.0.2. The staged source inventory contains 152 files and has SHA-256 `341eb2683cc92c71490d0c6bb007e7d4b0c558ec248bd50ba3c016ac110b584b`. All original and staged source bytes were checked unchanged afterward. The network-denial self-test passed; the test run recorded no denied effects. Test plugin autoload and conftest discovery were disabled, environment variables were restricted, and output writes were confined to the temporary output directory by the reviewed launcher. This is a guard for reviewed code, not an adversarial operating-system sandbox. The parent enforced a 60-second deadline; it did not enforce a general memory or output-file-size ceiling. An initial launch failed before collection when pytest attempted its default log sink; assigning an explicit output-directory log path resolved the launcher issue.

The complete source snapshot, configuration, launcher, dependency provenance, runtime metadata, raw fixture artifacts and two summary records are retained under [the ignored qualification directory](/Users/ronoktanvir/Documents/ChatGPT/RL-harness/.harness/observed-replay-qualification/2026-11-02-native-v2-60-tests/qualification.json). Its 354-file retention inventory was reread and verified; inventory SHA-256 is `ae2bd1b323bf64ad9f89428997f6d512586a3334204fcef163be9556f28b4a37`. Pytest convenience symlinks were omitted and listed explicitly. That fixture did not qualify credentials, actual provider behavior, historical custody, complete evaluator validity or a production execution boundary. The subsequent [local adapter qualification](observed-replay-adapter-qualification.md) adds a versioned source/input contract, bounded execution and recoverable private artifacts; scientific and deployment limits remain explicit.
