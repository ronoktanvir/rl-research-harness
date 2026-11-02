# Terminal cleanup evidence

The supervisor can now retain positive cleanup evidence after systemd clears a terminal unit's `ControlGroup` field. On the qualified Linux image, the production transport observed the exact owned cgroup's absence, bound that observation to the service invocation, and allowed the worker to preserve a terminal execution result across journal reopening. **Process cleanup, execution outcome and resource settlement remain separate facts.**

## Implemented evidence contract

[`ServiceCleanupEvidence`](../src/execution/types.ts) records `kind`, `controlGroup`, `invocationId`, `observedAt` and `confirmedAt`. Its two kinds are `cgroup_v2_empty` and `cgroup_v2_absent`. The evidence names the expected kernel path `/system.slice/<owned-unit>`; it does not replace or invent the manager's `ControlGroup` observation. The surrounding snapshot retains the declared unit/description, machine and boot identity, manager state and process outcome.

The native [`systemd` transport](../src/execution/systemd.ts) requires this sequence before producing terminal cleanup evidence:

1. Read a matching loaded unit with a nonzero invocation ID, no main PID, an established process exit and a supported terminal state.
2. Inspect its exact expected cgroup in a pinned cgroup v2 mount. An existing group's `cgroup.events` must contain one valid `populated 0` value, or opening the group directory must establish its absence. A missing events file, denied read or malformed observation is not absence proof.
3. Read the loaded unit again, requiring the same invocation, terminal state, result, exit code and status. Recheck host identity, cancellation and observation-clock ordering.

The kernel reader checks the filesystem type and descriptor mount ID, requires the full `/sys/fs/cgroup` root mount without nested overmounts, and verifies its expected view of PID 1 at `/init.scope`. It compares the mount context before and after the read. These checks support the tested standard system-manager deployment; they are not an attestation against a privileged host administrator, or a claim that arbitrary container/cgroup namespace arrangements are supported. Unsupported or changing context remains unknown.

A successful sequence sets `cgroupPopulated: false` and adds the separate cleanup evidence. A terminal unit with a populated group produces an unknown query result. A terminal unit with unreadable or otherwise unestablished kernel evidence retains unknown occupancy. Unit absence by itself still establishes neither cleanup nor nonacceptance of an earlier launch.

## Persistence and outcome interpretation

The [`job journal`](../src/execution/journal.ts) validates the proof's exact owned path, invocation and timestamp ordering. It requires a terminal process snapshot, zero main PID and false occupancy. It rejects a replaced invocation, another unit's path, proof attached to a live process, unestablished exit, inconsistent occupancy and malformed proof fields. A manager snapshot with an empty path cannot claim false occupancy without this validated evidence. Historical snapshots remain readable; adding the optional field does not retroactively manufacture proof for them.

The [`worker`](../src/execution/worker.ts) keeps an established terminal outcome when subsequent queries cannot find the unit or the journal is reopened. Exit zero with a successful result becomes `succeeded`; manager failure remains `failed`. Its narrower `stopped` classification requires a recorded stop command and compatible signal/result evidence. In the real forced-shutdown case below, the manager reported `timeout`, so the worker returned `failed`, with reason `stop_observed`. Sending cancellation did not rewrite a timeout into success or establish the full causal history of the exit.

The journal records evidence. It does not release a ledger reservation, confirm VM deletion, settle provider charges, approve evaluation or validate a checkpoint. Cleanup evidence establishes the observed state of the owned service's process boundary under the deployment assumptions; cloud allocation and billing require their own authoritative observations.

## Verified Linux result

[CI run 41395292611](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41395292611) tested source `0ded185b603fa09064b4ed22885d8c03f2a45c62`; all three jobs succeeded. The [Linux supervisor job 125115199740](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41395292611/job/125115199740) passed five CPU lifecycle cases and their parent test: six passes, zero failures, 7.54 seconds total. Its environment was Ubuntu 24.04.5, runner image `20261025.353.1`, Node `24.22.1` and systemd 255 (`255.4-1ubuntu8.18`).

| Observed case | Manager outcome | Production cleanup evidence |
|---|---|---|
| Successful process | `active/exited`, `success`, exit 0 | Owned cgroup absent; occupancy false |
| Nonzero process | `failed/failed`, `exit-code`, exit 23 | Owned cgroup absent; occupancy false |
| Relative runtime expiry | `failed/failed`, `timeout`, signal 9 | Owned cgroup absent; occupancy false |
| Explicit stop of ignoring parent and detached child | `failed/failed`, `timeout`, signal 9 | Owned cgroup absent; occupancy false |
| Worker cancellation after lost-reply recovery and reopening | Acceptance `accepted`, execution `failed`, reason `stop_observed` | Owned cgroup absent; occupancy false; terminal classification retained after another reopening |

Every logged terminal snapshot still had `controlGroup: ""`. The added evidence used `kind: "cgroup_v2_absent"`, the exact expected service path and matching invocation, with ordered observation/confirmation timestamps. Before cancellation, the lost-reply worker observed `accepted/running` and a populated cgroup. Its repeated launch after journal reopening queried the original invocation, with exactly one actual start and one original fixture start marker.

The real tests require production cleanup evidence and also independently compare recorded process start ticks, cgroup membership and termination before the fixture's fallback timer. The parent and detached child both demonstrate ignored SIGTERM before cleanup. These independent checks corroborate the production observation rather than substituting for it. This run exercised native **absence** evidence; native empty-but-still-present cgroup evidence has offline coverage, not a separately logged real case here.

The earlier [run 41393686347](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41393686347), at `150723f2346551ab2debecb6f19d03d22e191a68`, had passed fixture cleanup while production terminal occupancy remained null and worker cancellation remained unknown. That limitation was real at that source revision. The new receipt and matching terminal observations close that specific gap on the tested image; they do not invalidate the earlier record. Startup failures and their corrections remain in [systemd qualification](systemd-qualification.md).

## Offline checks and scope

The focused cleanup and transport review ran 31 offline tests successfully before this CI run. They cover empty/absent proof, hierarchy mismatch, invocation replacement, terminal-state changes, malformed confirmation, reboot, cancellation, clock reversal, persisted terminal results and rejection of invalid proof. The [Node 24 CI job](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41395292611/job/125115199076) subsequently reports 362 passing offline tests, zero failures and one deliberate real-systemd skip; the separate opt-in job provides the actual service evidence. The Node 25 job also passed. No local service invocation was used to write or review this document.

The same tested source includes the separate [artifact byte verifier](integrations/coworker-artifact-verification.md), with 14 focused tests. Root review corrected an input-path bound that originally applied only to source traversal: selected input ancestors and returned reader output now also obey configured depth. Directory-count coverage is explicitly source-only, and previews have a 1 MiB encoded bound plus early structural/string checks. This is a review correction to the byte-verification contract, not evidence of immutable deployment, native adapter fingerprints, complete checkpoint validation or a newly enabled trainer.

Qualification remains limited to these short, non-root CPU fixtures and this host layout. It does not establish host-reboot recovery, hostile-code containment, remote fencing, provider resource release, GPU/vLLM behavior, native CoworkeRL execution, scientific validity or later deadline-gate changes. An actual training backend still needs its distinct artifact, authority, execution and resource contracts qualified before enablement.
