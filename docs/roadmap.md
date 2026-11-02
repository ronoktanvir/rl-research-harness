# Implementation roadmap and acceptance gates

Status: implementation underway. Runtime, council, subscription-worker and read-only CoworkerRL components now exist, but no full autonomous-experiment stage is complete. See `implementation-status.md` for verified capabilities and gaps; the gates below remain the target rather than a checklist inferred from partial code.

## Build evidence of reliability before expanding autonomy

The first milestone should be one reconstructable experiment that survives failure. A complex council running on unreliable job bookkeeping would multiply cost and ambiguity. Both training tracks should share the same lifecycle but earn their own adapter qualification.

| Stage | Deliverable | Required acceptance evidence |
|---|---|---|
| 0. Runtime qualification | Coherent pinned Pi packages, narrow runtime interface, single-owner durable storage | A model/tool round; reopen after forced process death; safe/unsafe replay behavior; owned/background cancellation; exact release API documented. No reliance on unreleased main features. |
| 1. Experiment broker | Manifest schema, immutable revisions, ledger, reservation admission, stable actions and worker API | A lost launch acknowledgement does not create duplicate work; changed payload under an existing key is rejected; concurrent reservations respect policy; unknown external state stays visible. |
| 2. Conventional RL slice | One environment and trainer, environment checks, baseline, metrics, checkpoints, evaluator | Tiny reproducible run; correct termination/truncation; independent success metric; planted reward shortcut detected; source/config/seed/artifact lineage recoverable after restart. |
| 3. LLM slice | One small affordable post-training setup with explicit verifier and evaluation | Prompt/data splits and model/template versions preserved; verifier errors distinguished from wrong answers; fixed evaluation sampling budget; independent held-out outcome; supported checkpoint state demonstrated. |
| 4. Selective council | Role/task contracts, independent reviews, structured objections, bounded revisions and decision records | Missing/malformed reviewers do not count as approval; unresolved validity defects lead to tests or narrower claims; quality compared with one agent at matched budget; descendants cannot exceed scope. |
| 5. Bounded autonomy | A project runs several proposed/evaluated experiments within configured policy | Negative results retained; no silent test-set adaptation; correct response to a relevant new paper; global stop includes background/remote jobs and paid resources; spend and unknown exposure reconciled. |
| 6. Droplet qualification | Supervised controller, isolated workers, off-host artifacts/backups, operator control | Restart and restore drills; disk-full behavior; rejected stale worker/controller credentials; deadline enforcement without an LLM; bounded resource release; no dependence on scratch as sole storage. |
| 7. Reviewed evolution | Candidate branches/images, regression suite, explicit promotion and rollback | Candidate changes cannot edit promotion criteria; evidence matches exact revision; failed upgrades roll back; existing manifests and running-job identities retain meaning. |

Stage 6 is the production qualification point, not the first time a test service may run on a Droplet. External paid resources need project-specific budgets and credentials before activation. No cloud resource has been provisioned by this assessment.

## Minimal first campaign

Choose a cheap conventional RL task with an established baseline and a small LLM task with deterministic or carefully validated scoring. Do not begin by trying to prove a new state-of-the-art result. First establish that the assistant can reproduce a baseline, reject an invalid improvement, recover from infrastructure failure, and accurately describe a null result.

Use the same experiment schema for both tracks, but different semantic checks. Keep a blinded evaluation packet containing deliberately flawed variants: reward exploitation, environment state leakage, train/test leakage, misleading seed selection, a verifier timeout, and an apparent improvement caused only by more evaluation samples. Record expected judgments before running the harness.

Measure validity and usefulness rather than message volume: correctly completed experiments, meaningful defect detection, false alarms, unsupported claims, reproduction success, duplicate launches, cost per valid result, and human interventions. Compare single-agent, critic-assisted and selective-council conditions at matched budgets. A council should survive this comparison before becoming the default.

## Failure matrix

| Injected failure | Required behavior |
|---|---|
| Controller dies before request dispatch | Resume the persisted command without creating a new action identity |
| Worker accepts a launch but acknowledgement is lost | Reconcile the same job; never assume timeout means failure |
| Same idempotency key arrives with different configuration | Reject the mismatch and retain both diagnostic records |
| Pi loses its result after broker admission | Recover the operation by its run/operation identity; a fresh tool call cannot create a replacement launch |
| Worker dies between intent persistence and process creation | Resume or reconcile its durable launch state; distinguish never-started from unknown |
| Process starts but worker loses its local receipt | Recover process/backend identity or hold unknown; do not blindly repeat |
| Metrics arrive twice or out of order | Deduplicate by event/sequence identity and preserve valid order metadata |
| Artifact upload/checkpoint is interrupted | Do not advertise a partial artifact as valid; publish only after integrity check |
| Model request outcome or bill is unknown | Retain outstanding exposure, reconcile where possible, and prevent budget reset on retry |
| Parallel agents approach a shared cap | Transactional admission prevents collectively reserving more than policy allows |
| Compaction, internal retries and tool-triggered model calls occur near exhaustion | Every provider call passes the same admission boundary; no hidden call path resets its allowance |
| A review response is malformed, absent, or contradicted | Keep transport/parse state distinct from scientific agreement |
| Local agent is cancelled but training/background work survives | Global stop enumerates and confirms each external resource separately |
| Stop races with dispatch or automatic restart | Durable admission barrier survives restart; stale dispatch cannot bypass worker authorization checks |
| Droplet disappears during a paid run | Worker/backend deadline still applies; independent release mechanism acts or reports bounded unknown exposure |
| Controller restarts after a long outage | Coalesce overdue monitor/literature ticks; reconcile before admitting new expensive work |
| A candidate proposes changing its own evaluator or budget policy | Route to a separately governed change; current results retain their original definitions |
| Backup restore regresses ledger state while workers still run | Reconcile external identities before new dispatch; recover or quarantine unknown exposure |
| Agent and experiment stores restore to different points | Experiment ledger remains authoritative; reconcile lost projections and reservations without duplicate work |

Passing these tests demonstrates bounded properties under tested conditions. It does not prove all distributed failure modes or power-loss cases are covered. Record which process, host and provider failures were actually exercised.

## Decisions still needed for implementation

The first concrete projects determine trainer choices, data requirements and evaluation semantics. The deployment additionally needs resource budgets, account access, allowed actions, retention policy, expected concurrency and recovery objectives. Default architecture choices in `context/PROJECT.md` allow planning to proceed without inventing those values.

Avoid selecting a permanent model hierarchy by reputation. Build a small task suite for extraction, coding, diagnosis and scientific judgment, then assign tiers from measured performance, cost and latency. Preserve the ability to change providers without rewriting the experiment ledger.

## Later additions that must justify their complexity

Add a distributed workflow engine when one controller cannot meet availability or throughput requirements. Add semantic memory search when explicit record retrieval is insufficient. Add more trainers when a new project needs them. Add automated runtime evolution when it passes held-out regression checks. Each addition should resolve a measured failure or limitation rather than merely resemble a larger agent platform.
