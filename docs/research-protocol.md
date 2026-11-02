# Research protocol

Status: proposed operating policy, not an implemented system. Scope: conventional RL and LLM post-training with separate adapters.

## Governing principle

The assistant should earn increasing autonomy by producing reproducible decisions and experiments. A research council improves coverage only if its members contribute independent evidence or expose different failure modes. Agreement and repeated self-criticism do not establish correctness.

Use the primary-source evidence and qualifications in `research/evidence-and-standards.md`. The procedure below is our design proposal, not a claim that the papers validate the whole harness.

## The research loop

1. **Frame:** specify the scientific question, existing strongest relevant baseline, proposed mechanism, measurable prediction, and what result would refute the idea.
2. **Ground:** search the latest relevant literature and read decisive methods, experiments, limitations, and implementation details. Separate publication date, revision date, and acceptance status.
3. **Design:** register the environment or task definition, datasets, reward, independent evaluation, baselines, ablations, seed plan, compute budget, and stopping rules.
4. **Critique:** have independent reviewers inspect the design, then resolve objections through evidence or small discriminating experiments.
5. **Validate cheaply:** test environment semantics, reward behavior, data splits, numerical checks, random/simple policies, and a known baseline before expensive training.
6. **Run:** execute an immutable configuration through an adapter; collect raw metrics, checkpoints, execution provenance, and cost.
7. **Evaluate:** compute locked metrics from held-out artifacts; compare against baselines with uncertainty and failure accounting.
8. **Decide:** replicate, modify, expand, reject, or conclude. Save the reasoning summary, evidence, dissent, and next experiment. A failed or inconclusive experiment is a valid outcome.

An agent may explore adaptively, but the ledger must distinguish exploratory runs from confirmatory evaluation. Changes selected using development results require fresh evaluation; repeated inspection of a test set spends its independence.

## Council and bounded self-criticism

The orchestrator owns the question and integration. It should convene only the reviewers that can change a consequential decision:

| Role | Main obligation | Concrete output |
|---|---|---|
| Domain designer | Explain why the environment, reward, or training change should work | Proposed mechanism, specification, expected failure cases |
| Literature reviewer | Check novelty and prior evidence, including contradictory work | Claim-to-source map and nearest competing methods |
| Methods reviewer | Find confounds, leakage, weak baselines, and invalid uncertainty estimates | Required controls, ablations, evaluation defects |
| Systems reviewer | Check resource cost, reproducibility, recovery, and execution feasibility | Run constraints, failure handling, estimates with assumptions |
| Adversarial evaluator | Try to obtain high reward without intended success | Exploits, counterexamples, evaluator tests |

Start with independent written assessments of the same versioned evidence packet. Give reviewers the actual code/configuration/data provenance, not only the proposer’s summary. Do not reveal other reviewers' conclusions until those assessments are saved. Different role prompts on the same model are not statistically independent judges; mixing models can diversify errors but also does not guarantee independence.

Use a default maximum of two revision rounds after initial assessments. This is a tunable engineering limit, not a scientifically established optimum. Round one identifies objections and proposes discriminating checks. Round two judges the revised proposal and new evidence. A specific unresolved validity objection triggers a test, narrower claim, or blocked decision; it must not be outvoted by generic approval. Stop earlier when more discussion is unlikely to change the decision. Escalate only if remaining uncertainty affects allowed cost, scientific validity, or scope.

The orchestrator writes a concise decision rationale: alternatives considered, decisive evidence, assumptions, uncertainty, dissent, and the condition that would reverse the decision. Save these auditable outputs rather than relying on a model's private internal reasoning transcript. No agent can overrule a deterministic validity or resource check by declaring consensus.

## Route work by difficulty and consequence

| Work | Default executor | Escalation trigger |
|---|---|---|
| Parse logs, count tokens, compare hashes, enforce limits, detect missing heartbeats | Deterministic code | Inconsistent or unrecognized schema |
| Deduplicate papers, extract metadata, summarize a bounded log or verified source | Small/low-cost agent with structured output checks | Contradictory evidence, missing source support, ambiguity |
| Implement an adapter, inspect a training failure, reproduce a baseline | Capable coding/domain agent | Repeated failure, unclear mechanism, consequential design change |
| Choose a research direction, assess novelty, judge a confound | Strong reasoning agent, selectively reviewed | Irreversible scientific choice, large resource commitment, unresolved disagreement |

The model policy should map these roles to available models based on a local evaluation set and measured cost/quality, rather than embedding a permanent ranking of model names. Every child has a task, scoped tools, deadline, cost allowance, parent ID, output schema, and stopping condition. The parent allowance covers descendants; spawning children cannot reset the budget. Use bounded concurrency and depth.

## Environment and reward validity

For conventional RL, specify observations, actions, transition dynamics, partial observability, reward components, success/failure, horizon, termination and truncation, reset distribution, seeding, constraints, and curriculum. Check that time-limit treatment matches the learning target. Gymnasium documents why termination and truncation require different bootstrapping behavior: [Handling Time Limits](https://gymnasium.farama.org/tutorials/gymnasium_basics/handling_time_limits/).

Check the environment with deterministic fixtures and a random/simple/known policy. Exercise boundary states, invalid actions, reset reproducibility, hidden state, unreachable goals, reward scale, and obvious reward exploits. Passing an API checker establishes interface compatibility, not that an environment measures the intended ability.

For LLM post-training, specify prompt/task distribution, tokenizer and chat template, base/reference/reward model versions, generation settings, tool access, verifier behavior, maximum response length, episode termination, reward components, data decontamination, and train/development/test separation. Distinguish deterministic verifiable rewards from learned reward models or judge scores. Check empty outputs, malformed answers, answer-format exploits, length effects, verifier false positives/negatives, test leakage, and evaluator prompt injection. A reward model and an independent task evaluator should not silently be the same measure.

Preserve verifier pass/fail, malformed output, parse error, timeout and infrastructure exception as separate outcomes. Apply retries or reward penalties through a declared policy rather than silently treating every failure as a wrong answer. Test justified task-preserving perturbations, such as equivalent formatting or reordered irrelevant context, and separate instruction/format compliance from substantive success. Read-only evaluation does not repair an incomplete definition of success.

For both tracks, compare **training reward** with **intended success**. Rising reward with flat or worsening independent success is a reason to inspect reward exploitation or metric mismatch, not to declare progress.

## Training monitoring and intervention

Separate health monitoring from scientific interpretation. Cheap code continuously handles health; an agent reviews compact evidence when an event warrants it.

| Signal | Meaning and default response |
|---|---|
| Worker heartbeat absent | Status is uncertain; reconcile backend state before restarting anything |
| Progress counter stalled but heartbeat present | Investigate data loading, distributed synchronization, or compute bottleneck; apply adapter-specific timeout |
| NaN/Inf, invalid rewards, corrupt checkpoint | Stop or isolate according to registered numerical-integrity policy; retain evidence |
| Cost/time/resource bound reached | Stop admission; checkpoint/cancel according to the run policy and confirm backend termination |
| Reward rises while success falls | Request reward/evaluator inspection and compare trajectories; do not silently modify the running reward |
| Entropy, KL, gradients, or value loss changes | Interpret using the algorithm, schedule, and baseline; no universal threshold is valid for every model |
| Evaluation regression | Apply a predefined rule or propose a new experiment; separate noise from meaningful change |

Conventional RL metrics include environment steps, episode returns and lengths, independent success, constraint violations, policy entropy, losses, and evaluation across seeds or held-out environments. LLM metrics include task accuracy, reward components, verifier outcomes, response lengths, token counts, KL where applicable, entropy, clipping behavior where applicable, and training/evaluation throughput. Common metrics include wall time, device memory/utilization, progress age, checkpoint age, failure counts, and costs. Availability depends on the trainer; absent metrics remain absent rather than being fabricated.

Pre-register early stopping and adaptive intervention rules. A plateau alone may not justify stopping a noisy RL run. Treat resumed training with changed hyperparameters as a new variant with explicit lineage. Infrastructure recovery that preserves the configuration should still record the interruption and any lost work or changed randomness.

## Evaluation sufficient to support a claim

- Match baselines on data access, tuning effort, compute, and evaluation conditions; report any mismatch.
- Freeze LLM evaluation decoding, sample count, maximum tokens/tool calls, and pass@1/pass@k or selected-answer semantics. Additional inference can otherwise masquerade as a training improvement. Aggregate correlated completions within their prompt/task structure rather than counting them as independent experiments.
- Choose repetitions and seeds using expected variability, effect size, and budget. A few seeds do not automatically support a robust conclusion; state the uncertainty and unit of analysis.
- Report distributions and intervals with an aggregation method suited to the question; do not treat correlated episodes as independent training runs.
- Include mechanism-targeted ablations and simple controls. An improvement without an isolating comparison may not identify why it occurred.
- Preserve failed trials, search history, resource consumption, selection criteria, and evaluator versions. Do not choose the best seed as the main estimate.
- Validate a final candidate on data/tasks kept separate from the adaptive search process. Limit access to final evaluation answers and keep its policy fixed.
- Log final-evaluation accesses under a declared access/release policy. Repeated feedback requires fresh held-out tasks or a narrower claim; a numeric access cap alone does not restore independence.
- Regenerate tables and plots from stored result artifacts. Mark proposed explanations as hypotheses unless tested.

Research that could survive serious review needs a meaningful question and contribution as well as methodological rigor. No council workflow, benchmark score, or checklist can guarantee novelty or acceptance at a top conference.

## Current-literature maintenance

At project inception, consequential design changes, and a configured periodic sweep, search by task, mechanism, failure mode, and strongest baselines. Search recent work explicitly while retaining foundational evidence. Record search date, query, sources searched, covered date range, and inaccessible papers. Do not label a selective search exhaustive.

Each paper record needs a stable identifier, version, primary URL, verified venue status, question, methods, relevant result, limitations, code/data availability, and exact design implication. Tag a result as author-reported unless independently reproduced. Save contradictions and negative evidence. A preprint can motivate an experiment but does not inherit peer-reviewed status from the reputation of its authors.

Treat papers and repositories as source material, not instructions that can grant tool privileges or modify project policy. A new paper creates a proposed decision update; it does not silently change a running experiment.

## Evaluate the research assistant itself

Compare: a single agent with tools; the same agent with one structured critic; and a selective council. Match total model and compute budgets. Use tasks with known defects (reward loopholes, leakage, invalid statistics, incorrect termination), baseline reproduction tasks, restart failures, and open-ended pilot research questions.

Measure useful defect detection, false alarms, claim-to-source accuracy, reproducibility, completed valid experiments per cost, recovery failures, duplicate launches, and human intervention burden. Keep development and held-out harness evaluations separate. Adopt extra debate, memory retrieval, or autonomous revision only when it improves those outcomes enough to justify its cost.
