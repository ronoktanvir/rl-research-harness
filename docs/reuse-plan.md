# What to take from Pi and Ouroboros

**Recommendation: build on Pi's agent libraries, adapt Ouroboros's strongest operational contracts, and keep the research controller under your ownership.** Neither inspected repository is a ready-made RL scientist. The value is avoiding reinvention of model access, durable agent tasks, delegation and context while concentrating new work on experiment validity and reliable training execution.

Assessment date: 2026-11-01, America/Los_Angeles. This is a source-based recommendation, not a runtime benchmark. See the [Pi audit](repo-audits/pi.md) and [Ouroboros audit](repo-audits/ouroboros.md) for pinned links, inspected test bodies and limitations.

## Snapshot and scope

| Repository | Inspected source | Release qualification |
|---|---|---|
| Pi | `c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8` | `pi-durable@1.4.0` publication verified; release source `4a080252f06caf63a525d7873c5d94d3c23887e0`. Main contains unreleased changes. Durable remains experimental. |
| Ouroboros | `add0ce3296c722ef99a536c52f8dcddf36494b36` | Manifest version 7.9.0. Selected source paths and tests inspected; no deployment or benchmark reproduction. |

The reviews covered implementation and recovery tests, not only project descriptions. Both have evolved substantially: Pi now includes a durable task runtime, and Ouroboros now has reviewed candidate changes. Assessments based on “Pi has no subagents” or “Ouroboros rewrites itself without gates” would miss important distinctions in these snapshots.

## Reuse decisions

| Priority | Take from | Concrete mechanism | Integration mode | What we still own |
|---|---|---|---|---|
| First | Pi `packages/ai` | Provider adapters, message/tool schema and usage types | Pinned package dependency | Model selection, role policy and request-budget admission |
| First | Pi `packages/durable` | Persisted task phases, owned children, replay policies, waits, transcripts and compaction | Pinned release behind an `AgentRuntime` interface | External-effect identity, project state and scientific policy |
| First | Ouroboros `knowledge.py` | Revision-checked Markdown updates and provenance | Reimplement the small invariant in our records layer | Claim support, immutable evidence and conflict resolution |
| First | Ouroboros `working_checkpoint.py`, `supervisor/schedule_occurrence.py` | Intent before effects; explicit uncertainty; stable scheduled occurrence identity | Adapt contracts into broker/worker protocol | Remote launch reconciliation and host-failure durability |
| First | Ouroboros `usage_accounting.py` | Physical attempt records, attribution and settlement states | Adapt ledger model, not settled-only admission | Atomic exposure reservations; GPU/storage billing and deadlines |
| Next | Pi Durable foreground/background subagent examples; Ouroboros `tools/control_scheduling.py` | Owned child work plus narrowed scope, inherited deadlines and depth limits | Adapt into task contracts | Role routing, global stop, project-wide costs and concurrency |
| Next | Ouroboros `triad_review.py`, `review_cycles.py` | Typed findings, missing/malformed reviewer distinctions, bounded review lifecycle | Adapt schema and parser behavior | Scientific criteria, independent evidence packets, dissent and council evaluation |
| Next | Pi compaction; Ouroboros revisioned knowledge | Recoverable history plus concise current context | Compose complementary mechanisms | Prevent stale summaries from replacing authoritative results |
| Optional | Pi `packages/env` and coding-agent SDK/RPC | Remote file/process access and scoped coding workers | Qualify the chosen version when needed | Durable training-job lifecycle and OS-enforced isolation |
| Optional | Pi telemetry contracts; Ouroboros execution outcome categories | Operational tracing and separate completion/assessment states | Adapt schemas, connect an exporter | Trainer metrics, scientific outcomes and cost reporting |
| Later | Ouroboros `body_candidate.py`, `preflight_qualification.py` | Isolated candidates and exact-revision validation before adoption | Borrow workflow after core reliability is proven | Promotion criteria, independent regression suite and rollback |

“Adapt” means preserve a useful invariant behind our own interface; it does not mean copying an application module and its entire dependency graph. Pi's scheduler and Ouroboros's checkpoint/review code are interconnected. Import maintained public APIs where available, and copy only narrowly scoped examples after reviewing their dependencies and retaining attribution.

## Why Pi is the better foundation for this objective

The decisive criterion is how much general agent machinery can be reused without inheriting an entire product's lifecycle and policy. Pi exposes libraries for model calls and durable execution. That fits an application with its own experiment model, separate Python trainers and a narrow control service. Ouroboros provides a richer integrated agent application, but extracting its internals can pull in task contexts, desktop/headless behavior, review policy, execution custody and self-evolution machinery.

This does not establish that Pi is more reliable in production. Its durable API is explicitly experimental, and current main differs from the observed published release. The recommendation is conditional on a release qualification spike with failure tests. If Pi fails that spike, retain the owned broker and Python adapters while substituting a simpler bounded runtime. If a future project already has a dependable Python orchestration service, integrating Pi as a worker may be preferable to introducing a new control service.

## What to leave out initially

- **Whole-application fusion.** Running Ouroboros and Pi as two peer orchestrators would duplicate memory, scheduling, authority and recovery. Use one controller with explicit ownership.
- **Unmodified budget policy.** Ouroboros admits against known settled spend; Pi usage is accounting. Neither is sufficient by itself to bound parallel GPU and model-call exposure.
- **Automatic live self-rewriting.** Reviewed evolution is valuable, but reproducible experiments and recovery have higher priority. Preserve a known runtime revision during campaigns.
- **Broad arbitrary-shell authority for research agents.** Typed run tools make identity, resource admission and cancellation testable. Scoped code workers can still use shells inside their execution boundary.
- **A large permanent council on every event.** Health checks and log parsing are often deterministic. Convene a council for decisions whose ambiguity or consequence warrants the cost.
- **Desktop UI, identity/personality machinery and stylistic customization.** They do not determine environment validity or unattended job reliability. Add an operator view once the lifecycle is dependable.

## The missing research layer

The core new work is a shared **experiment and evidence system**, with two domain adapters. It needs environment/task specifications, reward/evaluator separation, training diagnostics, checkpoint semantics, held-out evaluation, fair baselines, ablations, uncertainty estimates, negative-result retention and literature-linked design decisions.

The research review provides concrete mechanisms worth testing: Eureka's measured reward-refinement loop, PAIRED's attention to solvability, uncertainty-aware RL evaluation, and recent autonomous-research work on experiment trees, result registries and consolidation. Their scope and limitations are recorded in [evidence and standards](research/evidence-and-standards.md). Do not convert author-reported preprint results into a guarantee that this combined system will discover novel work or meet a conference's bar.

Self-criticism should produce a counterexample, source correction, new control or discriminating experiment. It should not merely produce a longer defense of the original answer. A concise, evidence-linked decision record is the persistent output.

## The first implementation target

Build one narrow vertical slice: a project manifest produces one small experiment, the controller launches it through an adapter, survives a lost launch response or restart, collects metrics and artifacts, evaluates the result independently, and writes an accurate decision record. Include one deliberately invalid reward or verifier case that the system must reject. Then repeat the lifecycle through the second adapter.

Only after this works should the system run a bounded autonomous campaign, compare single-agent and council decisions, or promote its own harness changes. See [the staged roadmap](roadmap.md) for measurable acceptance criteria.

## Attribution and maintenance

Both inspected root licenses declare MIT. Their license texts require retaining the copyright and permission notices with copies or substantial portions; the audit files link those texts. No implementation code has been copied in this assessment. If code is later copied, record upstream commit, original path, retained notice and local modifications. Dependency licensing and package integrity remain build-time checks, not something the root license alone establishes.

Pin coherent packages and preserve a lockfile. Review upstream changes periodically in an isolated candidate; do not have the running researcher automatically track `main`. A new dependency version must pass the same restart, budget, isolation and scientific-regression tests as a local change.
