# Execution-time deadline gate

The gate refuses to execute a trainer unless its absolute deadline still leaves the full configured runtime, shutdown grace and safety margin. It is required by the implemented `Type=notify` transport profile and works with systemd's runtime timer. The helper and integrated transport passed offline and real-manager qualification at `521ceba91b770b87a3c8a9094425fbcc60b1c3ac`; the deadline claim remains conditional on the host assumptions below. Earlier `Type=exec` lifecycle results alone do not qualify this protocol.

## Why the check follows a notification barrier

Starting a wrapper under `Type=exec` is insufficient for this check: the manager processes the exec notification asynchronously. In systemd 255, `service_enter_running()` sets the running state and arms the runtime timer; the exec-pipe handler reaches that transition later. A wrapper could otherwise check time before the runtime interval begins. The inspected paths are [`service.c` exec handling](https://github.com/systemd/systemd/blob/v255/src/core/service.c#L3518-L3556) and [running-state timer setup](https://github.com/systemd/systemd/blob/v255/src/core/service.c#L2231-L2253).

The trusted helper instead sends `READY=1` and `NOTIFYACCESS=none` together, then sends a separate `BARRIER=1` datagram carrying one pipe descriptor. It closes its own write end and waits for EOF. Only after this acknowledgement does it check time again and replace itself with the trainer using `execve`, preserving the main PID. A missing acknowledgement, malformed acknowledgement or failed check prevents trainer execution. The protocol follows the documented [notification and barrier contract](https://www.freedesktop.org/software/systemd/man/255/sd_notify.html) and its [reference pipe implementation](https://github.com/systemd/systemd/blob/v255/src/libsystemd/sd-daemon/sd-daemon.c#L617-L636).

Disabling notifications is necessary because the trainer inherits the main PID. Otherwise it could request a runtime extension. The inspected manager processes the barrier before per-service notification authorization, so the separate barrier still works after notifications are disabled. Within the service handler, readiness transitions precede the access override. This depends on a correctly configured, trusted system manager; a barrier acknowledges processing, not the meaning of arbitrary packets sent to an arbitrary peer. See [manager barrier handling](https://github.com/systemd/systemd/blob/v255/src/core/manager.c#L2553-L2564), [dispatch ordering](https://github.com/systemd/systemd/blob/v255/src/core/manager.c#L2701-L2704), and [service notification processing](https://github.com/systemd/systemd/blob/v255/src/core/service.c#L4415-L4533).

The deployment must use systemd 254 or later, `Type=notify`, `NotifyAccess=main`, no `ExecStartPost`, no runtime randomization, no automatic restart, and the existing bounded activation/runtime/shutdown and cgroup termination settings. The fixed endpoint is `/run/systemd/notify`; it must remain reachable. The interpreter, its libraries and the helper must be trusted and immutable to the trainer. Writable trainer environment settings must not affect the helper's interpreter.

## Clock and execution contract

[`deadline-gate.ts`](../src/execution/deadline-gate.ts) exports:

- `readTrustedDispatchClock(expectedBootId)`: samples fixed Linux boot-identity and uptime files, then UTC, and verifies that the boot stayed unchanged.
- `buildDeadlineGateCommand(request, config, anchor)`: produces literal arguments for the trusted Python interpreter and packaged helper. It snapshots inert input, rejects accessors and malformed identities, and enforces size limits.
- `PACKAGED_DEADLINE_GATE_PATH`: identifies the packaged helper; deployment must stage it where the service can read it.

The trusted configuration supplies absolute interpreter/helper paths, `safetyMarginMs` and `barrierTimeoutMs`. The latter cannot exceed the service activation timeout. The native profile requires at least a 1,000 ms safety margin, requires the helper in a declared read-only root and rejects overlap with writable paths. Before starting, it queries the running manager's `Version`; a newer installed client does not establish manager support. Command/environment data remain nonsecret declarations. Arguments are bounded to 128 KB in total; serialized trainer environment is at most 64 KB. The helper has no public override for its notify endpoint or clock sources.

The builder returns an empty gate environment for the outer `env -i` wrapper. Trainer environment is passed separately as bounded JSON and supplied only to the final `execve`. This prevents per-attempt `LD_PRELOAD` or library search settings from changing the trusted interpreter, and prevents Python's locale startup changes from silently rewriting the trainer environment. Python runs with `-I -S`, imports only its standard library and never invokes a shell or searches `PATH` for the trainer.

At dispatch the controller samples UTC and boot time; a successful acceptance receipt retains that anchor. The helper compares wall UTC with the dispatch UTC advanced by elapsed `CLOCK_BOOTTIME`, and uses whichever is later. Thus a wall-clock rollback after dispatch cannot increase the allowance. A boot mismatch or negative elapsed boot time fails closed. The Linux [uptime implementation](https://github.com/torvalds/linux/blob/v6.8/fs/proc/uptime.c#L26-L35) uses boot time and truncates to hundredths of a second. Sampling that value before UTC makes this rounding conservative.

After the manager barrier, the required remaining duration is:

```text
runtimeMs + stopTimeoutMs + safetyMarginMs
```

The full runtime is conservative because some has already elapsed. The final check immediately precedes same-PID execution. An early check also avoids readiness for work already known to be late. All notification sends and pipe waiting share one bounded timeout; errors produce fixed reason codes without copying arguments or environment into diagnostics.

## Limits of the deadline claim

The safety margin is an operator-supplied bound, not a measured guarantee. Completion before the stated UTC deadline requires an initially accurate clock within that margin, controller and service using the same host boot/time basis, bounded timer/scheduling/exec/kill latency, and no host suspend after activation. The inspected [systemd runtime timer](https://github.com/systemd/systemd/blob/v255/src/core/unit.c#L6414-L6419) uses a monotonic clock; it is not a suspend-aware wall-clock alarm. Reboot, manager failure, administrator interference and unkillable kernel operations are outside this guarantee. A larger margin alone does not establish those assumptions.

The native margin must also cover known timer coalescing. The inspected timer call selects default accuracy, which the [event timer documentation](https://www.freedesktop.org/software/systemd/man/255/sd_event_add_time.html) defines as 250 ms. Runtime and shutdown timers can each use that allowance. A native margin must therefore exceed their combined 500 ms before accounting for clock error and scheduling/kill delay; the much smaller values in deterministic tests are not deployment recommendations.

Manager acceptance means the gate reached readiness. The final check or trainer exec may still fail afterward; acceptance does not mean trainer readiness or successful training. A gate diagnostic or exit code alone is not authority to mark the launch unaccepted, release an allocation or settle accounting, because a trainer can emit the same text/code. The journal and worker must continue to use observed execution and cleanup evidence.

## Qualification evidence

The offline tests use a Unix datagram peer with real descriptor transfer, then execute a harmless Python child in the same PID. They cover exact packet ordering, bounded missing/malformed acknowledgement, expiry before readiness and after acknowledgement, wall-clock movement, boot mismatch, exact budget boundaries, strict parser rejection, detached literal arguments and the loader-environment separation. Native clock sampling runs only on Linux and fails explicitly elsewhere. These tests neither create a service nor establish real systemd timer behavior.

[CI run 41396062992](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41396062992), at the source above, passed all seven real Linux cases (eight reported tests including their parent) in 14.465 seconds on Ubuntu 24.04.5 with systemd `255.4-1ubuntu8.18`. The existing success, failure, runtime, cancellation and lost-reply cases all use the required gate. The added cases establish refusal before any fixture marker after delayed delivery, and verify `NotifyAccess=none` while the actual main PID sends runtime-extension notifications that do not prevent timeout and cleanup. Node 24 and 25 each passed 373 offline tests with one explicitly skipped native suite. See [service qualification](systemd-qualification.md) for the exact evidence and limitations. CoworkeRL, GPU execution and production deployment remain separate qualifications.
