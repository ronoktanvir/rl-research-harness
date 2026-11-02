# Persistent research-task queue

The queue persists bounded research work without pretending that a literature review, report capture or context export is a training run. It owns task identity, attempts, dependency readiness, local invocation allowances and account-availability holds. The experiment ledger remains the only global/project stop authority. This is a local trusted-controller component, not a distributed scheduler or a provider billing gateway.

## Storage and authority

`openTaskQueue({ path, authority, now? })` opens a synchronous API from [`src/scheduler/index.ts`](../src/scheduler/index.ts). Its SQLite database has its own `research-task-queue` identity and versioned schema. It refuses experiment-ledger, foreign and unsupported-version databases before schema writes. WAL, `synchronous=FULL`, foreign keys and transactional events preserve local state changes together.

The queue uses a separate persistent `<path>.owner.sqlite` file with a lifetime exclusive SQLite transaction. A competing controller fails before recovery; process death releases the lock. The owner file is never removed for takeover. Parent aliases are canonicalized and symlinked/hard-linked database files are rejected. This relies on a service-owned local directory and a filesystem with working SQLite locks. Host power-loss, hostile file replacement, distributed ownership and backup/restore are not qualified by these process-crash tests.

The required `authority(projectId)` callback reads `{ globalEpoch, projectEpoch, stopped }` from the experiment ledger. A missing project authority may be represented by `projectEpoch: null`; it is different from a later registered project epoch. The queue does not store or expose another global/project stop switch. Claims capture the ledger epochs, and `isAuthorized` re-reads them before invocation. Callback failure prevents authorization. A stop followed by resume does not restore an old claim's authority.

There is no transaction spanning the queue and ledger, or either database and an external client. The runner must recheck claim authority immediately before calling a handler. A stop after that check cannot unsend a request. A crash after claim commit leaves uncertainty even if the request may never have been sent.

## Tasks and handler contracts

Register trusted handler policies before enqueueing work. `registerHandler({ kind, version, replay, callUnits, resourceKey })` is immutable for a `(kind, version)` pair. The application registry supplies these fields; model text and user-supplied task payloads must not choose their own zero-cost or safe-replay declarations. The implemented handler registry separates Codex and Claude review kinds, each with one local invocation unit and no automatic replay. Capture/export handlers declare zero client calls and reconciled replay.

A task binds its ID, project, kind, handler version and policy, canonical JSON input/digest, dependency IDs, maximum attempts, deadline and original `notBefore` time. Identical retries return the persisted task; any changed binding conflicts. Inputs are snapshotted once, strictly validated and detached from callers. JSON records have a 2 MiB limit and reject nonfinite numbers, sparse arrays, unsupported objects and cycles.

Dependencies must already exist in the same project. Because identities and dependencies cannot later change, this construction prevents cycles without a mutable graph-rewrite mechanism. Only a durable `completed` predecessor unblocks a dependent task. Failed, rejected, cancelled, expired, quota-waiting and uncertain tasks do not count as successful evidence acquisition. A completed scientific review may contain a negative recommendation: successful review execution is distinct from scientific approval.

`notBefore` remains part of immutable task identity. `eligibleAt` is the current operational schedule after an explicit resume/reconciliation. Attempts do not reset either the overall deadline or `maxAttempts`.

## Admission, outcomes and recovery

| Operation | Persisted effect |
|---|---|
| `configureBudget` | Compare-and-set global/project local invocation and parallel limits. |
| `enqueue` | Immutable task, dependencies and event; no client invocation. |
| `claim` | Checks dependencies, time, ledger authority, resource availability and both allowance scopes; persists attempt and consumed units before external work. |
| `isAuthorized` | Compares the exact claim snapshot and rechecks current authority, deadline, cancellation, resource availability and lowered budgets. |
| `recordOutcome` | Binds a result ID to the current running/uncertain attempt and preserves its result. |
| `resumeTask` | Explicitly requeues a quota/auth wait without clearing its shared resource hold. |
| `requeueUncertain` | Requires a handler's reconciled-replay declaration and nonempty reconciliation evidence; preserves consumed attempts and units. |
| `cancelTask` | Cancels undispatched work, or records a cancellation request for running/uncertain work without claiming it stopped. |
| `releaseResource` | Explicitly releases one account-availability hold under its expected version and evidence. |

Task states are `queued`, `running`, `waiting_quota`, `waiting_auth`, `uncertain`, `completed`, `rejected`, `failed`, `cancelled` and `expired`. Expired queued tasks are recorded when the controller next tries to claim work. Already-running or uncertain work does not become proven stopped merely because its deadline passes.

Opening a queue converts persisted running attempts to `uncertain`. They are not automatically queued, even when their handler is a read-only client reviewer. Official clients have no qualified idempotent result lookup in this implementation. The same call may have consumed account allowance before its process disappeared.

An uncertain attempt continues occupying a parallel slot. Its local invocation units are never refunded. A controller may record a matching, authoritative late outcome, or explicitly reconcile a replay-safe observation. The latter records the original attempt as `reconciled` and requeues the task under the same immutable task identity. A handler marked `never` cannot take that replay path. Arbitrary assertion of safety in task input does not change the persisted handler policy. Reconciliation evidence is a trusted controller assertion; this database does not independently verify it.

## Invocation allowances and account availability

Global and project budgets are checked together, transactionally. `maxCalls` means the sum of **declared local handler invocation units**, not observed provider model requests, tokens, dollars or purchased quota. An official client can perform internal retries or other requests, so these counters do not establish a provider-call or invoice ceiling. Authentication failures and requests that were claimed but never invoked may still conservatively consume one unit. Every retry consumes another attempt and its declared units.

`maxParallel` counts running and uncertain attempts in both scopes. Parallel runners cannot each obtain a copied allowance. Lowering a positive-call budget revokes an uninvoked claim that no longer fits. Zero-call deterministic work remains possible when call allowance is exhausted, subject to parallelism, ledger authority and task readiness. Budgets are lifetime cumulative records; this implementation never guesses subscription reset windows or resets counters automatically.

Quota and authentication outcomes also persist a hold on the handler's `resourceKey`, such as `codex:default` or `claude:default`. The hold applies across task kinds and projects sharing that account resource. It prevents a queue of sibling tasks from repeatedly probing the same unavailable client. Unrelated clients and deterministic work remain eligible when their other constraints permit them.

An unknown quota reset is `null` and holds indefinitely. Known resets are caller-supplied absolute timestamps, recorded with the result; the current CLI handlers do not manufacture them. An existing unknown hold is not weakened by a later concurrent response that supplies a known reset. Authentication holds likewise require explicit release. Successful unrelated or concurrent work does not silently clear a hold.

`releaseResource` requires the current version and nonempty evidence. A recorded future reset cannot be bypassed with an earlier `notBefore`; release may instead schedule availability at or after that reset. This availability release does not itself requeue a task. Conversely, `resumeTask` does not clear a resource hold. Both transitions remain visible in the event history, and neither changes experiment-ledger stop authority.

## Qualification and limits

The queue suites exercise immutable identity and caller mutation, strict claim matching, same-project dependency readiness, shared invocation/parallel limits, lowered-budget rechecks, quota/auth persistence, cross-project account holds, explicit safe replay, attempt ceilings, cancellation uncertainty and actual ledger stop epochs. An injected failure at the final claim event proves rollback of the attempt, counters and state together.

Real child-process `SIGKILL` tests distinguish an untouched queued task, an uncommitted claim and a committed running attempt. The final case reopens uncertain with its consumed unit and parallel slot retained. Tests also verify live owner exclusion, lock reacquisition after death, and refusal to initialize the queue schema inside a ledger database. These are offline tests and invoke no paid models or training jobs.

Run `npm run check` and `node --import tsx --test test/scheduler/*.test.ts` for the current acceptance suite. Handler and runner tests qualify their separate boundaries; a passing queue test does not establish that a particular worker executes or cancels correctly.

This slice does not implement authenticated remote workers, durable account authentication on a Droplet, provider reset discovery, distributed scheduling, recurring task generation, task prioritization, scientific experiment selection or an autonomous campaign. It supplies the persistent scheduling records on which those capabilities can be built without replaying ambiguous external calls or losing completed evidence.
