# Proposed supervised Linux worker

**CoworkeRL training is not enabled.** A [generic local supervisor](../local-supervisor.md) now implements persistent intent, systemd transport and query-only recovery. The CoworkeRL integration still produces a declaration-only command preview; see [its limits](coworker-attempt-plan.md). Connecting that preview to execution requires verified artifacts, native admission checks and an absolute deadline gate in addition to the lifecycle machinery below.

This design follows CoworkeRL HEAD `84b219f64f1152f8b02babea388bfbbfff41e75a`, inspected 2026-11-01; see [the execution audit](coworker-execution-contract.md). No CoworkeRL trainer, credential or provider was exercised. Short CPU service tests have separate [Linux qualification evidence](../systemd-qualification.md).

## Narrow local API and ownership

Start with the dispatcher and systemd manager on the same trusted Linux host. Remote authentication, bounded authorization leases and fencing are separate future work; this local design does not qualify them. An eventual factory should implement the existing `ExperimentBackend` interface with `submit(claim, signal)` and query-only `reconcile(request, signal)`, backed by an injected transport, a durable intent/receipt journal and a trusted profile. No model-facing process may access that journal, the experiment ledger, provider credentials or the manager's control socket.

Resolve an archived plan by digest; verify its action, run and manifest against the claim. Verify immutable source/input/environment bytes and native admission prerequisites, enforce fresh ledger authority, and serialize the action before recording a durable start intent. The generic worker uses `rlh-<hash of workerId and backendKey>.service` as the deterministic unit identity and binds the complete declaration in controller-owned metadata. A worker identity plus unit name forms the stable job ID; a PID or dispatch-attempt UUID does not. Observation also retains machine/boot identity and systemd invocation identity to detect replacement.

The trusted profile fixes the unprivileged user, executable allowlist, read-only mounts, writable attempt root, resource ceilings and permitted credentials. Caller-provided systemd properties or shell commands are unsupported. Use literal argv with environment expansion disabled. Proposed service properties are `Type=exec`, `Restart=no`, `RuntimeMaxSec`, bounded start/stop timeouts, `KillMode=control-group`, `SendSIGKILL=yes`, memory/task ceilings and no delegated cgroup. `Type=exec` distinguishes successful program execution from the default early fork acknowledgement; it still does not establish trainer admission or scientific success. [systemd-run documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html), [service runtime controls](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html).

`RuntimeMaxSec` bounds active runtime, not the entire absolute authorization interval. The future worker must separately bound queued/start time, check the remaining authority deadline before trainer execution, and include shutdown grace. The preview checks arithmetic consistency only. Stop revokes new admission, then explicitly requests termination of the owned unit and verifies its cgroup empties; losing a local wait is not cancellation. Already submitted provider calls and VM/storage billing may persist after process termination. [systemd termination semantics](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html).

## Crash windows and observation rules

| Durable state / observation | Permitted conclusion and recovery |
|---|---|
| Plan exists, no start intent | No external submission recorded. Fresh authority can admit the next step. |
| Start intent persisted, controller dies before or during submission | Submission may have occurred. Inspect the original deterministic unit; do not automatically start again. |
| Matching unit or durable matching acceptance receipt exists | Worker accepted that job identity. Observe execution separately. |
| Unit absent after an issued intent, manager restart or host reboot | Unknown unless an authoritative receipt resolves it. Absence does not prove nonacceptance. |
| Definitive pre-effect rejection persisted | `not_accepted` may be recorded; any later retry requires explicit ledger requeue/admission. |
| Exit observed and owned cgroup empty | Record exit evidence. Evaluation, allocation release and billing settlement remain separate. |

Transient unit names alone cannot supply durable idempotency: systemd can unload unreferenced units and loses transient definitions on reboot. Persist intent before submission and receipts before cleanup; never recycle a unit name as proof a previous job did not run. A crash after intent but before the manager call can therefore leave an unstarted job unknown. This conservative loss of automatic progress is preferable to duplicate paid work. Retaining an exited unit may aid observation, but is not a substitute for the journal. Reconciliation must not start, restart, reset or delete units. [Systemd manager's transient-unit API](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.systemd1.html).

`accepted` means worker acceptance only. A generic command failure or timeout does not establish nonacceptance. Process exit zero does not imply a valid evaluation, and an empty process group does not prove the GPU VM is released. The first worker should support explicit `cancel` of its own job; cloud `release`, on-demand checkpoint creation and automatic resume remain unsupported until their separate contracts are implemented.

## Qualification required before enabling execution

Offline preview tests exercise mapping, immutable snapshots, manifest/lineage mismatches, path and limit rejection, and agreement with real ledger action identity. They do not execute the trainer or qualify systemd.

Next, use a Linux fixture to test manager acceptance, controller death before/after submission, lost replies, unit garbage collection, host reboot, stale identity, stop during start, ignored SIGTERM, child-process cleanup, runtime expiry and artifact collection. Injected transport tests alone cannot establish Linux cgroup or signal behavior. This development host is macOS and has no systemctl; Linux CI or a separately authorized Linux host must produce that evidence. Actual CoworkeRL CUDA/vLLM/helper/judge checkpoint-and-resume qualification remains a later, separately bounded experiment.
