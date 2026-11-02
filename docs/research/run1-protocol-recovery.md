# Run-1 protocol recovery and its implications for the harness

Status: read-only source and artifact investigation, 2026-11-02. This follows the [qualified evidence-planning recommendation](evidence-planning-qualification.md). No project code was imported or executed, no provider was called, and no experiment was launched. This report is manually reviewed research evidence; it has not been ingested as a new ledger observation or used to alter the immutable planning packet.

## Decision

The remaining semantic audit can now target the actual historical measurement path. Run-1's held-out diagnostic separates deterministic fact credit, event-based acquisition accounting and a model judge's memo-quality score. The archived driver also selects a scripted helper path through its defaults. A nearby module's model name or a general judge default would therefore misdescribe this particular experiment.

Preserve this as historical evidence. The active `coworkerl-v2` environment has different helper and scorer contracts; the Run-1 measurements cannot qualify its current behavior or support a claim of training benefit there.

## Evidence and the limits of each claim

| Question | Recovered evidence | What it establishes |
|---|---|---|
| What code defines the historical evaluation? | The saved revision-to-tree mapping and content-verified source blobs for evaluator revision `cb1bfd8b92abd4c23941300d653f61caf93ae3fb` | The inspected archived call path and predicates. This is not independent attestation that a historical process executed every archived byte. |
| How did helpers respond? | The held-out driver constructs its rollout engine without supplying a helper backend; the archived default reaches the scripted backend | Scripted-helper routing under the inspected source. Missing helper execution fields do not become evidence of an LLM helper merely because that implementation also exists. |
| What does a credited fact mean? | Deterministic grader predicates produce credit before the separate judge; the diagnostic's funnel combines credit with acquisition events | The producer defines separate deterministic-credit and event-attributed acquisition predicates. This inspection recovers their definitions and saved outputs, not an independent event-by-event acquisition audit. |
| Which judge composition applies? | The diagnostic invokes the training judging wrapper, which selects `banded`, overriding the generic judge default | Call-path-specific composition; a module default is insufficient. Saved judge declarations can corroborate this without proving judge correctness. |
| Was the final output judged? | Rollout traces retain `judge.consulted=false`, while the separate post-judge result files identify `gpt-5.5-2026-04-23`, `judge-v4` and `banded` for 21 trained and 17 baseline episodes | The files describe different pipeline stages. The pre-judge trace field cannot establish that the final result was unjudged; null judge fingerprints still leave provider identity incompletely attested. |
| Was evaluation protected? | Written diagnostic specification freezes selected checkpoints and evaluation worlds after training | A documented posthoc comparison. It does not establish author-blind selection, access controls or a prospective confirmatory test. |
| Does the current scorer already have tests? | Saved v2 repair reports declare 40 primary and nine supplemental synthetic extraction checks; the recorded extraction and reward hashes match the inspected current files | Existing regression evidence worth reusing. These saved results were not rerun here and do not independently calibrate real-policy semantics or helper behavior. |

The detailed source audit, saved declarations and protocol review are separate so that a source-level implication cannot silently become an observed execution fact:

- [Archived source and exact call paths](run1-protocol-source.md).
- [Saved protocol declarations and per-cell evidence](run1-protocol-declarations.md).
- [Selection, metric validity and proposed counterexamples](run1-protocol-validity.md).

## Consequence for the existing historical result

The earlier 23-versus-17 credited-fact counts remain a faithful recount of producer labels for one trained policy and its bare-base comparator. Protocol recovery explains those labels; it does not upgrade them to independently validated task success, a causal training effect or an evaluation of the current LLM-only helper environment. The lack of a matched training control and independent trained replicas remains consequential.

The written specification's statement that the credit stage is judged conflicts with the inspected implementation's deterministic credit path. Treat the implementation and saved output fields as the evidence for what the metric encodes, and preserve the specification discrepancy explicitly. A corrected description is necessary before interpreting any apparent improvement.

## Next useful work

Build version-specific scorer acceptance evidence using the exact recovered predicates. First demonstrate legacy conformance without treating the old scorer's behavior as the desired semantics. Then test the independent semantic contract: correct versus incorrect metric/value binding, asserted versus hypothetical or negated use, and lawful acquisition versus absent or misattributed disclosure. Each case needs an explicit expected label and a reason independent of the implementation being tested.

Reuse v2's 49 existing synthetic cases by content hash instead of inventing duplicates. Add the missing cross-product between semantic use and disclosure provenance, including wrong channel, read-before-post, wrong tool-call attribution and undisclosed correct guesses where applicable to each version's contract. Separate the fact-credit verdict, acquisition verdict, judge quality and overall task-success verdict. Abstentions, ambiguous cases and judge/provider failures must retain their own outcomes.

The saved audit's helper implementation hash differs from the current `llm_helpers.py` hash. Thus matching extraction/reward bytes cannot transfer old helper qualification to today's helper implementation. Current helper behavior requires its own evidence.

These are proposed checks, not results. A native scorer run requires a reviewed, bounded runner for the chosen source version; merely translating the predicate into a new harness implementation would test the translation. Once this engineering layer is qualified, independent labels on held-out, real-policy outputs are still needed to estimate semantic false positives and false negatives. Calibration examples used during repair are development evidence and cannot double as an untouched final test.

## General harness requirement

An experiment's effective protocol must record the selected entry point, resolved options, helper implementation, scorer and judge stages, budgets, selection rule and evaluation access separately. Defaults in an unused module are not effective configuration. Evidence needs an applicability boundary covering environment version, code identity, model identity and evaluation regime; identity matches for one component do not qualify the rest of the pipeline.

Artifacts also need explicit pipeline stages and joins. Here, a trace's default judge metadata precedes the separate judging pass. Reading that single field without joining the post-judge result would yield the wrong conclusion. An autonomous investigator must resolve both the call path and the artifact lineage before declaring a contradiction or filling a missing protocol value.

This investigation supplies a concrete example of the research behavior the harness should automate: follow a reported result into its actual call path, identify a misleading protocol description, narrow the conclusion and propose a discriminating test. That workflow is demonstrated here through manual inspection and agent review. Autonomous protocol recovery and semantic calibration remain unimplemented.

## Review and validation

Separate agents inspected archived source, saved declarations and research validity. Source review corrected the synthesis to state that acquisition definitions were recovered, without implying an independent event replay. It also checked the proposed legacy counterexample predictions against the exact archived predicates; those predictions remain unexecuted. The methods reviewer found no remaining material contradiction in the synthesis. Local source links and line bounds, both private inspection-manifest hashes, and whitespace checks passed. This documentation-only change does not add a new runtime-test or native-scorer qualification.
