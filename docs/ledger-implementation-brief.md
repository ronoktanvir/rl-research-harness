# Next slice: authoritative experiment ledger

Status: implementation brief, not implemented. Prepared after independent review of the foundation on 2026-11-01. The [architecture](architecture.md) and [full status](implementation-status.md) remain the scope references.

Use one controller-owned SQLite ledger with transactional admission and a durable outbox. Keep it separate from Pi's database. The first slice qualifies local identity and recovery with injected workers; it must not enable production training dispatch.

## Identity and records

| Record | Required identity and meaning |
|---|---|
| Manifest | Immutable schema version, canonical payload and digest; code/dirty patch, environment/dependencies, adapter config, data/splits, model/reward/evaluator versions, seeds, resource limits and evaluation policy |
| Run | Stable run ID, project, manifest digest, explicit replica identity and optional lineage/checkpoint; repeated tool requests retrieve it |
| Action | Unique `(runId, operation, operationRevision)`, stable action ID, immutable payload digest and discoverable backend idempotency key persisted before dispatch |
| Reservation | Action, applicable budget scopes, charge category, integer microdollars, pricing/bound basis and outstanding exposure |
| Observation/event | Stable event ID, source, payload digest, run/action/job identities and ordering metadata |
| Policy/stop | Versioned project/global policy, durable admission barrier and increasing authority epoch |

Identical retries return the existing record; changed content under an existing identity conflicts. Explicit replication creates a new run. Snapshot inputs before validation, hashing and persistence. Use checked integer arithmetic, with `bigint` monetary values and decimal strings at JSON boundaries.

## Operations and invariants

Prefer named commands over a public `setState` operation. Every state change appends its event in the same transaction.

| Operation | Required behavior |
|---|---|
| Register manifest/create run | Validate immutable content and bind identity; reject conflicting reuse |
| Record validation | Bind trusted check evidence to the exact manifest; council text cannot manufacture passed execution checks |
| Admit action | Atomically check policy/barriers/capabilities and all applicable allowances, reserve exposure, create the action/event and enqueue dispatch |
| Claim dispatch | Atomically select eligible work, recheck barriers and persist attempt/authority/deadline before any external I/O |
| Acknowledge/mark unknown/reconcile | Match action, manifest, backend and attempt; never interpret timeout as proven rejection |
| Append observation | Deduplicate with provenance; conflicting IDs fail and stale data cannot overwrite newer confirmed facts |
| Record charge/finalize reservation | Record actual charges even above estimates; release only demonstrably extinguished exposure |
| Stop/resume scope | Persist stop before cancellation work; resume explicitly checks expected epoch and cannot clear another scope's barrier |

Hierarchical allowances must be checked together. A child cannot receive an independently copied parent allowance. Duplicate admission cannot reserve twice. If actual charges exceed the reservation, preserve that fact and restrict subsequent admission; rejecting the accounting event would hide expenditure.

## Recovery and independent state dimensions

```text
queued -> dispatching -> acknowledged
                     -> unknown -> acknowledged
                                -> confirmed_not_accepted
                                -> held
```

A restarted dispatching action becomes unknown. The ledger cannot tell whether the external request was sent. A generic retry must not relaunch it. Requeue only after authoritative nonacceptance evidence or through a separately qualified idempotent backend, preserving logical identity.

Keep dispatch certainty, last confirmed trainer execution, resource-allocation release, billing settlement and scientific evaluation separate. Trainer cancellation does not establish that GPU billing ended. Successful execution does not establish that an evaluation is valid. Unknown charges and allocation state retain exposure.

Stop survives reopen, holds undispatched work and permits reconciliation, cancellation and resource release. A local transaction cannot close the interval between a committed dispatch claim and a remote request. Future workers must check authority or enforce bounded leases/deadlines; the controller must report potentially in-flight work. Initial deployment needs one exclusive owner; SQLite transactions alone do not supply remote fencing or distributed ownership.

## Failure-oriented qualification

1. Conflicting identity reuse fails; identical admission and observations remain idempotent after reopen.
2. Caller mutation/changing getters cannot make validated, hashed and stored content disagree.
3. Failure between admission writes leaves no orphan reservation, action, event or dispatch entry.
4. Concurrent requests near shared allowances cannot collectively overreserve; retries do not reserve again.
5. Actual subprocess death before/after commit and after dispatch intent preserves queued-versus-unknown distinctions.
6. A simulated backend accepts once, loses its reply and is reconciled without a second launch.
7. An ambiguous unsupported backend retains unknown/held status and exposure.
8. Stop before claim prevents dispatch; stop after claim preserves uncertainty and survives restart. Simulated workers reject stale authority.
9. Trainer cancellation, allocation release and unresolved billing remain independent.
10. Duplicate, stale, conflicting and late observations preserve provenance without corrupting confirmed state.
11. Partial, duplicate, late and above-reservation charges stay accurate; unknown billing never becomes zero automatically.
12. Historical metrics and successful trainer exit cannot mark scientific evaluation complete.

The resulting claim is limited to local ledger behavior under specified failures. Remote launch uniqueness, worker fencing, deadlines, paid allocation release, invoice ceilings, backup/restore and scientific validity require qualification against the actual systems.
