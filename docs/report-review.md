# Review an archived report without claiming an experiment succeeded

The report-review workflow queues independent, structured assessments of a captured CoworkerRL report. It answers which claims the archive supports and which controls or measurements a follow-up needs. Preparation and aggregation perform no model calls, training, literature searches or experiment registration. Only the separately operated queue runner can invoke the selected CLI reviewers under configured allowances.

The useful first workload uses two roles: a methods reviewer examines provenance, comparisons, uncertainty and falsifiable next tests; a reward/verifier reviewer examines reward correctness, infrastructure errors and the separation between training feedback and independent evaluation. Roles are explicit operator inputs. There is no automatic claim that a particular role name or model establishes expertise.

## Prepare and recover a fixed review plan

`prepareReportReviews(ledger, queue, handlers, request)` takes `projectId`, `campaignId`, `captureId`, `reviewers`, `deadlineAt` and `notBefore`. Each reviewer has a unique `id`, a bounded `role`, backend `codex` or `claude`, and an explicit model identifier or `null` for that client's configured default. The request contains one to twelve reviewers. A changed source, reviewer, model or deadline requires a new campaign identity; the same campaign cannot silently repurpose its existing tasks.

A request file such as `/srv/research/requests/report-review.json` can contain the following. IDs must refer to the configured project and an existing archived capture. The dates are illustrative; choose an actual bounded review window before preparing the campaign. Both model selectors below deliberately use the corresponding client's configured default.

```json
{
  "projectId": "example-project",
  "campaignId": "historical-report-audit-v1",
  "captureId": "archived-report-v1",
  "reviewers": [
    {
      "id": "methods",
      "role": "Assess provenance, evidence sufficiency, baseline comparisons and uncertainty. Separate observations from interpretations and propose falsifiable next tests.",
      "backend": "codex",
      "model": null
    },
    {
      "id": "reward-verifier",
      "role": "Assess reward and verifier validity, infrastructure confounds, and separation from independent evaluation. Identify concrete counterexamples and controls needed before a follow-up.",
      "backend": "claude",
      "model": null
    }
  ],
  "notBefore": "2026-11-02T12:00:00.000Z",
  "deadlineAt": "2026-11-03T12:00:00.000Z"
}
```

Preparation verifies the archived observation's content digest, capture source/version, project identity and supported projection. It does not reread the original report or claim that stored hashes authenticate a third-party producer. The archive contains a sanitized observation, not a complete executable manifest, loaded-process attestation or original checkpoint bytes.

The bounded evidence packet includes the capture and reader identities; producer source/configuration assertions; observed diagnostic metrics; current-checkout provenance distinguished from the historical producer; missing manifest fields; and explicit next-evidence requirements. It shows all step entries up to sixteen, otherwise the first eight and last eight in archived order, while retaining the full count. Diagnostic output counts every entry by severity and code, then shows at most twenty examples prioritized by severity. A late error therefore cannot disappear behind early warnings; counts also preserve issue types omitted from examples. Sampling never implies monotonicity, completion or absence of problems in omitted entries. Oversized or unsupported projections fail preparation rather than being silently interpreted.

Every reviewer receives the same frozen packet and only its own role. There are no dependencies between reviewers, previous reviews or criticism rounds in their task inputs. This prevents sharing earlier reviewers' answers through this workflow; it does not establish statistically independent model errors.

Preparation validates all selected handler contracts, then archives the complete plan as a ledger observation with source `report-review-plan.v1`, null run/action/job links, and stable plan/task identities. Enqueues follow that archive. The ledger and queue are separate SQLite stores: these writes are **not one cross-store transaction**. A crash may leave an archived plan with missing tasks. Repeating the exact request recovers its original packet, timestamp, reviewer identities and tasks, completes missing enqueues, and leaves existing outcomes intact. `loadReportReviewPlan(ledger, planObservationId)` verifies and returns the saved typed plan without coupling callers to the observation layout.

## Calls, quota and interrupted work

Each reviewer task binds the fixed backend handler and account resource key, declares one client-invocation unit per claim, and permits at most two attempts. The initial two-reviewer workload requires two available invocation units; a second attempt consumes another unit under the shared global/project caps. The plan does not grant an allowance or reserve provider tokens. These counters measure admitted official-client wrapper invocations, not provider requests, internal retries or final billing.

Quota and authentication waits never resume automatically. An operator may explicitly resume the task and release its account hold after checking availability; the second attempt keeps the same packet, role and model selector. Unknown completion stays `uncertain`, occupies its existing concurrency slot, and cannot replay through these handlers. Restarting preparation cannot clear an account hold, cancel uncertainty or replenish consumed attempts. The experiment ledger remains the only stop authority consulted by dispatch.

## Aggregate cached reviews and preserve scientific limits

`aggregateReportReviews(ledger, queue, plan)` first verifies the supplied plan against its authoritative archive and the queue's immutable task inputs, handler policy and input digest. It returns `pending` while any reviewer is missing, queued, running, waiting for quota/authentication, or uncertain. No partial council is finalized while a required review might still arrive.

After every task reaches a terminal state, aggregation uses only snapshotted cached results. It checks backend, model selector, successful client completion, reviewer, round and packet identity, then sends cached review content through the existing council validator again. This checks structure, criterion coverage and allowed citation IDs; it does not verify that prose is true or that a citation semantically supports a claim. Missing and malformed responses remain distinct, failed/cancelled/rejected/expired tasks block the council, and valid negative findings retain dissent and required actions. The council has zero revision rounds and cannot call a model. Its timestamp comes from stored task events, so repeating aggregation over unchanged records produces the same result.

The packet marks independent evaluation and baseline comparison as **unknown**. Those checks deliberately prevent a scientific-readiness approval even if every model recommends approval. An aggregation with `status: complete` means the cached review process finished; inspect `decision.status`, blockers, objections and next tests for its conclusion. This scope cannot establish learning benefit, reward/verifier validity, novelty, current literature coverage or conference readiness. A later controlled experiment requires independently established evaluator/baseline evidence and a new experiment or review identity.

The result is an auditable `CouncilResult`, suitable for the existing decision JSON/Markdown writer. It stores structured observations, interpretations, objections and recommendations, not private reasoning transcripts. Aggregation does not write scientific validation receipts or modify experiment state.

## Verification scope

Offline tests cover archive-before-enqueue failure and repair, reopened-store uncertainty, immutable request/plan/task bindings, digest and source rejection, pending states, explicit quota resumption, cached result provenance, malformed/missing/citation failures, preserved dissent and unknown-check blockers. Injected reviewers assert that neither preparation nor aggregation invokes a client. Live subscription authentication, remote dispatch, actual scientific judgments and training remain outside this qualification.
