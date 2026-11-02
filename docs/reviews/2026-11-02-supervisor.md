# Supervisor execution review

The local worker now preserves intent before starting a supervised process, observes the original service after response loss and refuses launch replay after reopening. Independent agents implemented the journal, transport and Linux qualification suite; the root implemented coordination. Reviews crossed those ownership boundaries.

## Required corrections

| Finding | Correction | Regression evidence |
|---|---|---|
| Caller-supplied unit metadata could diverge from action identity | Reconstruct and compare the complete declaration before launch/query ownership | Changed command/identity is rejected before a manager effect |
| Authority could change during the post-intent microtask or asynchronous host check | Pass a trusted authorization callback through the transport and recheck immediately before manager invocation | Both revocation windows produce zero starts |
| Empty/malformed present-state evidence could become successful execution | Require loaded service, nonzero invocation identity, valid state/outcome fields and bound cgroup evidence | Empty invocation cannot establish acceptance or completion |
| An accepted receipt could lack host/unit binding | Require complete matching structured or scalar identity metadata | Empty and partial accepted receipts remain unknown |
| Cancellation omitted an invocation pinned only by an earlier accepted receipt | Recover that identity from all journal evidence | Reopened cancellation retains the original invocation even when queries are unavailable |
| A later stop request overwrote an already confirmed process outcome | Preserve the first confirmed terminal outcome through cleanup and absence | Success and failure survive cancellation, removal and reopen |
| Caller mutation and late callbacks could change observed meaning | Snapshot bounded inert data; discard responses after the local wait ends | Stored results remain unchanged after a late callback |
| A crash fixture kept the process alive but allowed its database owner to be collected | Retain the ledger, queue and journal owners in live callbacks; force garbage collection before declaring readiness | Exclusive ownership remains asserted before actual SIGKILL; recovery still distinguishes each transaction boundary |
| The CLI parsed a timeout property that the systemd 255 transient-service API rejects | Remove the unsupported property; retain activation, active-runtime and shutdown bounds | Real CI identified the rejected property. Queue time remains explicitly unbounded pending the execution-time deadline gate |
| The broad systemd runtime mask obstructed namespace setup | Restrict the private manager socket instead of its parent directory | Independent source reviews identified the required incoming mount; real CI now passes startup and verifies denied private-endpoint read/write permissions |
| The lost-response fixture's internal startup assertion could be caught as transport uncertainty | Assert successful acceptance outside the wrapper before claiming reply-loss recovery | Failed service creation cannot satisfy the intended lost-successful-reply scenario |

The journal additionally rejects foreign schemas, conflicting action/job declarations, wrong hosts/units, replaced invocations and ownership aliases. Real subprocess tests kill journal owners before and after commit. A committed intent remains existing after reopening and cannot authorize another start.

The ownership fixture defect was exposed by Node 24 in the first Linux run and reproduced locally on Node 25: forced collection released the connection while the child process remained alive. The correction changes fixture lifetimes, not production lock semantics. All 44 focused ledger/journal/queue tests passed locally with Node 24.22.1 and Node 25.9.0. [Linux CI at `73c0b0d`](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41392837686) passed both Node versions' offline checks, while its separate service job identified the unsupported timeout property. Independent review found no material issue with the fixture correction.

## Qualification scope

The corrected source suite passed **332 offline tests**, with the explicit Linux service suite skipped by default, plus TypeScript and whitespace checks. This includes 39 focused execution tests. The separate [Linux qualification record](../systemd-qualification.md) identifies the actual CI evidence; offline injected transport tests do not qualify systemd behavior.

[CI run 41393686347](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41393686347), at source `150723f2346551ab2debecb6f19d03d22e191a68`, passed the Node 24/25 offline jobs and all five real Linux CPU lifecycle cases. Literal arguments, nonzero exits, runtime expiry, detached-child termination and lost-reply/reopen recovery passed. Terminal snapshots have an empty cgroup path and unknown occupancy, however; the production worker therefore preserves an unknown cleanup outcome. The independently verified fixture cleanup must not be presented as production terminal classification or allocation release.

The accepted process is an environment-clearing wrapper, not proof of native trainer readiness. Relative runtime limits and pre-send authorization checks are implemented; an absolute execution-time gate remains missing. Current cgroup observations stay unknown if the kernel evidence cannot be established. Test-only cleanup evidence must not be silently substituted into production worker state.

No model account, CoworkeRL trainer, GPU allocation or Droplet is needed for these tests. Actual training still requires frozen artifacts, native preflight, worker credentials, separately admitted resources, evaluation controls and provider-release qualification. The generic local worker does not satisfy those requirements by itself.
