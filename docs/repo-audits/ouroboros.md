# Ouroboros source audit for an autonomous research harness

**Recommendation:** borrow Ouroboros's operational contracts for evidence, recovery, delegated authority, and reviewed changes. Do not transplant its entire application as the research harness. It contains substantial engineering for long-lived agents, but the inspected code does not supply the scientific experiment model, RL training adapters, or evidence standards needed for this project.

## Snapshot and scope

- Repository: [`razzant/ouroboros`](https://github.com/razzant/ouroboros).
- Reviewed commit: [`add0ce3296c722ef99a536c52f8dcddf36494b36`](https://github.com/razzant/ouroboros/tree/add0ce3296c722ef99a536c52f8dcddf36494b36), committed 2026-11-01 12:59:46 UTC. Audit date: 2026-11-01, America/Los_Angeles.
- Package version at that commit: **7.9.0**; Python requirement: **3.10 or later**. [Package manifest](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/pyproject.toml#L5-L15).
- Method: inspected the complete recursive Git tree, fetched selected documentation, and read relevant implementation paths and test bodies through the GitHub connector. No upstream application, installation script, training job, or test suite was executed.
- Scope includes both conventional RL environment/policy training and LLM post-training/agent research with verifiable rewards. They should share orchestration and evidence handling but use separate experiment adapters.

This is a selective architectural audit, not a complete correctness or security audit. Source inspection establishes that mechanisms exist and exposes their intended boundaries; it does not establish that every path works in production. The repository's benchmark claims remain upstream self-reports in this audit.

The snapshot is much larger than an agent-loop library. Its nontruncated tree contains 835 Python files under `ouroboros/`, 83 under `supervisor/`, and 2,916 under `tests/`. Those counts include support files and do not measure quality or test coverage. They do explain why extracting a seemingly small component can pull in substantial application policy. [Snapshot tree](https://api.github.com/repos/razzant/ouroboros/git/trees/add0ce3296c722ef99a536c52f8dcddf36494b36?recursive=1).

## What is worth taking

| Component | Observed mechanism | Recommendation for this harness |
|---|---|---|
| `working_checkpoint.py` | Saves accepted model/tool state before effects; captures results after a batch; retains uncertain interrupted calls. | Adapt the transaction boundaries around experiment launch, intervention, cancellation, and artifact publication. Add durable database intents and backend reconciliation. |
| `knowledge.py` | Markdown notes have content revisions; updates check the expected revision under a shared lock; history captures old/new content and writer provenance before publication. | High priority. Use the pattern for project briefs, hypotheses, decision records, and handoffs. Keep measurement records independently immutable. |
| `usage_accounting.py`, `usage_admission.py` | One physical model-attempt ledger with reserved/dispatched/settled/unresolved states and root/group attribution. | Take the accounting model; replace admission policy if a strict budget is required. Extend it to GPU/storage costs and open commitments. |
| `tools/control_scheduling.py` | Child contracts narrow deadlines and input scope, carry lineage, distinguish read-only from acting children, and enforce depth limits. | Adapt into explicit specialist task contracts and a bounded role/model router. |
| `triad_review.py`, `review_cycles.py` | Structured per-reviewer responses distinguish missing, malformed, interrupted, and actual findings; paid review rounds can be bounded. | Take parser and lifecycle ideas for the research council. Replace code-review criteria with scientific criteria and evidence-linked findings. |
| `schedule_occurrence.py` | A scheduled occurrence has a stable identity, durable admission receipt, and a possible-dispatch marker; ambiguous dispatch is not blindly replayed. | Adapt this state-machine pattern for experiment launching and periodic monitoring. |
| `workspace_executor.py` | Local/Docker execution has process records, backend completion observations, cancellation handling, and retained uncertainty. | Use as an execution-contract reference. Build a separate remote job adapter for GPU workers. |
| `body_candidate.py`, `preflight_qualification.py` | Self-edits are isolated from the serving checkout; adoption requires evidence tied to the exact candidate commit/tree. | Useful later for harness evolution. Keep the first research deployment on an immutable release. |
| `outcomes.py` | Execution health, lifecycle, artifacts, review, and objective assessment are distinct axes. | Strong conceptual fit: a successfully completed run is not necessarily evidence for the hypothesis. |

The strongest reuse opportunity is the **contract**, not an unmodified import. For example, `working_checkpoint.py` depends on Ouroboros task contexts, pause handling, usage state, continuation serialization, and tool custody. Reimplementing its small invariant in the chosen runtime is likely simpler than importing the surrounding application.

## Recovery: preserve uncertainty before repeating actions

`save_before_effects()` blocks the tool batch until its accepted state is saved. The ordinary writer serializes the continuation, includes pending tool-call IDs, and atomically replaces the checkpoint. This is a useful safeguard against losing the relationship between an agent's decision and the action it initiated. [Checkpoint implementation](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/ouroboros/working_checkpoint.py#L133-L199).

The limit matters: the module explicitly provides process-crash protection without `fsync`, so it does not promise survival of a host power failure. Its recovery tests also deliberately restore crashed work into a hold that requires Resume. That policy is appropriate when replaying effects would be uncertain, but copying it unchanged would prevent the user's intended unattended operation after some failures. [Checkpoint durability boundary](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/ouroboros/working_checkpoint.py#L1-L34); [crash recovery test](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/tests/test_working_checkpoint_process_kill.py#L83-L95).

**Adaptation:** persist a launch intent with a stable `run_id` and idempotency key before contacting the training backend. After a crash, query that backend by the same key. Resume observation of a known job; repeat an idempotent request when safe; keep an unresolved launch in an explicit unknown state. Never infer that a lost connection means the training job failed or that it is safe to launch another copy. A small database transaction should own this policy; a prose memory entry should not.

Ouroboros already applies a similar distinction to schedules. It uses a durable occurrence identity and marks dispatch as possible before delivery to a worker. The implementation explicitly avoids an exactly-once promise for external effects. Recurring schedules retain one overdue occurrence instead of issuing a catch-up burst. That is a good default for training monitors and literature refreshes. [Schedule occurrence protocol](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/supervisor/schedule_occurrence.py#L1-L46); [reconciliation implementation](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/supervisor/schedule_occurrence.py#L155-L214).

## Research memory: take revisions and provenance, constrain interpretation

`write_knowledge_note()` checks revisions while holding the shelf lock, rejects stale edits, and preserves before/after content with task, writer, route, and input references. A failure to save history prevents publication; a later publication failure returns the observed state rather than claiming success. This is directly useful when several agents produce competing interpretations. [Revision check](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/ouroboros/knowledge.py#L581-L646); [history and publication](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/ouroboros/knowledge.py#L694-L729).

For this harness, use separate record types:

- **Project brief:** objective, constraints, target claim, budgets, and current scope.
- **Evidence record:** immutable run configuration, source revision, dataset/environment revision, metrics, artifacts, and evaluation protocol.
- **Decision record:** recommendation, evidence references, alternatives, dissent, uncertainty, and the condition that would reverse the decision.
- **Working handoff:** current task, completed actions, unresolved jobs, and next checks. This is replaceable orientation, not scientific evidence.

An agent-authored summary should not overwrite a run's raw evidence or silently promote a conjecture into a result. Ouroboros's revision/history mechanism provides provenance, but provenance alone does not establish that the authored content is correct. Add validation that every empirical claim points to a retained measurement or source passage.

## Council decisions: borrow structured dissent, not consensus as proof

The reviewer parser is worth studying closely. It does not treat a malformed response or a missing answer as a clean result. It separates transport state from answer state, preserves discarded diagnostics from malformed coupling matrices, and records stable reviewer-slot identities. Those distinctions prevent a silent reviewer failure from looking like agreement. [Per-part parsing](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/ouroboros/triad_review.py#L431-L583).

The current review machinery is richer than a three-agent vote, despite the `triad_review` filename. It includes different review surfaces and per-seat contracts. However, inspected review criteria and parsing are principally built around change, coupling, result, and skill assessment. They are not a statistical validity protocol for RL experiments.

For the research council, adapt the structured response to require: claim assessed, cited evidence, objection, severity, proposed discriminating test, and resolution status. Let reviewers first form independent assessments of the same frozen evidence packet. A subsequent rebuttal round should address specific objections. An adjudicator should preserve unresolved disagreement and choose the next informative experiment; a majority vote must not substitute for an ablation, held-out evaluation, or replication.

Round caps also deserve adaptation. Ouroboros counts paid cycles and blocks repeated review of identical rejected material without a new rebuttal. But planning asks are explicitly outside that cycle cap. A research harness needs one encompassing council budget that covers initial assessments, rebuttals, literature retrieval, and adjudication, or a nominally bounded review can still generate unbounded planning work. [Cycle accounting and exclusions](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/ouroboros/review_cycles.py#L1-L53).

## Budgets: its accounting is useful; its cap is not a hard ceiling

`usage_accounting.py` models physical attempts rather than deriving money from chat summaries. Admission and ledger writes share a transaction, while network and pricing calls remain outside it. That is a sound accounting separation to reuse. [Ledger contract](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/ouroboros/usage_accounting.py#L1-L8); [reservation implementation](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/ouroboros/usage_accounting.py#L676-L777).

The observed admission policy compares **known settled spend** with the cap. Reservations and unresolved upper bounds are exposed but do not consume the admission budget. The source explicitly acknowledges that concurrent, in-flight, and late charges can exceed the cap. This is a deliberate policy, not evidence of a hidden bug. It is also unsuitable as the sole control for an unattended research system with costly parallel training. [Admission policy](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/ouroboros/usage_admission.py#L1-L25); [review-wave rule](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/ouroboros/usage_admission.py#L286-L320).

**Adaptation:** reserve conservative maximum additional liability before launch, alongside settled spend. Include LLM output limits, reviewer fan-out, GPU time limits, storage retention, and pending jobs. Bound each worker's lifetime outside the model. An internal reservation system still cannot guarantee the provider's final bill when prices, termination latency, or reporting are uncertain; record that uncertainty and use provider-side controls where available. Model-call accounting does not automatically cover GPU bills.

## Delegation and isolation on a droplet

The child-contract builder prevents a child from widening inherited declared inputs, chooses the earlier of child/parent deadlines, and explicitly replaces inherited acceptance claims with the claims assigned to that child. Scheduling also checks the task's remaining allowance and maximum depth. These are useful invariants for matching specialist workers to bounded tasks. [Contract narrowing](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/ouroboros/tools/control_scheduling.py#L588-L695); [admission and depth](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/ouroboros/tools/control_scheduling.py#L790-L860).

Do not confuse schema visibility with execution authority. `tool_policy.py` explicitly states that loading a tool's schema does not grant permission to execute it. The same separation should hold for research workers: retrieving a paper, proposing an experiment, allocating GPU hours, modifying the evaluation set, and changing the harness release are different capabilities. [Tool-schema boundary](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/ouroboros/tool_policy.py#L1-L10).

The inspected workspace executor dispatches locally or into Docker. Docker execution records backend process identity, checks network mode when the requested policy is `none`, and retains unknown completion rather than assuming that a CLI exit proves all work ended. This is a useful reference for remote training-job adapters, but it is not itself a distributed GPU scheduler. [Execution dispatch](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/ouroboros/workspace_executor.py#L113-L144); [Docker custody and completion](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/ouroboros/workspace_executor.py#L275-L369); [network-mode check](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/ouroboros/workspace_executor.py#L749-L761).

There is a material Linux boundary to preserve in the assessment. The delegated containment checker compares the access profile actually reported by the execution engine with the requested one, but its own comments explain that unavailable OS confinement on non-macOS hosts is disclosed rather than automatically forbidden. A scoped home directory is therefore not sufficient evidence of isolation on the planned droplet. This observation concerns the inspected policy; it does not establish that every deployment is unconfined. [Applied-access comparison](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/ouroboros/delegate_containment.py#L48-L85); [home/confinement boundary](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/ouroboros/delegate_containment.py#L97-L130).

For this project, enforce worker isolation independently of prompts and declared capabilities. Run experiment code with bounded CPU/RAM/disk/time, narrowly scoped project storage, and only the credentials it needs. Keep control-plane credentials and the ability to create arbitrary infrastructure outside ordinary coding-worker access. This follows from the required autonomous execution and cost control, not from a claim that the upstream project lacks all protections.

## Self-modification: current Ouroboros has real gates

It would be inaccurate to dismiss the current repository as unrestricted self-rewriting. `body_candidate.py` keeps unfinished self-edits in task-owned worktrees instead of the running import tree. `preflight_qualification.py` binds adoption to test evidence for the exact commit and Git tree; full publication and locally selected testing have distinct qualification rules. [Candidate separation](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/ouroboros/body_candidate.py#L1-L21); [exact-commit qualification](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/ouroboros/preflight_qualification.py#L30-L146).

Take that architecture only after the ordinary experiment loop is reliable. A first deployment should propose harness changes in isolated branches, evaluate them against regression tasks and restart tests, and adopt a new release through a separate controller. Otherwise the experiment-running system and the criteria that certify it can drift together. The research question, test set, budget rules, and success criteria should remain versioned inputs that an ordinary experimental run cannot quietly rewrite.

## Deployment pieces worth reusing

The project provides both an immutable Docker image and a managed variant with persistent code, environment, data, and work volumes. The compose recipe publishes to loopback, uses `init: true`, and uses `restart: on-failure` so that the explicit stop protocol is respected. Those are practical patterns for the droplet control plane. [Container recipe](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/packaging/docker/compose.yaml#L15-L67).

The deployment documentation also names a concrete exposure risk: the container binds on all interfaces internally, and an unset network password does not itself block requests. The shipped loopback publication therefore matters. Preserve private access or add authenticated ingress before exposing an owner interface. The documented health check indicates boot/process health, not whether training supervision or scientific analysis is functioning. [Exposure and boot-health semantics](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/docs/DEPLOYMENT.md#L111-L156).

Ouroboros uses several stores and journals rather than one universal Markdown memory. Its storage code explicitly manages SQLite journal compatibility, including refusing incompatible WAL access rather than converting it opportunistically. Borrow the principle of explicit migration and durability ownership; do not transplant the full schema history into a new small system. [Store journal lifecycle](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/ouroboros/store_journal.py#L1-L26).

## What still must be built for research

No inspected component provides the following complete research contract. A filename scan for `ppo`, `grpo`, `rlhf`, `gymnasium`, `wandb`, `tensorboard`, `training`, `reinforcement`, and `reward` returned no matching tree paths; that is a bounded discovery result, not proof that every source file lacks related logic.

1. **Conventional RL adapter:** observation/action-space contracts; reset/step semantics; termination versus truncation; seeding; reward decomposition; baseline agents; held-out environment variants; policy evaluation across seeds.
2. **LLM post-training adapter:** dataset and prompt lineage; reward/verifier versioning; contamination controls; rollout accounting; checkpoint lineage; training diagnostics; independent evaluation of reward optimization versus actual task improvement.
3. **Training supervision:** backend job reconciliation, heartbeat interpretation, quantitative anomaly detection, checkpoint integrity, predeclared stop/intervention rules, and costs attributed to each experiment.
4. **Scientific evidence:** falsifiable hypotheses, controls, ablations, fair compute comparisons, uncertainty estimates, multiple-seed reporting, negative results, and claims tied to immutable artifacts.
5. **Literature validation:** dated retrieval, verified paper identity/version, reading beyond abstracts, explicit related-work comparison, and tracked corrections when new evidence changes an earlier judgment.
6. **Harness evaluation:** measured performance against a simpler single-agent baseline and human-designed experiment plans. More council messages or self-criticism rounds are not themselves evidence of better research decisions.

These missing layers are the decisive work. Neither a robust coding-agent runtime nor a history of reviewed self-improvement establishes that its proposed RL experiments would survive top-conference methodological scrutiny.

## Extraction order and acceptance criteria

| Order | Deliverable | Evidence needed before relying on it |
|---|---|---|
| 1 | Run/attempt identities, immutable experiment specification, artifact references, revisioned Markdown context | Reconstruct one decision from its exact inputs and outputs after restarting the control plane. |
| 2 | Durable launch intents and remote-worker reconciliation | Kill the control plane during launch and during monitoring; verify that no duplicate training job is created and uncertain jobs remain visible. |
| 3 | Global/project/run budget ledger with reservation policy | Concurrent launches, delayed cost reports, unknown prices, retries, and cancellation latency cannot silently bypass the configured policy. |
| 4 | Typed specialist contracts and bounded council | Malformed or missing reviewer output cannot become approval; every decisive finding names supporting evidence or a test that would resolve it. |
| 5 | Conventional RL adapter, then LLM post-training adapter | Each passes its own environment/data/reward/evaluation checks and a small reproducible end-to-end experiment. |
| 6 | Reviewed harness evolution | A proposed change passes exact-revision regression tests, crash recovery tests, and evaluation against fixed research tasks before adoption. |

## Testing evidence and what it does not establish

- `test_triad_review_primitive.py` contains tests for malformed responses, declared severity policy, degraded quorum, and stable reviewer identity. The test bodies support the intended distinctions described above. [Review tests](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/tests/test_triad_review_primitive.py#L46-L129).
- `test_working_checkpoint_process_kill.py` launches a real interpreter and kills its process group at controlled checkpoints, then exercises restore logic with mocked model dispatch. This is stronger failure-oriented test design than an exception-only fixture, but it does not test machine power loss or a real remote training backend. [Kill/recovery tests](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/tests/test_working_checkpoint_process_kill.py#L40-L121).
- `test_tree_cost_ceiling.py` covers accounting and root-ceiling propagation, among other behaviors. The existence or names of those tests must not be interpreted as a hard-spend guarantee, because the implementation explicitly uses the settled-spend admission policy discussed earlier. [Cost test source](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/tests/test_tree_cost_ceiling.py).
- No test was run in this audit. No conclusion about current CI status, benchmark reproducibility, production uptime, or RL research quality was drawn.

## License and dependency provenance

The reviewed repository's `LICENSE` declares the MIT License and copyright 2026 Anton Razzhigaev. Its text requires retaining the copyright and permission notice with copies or substantial portions. Track any actual copied files, upstream revision, and subsequent modifications in the new project's third-party notices. This audit copies no implementation code. [License text](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/LICENSE#L1-L21).

The README identifies **Claudexor** as a separate execution layer for delegated coding and hosted-agent review. This audit inspected the Ouroboros-side contracts, not Claudexor's implementation, provider terms, or every transitive dependency. Those remain separate integration questions if that execution path is adopted. [Execution-layer description](https://github.com/razzant/ouroboros/blob/add0ce3296c722ef99a536c52f8dcddf36494b36/README.md#L80-L84).

## Inspected source inventory

Substantive implementation reads: `working_checkpoint.py`; `knowledge.py`; `triad_review.py`; `review_cycles.py`; `review_verdict.py`; `usage_accounting.py`; `usage_admission.py`; `tools/control_scheduling.py`; `workspace_executor.py`; `delegate_containment.py`; `consciousness.py`; `commit_admission.py`; `preflight_qualification.py`; `store_journal.py`; selected `body_candidate.py`, `outcomes.py`, `memory.py`, `tool_policy.py`, and `supervisor/schedule_occurrence.py` paths. Supporting files fetched for structure and cross-checking included `tools/parallel_review.py`, `contracts/task_contract.py`, `tool_capabilities.py`, `usage_store.py`, `supervisor/queue_transitions.py`, and `supervisor/evolution_lifecycle.py`; these were not comprehensively reviewed.

Documentation/configuration inspected: `README.md`, `LICENSE`, `pyproject.toml`, `Dockerfile`, `packaging/docker/compose.yaml`, `docs/DEPLOYMENT.md`, and selected sections of `docs/PERSISTENCE.md` and `docs/architecture/01-high-level-architecture.md`. Test bodies inspected are listed above. All links refer to the pinned snapshot.

**Decision:** Ouroboros is a valuable source of long-running-agent engineering and failure semantics. Its best contribution to this project is making autonomous activity accountable and recoverable. The research harness still needs a separately designed scientific decision process and two explicit training adapters.
