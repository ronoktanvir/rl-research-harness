# Bounded Linux supervisor qualification

**Status: real Linux qualification failed at startup; the supervisor is not yet qualified.** [CI run 41392051749](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41392051749), at source `9d8f983`, reported systemd 255 (`255.4-1ubuntu8.18`); all five cases received an unknown start outcome before reaching their lifecycle assertions. The original assertions omitted the underlying manager diagnostic.

The [diagnostic run 41392837686](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41392837686), at `73c0b0d998a3213168d44760f21802cf9b6bbf2c`, identifies the failure: each start returned exit code 1 because the transient-service API rejected `JobTimeoutUSec`, generated from the requested `JobTimeoutSec` setting. Native host-identity reading passed; subsequent queries found no matching unit. No lifecycle or terminal-cgroup assertion was reached. The unrelated environment-expansion hint in the error output is not evidence that argument expansion should be enabled. A transport correction still needs a successful real CI run. The ordinary offline suite skips real services. No CoworkeRL, model accounts or infrastructure provisioning is involved.

## Execution boundary

The explicit CI step runs:

```sh
HARNESS_TEST_SYSTEMD=1 node --import tsx --test test/execution/systemd-linux.test.ts
```

The test fails, rather than silently skips, if the opt-in environment lacks Linux, systemd 254 or later, cgroup v2, a non-root runner identity, or noninteractive access to the system manager. It records the installed systemd version. There is no user-manager fallback, package installation or account creation. The fixed transport uses `sudo -n` for manager commands; each fixture runs as the existing runner's non-root UID/GID.

The test stages only its fixed [fixture source](/Users/ronoktanvir/Documents/ChatGPT/RL-harness/test/execution/fixtures/service-child.cjs) into a separate read-only temporary source directory. This avoids relying on a checkout under `/home`, which the selected profile hides. The fixture writes one `events.jsonl` file in its private, owned temporary directory. The controller journal lives in a different directory. No credential or environment dump is collected, and the fixture contains no network operations.

Each fixture has at most six seconds of configured active runtime, two seconds of start allowance and one second of stop grace. It also schedules its own fallback exit at twelve seconds. The tests require supervisor cleanup before that fallback; seeing a fallback event fails the assertion. Each case has a fifteen-second test bound. These are practical test bounds, not a claim of hard real-time scheduling.

## What the five cases establish if they pass

| Case | Required evidence |
|---|---|
| Successful process | The retained unit has the expected host/unit identity, exit code zero and successful result; dollar signs, braces and percent text reach the fixture unchanged. |
| Nonzero process | Manager acceptance remains separate from a later exit status of 23 and an `exit-code` failure result. |
| Relative runtime expiry | A running process is observed, ignores SIGTERM, then reaches a timeout result and disappears before its fallback timer. |
| Explicit cancellation | Both a parent and a child in a separate process group demonstrably ignore SIGTERM; the original processes and their service cgroup are then gone or empty. |
| Lost acceptance reply | The real start succeeds but a wrapper discards its reply. Query resolves the existing identity. After journal close/reopen, repeating launch performs no second start; invocation identity and the single start marker remain unchanged. |

Cleanup assertions use recorded process start ticks, not bare PIDs, and verify that those processes were observed in the expected service cgroup. This avoids confusing PID reuse with a surviving child. A unit's absence alone never counts as termination proof. Test-only cleanup stops and resets only the exact generated unit after collecting the relevant observations.

The lost-reply case simulates response loss; it does not kill the controller process during a real service launch. Separate offline journal tests exercise actual controller SIGKILL boundaries. Neither establishes host-reboot recovery or power-loss durability.

## Semantics and remaining limits

Systemd's [`Type=exec`](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html) acknowledges execution of the configured program. Here that program is the environment-clearing wrapper, so acceptance does not establish trainer readiness. Retaining an exited service enables subsequent exit inspection. The transport disables argument environment expansion, an option introduced in systemd 254.

[`RuntimeMaxSec`](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) limits active runtime; it is not an absolute admission-to-completion deadline. [`KillMode=control-group`](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html), a stop timeout and final SIGKILL supply the termination mechanism tested here. Startup delay and termination grace remain separate intervals.

The transport conservatively returns unknown cgroup occupancy when the cgroup file is unavailable. The fixture tests can supplement that observation using their previously recorded process identities and kernel paths; this does not silently change the production worker's state interpretation. Diagnostics record the actual terminal `controlGroup` and `cgroupPopulated` values and the worker's cancellation classification. A passing transport-state and independent-cleanup test does not, by itself, qualify automatic terminal classification by `SupervisedWorker` when its own evidence remains unknown.

Even a passing CI run qualifies only the tested Linux image and short CPU lifecycle. It does not establish immutable artifact verification, an absolute execution-time authority check, remote fencing, hostile-code isolation, GPU/vLLM correctness, checkpoint recovery, helper/judge authentication, evaluation validity or cloud allocation release. The generic worker must remain separate from an enabled CoworkeRL backend until those contracts have their own evidence.

Record a successful CI run and tested commit only after the explicit step succeeds; retain the failed qualification above. No actual systemd service or local privilege escalation was invoked during macOS development of these tests.
