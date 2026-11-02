# Native extraction qualification and counterexamples

Qualified locally on 2026-11-02. The harness ran the actual pinned legacy and v2 extraction modules on the prewritten [17-case semantic fixture](../../examples/calibration/coworker-credit-cases.json), then reran v2's 49 preserved acceptance cases through the new probe. No project files were changed and no provider, training, service or cloud allocation was invoked. These are synthetic extraction findings, not rescoring of historical policy outputs.

## Observed result

| Source and fixture | Cases | Scored known labels | Unknown labels | Scorer errors | False positives | False negatives |
|---|---:|---:|---:|---:|---:|---:|
| Legacy extraction; new semantic fixture | 17 | 17 | 1 | 1 | 9 | 2 |
| Current v2 extraction; new semantic fixture | 17 | 18 | 1 | 0 | 1 | 0 |
| Current v2 extraction; existing regression fixtures | 49 | 60 | 0 | 0 | 0 | 0 |

The current scorer credits the supplied ratio in: “The draft states that interest coverage is 1.40x. That statement is false.” The fixture's prewritten expected label is false because the writer explicitly rejects the assertion. This is a concrete false positive under the stated rubric. It shows why regression success does not establish semantic validity; its frequency in real policy outputs remains unknown.

The legacy error is on the negative canonical money value `-$17.25M`. Its renderer attempts integer conversion on a substring containing `-$`, which this version does not support. This is an input-domain limitation exposed by the fixture, not evidence that a historical Run-1 episode crashed. The initial probe stopped the batch on this exception. That failed receipt remains intact; the revised probe preserves errors per fact and allows neighboring results to remain assessable. The original fixture labels were not changed.

The unsupported-conclusion control deliberately earns numeric credit while leaving its risk conclusion unvalidated. Extraction cannot establish substantive task success even when it agrees with all expected numeric labels.

## Exact evidence

The final Python probe SHA256 is `041d1ee86db1f9375be473dd657cdd4a43572c9c5239d7feee88550cfc6cb563`. It executed with the configured `/Library/Frameworks/Python.framework/Versions/3.11/bin/python3.11`; a separate version check reports CPython 3.11.9. This is an observed interpreter version, not an immutable deployment attestation.

Pinned source hashes:

- Legacy: `ce0d32352e386ee0cf4c5d1ad2da34fd70e17690851eda15fe495740cdc0785b`, archived evaluator blob `1c6ed01e7b2650f42f9a7259206a555cac188962`.
- V2: `4d3e2e36737b822f07386e95f047d8e261946ed732502e2e24ff6d9344381101`, `experiments/coworkerl-v2/src/probing/extraction.py`.
- New fixture raw bytes: `58b0a3c64f048fbfe2d1db6e66217ab309b605c599ec8e1b6ee0af2cdcfad68a`; independently prepared before outputs, with the limitations stated in its rubric.
- Existing `scorer-cases.json`: `079006facb87e285908dc8e015d869adf88d70e1c6d4913a0cbd395796d6c3c4` (5,180 bytes); supplemental corpus: `334125fd8edf2ca0b9d5f3f23d1e5a1d2059ae3ea25656c4a86a750510b8398e` (2,967 bytes). The adaptation preserves each original expected credit set and selected tested-fact set, cross-checked against saved result rows. It does not invent new labels for those 49 cases.

Private receipts are under ignored `.harness/`. Each final execution was reloaded in a fresh Node process; request normalization, result binding, assessment derivation and receipt digests were rechecked offline.

| Directory | Request digest | Execution digest | Assessment digest |
|---|---|---|---|
| `credit-legacy-qualification-final` | `5ba5f745709113593717a33fb500cff333aab5aab8b0238f867795ae9b9c40b0` | `a3e76b81e965276c81cf0f6cfd440ddd9a162283d03744cc852aa06e1b1ffecd` | `7f040d7886468ac67eade370a72420662cd22c93589429e952bcf0d9afb69d05` |
| `credit-v2-qualification-final` | `65e1c16d3f2daf2982f62b440ebca4fa8de66992a4e89cbfaac3966e73a9f95c` | `b7afd7efe26c09d4c95e3fdf135473ef623dcddd496a16df283ed3aa455984c4` | `3ce57d28dabf133e5fdccfce088808dae3610a7b219d167e524cbca2a511305f` |
| `credit-existing-v2-qualification` | `d53d37e0e5d4fce58309521bc00e7f08e1b1aa81770de21da36ae2707f246186` | `b362cb27ab08845376e9c8386aa79debd3fc610edd33da1e66e8a9d2f50f7f9b` | `221739b7982f98cedf2bf7fe645a8549eeda7275cebd316422292008c49c1ab3` |

The earlier `credit-legacy-qualification` and `credit-v2-qualification` directories preserve the initial worker version's failure/success. They are not silently overwritten by the final probe's results. The three final requests are explicit local qualifications, not a queued autonomous campaign or a revision of the historical evidence ledger.

## Review and tests

Independent review found and corrected three substantive boundaries: results must bind the exact scored text/fact input rather than only IDs; Python and TypeScript must agree on supported control characters; and cumulative JSON size must be bounded during traversal. The later native exception motivated per-fact error retention. Ten independent TypeScript cases test the corrected joins, error pairs, denominators, label separation, immutable snapshots and failure paths; two artifact/CLI cases verify incomplete receipts and overwrite refusal.

Typecheck and the full local suite pass: 540 total TypeScript tests, 536 passing and four deliberate native skips. The focused calibration command passes all 12 TypeScript tests and 16 Python tests, with two explicitly opt-in native source tests skipped by default. Those two tests were separately executed against the actual pinned sources and passed; they are narrow smoke tests, separate from the larger actual fixture runs above. Native source files are not vendored into this repository. Diff checks pass.

Source `c6c3acfc244d55d6a927e69cba97eecf1efdcf5e` also passes [Linux CI41419284650](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41419284650). Node 24 and 25 jobs (`125190667882`, `125190667846`) each report 536 passes, zero failures and four native skips, plus 15 investigation Python passes and 16 probe Python passes with two explicit source-dependent skips on CPython 3.11.17. The separate conventional RL (`125190667496`), supervisor (`125190667926`) and publisher-PDF (`125190667802`) jobs all completed successfully. CI does not possess the private native extraction sources; their actual qualification remains the local evidence above.

Scientific evaluation remains unassessed. Next work is to connect attributable disclosure/read evidence to semantic use, preserve the current counterexample as evidence requiring an evaluator decision, and bind these observations into the research planning workflow. A source fix requires its own reviewed version and new qualification; this harness change did not modify CoworkeRL.
