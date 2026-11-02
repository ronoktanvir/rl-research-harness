# Durable review, revision and renewed criticism

The durable council workflow carries a bounded research discussion across process restarts. It stores each independent critic and each proposal revision as a distinct task, reuses completed outputs, preserves dissent and asks the original critic to resolve its objections. It does not fetch evidence, launch training or turn model agreement into scientific validation.

## Run a campaign

A `CouncilPlanRequest` contains the project/campaign IDs, a verified evidence packet, explicit reviewers (`id`, `role`, `backend`, `model`), an optional reviser, `maxRevisions`, `notBefore` and `deadlineAt`. `model: null` chooses the official client's default; it is not proof of the model version that served the request. The operator's [controller configuration](local-controller.md) supplies invocation allowances and trusted projects.

```sh
npm run harness -- council-prepare /private/controller.json /private/council-request.json
npm run harness -- council-run /private/controller.json PLAN_OBSERVATION_ID 5 /private/decisions
npm run harness -- council-advance /private/controller.json PLAN_OBSERVATION_ID
```

Preparation archives the complete plan and materializes the first review tasks without model calls. `council-run` progresses only that campaign, up to the requested task bound and shared allowances. It alternates deterministic advancement with individually admitted handler executions. `council-advance` uses cached records only; it can materialize the next stage or finalize a result but cannot invoke a client.

A two-reviewer council with one revision normally needs five successful task executions: two initial critics, one reviser, then both critics again. Explicit quota/authentication resumption can consume another attempt and invocation unit. Plans allow at most twelve reviewers and five revisions; each task permits two attempts. No limit grants provider quota or changes the account's billing settings. The example configuration retains zero allowance until the operator sets it.

`council-run` writes a JSON/Markdown bundle when the process reaches a final decision, including a blocked decision. Exit 0 means the final artifact was produced; inspect `decision.status` for the scientific protocol result. Exit 2 means required work remains pending, and 1 reports an operational error. Interrupt signals persist the global stop barrier before requesting cancellation, as for the ordinary queue runner.

## How recovery preserves the discussion

The initial plan binds question, criteria, evidence, independent checks, reviewers, models, revision bound and overall time window. Each stage is archived before its queue task. The task contains only the archive reference; an arbitrary queued JSON file cannot supply a replacement prompt or invented review history. Stage loaders and handlers enforce the [archived contract](council-handlers.md).

Advancement replays the existing council protocol using cached outputs. Missing tasks are materialized, while completed critics and revisions are read without invoking their clients. All critics in one round receive the same pre-round history. The reviser is scheduled only after every required critic returns a valid assessment. An invalid or failed critic blocks the campaign rather than prompting new calls in search of a usable or favorable verdict.

Revision output contains only proposal text. The controller constructs the next packet with unchanged question, evidence, criteria and independent checks. A missing baseline therefore remains missing after any amount of discussion. The original author of an objection alone can resolve or withdraw it, with evidence references checked by the core validator. Model-written reasoning and references remain claims to assess; citation ID validation cannot establish semantic truth.

The ledger archive and queue are separate stores. A failure between stage archival and enqueue leaves repairable intent: the next advancement reconstructs the same context and enqueues the missing task. Changed content under an existing identity conflicts. Database, contract or cache-binding errors remain controller errors and cannot be finalized as scientific verdicts. The final decision is separately archived and compared with deterministic replay on subsequent advancement.

Pending quota, authentication, running or uncertain tasks prevent finalization. Completed siblings remain usable. Restart never repeats an uncertain official-client call. A claim that discovers expired selected tasks refreshes the campaign state immediately, permitting a blocked final result instead of returning stale queued status. Task-ID filtering prevents a campaign runner from claiming another campaign's work.

## Authority and limits

Only the trusted controller may write campaign/stage archives. Hashes establish consistency, not authenticity against arbitrary store writers. The exported low-level builder and ledger append API do not independently attest that prior model calls happened; production callers must use the workflow and protect database access. The queue still consults the experiment ledger as its sole stop authority.

The workflow stores complete bounded history rather than silently summarizing dissent. The existing record and prompt byte limits apply; excessive history fails explicitly. It is a local sequential runner with durable state, not a distributed or recurring campaign service. Scientific performance, diversity benefits, full-paper research and remote worker guarantees still require separate qualification.

Offline integration tests cover a complete two-round cycle across reopening, independent same-round context, preserved objection resolution, proposal-only changes, malformed critics/revisions, unknown checks, partial enqueue repair, expiry, quota/uncertainty and exclusion of unrelated tasks. CLI subprocess tests deny network/client invocation while checking zero-allowance expiry and immutable artifact replay. No live model calls were used to qualify this new workflow.
