# Replay evidence and planning qualification

The actual native counterexamples now have verified ledger observations, separately bound posthoc annotations and complete planning packets. Both packets reload after the copied bundle root is removed, with identical bytes and recommendations. The original historical evidence remains unchanged.

Qualification date: 2026-11-02. Evidence is retained under ignored `.harness/replay-evidence-qualification-v1`; its `qualification.json` SHA256 is `0de3f4f97cddea25461d465eac8305af2f143dd9192b539b845863c253ce8fa7`. The inputs are the final denied-quotation and mixed-witness bundles from [native adapter qualification](observed-replay-adapter-qualification.md). This step invokes no native replay, provider, service or training process.

## Actual outcomes

Sixteen fresh Node CLI calls exercised import, annotation archival, assessment, packet export, cached import after deleting only copied bundles, offline reassessment/export and refusal of existing packet outputs. Two replay observations and two annotation observations were added to project `coworker` in `.harness/coworker.sqlite`. Its observation count changed from 18 to 22; every previous observation ID/digest, run and action remained unchanged. Controller configuration, research queue bytes and original replay bundles were also rechecked unchanged.

| Case | Required facts | Known/unknown annotations | Native observation | Recommendation |
|---|---|---|---|---|
| Denied quotation |2|1/1|One numeric credit with authorized observation, against a negative annotation|`review-evaluator-discrepancy`|
| Read policy echo with unread holder reply |2|1/1|One numeric credit without authorized observation, agreeing with a positive assertion annotation|`review-acquisition-credit-boundary`|

Each case retains all ten world facts and two required targets. One fact is comparable to a known annotation; the other remains explicitly unknown. Neither has a native scorer error. The first exposes a discrepancy under the declared assertion criterion, while the second shows why correctly asserting a number is different from reading it through an authorized source. Whole-task success and scientific evaluation stay unassessed.

The annotations record `kind:model`, `declaredTiming:after_native_result` and `declaredResultExposure:seen`. Their method applies the earlier synthetic assertion criterion to the exact saved memo/fact definitions. This is not blinded or human adjudication. The assessor and packets preserve authorship, timing, blindness and semantic-truth verification as `not_established`.

## Retained identities

| Record | Denied quotation | Mixed witness |
|---|---|---|
| Replay event suffix after `coworker-replay-evidence:` |`40f525f5ab0d7071c2cda805b72f6363ff7860eec3bcc4869134c82f3888e22d`|`b8b1689bd9ccc5fb1bf557c32c0e1514012f7c1c4908aa3d9bd6624f46a119e0`|
| Replay observation digest |`47efd5a8cc708751253ffe3ceba497888ba934af46c4a33343c738b95a195dd2`|`5d2bbc563ee5ece44745bbdd459e8f20d4195acc3d5d6fcf9ea2fd43fa3ba8d3`|
| Annotation event suffix after `coworker-replay-annotations:` |`2810534aff058831d4d54cede96e77c947db1fc42d9e453405185c2730c9e5f2`|`fd710714279d6b3b523ecfa1a64dd8b3193d29a5c9df7d8ea34485b02eb3838a`|
| Annotation observation digest |`6767a4a89fad926f4f744f4eb667d4b3c437557f844d0d8331662ddbcfb1163b`|`2de64f7b44843483a5ca27ebc67c882fe1bd3bba59b561a0168cccf59f619771`|
| Assessment digest |`93d201eb0b3f231f76d1cc10cbdfd23c7860314fb30c56713c0752d36cd1c79b`|`8f6fffe335a5dd20469f0123b28a0097dfad7479a0330b52db80f62c8c67e672`|
| Packet digest |`650970e91bf099f15a058a3d2a6c8b9fefbb3d9b6b713abd5b1fd8e678446c3b`|`ba1e3d10ba7480275c969ef04258706abfcf673ea243700f6e27f85f4398f916`|

The packets contain 45 and 44 evidence items respectively. Exact source-content items retain the memo, task/brief, world definitions, observed context, read pages and native observations alongside their immutable references. They are review inputs, not council decisions; no reviewer invocation occurred.

## Tests and limits

The initial full local suite passed 597 tests with four explicit native-suite skips (601 total). Twenty-four independent import tests cover SQLite persistence, exact identities, full private content and redacted summaries, root/path/origin conflicts, immutable retries after root deletion, concurrent imports, failed writes, bad links and rehashed false projections. Thirteen independent annotation/planning tests cover exact label binding, unknown/error accounting, declaration-only provenance, complete source content including Unicode reconstruction, offline persistence and preserved historical boundaries. A subsequent review found that text decoding silently removed a report's leading UTF-8 byte-order mark; preserving that character now rejects altered bytes. Its new regression reproduced the bug before the fix, then passed for both loading and recovery without modifying the files. Typecheck and whitespace checks pass.

Initial import assumes operator-owned, nonmutable directory ancestors. Link and before/after identity checks do not establish resistance to a malicious concurrent ancestor swap. Hashes establish retained-content consistency, not signed custody or truthful operator/annotator declarations. See [the protocol](../replay-evidence-planning.md) and [independent review](../reviews/2026-11-02-replay-evidence.md).

After the byte-order-mark correction, the full local suite passed **598 tests**, with four explicit native-suite skips (**602 total**), and typecheck passed. Both retained original native bundles also loaded under the corrected reader with their recorded execution digests unchanged. Linux qualification for this source is recorded separately when available.

This connects local observations to prospective planning. Automatic evidence acquisition, review dispatch and execution still require their own configured authority and handlers. The existing historical scientific requests remain unresolved; matched controls, protected evaluation, independent semantic validity and research replication are not established by these two cases.
