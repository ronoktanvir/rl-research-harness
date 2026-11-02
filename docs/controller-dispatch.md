# Dispatch and reconciliation coordinator

Status: implemented with injected test backends. No production training backend is supplied or enabled by the CLI.

`src/controller/dispatcher.ts` connects the durable ledger to an explicit backend interface. `dispatchNext` claims at most one queued action and performs at most one submission. `reconcileAction` queries the original identity of an unknown action. Neither function contains an automatic launch retry.

## Identity and uncertainty

Every reply must match the action ID, current attempt ID, manifest digest, backend name and stable backend key. Accepted replies also require a job ID. The controller snapshots and validates the reply before passing it into the ledger. An exception, timeout, malformed reply or mismatched identity records an unknown outcome and retains exposure. A missing local adapter or authority revoked before submission can establish that this invocation sent no request.

An adapter's `not_accepted` response must mean authoritative nonacceptance. A temporarily empty job listing or an eventually consistent lookup does not establish that condition; adapters must return unknown in those cases. The coordinator validates the envelope, not the truth of a remote assertion. Real adapters need source-specific qualification.

Confirmed nonacceptance still does not trigger another submission or settlement. Requeue and settlement remain separate ledger operations. Reconciliation of a lost reply can acknowledge the existing job without submitting again. A job receipt alone does not change trainer execution, allocation release, billing settlement or scientific evaluation.

## Deadlines and stop

`timeoutMs` bounds the local wait for a backend call. It does not stop remote work. The adapter receives an abort signal, but a timeout remains unknown even if the adapter ignores that signal or returns success later. Late replies are discarded by the wait wrapper; a subsequent reconciliation recovers authoritative state.

The dispatch claim carries a separate `deadlineAt` and authority epochs. The ledger checks local authority before invoking the backend. A real worker must also check authority and enforce its deadline independently; a local check cannot prevent a stop from arriving after the network request leaves the process. If acceptance arrives after stop, the controller records the real accepted job so cancellation work can address it.

Backends are trusted application adapters. This in-process interface cannot preempt a callback that blocks the event loop, isolate arbitrary trainer code, or prevent direct credential use. Production workers require the separate isolation and authenticated policy boundary described in [architecture](architecture.md).

## Tested behavior and remaining qualification

The tests use real temporary ledgers and injected synthetic backends. They cover lost replies across ledger reopen without duplicate submission, malformed/mismatched receipts, deadlines with late responses, pre-cancelled calls, missing backends, a stop before local submission and acceptance after stop. An independent regression checks sparse-array evidence, which must become durable unknown rather than fail later during persistence.

These tests do not establish real cloud idempotency, worker fencing, remote cancellation, allocation release or billing correctness. No API keys, cloud resources, training jobs or model calls are involved.
