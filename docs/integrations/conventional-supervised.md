# Supervised conventional RL adapter

The fixed FrozenLake adapter now has a deterministic attempt plan, a read-only deployment resolver, a supervised output entry point and an evidence collector. These components connect to the existing experiment ledger and worker journal. The separate local engineering batch command remains available; supervised mode requires exactly one training replica per registered run, with matching replica IDs.

The implementation supports the specific Q-learning experiment in [the Python runner contract](conventional-python-runner.md). It does not provide a general environment runner, checkpoint resume, automatic experiment selection, cloud allocation or a scientific acceptance decision.

## API integration order

These are programmatic APIs; the existing `conventional-run` command remains the separate local engineering path. A trusted controller composes supervised execution in this order:

1. Register the immutable experiment manifest and one-replica run, then call [`prepareConventionalAttempt`](../../src/integrations/conventional/supervised.ts) with that registration, an operation revision and operator-controlled deployment. Planning performs no file reads or launch.
2. Admit a `launch` action through the ledger with backend `conventional-systemd-v1` and payload exactly `{attemptPlanDigest: plan.digest}`. The policy, reservation and fresh dispatch authority remain ledger responsibilities; possession of a plan is not authorization.
3. Configure [`createSupervisedExperimentBackend`](../../src/execution/backend.ts) with the same worker identity, ledger, journal and trusted transport. Supply `createConventionalLaunchResolver` as its `prepareLaunch` callback. Dispatch or reconcile through the existing controller; do not call the entry script as a substitute for admission.
4. Observe the admitted action, retain the exact worker-journal observation ID and digest, then call [`collectConventionalSupervised`](../../src/integrations/conventional/supervised-collection.ts). An execution success without verified artifacts and a verified artifact without owned terminal execution are different incomplete evidence states.

## Identity and deployment

`prepareConventionalAttempt({manifest, run, operationRevision, deployment})` is pure. It derives action identity using the ledger's `(runId, "launch", operationRevision)` rule, builds the exact command and hashes the complete plan. `verifyConventionalAttempt(plan)` reconstructs every derived field rather than accepting a replacement command with a new self-computed digest.

The fixed backend is `conventional-systemd-v1`; the manifest adapter is `conventional_rl` / `frozenlake-q-learning-v1`, with configuration `{spec}`. Code revision/dirty patch, image/dependency declarations, complete seed schedules, reward/evaluator versions, split digest and evaluation policy must agree. The lifecycle fits within the manifest duration. Runtime is capped at two minutes, memory at 8 GiB and tasks at 256, and the configured supervisor maxima can be lower.

`ConventionalDeployment` names the interpreter, runner, entry script, requirements lock, expected source hashes, output root, host/boot, limits and full `SystemdProfile`. Source/interpreter/gate paths must lie within declared read-only roots; the output root must equal the profile's writable root and cannot overlap protected paths. The operator must explicitly assert an immutable deployment and supply a fresh authorization callback that binds the actual deployed profile. The transport independently validates its configured profile and authorization at the manager-call boundary.

The fixed runtime requires Python 3.11, Gymnasium 1.4.0 and NumPy 2.3.5. The resolver observes existing files; it does not install these dependencies or create the output root. Native execution also requires the system-manager profile, non-root training identity and deadline gate described in [the supervisor contract](../local-supervisor.md) and [deadline contract](../execution-deadline.md). The callback is trusted operator policy: the module cannot infer that a separately constructed transport actually uses the asserted deployment profile.

An image digest remains an operator declaration. It is not evidence that an OCI image was used. The dependency digest identifies the declared requirements-lock bytes, not every installed package byte. Current file hashes, package version checks and read-only path declarations do not independently attest immutable deployment. Those distinctions remain in resolver evidence and collection limitations.

## Read-only resolution and crash recovery

`createConventionalLaunchResolver({ledger, deployment, authorizeDeployment})` returns the `prepareLaunch` callback for `createSupervisedExperimentBackend`. It loads the registered run/manifest/action, rebuilds the admitted plan, and checks canonical source paths and bounded regular-file hashes. It creates no output directory and starts no process. Its source observations are retained by the generic bridge.

Request and envelope serialization is canonical, so reloading a manifest from SQLite cannot change command bytes through object-key ordering. The envelope is limited to 72,000 bytes and encoded into arguments of at most 8 KiB. This leaves room for the required deadline gate under its total argument limit. The local engineering protocol's larger input bound does not override this supervised limit.

The generic bridge persists its intent and worker declaration before calling the supervisor. Once such an intent exists, recovery queries the original job; it never resolves a new deployment or starts again merely because a reply was lost. A missing or conflicting ledger/journal binding remains unresolved. Cancellation uses the existing separately admitted targeted cleanup action.

## Child output protocol

`supervised_entry.py` runs behind the required supervisor deadline gate. It validates the envelope and action identity, verifies source bytes, pins directories by descriptor, and exclusively creates an action-specific attempt directory. An existing directory fails before runner module execution. The entry executes the exact runner bytes it read and hashed; this closes that file's read/execute gap without claiming to attest the interpreter or executing entry script.

The child writes three files:

- `intent.json` preserves the exact envelope and explicitly denies replay support.
- `result.json` contains the complete runner JSON output, including every episode and learned Q-table.
- `receipt.json` binds run/action/manifest, request bytes, source references, envelope and exact result bytes.

Files are fsynced and published atomically without replacing an existing destination. The receipt is published last. A crash can leave an intent or partial publication; no successful collection follows from that alone. The small standard-output message is a reference, not the full result or a substitute for supervisor evidence.

## Collection and evidence

`collectConventionalSupervised({ledger, journal}, {collectionId, actionId, plan, observationId, observationDigest})` makes no supervisor call. It verifies the complete registered plan, admitted action, declaration and generic bridge intent, then joins the exact persisted worker observation. Completed collection requires acknowledged dispatch, an owned successful terminal process and explicit empty/absent-cgroup cleanup proof. The worker's first confirmed terminal outcome governs: a later apparent success cannot replace a prior failure.

The collector uses the existing descriptor-relative bounded file reader. It checks the intent, receipt and raw result hashes and parses the full result with the conventional protocol validator. Missing, unsafe, malformed or mismatched output produces an immutable incomplete collection observation. Invalid ownership bindings are rejected before reading output. Duplicate JSON fields are rejected.

A repeated collection ID returns its original observation after verifying the full request identity, including the selected worker observation digest. It does not reread files. A new ID explicitly requests another observation. Completed collection means that the bound artifacts were collected; it does not independently establish learning improvement, generalization or a scientific verdict. The observation retains one training replica, raw-file references, policy/result hashes and the exact worker/bridge evidence references. It changes no execution fact, evaluation state, reservation, charge or allocation state. Raw result retention remains necessary because the compact ledger observation does not duplicate all episode data.

## Qualification boundary

Offline tests exercise real temporary ledgers/journals with injected supervisor observations, lost-response recovery after reopening, source/manifest/profile binding, read-only preparation, harmless entry subprocesses, no-overwrite publication, symlink rejection and incomplete collection. The native Linux test is explicitly opt-in and must be reported separately with its CI revision/result. Passing offline tests does not establish that the real system manager, dependency deployment or Gymnasium workload has passed that native test.
