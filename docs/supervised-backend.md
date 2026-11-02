# Ledger-connected local execution backend

The local backend connects admitted ledger actions to the persistent supervisor. It dispatches one prepared launch, observes execution, and sends explicitly admitted cancellation commands. Lost replies and controller restarts recover the existing identity instead of launching or cancelling again. **It supplies no default CoworkeRL deployment resolver and does not enable training from an attempt preview or matching byte receipt.**

## Deployment and authority

`createSupervisedExperimentBackend` in `src/execution/backend.ts` takes the backend/worker identities, existing ledger and job journal, transport and a trusted `prepareLaunch` function. Both stores have one controller owner. A launch action's payload is exactly `{attemptPlanDigest}`. The resolver must validate the exact plan and actual immutable deployment, native prerequisites and runtime profile. It may read and verify existing state; it must not launch, provision, import untrusted project code in the controller or consume paid work as a hidden preparation step.

The resolver returns a `JobDeclaration`, bounded nonsecret evidence and a synchronous `authorizeDeployment` callback, or `null` when no qualified deployment is ready. The bridge verifies action, backend key, manifest, plan, worker, deadline and declaration integrity. It records deployment evidence and the complete declaration digest before asking the worker to launch. Manifest identity, declared plan identity and deployment evidence remain distinct. A matching hash does not itself establish immutable bytes or scientific admission.

The worker is constructed inside the bridge. Its authority callback combines the exact frozen dispatch claim's current ledger authorization with the deployment callback, including the manager's final pre-send check. A stop, policy change, expired dispatch or revoked deployment during asynchronous preparation therefore denies a new start. The existing execution-time gate handles late delivery separately; neither mechanism is a distributed revocation lease.

A run represents one execution. The bridge refuses a new launch when another non-rejected launch action already belongs to that run. Replication and resume require a new registered run with appropriate lineage. Resource release is explicitly unsupported and is rejected before any manager effect.

## Durable operations and recovery

The bridge saves operation intent in ledger observations before calling the worker. That intent binds the dispatch attempt, action payload, target action/job and full worker declaration digest. The worker then saves its own intent before manager submission. These are two separate transactions: a crash between them can leave an operation unknown. The bridge never interprets a missing worker record as permission to start again.

Conclusive replies are archived under a deterministic receipt ID. If the controller loses the reply after this write, reconciliation returns the retained result. Unknown results remain observations that can be superseded by later evidence. Existing launch recovery compares the ledger intent against the journal's full declaration before querying; a command restored from an inconsistent store cannot borrow matching action/plan labels. Reconciliation never invokes the deployment resolver, launch or cancellation.

`cancel` must be a ledger-admitted cleanup action bound to an original launch. It remains possible after a project/global stop when policy permits cleanup. Its authority is rechecked after the asynchronous ownership query, immediately before the manager stop. The receipt identifies that cancellation's exact stop observation and command status. The original job's acceptance cannot acknowledge a later cancellation.

If cancellation's operation receipt is unavailable after interruption, the bridge queries the target and preserves uncertainty about the cancel command. Even a dead target cannot prove that particular command was sent. It does not retransmit the stop automatically. A timeout/SIGKILL result remains failed execution with separately established cleanup; it is not rewritten as successful cancellation.

## Monitoring without changing scientific conclusions

`observe(actionId, signal)` queries the bound launch and archives its worker result with the exact journal observation. For an acknowledged launch with no competing execution, it can record a known execution state in the ledger. Journal sequence identity prevents a newer concurrent observation from being attached to an older result. Conflicting authoritative execution streams remain archived observations; the bridge does not overwrite them.

Execution, evaluation, allocation and financial settlement remain separate dimensions. Observation never approves an evaluator, declares training useful, releases a GPU allocation or settles a reservation. The returned `executionProjected` flag identifies whether the observed state is reflected in the run's execution state; callers can still inspect retained evidence when projection is withheld.

## Qualification boundary

Integration tests use real persistent ledgers and worker journals with an injected manager transport and explicitly synthetic deployment evidence. They exercise dispatch, lost replies, reopening, missing journal identity, authority/deployment revocation, mismatched plans/deadlines, targeted cancellation after global stop, cancellation uncertainty, unsupported release and conflicting execution facts. Separate native Linux tests qualify the transport's lifecycle and authorized cancellation; revocation during its asynchronous ownership query is tested offline. Neither test class establishes an immutable CoworkeRL installation, its CUDA/serving stack, native checkpoint recovery or remote worker operation.

The concrete CoworkeRL resolver remains unfinished because the [byte verifier](integrations/coworker-artifact-verification.md) does not freeze execution inputs and the [native preflight flag](integrations/coworker-native-preflight.md) does not establish complete trainer admission. No permissive resolver is installed as a substitute. The bridge is reusable by separate conventional RL and LLM adapters once their deployment and scientific prerequisites have independent evidence.
