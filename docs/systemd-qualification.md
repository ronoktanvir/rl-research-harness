# Bounded Linux supervisor qualification

**Status: seven bounded CPU cases pass with production cleanup evidence and the required deadline gate.** [CI run 41396062992, Linux job 125117528860](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41396062992/job/125117528860), at source `521ceba91b770b87a3c8a9094425fbcc60b1c3ac`, passed all seven cases and their parent test (eight passes, zero failures or skips) in 14.465 seconds. The environment was Ubuntu 24.04.5 with systemd `255.4-1ubuntu8.18`. Node 24 and 25 each passed 373 offline tests, skipping only the explicitly opt-in native suite. No CoworkeRL training, model accounts or infrastructure provisioning was involved. This qualifies the tested local-host mechanisms under their stated assumptions, not production deployment.

The earlier [five-case success at `150723f`](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41393686347/job/125110331007) took 7.16 seconds on runner image `20261025.353.1`, Node `24.22.1`, and the same OS/systemd package. That source lacked production evidence after cgroup removal. [Run 41395292611 at `0ded185`](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41395292611) then passed all five cases with cleanup evidence and persisted worker terminal classification. The current seven-case run also qualifies the notify gate. These successive results are distinct; later evidence does not erase earlier failures.

The subsequent ledger-integration source `1a5c6bef7a5886d5d6d04d5562279a259fa96117` also passes these seven cases and their parent in [run 41398760542](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41398760542/job/125125749066), with systemd `255.4-1ubuntu8.18` and Node `24.22.1`. Both offline Node jobs pass 415 tests with one deliberate native-suite skip. This source adds mandatory cancellation authority callbacks and exact observation IDs; the native fixtures use authorized callbacks, while revocation during the ownership query is tested offline. The new [backend bridge](supervised-backend.md) has persistent-store integration tests with injected deployment/transport evidence, not a native CoworkeRL resolver qualification.

## Earlier failures and corrections

[CI run 41392051749](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41392051749), at source `9d8f983`, reported the same systemd package; all five cases received an unknown start outcome before reaching their lifecycle assertions. The original assertions omitted the underlying manager diagnostic.

The [diagnostic run 41392837686](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41392837686), at `73c0b0d998a3213168d44760f21802cf9b6bbf2c`, identifies the failure: each start returned exit code 1 because the transient-service API rejected `JobTimeoutUSec`, generated from the requested `JobTimeoutSec` setting. Native host-identity reading passed; subsequent queries found no matching unit. No lifecycle or terminal-cgroup assertion was reached. The unrelated environment-expansion hint in the error output is not evidence that argument expansion should be enabled. The correction removed the rejected queue-time setting while retaining literal argument handling and activation, active-runtime and stop limits.

[Run 41393036492](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41393036492), at `03d05517a37bb533e55d00493d005723d9f60232`, passed property submission after that setting was removed, but every service failed namespace setup with status `226/NAMESPACE` before its fixture started. A recovered unit query showed a failed process, an empty `ControlGroup` and a nonempty invocation ID. This is evidence of the startup failure, not successful fixture execution or established cleanup; no runtime-expiry or descendant-termination assertion passed.

The passing source narrows the inaccessible systemd path from `/run/systemd` to `/run/systemd/private`, preserving the runtime directory needed for namespace setup. The other control-path restrictions remain. The successful run also verifies separate read and write permission denial or absence for the private endpoint from each fixture process. It does not connect to that endpoint. This establishes the observed path restriction for the tested identity, not that the mask alone caused it or that every form of local IPC is isolated.

## Execution boundary

The explicit CI step runs:

```sh
HARNESS_TEST_SYSTEMD=1 node --import tsx --test test/execution/systemd-linux.test.ts
```

The test fails, rather than silently skips, if the opt-in environment lacks Linux, systemd 254 or later, cgroup v2, a non-root runner identity, or noninteractive access to the system manager. It records the installed systemd version. There is no user-manager fallback, package installation or account creation. The fixed transport uses `sudo -n` for manager commands; each fixture runs as the existing runner's non-root UID/GID.

The test stages its fixed [Node fixture](../test/execution/fixtures/service-child.cjs), [Python extension fixture](../test/execution/fixtures/deadline-child.py) and [deadline helper](../src/execution/deadline-gate.py) into separate read-only temporary source/helper directories. This avoids relying on a checkout under `/home`, which the profile hides. Each fixture writes one bounded `events.jsonl` file in its private, owned temporary directory; the controller journal lives separately. No credential or environment dump is collected. The extension fixture sends only local notification datagrams to `/run/systemd/notify`.

Each fixture has at most six seconds of configured active runtime, a two-second activation timeout and at most one second of stop grace. Activation timeout does not bound waiting in the manager's queue. The required gate separately refuses execution when the absolute deadline cannot accommodate the full runtime, stop grace and margin. It uses a 1,000 ms margin in these fixtures; that value does not prove a latency bound on arbitrary hosts. Fixtures have a twelve-second fallback exit, and tests require cleanup before it. Each case has a fifteen-second test bound. See the [deadline contract](execution-deadline.md) for clock, scheduling and suspend limitations.

## Evidence established by the seven passing cases

| Case | Required evidence |
|---|---|
| Successful process | The retained unit has the expected host/unit identity, exit code zero and successful result; dollar signs, braces and percent text reach the fixture unchanged. |
| Nonzero process | Manager acceptance remains separate from a later exit status of 23 and an `exit-code` failure result. |
| Relative runtime expiry | A running process is observed, ignores SIGTERM, then reaches a timeout result and disappears before its fallback timer. |
| Explicit cancellation | Both a parent and a child in a separate process group demonstrably ignore SIGTERM; the original processes and their service cgroup are then gone or empty. |
| Lost acceptance reply | The real start succeeds but a wrapper discards its reply. Query resolves the existing identity. After journal close/reopen, repeating launch performs no second start; invocation identity and the single start marker remain unchanged. |
| Late delivery | A four-second delay before actual manager submission leaves insufficient time; the gate exits with status 78, its refusal diagnostic is observed, no trainer marker exists and production cleanup is confirmed. |
| Main-PID timeout extensions | The manager reports `NotifyAccess=none`; the actual trainer main PID sends at least two extension notifications, ignores SIGTERM, and still reaches timeout and confirmed cleanup before its fallback. |

Cleanup assertions use recorded process start ticks, not bare PIDs, and verify that those processes were observed in the expected service cgroup. This avoids confusing PID reuse with a surviving child. A unit's absence alone never counts as termination proof. Test-only cleanup stops and resets only the exact generated unit after collecting the relevant observations.

The lost-reply case simulates response loss; it does not kill the controller process during a real service launch. Separate offline journal tests exercise actual controller SIGKILL boundaries. Neither establishes host-reboot recovery or power-loss durability.

## Semantics and remaining limits

The current transport requires `Type=notify`. The trusted gate sends readiness and disables future notifications, waits for the manager's descriptor barrier, checks remaining time and then executes the trainer in the same PID. Acceptance means gate readiness; the final check or trainer execution can still fail afterward. It does not establish trainer readiness. Earlier `Type=exec` acceptance covered only the environment-clearing wrapper. The transport checks the running manager's version, requires systemd 254 or later, and disables argument environment expansion.

[`RuntimeMaxSec`](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) limits active runtime; it is not an absolute admission-to-completion deadline. [`KillMode=control-group`](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html), a stop timeout and final SIGKILL supply the termination mechanism tested here. Startup delay and termination grace remain separate intervals.

**The earlier terminal-classification gap is now addressed under the qualified host contract.** At `150723f`, terminal snapshots had an empty `ControlGroup` and unknown occupancy; the worker therefore returned `accepted/unknown` after cancellation. The current production transport derives the exact owned cgroup path, verifies the standard cgroup-v2 mount/host view, observes the kernel state, and rechecks the same invocation and terminal outcome. Current native observations preserve the empty raw `ControlGroup` while recording `cgroupPopulated: false` with `cgroup_v2_absent` evidence. The empty-but-present cgroup branch has offline coverage; these native runs exercise absence. See [cleanup evidence](cleanup-evidence.md) for the full proof and exclusions.

The lost-reply worker now preserves the terminal result across reopening without another start. Explicit cancellation that ends in systemd's timeout/SIGKILL result remains `accepted/failed` with reason `stop_observed`; cleanup does not establish the unique cause of failure or turn it into success. Missing or malformed evidence still produces uncertainty. Independent fixture PID/start-time checks corroborate cleanup but are not substituted into production state. Neither cleanup nor a terminal result releases a reservation or cloud allocation automatically.

This CI run qualifies only the tested Linux image and short CPU lifecycle. The deadline depends on accurate initial time, the same host/boot clock basis, bounded scheduling/termination latency and no suspend after activation; privileged interference, host/manager failure and unkillable kernel work remain excluded. The separate byte verifier does not establish immutable deployment. Remote fencing, hostile-code isolation, GPU/vLLM correctness, native checkpoint recovery, helper/judge authentication, evaluation validity and cloud allocation release remain unqualified. The generic worker remains separate from an enabled CoworkeRL backend.

No actual systemd service or local privilege escalation was invoked during macOS development of these tests.
