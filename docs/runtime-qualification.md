# Pi runtime qualification

**The pinned Pi Durable 1.4.0 adapter passes seven offline integration tests, including real process termination and recovery.** This qualifies a narrow conversation/runtime integration. It does not qualify a cloud deployment, scientific decision policy, paid provider, experiment launch, or spending gateway.

Qualification date: 2026-11-01, America/Los_Angeles. Observed local runtime: Node.js 25.9.0 on macOS. The project targets Node.js >=24.12.0 and <26; this test run does not establish equivalent behavior on every supported Node version or on the deployment Linux host.

## Implemented boundary

The backend-neutral interface is in `src/runtime/types.ts`; the Pi implementation is in `src/runtime/pi-runtime.ts`. The public interface does not expose Pi's internal tables or branded numeric identifiers. IDs are opaque strings scoped to a runtime store.

| Operation | Contract |
|---|---|
| `openPiRuntime(options)` | Open persistent SQLite, acquire/create the root conversation, and resume surviving work. Model collection, trusted tool registry and runtime settings are injected. |
| `submit({requestId, message, conversationId?})` | Durably bind the request ID to the message digest, then admit the input through Pi. Identical retries return the same submission; a changed message under the same ID is rejected. |
| `wait(id, {signal?})` | Return a completed textual answer or an explicit unanswered reason. Aborting this wait does not cancel the agent. |
| `cancel(conversationId?, {includeBackground?})` | Cancel the existing conversation ownership scope. Background work is included only when requested. |
| `inspect()` | Read scheduling, pending submissions, live tasks and blocked-task reasons. This is a point-in-time snapshot, not a streaming subscription. |
| `history(conversationId?, limit?)` | Read 1–1000 recent transcript entries in chronological order; default 100. |
| `usage()` | Read recorded model/tool token and cost totals. These totals may contain estimates and are not spending enforcement. |
| `close()` | Close the runtime and storage. Interrupted work follows Pi's recovery policy on reopen; this does not confirm cancellation of external jobs. |

No shell tools, execution environment, implicit credentials or production delegation policy are installed by this adapter. An injected registry is trusted application code, not an isolation boundary. Model-facing arbitrary code must remain outside the controller process.

The initial agent configuration is applied only when creating the root conversation. Reopening an existing store preserves its configuration; changing the factory options is not a silent model/policy migration.

## Minimal offline use

```typescript
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openPiRuntime } from "../src/runtime/index.ts";

const faux = fauxProvider();
faux.setResponses([fauxAssistantMessage("The baseline result is recorded.")]);
const models = createModels();
models.setProvider(faux.provider);

const runtime = await openPiRuntime({
  storagePath: "./var/agent.sqlite",
  models,
  initialAgent: { model: { provider: "faux", modelId: "faux-1" } },
  settings: {
    compaction: { enabled: false },
    retry: { enabled: false },
    stream: { maxRetries: 0 },
  },
});
try {
  const receipt = await runtime.submit({ requestId: "baseline-review-1", message: "Review the baseline." });
  console.log(await runtime.wait(receipt.id, { signal: AbortSignal.timeout(5_000) }));
} finally {
  await runtime.close();
}
```

The example's fake response validates plumbing only. It is not research reasoning or evidence of model quality. A real provider must be deliberately configured, authenticated and budgeted before use.

## Verification performed

Commands executed from the repository root:

```sh
npm run check
node --import tsx --test test/runtime/pi-runtime.test.ts
```

Both completed successfully. The focused runtime suite reported **7 tests passed, 0 failed**. All model responses came from Pi's deterministic faux provider; no paid model requests were made.

| Test | Observed result | Limit of the conclusion |
|---|---|---|
| Typed tool execution, close/reopen and request deduplication | Tool runs once; response, tool result, usage and root ID remain available after reopen; changed payload is rejected. | Not a remote experiment-launch or external billing test. |
| Request mutation during admission | Each request field is read once before validation or asynchronous work; getter changes and later caller mutation cannot change the admitted message or its identity. | Protects this request boundary, not arbitrary mutable objects inside injected tools. |
| Safe tool interrupted by `SIGKILL` | A child Node process is killed while its tool is executing; a fresh runtime reopens SQLite and reruns the safe tool once. | The test tool has no external effect. Declaring a tool replay-safe does not supply external idempotency. |
| Unsafe tool interrupted by `SIGKILL` | Reopen records an interrupted tool result; the unsafe implementation is not rerun. | A real external effect may have happened before the crash and still requires reconciliation. |
| Wait cancellation versus work cancellation | A cancelled waiter leaves the tool running; explicit conversation cancellation aborts it and settles the input unanswered. | Cooperative tool cancellation only; does not demonstrate remote-job termination. |
| Owned child cancellation | Parent abort reaches the child conversation and its blocked tool; live tasks drain. | Uses a controlled trusted test extension, not a production council. |
| Background ownership boundary | Ordinary cancellation leaves background child work running; explicit background-scope cancellation aborts it. | Work created after the abort's scope snapshot is outside this guarantee. |

The forced-death tests run the actual installed packages in a subprocess and send `SIGKILL`; they are stronger than calling `close()` and reopening. They still do not simulate host power loss, storage corruption, disk exhaustion, a network filesystem, database restore skew or a remote provider's ambiguous launch response.

## Persistence and recovery qualifications

The adapter uses a separate Pi-owned SQLite database and changes the upstream `synchronous=NORMAL` setting to `FULL`. That setting is a deliberate durability choice, not evidence that power-loss recovery has been tested. Backups and restore drills remain required. An in-process path guard prevents accidental double-open in one Node process; **cross-process single ownership must be enforced by the hosting service**. Path aliases and separate processes are not a distributed ownership mechanism.

Request-payload binding and Pi submission admission occur in two ordered commits because the pinned release does not expose the newer transactional submission convenience. Binding happens first. If the process stops between them, an identical retry passes the stored binding and submits with the same request ID. This covers local request identity; the experiment broker must separately own external action identity and reservations.

Pi's safe/unsafe replay rules are respected without reinterpretation. `cancel()` is a scoped agent operation, not the project's durable stop barrier. The broker still needs the admission barrier, worker authorization checks and external cancellation/reconciliation described in `architecture.md`.

## Release fidelity

Dependencies are exact `@earendil-works/pi-durable`, `@earendil-works/pi-ai` and `@earendil-works/chord` **1.4.0** packages installed by the project lockfile. The adapter and tests were checked against their installed declarations and implementation, rather than the newer main-branch API.

Release-specific distinctions include TypeBox tool schemas, the two-argument `onReport(error, info)` callback, and no use of main's newer `maxTurns` or transactional `submit(tx, ...)` interface. The upstream package remains experimental. Its published release corresponds to the audited [v1.4.0 source](https://github.com/earendil-works/pi/tree/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable); the earlier source audit is in `repo-audits/pi.md`.

The owned-child fixtures use the public ownership/configuration primitives described by Pi's release examples. They are qualification fixtures, not a production subagent manager. No upstream implementation files were vendored.

The default Pi root is one continuing conversation. It must not be reused as the supposedly independent context for different council reviewers. A future Pi-backed council needs separate conversations and the same versioned evidence packet, with opinions withheld until independent assessments are stored. The CLI council uses separate isolated official-client sessions; that execution path does not share this Pi root.

## Subscription-backed workers and billing

`AgentRuntime` is backend-neutral. This Pi implementation is one optional backend; a Codex or Claude Code CLI worker can implement a separate adapter using that product's supported sign-in and account usage. This module does not launch either CLI, extract subscription credentials, or treat a subscription login as a generic model API key.

This adapter does not implement automatic fallback from an authenticated subscription worker to a paid API provider. The application must select its backend explicitly and report its authentication/billing mode; injected provider configurations must preserve that rule. Pi's usage totals do not establish subscription quota availability or an account invoice.

## Remaining qualification work

- Enforce a single process owner on the deployment host and test restart/restore behavior there.
- Connect every actual model-call path to a verified admission gateway, including internal retries, compaction, hooks and tool-triggered calls. **No hard model-spend cap is implemented here.**
- Validate a deliberately selected live provider and its cancellation, timeout, retry and usage semantics. Offline success does not establish live-provider compatibility.
- Add project/task scope, deadlines, model selection, bounded delegation and a durable global-stop policy before unattended campaigns.
- Qualify experiment actions independently: stable external keys, launch reconciliation, checkpoint integrity, deadlines and allocation release.
- Test compaction and context-record consistency with the real project evidence workflow. Automatic compaction was disabled in these deterministic tests.

The current result supports proceeding with the pinned Pi integration while preserving the application-owned broker and backend-neutral interface. It does not authorize or certify unattended paid operation.
