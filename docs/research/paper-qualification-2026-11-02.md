# Paper qualification: replication and evaluation integrity for CoworkeRL

**Recommendation: implement checks for evaluation identity and the unit of replication before adding an uncertainty estimator.** CoworkeRL's historical two training pairs support a descriptive comparison. Recounting their evaluation episodes as independent training runs would overstate the evidence. The tests below are proposals for the harness, not newly implemented checks or new experiment results.

## Primary source and read scope

Rishabh Agarwal, Max Schwarzer, Pablo Samuel Castro, Aaron Courville and Marc G. Bellemare, **Deep Reinforcement Learning at the Edge of the Statistical Precipice**. The [official proceedings record](https://proceedings.neurips.cc/paper_files/paper/2021/hash/f514cec81cb148559cf475e7426eed5e-Abstract.html) confirms publication in *Advances in Neural Information Processing Systems 34*, NeurIPS 2021. This is an accepted conference paper, not a newly discovered 2026 result.

- **Reviewed version:** the publisher's [17-page paper PDF](https://proceedings.neurips.cc/paper_files/paper/2021/file/f514cec81cb148559cf475e7426eed5e-Paper.pdf), substantive main text §§1–6, pp. 1–10; and selected supplementary material, §A.2/Figure A.13 and Figures A.18–A.19. The [supplement](https://proceedings.neurips.cc/paper_files/paper/2021/file/f514cec81cb148559cf475e7426eed5e-Supplemental.pdf) has 11 PDF pages numbered 18–28. Supplement page references below use printed numbering. References and released code/data were not independently audited or reproduced.
- **Retrieved:** 2026-11-02 UTC, corresponding to 2026-11-01 in America/Los_Angeles. Both complete PDFs were retrieved directly from `proceedings.neurips.cc`; review used their extracted full text and figure captions, not search snippets.
- **Artifact identity:** paper, 10,255,284 bytes, SHA-256 `7553e280d4a1560860bc5f6be2d70539fc5b510e0e3bb2d556824e51e9a80252`; supplement, 13,473,326 bytes, SHA-256 `62516c1435535671722c645868e2505d61d541763eff44dd3f2fdbb5f25961b5`. These identify the retrieved publisher artifacts; no correspondence to an arXiv revision is asserted.

This manual review does not implement publisher ingestion or establish coverage of recent literature. No arXiv endpoint was contacted, and its existing service hold was neither released nor bypassed.

## What the authors establish

| Author finding or method | Exact location in the paper |
|---|---|
| The statistical setup distinguishes independent training runs from scalar scores estimated through evaluation. | §2, pp. 2–3; §3, p. 4 |
| The Atari study uses 100 runs per algorithm/game and 100 evaluation episodes per run; subsampling exposes variability in reported medians. | §3 and Figure 2, p. 4 |
| Changing from final performance to selection by maximum evaluation score can reverse comparisons. | §3, p. 5; Figure 5, p. 6 |
| Stratified bootstrap resamples runs within tasks. Its DER coverage experiment shows undercoverage with three runs; ten performs better in that tested setting. | §4.1 and Figure 6, p. 6 |
| IQM averages the middle half of pooled run scores; profiles expose distributional differences. | §§4.2–4.3, pp. 6–8; Figure 7 |

These are benchmark-specific author results, not a universal minimum-run rule or a guarantee for LLM evaluation. The supplement reports weak same-seed reproducibility for DER (Figure A.13, p. 18), and per-game bootstrap undercoverage even with 30 runs on many games (Figure A.18, p. 21). Figure A.19 explicitly qualifies its finite-run approximation to true coverage. None validates CoworkeRL's scorer.

## The local case this source informs

Local evidence was inspected at CoworkeRL commit `84b219f64f1152f8b02babea388bfbbfff41e75a`. Its [README, lines 15–24](/Users/ronoktanvir/CoworkeRL/README.md:15) reports the **earlier Phase-2 campaign**: two aligned/control training pairs, 30 steps, 384 episodes and 768 required-fact opportunities per evaluation cell. It records credited-fact counts of 33 versus 17 for seed 11 and 35 versus 24 for seed 12, and explicitly limits these to descriptive findings. Independently initialized adapters mean matching seed labels did not imply matching initial weights.

The [historical contract, lines 55–76](/Users/ronoktanvir/CoworkeRL/experiments/probing/CONTRACT-MATCHED-CONTROL.md:55) freezes step-29 adapters, the held-out set and per-seed comparisons, with no pooling or inferential statistics. The [set-composition audit, lines 3–9](/Users/ronoktanvir/CoworkeRL/research/pre2post-work/verifications/V2-heldout-set-composition.md:3) describes six held-out configurations × 64 world seeds. These are repository-reported facts; this review did not re-audit the underlying sealed trajectories.

**Scope boundary:** the [current-development notice](/Users/ronoktanvir/CoworkeRL/README.md:5) says CoworkeRL v2 uses a different environment and scorer and remains under qualification. The historical campaign's sample counts and conclusions must not be assigned to current v2 or inferred from the harness's single `historical-main-s11` training-report capture.

## Proposed tests and their decision consequences

The following are our applications of the paper's evaluation questions to local evidence, not experiments performed by its authors.

1. **Preserve replication identity.** Require each evaluation record to bind campaign, arm, training attempt, checkpoint hash, configuration, world seed, completion replicate and evaluator version. A fixture containing two training pairs and 768 fact opportunities per cell must report two comparison pairs, never 768 training replications. Repeated identifiers must be rejected or explicitly deduplicated. Additional evaluations can reduce uncertainty conditional on a fixed policy; they cannot manufacture new trained policies. This tests the distinction in §2.

2. **Reject incompatible comparisons.** Freeze checkpoint selection, training updates, evaluation worlds, decoding, token/tool budgets, helper policy and scorer version. Inject a mismatch in each field and require an explicit incompatibility result. In particular, compare a fixed final checkpoint against the best of several evaluations: the harness must flag the changed selection procedure before interpreting the score difference. This operationalizes §3/Figure 5 without assuming that every protocol difference has the same effect.

3. **Keep the historical readout exact.** Recompute from integer counts: `(33−17)/768×100 = 2.0833…` and `(35−24)/768×100 = 1.4323…` percentage points. Assert that displayed values round to 2.08 and 1.43 and retain both numerators and denominators. Preserve per-pair results and the descriptive status; a new aggregation option must not silently override the historical contract. These are arithmetic checks on reported counts, not a new statistical analysis.

4. **Qualify the resampling unit before using confidence intervals.** For a future campaign, first specify whether the target is new training runs on a fixed evaluation set, new evaluation worlds, or new task configurations. A CoworkeRL checkpoint is evaluated across several configurations, so independently resampling each configuration can erase dependence induced by the shared policy. Test a candidate resampler on synthetic correlated outcomes: preserve the entire training-pair outcome vector, and add paired world-level resampling only when the target requires it. Simulate coverage under sparse successes, heterogeneous tasks and shared run effects before adopting a method. This is a proposed adaptation of §4.1, not a validated CoworkeRL estimator or permission to infer from two pairs.

5. **Expose concentration and selection.** Report each configuration's denominator, credited facts and arm difference alongside the aggregate. A fixture whose apparent improvement comes from one configuration must reveal that concentration. Keep fact-weighted and equally weighted configuration summaries distinct when denominators differ. Do not replace the registered credited-fact rate with IQM merely because §4.3 recommends it for another score distribution. Retain failed attempts and restart lineage: the [Phase-2 incident record, lines 87–98](/Users/ronoktanvir/CoworkeRL/experiments/probing/REPORT-PHASE2-MATCHED-CONTROL.md:87) reports a failed main-s12 attempt followed by a fresh start. A failure must not disappear into the successful run's identity.

6. **Separate measurement validity from sampling uncertainty.** Require independent scorer calibration before stronger capability claims. Proposed counterexamples include an unsupported fact that receives credit, a correctly acquired fact used incorrectly, and irrelevant fact repetition. Compare scorer labels against adjudicated reference labels and preserve disagreement categories. An interval around biased labels can still describe the wrong outcome. This requirement follows from CoworkeRL's measurement problem; the reviewed paper does not supply or validate these tests.

## Decision and remaining evidence

Prioritize the deterministic identity, comparability and arithmetic fixtures. Plan prospective replication and estimator qualification only after freezing the target quantity and independently qualifying the evaluator. Current evidence does not justify promoting the historical result into a general training-effect claim. That decision could change with additional independent training replications, comparable evaluation artifacts and demonstrated scorer validity. A council should record those missing observations, rather than treat this citation or reviewer agreement as conference-level validation.

Only this Markdown review was created. No training, paid model calls, new benchmark evaluation or runtime paper ingestion occurred.
