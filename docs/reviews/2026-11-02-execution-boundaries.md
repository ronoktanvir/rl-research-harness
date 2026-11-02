# Execution boundary review

The generic worker now retains production cleanup evidence after systemd removes cgroup metadata, verifies bounded CoworkeRL source/input bytes, and requires a deadline check after the manager arms its timer. These changes do not enable CoworkeRL training. Immutable deployment binding and native trainer qualification remain separate work.

## Sources and independent review

The implementation is split into four coherent commits:

- `9dbd164`: cgroup cleanup evidence and persisted terminal classification.
- `0ded185`: versioned source inventories and bounded input-byte verification.
- `50eed89`: acknowledged execution-time deadline helper.
- `521ceba`: required systemd gate integration and real Linux qualification cases.

The cleanup author, gate author and artifact author worked in separate modules. Independent review checked cleanup transport/journal semantics, gate ordering and environment boundaries, and the root transport integration. The root reviewed artifact bounds and connected native lifecycle assertions. The published integration received a further independent source/CI review with no remaining material defect identified within the documented scope. This is a bounded engineering review, not proof against every host or adversary.

## Required corrections

**The helper must not inherit trainer-controlled loader settings.** The first gate design forwarded trainer environment into the interpreter process. Settings such as `LD_PRELOAD` could alter execution before Python's isolated-mode flags applied, undermining the gate. The corrected command starts the helper with an empty environment, carries trainer environment as bounded JSON data, and installs it only at final `execve`. Offline tests verify both sides of that separation.

**Artifact validation needed byte and path-depth limits before trusting a preview.** Root review required explicit preview-byte bounds and consistent selected-input depth checks in both TypeScript and the isolated reader. The corrected verifier rejects oversized or structurally excessive input before reading, enforces descriptor-relative traversal and retains a launch-disabled receipt. Source inventory covers its declared staged tree; it does not authenticate the Git commit or substitute for native adapter/checkpoint semantics.

**Terminal cleanup requires production evidence, not test-only PID checks.** The earlier Linux suite observed successful cleanup independently while the worker remained uncertain. The corrected transport pins the owned cgroup path and trusted host/mount view, distinguishes a missing group from unreadable events, and confirms the same terminal invocation afterward. Journal validation rejects mismatched paths, identities, timestamps and live-process contradictions. Missing evidence still remains unknown.

## Qualification

[CI run 41395292611](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41395292611), at `0ded185b603fa09064b4ed22885d8c03f2a45c62`, passed 362 offline tests on Node 24/25 and all five native cases plus their parent. It first qualified production terminal classification after cgroup removal. [Cleanup evidence](../cleanup-evidence.md) records the exact observations and exclusions.

[CI run 41396062992](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41396062992), at `521ceba91b770b87a3c8a9094425fbcc60b1c3ac`, passed:

| Job | Result |
|---|---|
| [Linux supervisor](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41396062992/job/125117528860) | Seven cases plus parent: eight passes, zero failures/skips, 14.465 seconds |
| [Node 24](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41396062992/job/125117529082) | 373 passes, zero failures, one skipped opt-in native suite; type and diff checks pass |
| [Node 25](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41396062992/job/125117529114) | Same results |

The native image reports Ubuntu 24.04.5 and systemd `255.4-1ubuntu8.18`. All lifecycle cases now run through the required gate. The added delayed-delivery case observes refusal before any trainer marker. The extension case checks the manager's notification access and sends actual extension requests from the trainer's main PID; successful sends still end in timeout and cleanup. Testing a helper PID would not establish the same property because the original notification policy already excluded it.

The lost-reply case preserves one start and a stable invocation through journal reopening. Cancellation retains the observed timeout/SIGKILL outcome as failure, with cleanup established separately. Native terminal proofs cover a removed cgroup; the empty-but-present branch is covered offline. The [qualification history](../systemd-qualification.md) preserves earlier failed runs and corrections.

## Consequences and remaining work

The [deadline contract](../execution-deadline.md) depends on a trusted host/manager, accurate initial clock, bounded scheduling and kill latency, and no suspend after activation. It refuses late execution after arbitrary delivery delay; it does not bound the delivery queue itself or ensure allocation release. Manager readiness precedes the final gate check and does not establish trainer readiness.

Next work is immutable deployment binding and native CoworkeRL preflight before an actual launch/status/cancel/checkpoint/collect/reconcile backend. GPU/vLLM behavior, training helper/judge access, scientific controls, conventional RL, remote fencing and Droplet operation remain unfinished. No training campaign, cloud allocation, additional model-provider call or account-cap increase was part of this qualification.
