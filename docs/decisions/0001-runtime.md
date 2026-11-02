# Decision 0001: Pi runtime with an owned research controller

Date: 2026-11-01, America/Los_Angeles.
Status: **proposed; source review supports qualification, production adoption remains conditional**.

## Decision

Qualify pinned Pi libraries for model access and durable agent execution. Build the experiment broker, research policy and two Python trainer adapters under project ownership. Adapt Ouroboros's revisioned knowledge, narrowed child contracts, typed reviews, accounting and uncertain-effect recovery patterns. Do not combine the two applications as peer controllers.

The decisive criterion is preserving reusable agent primitives while avoiding duplicated authority and concentrating new code on scientific experiments.

## Alternatives and tradeoffs

| Option | Principal benefit | Decisive cost or limitation |
|---|---|---|
| Full Ouroboros fork | Integrated long-lived agent, review, memory and deployment machinery; Python implementation | Broad application coupling and lifecycle policy; scientific adapters and experimental validity still need to be built |
| Pi libraries plus owned controller | Modular model/runtime layer; existing durable tasks and explicit integration surface | Experimental durable API; TypeScript/Python boundary; release qualification required |
| Entirely custom Python agent runtime | One main language and full lifecycle control | Rebuild provider, streaming, tool, context and agent-recovery machinery before solving research problems |
| Two peer harnesses | Access to both applications' features | Duplicated scheduling, memory, budgets and recovery ownership; no clear authoritative state |

## Evidence

The [Pi audit](../repo-audits/pi.md) verifies substantive durable implementation and published 1.4.0, while distinguishing main-only changes and failure semantics. The [Ouroboros audit](../repo-audits/ouroboros.md) verifies useful operational contracts and reviewed evolution, while identifying coupling, settled-spend admission and recovery/isolation limitations. The [research review](../research/evidence-and-standards.md) establishes why provenance and independent evaluation need explicit design beyond an agent runtime.

These are source observations and a design judgment. No comparative runtime benchmark or unattended deployment has been completed.

## Conditions of acceptance

Pin a coherent release and lockfile; qualify its actual API; pass process-crash/replay, external launch reconciliation, background cancellation, concurrency and budget tests; keep scientific state independent of conversation summaries; and verify a tiny complete experiment through each adapter. See `../roadmap.md`.

## Reversal conditions

Reconsider if Pi's release lacks required recoverability, its API churn overwhelms the adapter boundary, or a dependable existing Python controller makes a TypeScript service unnecessary. Consider a larger workflow engine only when concurrency or availability requirements exceed a single-owner deployment. Revisit Ouroboros as a full base if its application lifecycle becomes a better fit than owning the controller and the integration cost is demonstrated to be lower.

## Critique record

Initial source audits were performed independently for both repositories, with a separate literature reviewer. The architecture received independent systems critiques; the scientific protocol received a methods critique. Material findings changed the design:

- Bind action identity to a registered run/operation before dispatch, including fresh model calls and lost local receipts.
- Reconcile deterministic worker job identities across the crash-after-spawn window; durable intent and serialization alone are insufficient.
- Enforce budget admission on every model-provider call path, including compaction and internal retries.
- Enforce worker deadlines and resource release independently of controller availability.
- Make Stop a persistent admission barrier that survives automatic restart, and account for network-partition delay.
- Enforce broker/evaluator boundaries through execution and data permissions; restrict access to final evaluation answers.
- Freeze LLM evaluation sampling budgets, distinguish verifier infrastructure failures from wrong answers, and test substantive success beyond format compliance.

A second systems review found the required corrections closed at the design level with no remaining material contradiction in its bounded scope. The roadmap includes corresponding failure tests, including mismatched-store restoration. This is review evidence, not proof that an implementation satisfies the design. No reviewer acceptance substitutes for runtime qualification or scientific evaluation.
