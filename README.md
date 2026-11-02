# RL research harness: repository assessment and design

**Use Pi as the candidate agent runtime, borrow selected Ouroboros operational contracts, and build an owned research controller with separate conventional-RL and LLM post-training adapters.** The reusable infrastructure is substantial; scientific validity and dependable experiment execution remain the central new work.

Assessment completed **2026-11-01, America/Los_Angeles**. This workspace contains source audits, a research review and proposed architecture. It contains no implemented harness or deployment. Upstream source and selected test bodies were inspected; upstream tests and training were not run.

## Start here

| Document | What it answers |
|---|---|
| [Reuse recommendation](docs/reuse-plan.md) | Which packages, modules and patterns are worth taking, which to leave out, and why |
| [Architecture](docs/architecture.md) | How agents, the experiment ledger, worker adapters, budgets, recovery and Droplet deployment fit together |
| [Research protocol](docs/research-protocol.md) | How to design environments, critique proposals, monitor training and support defensible scientific claims |
| [Implementation roadmap](docs/roadmap.md) | What to build first and which failure tests justify increasing autonomy |

## Evidence and continuity

- [Pi source audit](docs/repo-audits/pi.md): pinned implementation evidence, release/main differences and reuse limits.
- [Ouroboros source audit](docs/repo-audits/ouroboros.md): pinned implementation evidence, reviewed evolution, accounting and recovery contracts.
- [Research evidence and standards](docs/research/evidence-and-standards.md): selected primary literature, verified publication status, useful mechanisms and qualifications. Recent selected work reaches October 14, 2026; the search is not exhaustive.
- [Project context](context/PROJECT.md): the user's objective, settled scope, current status and outstanding implementation decisions.
- [Runtime decision](docs/decisions/0001-runtime.md): alternatives, adoption conditions, critique corrections and reversal criteria.
- [Record templates](docs/templates/research-records.md): experiment, result, decision, paper and task/handoff fields.
- [Agent instructions](AGENTS.md): how future work should preserve objectives and evidence without treating proposals as completed capabilities.

## Decisive distinctions

Pi's durable runtime is real and published, but experimental; qualify a pinned release rather than coding against whatever is on main. Ouroboros has real reviewed-change mechanisms, but its current spending admission is not a final-bill cap. Neither runtime turns a council's agreement into a valid scientific result.

The proposed first milestone is one small experiment whose identity, launch, metrics, evaluation and decision can be reconstructed after a failure. Demonstrate that through each adapter before expanding to long autonomous campaigns.
