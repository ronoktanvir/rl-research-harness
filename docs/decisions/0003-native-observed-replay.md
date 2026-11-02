# Decision 0003: reuse native v2 observed replay

Date: 2026-11-02. Status: selected adapter design; local mechanical qualification passed; production harness adapter pending.

## Decision and reason

Use CoworkeRL v2's actual `build_observed_replay` as the source of authorized, policy-observed fact evidence under its supported memory protocol. Join native extraction to the exact replayed memo and the same instantiated episode's fact definitions. Preserve separate semantic labels, stage failures and task-success status.

The decisive advantage is its existing complete path: original raw result/trace validation, world and runtime binding, per-message ownership, exact page reconstruction and the next-inference witness. A new harness event model would need to recreate these relationships and could diverge from the actual trainer's artifacts.

## Alternatives and evidence

The initial source review considered the smaller native `disclosed_fact_ids()` primitive plus a new harness event contract. That remains useful for isolated primitive testing, but is not the chosen integration. Subsequent inspection found the real persisted-capture fixture, and [native qualification](../research/observed-replay-qualification.md) passed 58 existing tests plus two new combinations without replacing the catalog, world or replay logic.

The first new case shows that an unread legitimate disclosure cannot combine with a separate read of a policy-authored guess. The second shows that valid acquisition plus numeric credit still accepts a denied quotation under the pinned extraction implementation. Together, they support native replay reuse while requiring a distinct semantic assessment.

Porting the historical Run-1 auditor would preserve a weaker same-channel value-arrival proxy and different source/runtime assumptions. It is appropriate only for explicitly scoped historical analysis. Neither its results nor current-v2 declarations may silently become the other's evidence.

## Implementation conditions

Pin the executable source/data package and wrapper before launch; resolve a real catalog episode; require original unjudged linked records and separately captured backend/page/prompt provenance. Do not repair rejected inputs by inventing identifiers, replacing a world or inferring backend provenance from an inference-server label.

Retain the complete required-fact universe, private world inputs, original identities and per-message read/inference witnesses. Extraction must use the replayed memo and the instantiated fact aliases, with exact digest binding. Missing or rejected evidence remains unassessed; repeated reads cannot multiply a fact's numerator. Keep source custody, numeric agreement, semantic correctness and experiment quality separate.

The one-off qualification launcher is not the production adapter. Runtime/import/output bounds, persistent intent/results, receipt reload and queue integration still need implementation and review. Task-package-only configurations need an explicit manifest/revision/interpretation-notes profile beyond the first catalog profile.

## Reversal conditions

Reconsider this entry point if the selected execution backend no longer obeys the supported memory protocol, native replay requires unbounded or provider-calling behavior, or its source coupling prevents dependable versioned deployment. A replacement should preserve equivalent source, ownership, page and inference checks and be compared against these retained counterexamples. A source update that repairs the semantic counterexample requires new source identity and qualification, not an altered old label.
