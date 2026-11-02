# Local experiment ledger

The implemented ledger makes experiment identity, admission, dispatch uncertainty, stop authority and recorded spending persistent under one trusted local controller. It does **not** launch training, authenticate remote workers, verify invoices, or enforce provider spending limits. The [architecture](architecture.md) remains the broader target; this document describes the narrower code in [`src/ledger`](../src/ledger/index.ts).

Qualification date: 2026-11-01, America/Los_Angeles. Local verification uses Node 25.9.0 and built-in `node:sqlite`. The package target remains Node >=24.12.0 <26. These tests establish process-crash behavior on the tested local filesystem, not power-loss durability or distributed failover.

## Ownership and persistence

`openExperimentLedger({ path, now? })` returns a synchronous `ExperimentLedger`. Open one instance, call its named commands, then `close()` it. External work happens after ledger methods return. No transaction accepts a caller callback and no method performs a network request or subprocess dispatch.

A separate `<path>.owner.sqlite` connection holds `BEGIN EXCLUSIVE` for the controller's lifetime. A second owner fails before main-ledger recovery. Closing the main connection precedes releasing ownership; process death releases the operating system's SQLite locks. The owner file is retained, never deleted for a takeover. Parent-directory aliases resolve to one canonical path; symlinked or multiply hard-linked ledger/owner files are rejected. This requires a trusted service-owned directory and a local filesystem with working SQLite locks. It does not defend against an actor who can replace the live files or bypass this API with a direct SQLite connection. It is not a remote fencing mechanism.

The main database uses WAL, `synchronous=FULL` and foreign keys. Each mutation runs in `BEGIN IMMEDIATE` and appends its event in the same transaction. Existing unsupported schema versions and unrelated databases are rejected before main schema initialization. Version 1 is the only implemented schema; migration, backups, restoration and corruption recovery are not implemented here.

Opening increments global authority, preserving its stopped flag. Any action left `dispatching` becomes `unknown`, with a recovery event. The previous controller may have sent the request before dying. Recovery never invents nonacceptance or places that action back in the dispatch queue.

## Public operations and authority

The complete types are in [`types.ts`](../src/ledger/types.ts). Commands validate one detached input snapshot before hashing and persistence. JSON must contain finite values and ordinary objects; sparse arrays, cycles, boxed enum values and unsupported types fail. Each encoded record is limited to 2 MiB. Returned records are detached views and cannot mutate stored content.

Manifest image digests must use `sha256:` followed by exactly 64 lowercase hexadecimal characters. Dependency and data-split digests must contain exactly 64 lowercase hexadecimal characters without a prefix. Format validation rejects placeholders; it does not verify that a supplied digest matches an image, dependency snapshot or dataset. Code revisions and model/reward/evaluator versions remain supplied version references pending adapter verification.

| API | Meaning |
|---|---|
| `registerManifest`, `getManifest` | Canonical immutable manifest and SHA-256 identity. Version fields bind supplied provenance; structure checks do not verify its truth. |
| `createRun`, `getRun`, `listRuns` | Stable run ID, project, manifest, replica and optional checkpoint lineage. Reusing the same project/manifest/replica under a second run ID conflicts. Intentional replication needs a new replica ID. |
| `configureBudget`, `getBudget` | Versioned global/project/child allowances; immutable parent links and exact aggregate charges/exposure. |
| `configurePolicy` | Versioned backend/operation allowlists and required manifest checks for global and project scopes. New policy versions revoke existing authority. |
| `recordValidation` | A trusted controller's check result tied to one manifest. Missing or latest failed required checks block ordinary admission. |
| `admitAction`, `getAction`, `listActions` | Atomic policy check, reservation, immutable logical action and durable outbox entry. |
| `claimDispatch`, `isDispatchAuthorized` | Persist attempt identity, worker, deadline and authority before external I/O; validate the exact claim and current authority. |
| `recordDispatchOutcome`, `requeueAction` | Preserve accepted/nonaccepted/unknown outcomes and permit limited retry only after proven nonacceptance. |
| `stopScope`, `resumeScope`, `getScope` | Durable global/project barriers with expected-epoch checks. |
| `admitCleanup` | A narrow cancel/release command bound to an existing original action. |
| `appendObservation`, `getObservation`, `listObservations` | Immutable evidence with nullable execution links. These records never change execution, evaluation or accounting facts. |
| `recordExecution`, `recordAllocation`, `recordEvaluation` | Separate trusted confirmations, with pinned-source ordering and manifest-matched evaluator version. |
| `recordCharge`, `finalizeReservation` | Additive actual charges, explicit final settlement, and retained unresolved exposure. |
| `events` | Append-only local transition history in commit order. |

The API is for trusted controller code. Any caller that can invoke `recordValidation`, `recordExecution` or `recordEvaluation` can assert a fact; the ledger checks identity and consistency, not the scientific truth or authenticity of the evidence. Models, trainer code and remote services must not receive this API or filesystem access directly. An authenticated broker boundary and independent check/evaluator execution remain future work.

Validation and confirmed-fact streams pin the first source for each manifest/check or entity/dimension. Their sequence values order that stream; an older event remains recorded without replacing the latest fact. A different source must be preserved as an observation, rather than silently becoming the new authority. Same-ID changed content and same-stream occupied sequences conflict. Terminal execution and released allocations cannot be silently reopened; further execution needs a linked run. Evaluation is separately version-bound and does not follow automatically from trainer success.

## Identity, admission and dispatch

A logical action ID is derived from `(runId, operation, operationRevision)`. The backend key is the same stable identifier. The immutable admission binding includes payload, backend, manifest, allowance ancestry, reservation amount/category and the basis for that bound. Identical retries retrieve the existing action even after a stop; changed input conflicts. A caller cannot mint a new ID merely to repeat the same admitted operation without explicitly changing its operation revision or run identity.

Every project allowance descends directly from `global`. An optional child allowance must descend from that action's project, and all persisted ancestors are charged together. Callers cannot omit the global/project allowances or choose a sibling project's budget. Admission checks all allowance headroom and aggregate run commitments against the manifest's maximum cost.

A claim persists the action's exact payload and reservation view, attempt ID, selected worker, global/project authority epochs and deadline. Authorization rejects payload type substitutions as well as changed values. The deadline must be future and within the manifest's maximum duration from the claim time. This is a **per-attempt deadline contract**; it is not an implemented worker timer or a cumulative run-duration limit. Actual workers must enforce it independently.

A stopped or no-longer-admissible queued action stays queued but cannot be claimed. A timeout or lost reply becomes unknown. An accepted outcome records a job identity; it does not establish that training is running, resources are released or billing is settled. Receipts must match action, manifest, backend and current attempt. A later accepted receipt may be recorded after a stop because real external effects must not disappear from the ledger.

`requeueAction` requires confirmed nonacceptance, an unfinalized reservation and zero recorded charge. A previous attempt that consumed any of its bound needs a separately authorized new operation/bound; it cannot silently obtain another full physical-attempt allowance. Unknown actions remain unavailable for generic retry, including after restart. The injected [dispatch coordinator](controller-dispatch.md) demonstrates reply-loss reconciliation, but no production worker/backend contract is qualified by these ledger tests.

## Money, exposure and cleanup

Money uses nonnegative `bigint` microdollars in the controller API. Individual charges, limits and reservations must fit a signed 64-bit magnitude; stored JSON uses canonical decimal strings. SQLite stores monetary fields as text. Aggregation uses JavaScript `bigint`, avoiding SQLite `SUM` overflow and floating-point conversion. Aggregate accounting totals may exceed an individual amount's range and remain exact.

For an unfinalized action:

```text
outstanding reservation = max(admitted bound - recorded charges, 0)
committed scope amount = sum(recorded charges + outstanding reservations)
available = scope limit - committed amount
```

A partial charge consumes reservation rather than being counted twice. Available balances may be negative. Charges are accepted even after settlement or above the original bound. A late charge clears finalization until the controller explicitly settles the new total.

An unfinalized action that reaches or exceeds its positive bound, or incurs any charge against a zero bound, holds further **ordinary** admission and claims in every overlapping allowance scope. Its remaining external liability is unresolved; zero numeric residual reservation is not a claim of zero unknown exposure. Explicit settlement can remove that hold after the relevant conditions are established. The controller cannot silently release unknown exposure because an invoice has not arrived.

Finalization requires accepted or confirmed-nonaccepted dispatch, an exact match with the sum of recorded charges, and nonempty evidence asserting that exposure ended. Accepted compute/storage actions additionally require confirmed allocation release. Trainer cancellation alone does not satisfy that requirement. The evidence is an operator/controller assertion; the ledger does not query a provider to establish its accuracy. Refunds, credits, price fetching and automatic reservation extension are outside this implementation.

Stop and resume require expected epochs. A project can be preemptively stopped before its first run or policy exists; explicit resume still requires an existing scope. A project resume cannot clear a global barrier. Policy changes and controller reopen also change authority, so an earlier claim cannot regain permission merely because a stop was later cleared.

`admitCleanup({ targetActionId, operation: "cancel" | "release", operationRevision, reservation })` generates the payload from the original target's immutable action/key/manifest. The target must be an original, possibly accepted action; nested cleanup targets and arbitrary payload/backend substitution are rejected. Cleanup retries remain idempotent after the target's state changes. Operation revisions must distinguish different cleanup targets within one run.

Cleanup may bypass stop, failed scientific checks and the unresolved-spending hold, while still requiring explicitly configured backend/cleanup-operation permission and fresh authority. Positive-cost cleanup requires allowance headroom at admission and dispatch. Only stored cleanup with zero reserved amount **and zero recorded charges** may proceed under exhausted caps. An ordinary action merely named `cancel` or `release` receives no exemption. These are local command-admission rules: actual remote cancellation, resource release and independent cleanup capacity remain unimplemented until a worker adapter is qualified.

## Qualification and limits

The focused ledger tests cover:

- Conflicting and idempotent identities across close/reopen, immutable ancestry, shared ancestor caps and aggregate run caps.
- Snapshot consistency with changing getters; strict enum/JSON checks; prototype-named JSON keys and type-preserving claim authorization.
- A trigger failure at the final admission write, proving action/reservation/outbox/event rollback together.
- Actual child-process `SIGKILL` before admission commit, after admission commit, and after dispatch claim. Reopen distinguishes no action, queued action and unknown dispatch, and reacquires the owner lock.
- A simulated accepted launch whose reply is lost, reconciled by its existing identity without another launch.
- Durable stop/resume, stale authority, preemptive project stop, scoped cleanup and positive-cost cleanup under reduced limits.
- Separate trainer, allocation, evaluation and billing states; stale fact retention; duplicate, partial, late, exact-bound and above-reservation charges.

Run the current suites with `npm run check` and `node --import tsx --test test/ledger/*.test.ts`. Test counts may increase with independent review; the suite itself is the acceptance reference. No ledger test invokes a paid model, provisions a resource or starts real training.

This remains a local single-owner component. Remote fencing, network authentication, backend discovery/idempotency, worker-enforced deadlines, external reapers, provider invoice ceilings, off-host recovery, recurring scheduling, production training adapters and scientific validity still need their own implementation and acceptance evidence. There is no claim that a local SQLite commit makes an external launch exactly once.
