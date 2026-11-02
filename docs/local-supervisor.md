# Local supervised execution

The harness now has a persistent local worker and a systemd transport for one trusted Linux host. The worker records start intent before contacting the manager and never uses an existing intent to start again. The implementation is a generic execution boundary; **CoworkeRL training is not enabled**. Frozen-artifact verification, native qualification and an absolute execution-deadline gate remain prerequisites for that integration.

## Ownership and interfaces

`src/execution/types.ts` defines the commands, deployment profile, host/unit identity, observations and journal contract. `journal.ts` owns a separate SQLite database with one controller owner, immutable job/action identities and append-only receipts. `systemd.ts` implements bounded native manager calls. `worker.ts` coordinates those components, including uncertainty, current authorization and serialized operations for each job.

Trusted deployment code constructs a declaration with `createJobDeclaration`, then calls `createSupervisedWorker({journal, transport, workerId, authorize})`. Its operations are `launch(declaration, signal)`, `query(jobId, signal)` and `cancel(jobId, signal)`. There is no general model-facing shell endpoint or training-launch CLI.

The declaration binds the action/backend key, manifest, plan, host/boot identity, literal command, limits and deadline. Unit identity derives from the worker and backend key; the description binds the full declaration. Launch reconstructs that identity and refuses changed or forged declarations. The host, command and limits are declarations until the deployment layer verifies their real provenance.

The required `authorize` callback is trusted synchronous application code. It must check the actual current authority, not a cached model decision. Authorization is checked before creating intent and again immediately before the native manager invocation, after asynchronous transport preflight. Cancellation can address an owned existing job while new launches are stopped. Query never starts, resets or deletes a unit.

## Durable start and recovery

The journal uses WAL with `synchronous=FULL` and a crash-released lifetime ownership lock in a service-owned local directory. It rejects foreign/unsupported stores and conflicting job/action declarations. Existing records return `created:false`; this is evidence of an earlier intent, never replay authority. A genuine process-kill test verifies the difference between an uncommitted transaction and committed intent.

After a lost launch response, matching supervisor evidence can establish acceptance. An empty listing, host reboot, malformed response or unreachable manager cannot establish nonacceptance after intent. Repeating launch queries the original identity. It does not generate a new unit or replace the journal. A crash between recording intent and sending the request can therefore leave an unstarted job uncertain; automatic retries would risk duplicate work.

Acceptance, process state, cancellation requests and cleanup evidence are distinct. Accepted receipts must bind the declared unit and host. Once an invocation has been observed, subsequent queries and cancellation pin that invocation. Malformed or conflicting observations are retained as unknown outcomes. Previously confirmed terminal process outcomes survive later cleanup and unit removal; a stop request cannot rewrite success as cancellation. No process outcome establishes scientific validity or paid allocation release.

## Native transport

The first transport requires Linux, systemd 254 or later and cgroup v2. A trusted profile fixes non-root UID/GID, executable and environment allowlists, read-only roots, writable root and maximum resources. Use a separate profile/writable root per job when jobs must not modify each other's outputs. Keep the journal and controller data outside the writable root. These are deployment obligations, not facts inferred from path strings.

Manager access uses fixed binaries and, when explicitly configured, a fixed noninteractive sudo prefix. The trainer remains non-root. Commands use literal arguments, an empty inherited environment and explicit nonsecret values. Job declarations are stored in the journal, so credentials must not be inserted into them. The current transport has no training-credential provisioning integration.

Systemd controls active runtime, startup/stop intervals, memory, tasks and the owned cgroup, with no restart or cgroup delegation. Filesystem and privilege protections narrow the service's access. This configuration and its tests do not establish hostile-code isolation or verify every host policy.

Manager queue time is currently unbounded. The first real Linux run rejected the transient `JobTimeoutUSec` property generated from `JobTimeoutSec`; systemd 255's setter processes that field but falls through without returning success. The transport therefore omits it while retaining `TimeoutStartSec`, `RuntimeMaxSec` and `TimeoutStopSec`. A timeout on a running manager job would not supply the missing queue deadline and is not used as a substitute. The accompanying generic hint about environment expansion did not identify the rejected property; literal argument handling remains enabled. [Observed CI diagnostic](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41392837686/job/125107754374), [systemd 255 setter](https://github.com/systemd/systemd/blob/v255/src/core/dbus-unit.c#L2034-L2045).

The accepted program is the environment-clearing wrapper. Acceptance is therefore distinct from trainer readiness or native preflight success. Cgroup occupancy remains unknown if the kernel observation cannot be established. The worker does not equate a missing MainPID or absent unit with confirmed cleanup.

## Qualification boundary

Offline tests exercise journal crash windows, exact identities, lost replies, concurrency, late callbacks, fresh authorization, malformed evidence and terminal-state preservation. The separate [Linux qualification suite](systemd-qualification.md) runs short CPU fixtures only when explicitly enabled and records actual manager/process evidence.

`RuntimeMaxSec` bounds active runtime. Pre-send deadline checks and relative start/stop bounds do not bound queued time or prove an absolute completion deadline if manager dispatch is delayed. An independently qualified execution-time deadline gate is still required before connecting this worker to paid training. Remote authentication/fencing, immutable artifact verification, full CoworkeRL/GPU qualification, cloud release and off-host recovery also remain unfinished.
