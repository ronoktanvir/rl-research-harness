# Native observed-replay qualification

The actual current-v2 replay path passes 58 existing checks and two new combined counterexamples. This supports reusing `build_observed_replay` for a future harness adapter. It also demonstrates that authorized observation plus native numeric credit can still accept a semantically rejected assertion. The harness should retain those measurements separately.

Qualification date: 2026-11-02. CoworkeRL checkout: `84b219f64f1152f8b02babea388bfbbfff41e75a`. The test used its actual catalog, world instantiation, memory backend, helper validation, tool driver, grading, trace recorder, group reservation, persisted raw records and replay. Only the policy/helper provider transports were fake. No live provider, training run or service was invoked; the isolated test dependency installation preceded execution.

## What the combined cases demonstrate

Both cases instantiate `m3-covenant-recheck`, seed 7, and retain its two required facts. The selected fact is `m3-covenant-recheck/covenant-breach-count`; the other required fact has no supplied semantic annotation and remains explicitly unknown in that column. The tests do not narrow the episode denominator to the selected target.

| Case | Selected fact's native text credit | Authorized and policy-observed | Observed numeric credit | Prewritten semantic expectation |
|---|---|---|---|---|
| Legal holder reply left unread; policy reads its own copied claim in another channel | true | false | false | true for the affirmative numeric assertion |
| Legal holder reply read and included in the next inference; memo quotes its value then rejects the assertion | true | true | true | false for the denied quotation |

The first case prevents combining unrelated witnesses: one unread legitimate disclosure and a different read containing the same value cannot establish authorized acquisition. The test verifies that the read page actually included the policy's own text, so its result is not explained by a failed read. The second case follows a valid acquisition chain but reproduces the extraction defect in a real persisted fixture. Better provenance does not repair semantic interpretation.

For the denied quotation, replay maps read turn 2 / call `call-2-0` to messages `mem-000001` and `mem-000002`, then verifies the observation in inference 3. The authorized fact witness is `mem-000002`, source `m3-covenant-recheck/seat0`. In the mixed-witness case, read turn 4 / call `call-4-0` returns different messages, `mem-000003` and `mem-000004`, witnessed by inference 5; no authorized fact evidence results. These IDs are **validated state reconstruction**, not IDs observed directly in the read payload.

The [harness-owned tests](../../test/integrations/coworker_observed_replay_cases.py) prepare their memo-generation rules and labels before native outputs, retain memo/fact-definition hashes, native results and read/inference witnesses, and mark task success and scientific evaluation unassessed. Expected semantic labels are agent-authored synthetic annotations, not independent human adjudication. `observedSemanticUse=false` with no authorized observation is a grounding conjunction; it does not replace an unknown semantic annotation or declare the entire task unsuccessful.

## Source and execution identity

The final combined snapshot contains 152 files: the complete tracked v2 source package, exact original test module and the two-case harness extension. Its canonical source-manifest SHA256 is `341eb2683cc92c71490d0c6bb007e7d4b0c558ec248bd50ba3c016ac110b584b`. Original and staged file bytes were rechecked unchanged after execution. The runtime record lists 49 imported `probing` modules; dynamic catalog inputs are also covered by the staged inventory. This is not an inventory of every interpreter or operating-system byte.

Key identities:

- Native bridge: `47b9db082584fce8469897d52fc8279cbfa9a5a6511a80f073affbba69ac7087`.
- Native extraction: `4d3e2e36737b822f07386e95f047d8e261946ed732502e2e24ff6d9344381101`.
- Original test module: `5fdd557acdb865273cc64d9af9e1110c41a6f8f69bdaa409bf2ebac489c4034d`.
- Harness extension: `1cbff19b423349c38cec40c3d72a7c23932ba9675a5143e54c2393d341d7f841` (7,441 bytes).
- Preserved one-off launcher: `78d9e622fe2f65ad77703b3766e4b6c2d8aae5578f5d5db82580787a5883f724`; its identity was recorded after execution from the unchanged launcher, not as an independently attested prelaunch identity.
- Upstream `uv.lock`: `e831423d2624b9e27e9ec3da0330ea76a0a37274af03396bebc9abb74042a0f6`; derived hash-required pytest dependency lock: `2c6a5a332426d33a4f59b344b8d98e0e00b5901aea4bb43028af0347000d5ade`.

CPython 3.11.9 and pytest 9.0.2 reported **60 passed in 2.98 seconds**, exit 0, with empty stderr. The original 58-case suite had passed separately before the combined run. No model-provider SDK was installed for this qualification.

The child started with Python isolation/no-site/no-bytecode flags, a minimal environment, explicit staged package/test/dependency paths, disabled plugin/conftest discovery and no pytest cache. Before importing project code, audit guards denied network/socket/DNS activity, subprocesses and access outside allowed paths; writes were limited to test output. A socket-creation self-test was denied, and the execution recorded no additional denied effects. The parent enforced a 60-second deadline. The 128 KiB output threshold bounded display only, not process disk output or memory. These are controls for this inspected qualification, not a general Python isolation guarantee or a production worker.

## Retained evidence and checks

The full snapshot, configuration, dependency metadata, raw fixture pairs, runtime/JUnit records and summaries are preserved under ignored `.harness/observed-replay-qualification/2026-11-02-native-v2-60-tests`. A separate reread verified all 354 inventoried regular files, totaling 9,293,421 bytes. Pytest convenience symlinks were omitted and recorded; the sole copies are not left in temporary storage.

| Retained record | SHA256 |
|---|---|
| `inventory.json` | `ae2bd1b323bf64ad9f89428997f6d512586a3334204fcef163be9556f28b4a37` |
| `qualification.json` | `dfb6cd0bda215b71e8b3c23c9b332b87ebea2256206a3b1d1e88f46368110e12` |
| Mixed-witness summary | `756821b1dc18d83e8c78d637e53e08112239028c5b15a95516a385ac9c9ba7d0` |
| Denied-quotation summary | `977c2d2c17c3fcfa6c09a2287c87c9f46b41be416162484f96650868f3a1cfd2` |
| Runtime record | `b80ff8191620e83bb0c11e14d9b1f9feaf033193efab8fed9996dbe13cb195d6` |
| JUnit record | `d285f4e717e07684267c628b00acc266890fe2e03136020e7df841cdfd4ffa40` |

Independent review rehashed all 152 staged source/test files and 49 recorded project modules, then checked both raw result/trace/memo bindings, complete required-fact sets, reconstructed message IDs and exact next-inference requests. No required correction remained. The semantic rules were reviewed before execution; they remain synthetic annotations rather than blinded human judgments.

The existing independent Node/ledger qualification is unchanged. This slice adds opt-in native tests requiring the separately staged private project; ordinary repository CI does not execute them. Typecheck and diff checks pass. See the [acceptance rubric](acquisition-rubric.md), [adapter boundary](../integrations/coworker-observed-replay.md) and [reuse decision](../decisions/0003-native-observed-replay.md).

The next implementation is a catalog-backed bounded adapter with prelaunch source/input binding, original-pair/provenance validation, failure persistence and offline reload. These tests do not create that adapter, establish historical custody, qualify live helpers or validate a complete semantic evaluator. Current-v2 results cannot retrospectively validate legacy Run-1.
