# Operating the local research queue

The local controller can persist and run bounded research tasks through signed-in official clients. It is a sequential command-line runner; it is not yet an unattended service or a training controller. The separate [task queue](task-queue.md), [fixed handlers](task-handlers.md), and [report-review workflow](report-review.md) define what its saved states mean.

## Configure one trusted owner

Copy [`examples/controller.example.json`](../examples/controller.example.json) into a private runtime directory and adjust its paths. Relative paths resolve from the configuration file's directory. Both the experiment ledger and task queue need distinct files in service-owned local storage. The project root supplies read-only CoworkeRL observations; the summary directory receives derived artifacts.

`maxClientInvocations` is a cumulative local allowance, enforced globally and per project. The example starts at zero. Raising a limit permits additional work but preserves every consumed unit. Reopening the process does not replenish it. One official client invocation can contain internal model requests, so this counter is neither a token limit nor a guaranteed spending ceiling. The signed-in provider account controls actual subscription limits and extra-usage settings.

Every command opens both databases under exclusive ownership, advances experiment-ledger recovery authority, and applies configured limits if they changed. Even `queue-status` is therefore an administrative open, not a passive attachment to an active service. A second owner fails. Keep configuration consistent between invocations; model-generated task files cannot change configured roots, budgets or handler implementations.

## Enqueue, run and inspect

```sh
npm run harness -- queue-enqueue /private/controller.json /private/task.json
npm run harness -- queue-run /private/controller.json 2
npm run harness -- queue-status /private/controller.json
```

`queue-run` executes at most the requested number of currently eligible tasks, one at a time. It exits when that bound is reached or no task can be claimed. It does not wait in a quota loop. Exit code 0 means every stored task is completed; 2 means unfinished or unsuccessful tasks remain; 1 indicates an operational error. A negative scientific recommendation may belong to a successfully completed review.

The runner rechecks ledger stop authority and task cancellation before invocation and while waiting. Each invocation has a three-minute runner bound, reduced by its task deadline; a handler may impose a shorter bound. On cancellation it allows a short cleanup grace. A matching known completion received during grace is retained. Otherwise the task remains uncertain, keeps its invocation unit and parallel slot, and is not automatically retried. A later callback cannot overwrite the recorded uncertain outcome through that abandoned runner.

`SIGINT` or `SIGTERM` first persists the ledger's global stop barrier, then requests cancellation of active work. A forced kill cannot persist that barrier, but startup recovers a claimed task as uncertain. Neither event establishes that external computation has stopped. There is no active-controller administration socket; commands cannot attach to a running owner. After it exits, use the ledger's explicit resume command when resuming is justified.

## Review an archived CoworkeRL report

```sh
npm run harness -- report-review-prepare /private/controller.json /private/report-review-request.json
npm run harness -- queue-run /private/controller.json 2
npm run harness -- report-review-aggregate /private/controller.json PLAN_OBSERVATION_ID /private/decisions
```

Preparation archives the request, evidence packet, reviewer assignments and task identities before enqueueing reviewer work. Repeating the identical preparation repairs missing enqueues after an interruption without replacing completed reviews. Aggregation reads the authoritative archived plan and stored reviews, makes no new model calls, and writes an immutable JSON/Markdown decision bundle. A pending result exits 2. A completed aggregation exits 0 even when scientific readiness is blocked: artifact publication and scientific approval are different outcomes.

The request shape and provenance checks are documented in [report-review.md](report-review.md). This workflow preserves initial independent reviewers. Durable criticism and revision rounds remain to be implemented; the existing separate `review` command still runs its whole council in memory and does not use this queue's invocation allowance.

## Resolve a quota or authentication wait

An unavailable client holds its shared resource (`codex:default` or `claude:default`) across projects. No reset time is inferred from an unstructured error. After obtaining evidence that the account is available, an operator can release the hold with `queue-release-resource` and separately resume a waiting task with `queue-resume`. Both accept bounded JSON requests using the queue's typed input contracts and record the supplied evidence. These operations preserve consumed units, attempt ceilings and the original task deadline.

Release requires the resource's current version, obtainable from `queue-status`; resume requires a unique command ID. Neither changes ledger stop authority. Increasing an allowance does not clear a resource hold. A task with an uncertain official-client invocation has no qualified automated result lookup or retry path in this implementation.

## Deployment boundary

The current commands have no network listener, remote authentication, recurring campaign generation, account-reset discovery or remote worker protocol. Hosting them on a Droplet does not supply those missing capabilities. Local process-crash tests and bounded client reviews qualify the demonstrated behavior only; server sign-in persistence, backups, host-failure recovery and research usefulness need their own acceptance evidence.
