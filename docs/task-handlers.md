# Bounded research task handlers

The scheduler's handlers perform one reviewer invocation, archive one CoworkeRL report observation, or publish one operational project snapshot. They do not launch training, fetch papers, invent a scientific manifest, or run a complete research council inside one queue task.

## Fixed task contracts

`createResearchTaskHandlers` in `src/scheduler/handlers.ts` accepts the existing controller-owned experiment ledger and a trusted `projects` map:

```ts
const handlers = createResearchTaskHandlers({
  ledger,
  projects: {
    coworker: {
      root: '/path/to/CoworkeRL',
      summaryDirectory: '/private/runtime/project-summaries',
    },
  },
});
```

The factory snapshots this configuration. Queued tasks cannot supply or replace a project root or export directory. The operator must protect the configured paths and process configuration; this interface is not an OS isolation boundary.

| Kind | Input | Client invocation allowance units | Resource | Replay policy |
|---|---|---:|---|---|
| `cli-review-codex` | `packet`, `reviewer`, `model`, optional `timeoutMs` | 1 | `codex:default` | Never automatically replay an uncertain attempt |
| `cli-review-claude` | Same review shape | 1 | `claude:default` | Never automatically replay an uncertain attempt |
| `coworker_capture` | `captureId`, project-relative `reportPath`, optional `observedAt` | 0 | None | Reconcile through stable capture identity |
| `project_summary` | Optional `observedAt` | 0 | None | Safely recompute and publish an immutable view |

These units count declared official-client invocations. They are not an exact count of model requests, provider retries or charges: an official client can perform internal work. Backend, resource and replay metadata come from the fixed handler definition, not from task input. No handler changes accounts, rotates providers, falls back to API billing or retries a model call to obtain approval.

The runner calls `handler.validate(input, projectId)` before enqueue so invalid work need not consume an invocation allowance. `execute(claim, signal)` revalidates the queued policy and input immediately before use. Fresh queue/ledger authority, task deadlines and persistence of intent/results remain the runner's responsibility; the handler alone does not authorize a claim.

## One reviewer, one immutable evidence packet

Review input contains an already digested `EvidencePacket`, a reviewer `{id, role}`, and an explicit model selector. A model string is passed unchanged to the selected official client. `model: null` explicitly chooses that client's default; it does **not** establish which underlying model version the client will select. `timeoutMs` defaults to 120,000 and must be between 1 and 300,000 milliseconds. The exact fixed prompt must fit within 512,000 bytes.

Only round zero is supported. The handler constructs empty prior-review and objection lists, uses the evidence-only review prompt, and validates the returned JSON against the packet digest, reviewer ID, criteria and evidence IDs. Caller-supplied arbitrary prompts, prior rounds and objections are rejected. This prevents a task from presenting unverified prior reviews as authoritative history.

A valid reviewer recommendation of `reject`, `revise` or `abstain` completes the review task. It remains a negative scientific finding in `reviewOutcome`; successful execution does not mean approval. Missing or malformed review JSON is a failed review task, even if the official client reported successful execution. The result retains client status/usage metadata and the response byte count/hash. A valid structured review is retained; oversized responses above 1,000,000 bytes are rejected rather than stored partially. Malformed output retains its total validation-issue count and at most 64 issue excerpts, each bounded to 2,048 characters, so diagnostic expansion cannot prevent durable failure recording.

These original handlers remain round-zero contracts. The separate [durable council](durable-council.md) now persists critic and revision steps through archived stage handlers, verifies previous-round bindings, and resumes completed work. The standalone in-memory council remains available; running it does not gain the queue's recovery or invocation caps.

## Failure and availability evidence

| Observed result | Handler outcome | Interpretation |
|---|---|---|
| Valid structured review | `completed` | One reviewer produced usable evidence-linked output; verdict is separate |
| Missing/malformed review after client success | `failed` | No usable structured review; no inferred approval |
| Client `rate_limited` | `waiting_quota`, `retryAt: null` | Hold the selected resource; current adapter supplies no reset timestamp |
| Client `auth_required` | `waiting_auth`, `retryAt: null` | Authentication needs attention; no automatic credential repair |
| Proven spawn/auth-preflight failure | `failed` | Review process/request was not successfully started |
| Timeout, cancellation after invocation, thrown executor, invalid/mismatched client result, missing completion receipt or otherwise ambiguous failure | `uncertain` | No trustworthy completed result; do not assume remote work or usage stopped |
| Pre-aborted handler | `cancelled` | No client invocation started by this handler |
| Invalid task input or changed handler metadata | `rejected` | Fixed task contract was not met; no invocation |

The queue stores quota/auth resource holds across sibling tasks and projects. A missing reset timestamp is not a guessed timer. Explicit controller release/resume requires evidence and remains separate from handler execution. The handler preserves the original `CliTaskResult.status` even when an ambiguous failed client process requires the more conservative queue state `uncertain`.

## Capture and export semantics

Capture delegates to the [observation-only archival API](integrations/coworker-capture.md) using the configured project root. Its queue result contains an observation identity and digest; the sanitized full payload remains in the experiment ledger. Repeating the same capture ID retrieves the prior observation without rereading source/report contents. Missing-file diagnostics can be archived successfully: completion means the observation was stored, not that training is healthy.

Project export delegates to the existing [project-state publisher](project-state.md) under the configured summary directory. It does not overwrite ledger records or grant authority. A replay can recompute a newer state and publish another immutable bundle, especially if the prior process died after publication but before recording its result. Supplying `observedAt` pins the reporting clock only; it does not freeze the ledger state. Content digests and event positions identify what each artifact actually contains.

## Qualification and limits

Offline tests inject client executors and use a temporary real ledger for capture/export. They cover fixed backend/model behavior, preserved negative findings, missing/malformed reviews, quota/auth holds without invented times, ambiguous completion, cancellation, metadata bypass attempts, unconfigured projects, forbidden task-controlled paths, configuration/caller mutation and stable capture recovery. No live client calls or training are performed by these tests.

This handler API does not itself implement source retrieval, novelty assessment, revision orchestration, quota-reset discovery, remote worker enforcement or scientific qualification. The new durable workflow supplies revision orchestration separately, and the literature module provides bounded arXiv metadata/abstract capture; their limits remain explicit.
