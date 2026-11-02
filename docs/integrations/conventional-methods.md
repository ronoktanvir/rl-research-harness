# Methods contract for the first conventional RL adapter

The first experiment should establish a reproducible training/evaluation path on one fixed FrozenLake map, with an honest comparison against a random policy. It cannot establish algorithm novelty, generalization across environments or conference-level research validity. This document records the agreed design and acceptance criteria; implementation and runtime qualification require separate evidence.

## Source basis and scope

Official Gymnasium documentation was inspected on 2026-11-02 UTC, without contacting arXiv. The current documentation identifies version 1.4.0. The first runner requires Python 3.11.x, Gymnasium 1.4.0 and NumPy 2.3.5 before constructing an environment, and reports observed versions. Version strings do not attest package bytes or the complete execution environment.

- [Handling Time Limits](https://gymnasium.farama.org/tutorials/gymnasium_basics/handling_time_limits/), “Termination,” “Truncation” and “Importance in learning code”: task termination suppresses bootstrapping; an external truncation does not. A genuine finite-horizon task needs remaining time represented in its state if the policy is to remain Markov.
- [Env API](https://gymnasium.farama.org/api/env/), `step`, `reset` and action-space seeding: an integer reset seed reinitializes the environment RNG; environment and action sampling have separate RNG interfaces. Ending an episode requires a reset before further stepping.
- [FrozenLake](https://gymnasium.farama.org/environments/toy_text/frozen_lake/), “Rewards,” “Episode End” and “Arguments”: the standard 4×4 task has goal reward one and otherwise zero; goal and hole states terminate. Slipperiness, map, reward options and the wrapper horizon affect the task.
- [Official TimeLimit source](https://gymnasium.farama.org/_modules/gymnasium/wrappers/common/), `TimeLimit.step`: reaching the wrapper limit sets truncation without clearing the underlying termination flag. Both can therefore be true on one transition.
- Agarwal et al., [*Deep Reinforcement Learning at the Edge of the Statistical Precipice*](https://proceedings.neurips.cc/paper_files/paper/2021/file/f514cec81cb148559cf475e7426eed5e-Paper.pdf), accepted NeurIPS 2021, §2 pp. 2–3 and §3 pp. 4–5: independently trained runs supply scores estimated through evaluation; changing final-policy evaluation to maximum-score selection can alter comparisons. These findings motivate replication and selection controls, not a universal minimum seed count. The earlier [paper qualification](../research/paper-qualification-2026-11-02.md) records the full-paper read scope and limitations.

The requirements below are our application of these sources to this adapter, not newly reported results from the cited authors.

## Learning target and episode accounting

Use fixed-map tabular Q-learning with declared learning rate, discount, exploration schedule, zero initialization and action tie-breaking. Treat the rollout time limit as an external collection boundary for the discounted task. The update target is `reward + discount * max(Q[next_state])` unless `terminated` is true, in which case it is just `reward`. A task with a true finite-horizon objective would require a different state/target specification.

Preserve `terminated`, `truncated` and collector cutoff separately. End collection on any of them; do not infer that they are mutually exclusive. A goal reached exactly at the wrapper limit remains a success, with both environment flags retained and no bootstrap. A collector cutoff records a deliberate collection boundary rather than inventing an environment signal. Updates must use the final transition observation, never an observation returned by the subsequent reset.

Evaluation measures goal attainment within the declared evaluation collection cap. That outcome is not mathematically identical to the discounted training objective. Compute success from the terminal goal cell and cross-check the standard reward, retaining endpoint state, return, length and ending flags. This separates success calculation from reward interpretation; it does not independently validate the environment implementation itself.

## Replication, evaluation and comparability

Each replicate trains a new Q-table using its own policy RNG and explicit training reset-seed schedule. Exploration draws must not reuse the environment RNG or an identically seeded action stream. Evaluation uses disjoint reset seeds, a copied/frozen final table and no learning updates or checkpoint selection. Record the final table and its digest, the greedy tie rule and the random baseline's separate action seeds.

Execute the shared random baseline once on the same evaluation reset seeds and collection rules. Reference that one episode vector from every trained-policy comparison. Repeating it in a display does not create more baseline observations. Shared seeds provide matched evaluation conditions; different actions can still produce different trajectories.

For each training replicate report learned successes/evaluated episodes, baseline successes/evaluated episodes and their success-rate difference. Preserve every replicate, including zero-success policies. An optional mean of replicate differences is descriptive: its unit is the trained policy, not an episode. Report the number of training replicates and the number of unique baseline episodes separately. Do not turn repeated evaluation or shared baseline copies into independent training replications.

Comparability requires the same map, transition/reward settings, dependency versions, evaluation seed vector, policy-selection rule, evaluation caps, action tie rule and success definition. Training configuration and transition budgets must also remain explicit. A changed field requires a new configuration identity and a stated comparison limitation. Per-replica training episodes, transition counts and ending-reason counts prevent early endings from disappearing behind a nominal budget.

## Acceptance evidence and missing controls

Required deterministic fixtures cover terminal versus truncated update targets, simultaneous flags, collector cutoff, final-versus-reset observation, one-episode exploration scheduling, unchanged Q-table during evaluation, reward/goal disagreement, duplicate or overlapping seed identities, and preservation of a valid all-zero result. Physical transition accounting must include every actual baseline execution even though statistical replication counts do not.

The [runner's nine tests](../../test/conventional/runner_test.py) and [ten independent methods tests](../../test/conventional/runner_independent_test.py) passed using scripted environments and standard-library code only. They check the update and reporting contracts, including refusal of mismatched runtime versions; they do not qualify Gymnasium execution or report a learned FrozenLake result. No dependency installation, provider call or real-environment workload was performed by this methods review.

An [independent output-integrity regression](../../test/conventional/summary-independent.test.ts) also passes without executing Python: validated data is detached and frozen, and summaries reconstruct metrics from digest-checked stdout rather than a mutable result projection. Changed output bytes, changed request content or an interrupted completion cannot silently become a completed scientific summary. The digest binds observed output; it does not attest that an arbitrary supplied observation came from the intended environment.

The first report should leave uncertainty estimation, tuning independence and out-of-map generalization unqualified. A random policy is a basic control, not the strongest available comparison. Future stronger claims need a prespecified target population, appropriate independent replications, a stronger or exact planning baseline, additional maps and controls on tuning/evaluation reuse. Shared evaluation conditions and one shared baseline must remain visible when designing any resampling procedure. No confidence interval or “solved” label should be inferred merely because the implementation completed its bounded work.
