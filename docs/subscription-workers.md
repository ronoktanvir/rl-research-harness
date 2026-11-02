# Subscription-backed workers

Status: implemented for bounded evidence-only reviews through the official local clients. Both clients completed a one-message live smoke test on 2026-11-01 using the account authentication present on this machine. This does not verify unattended server operation, quota-reset scheduling or paid training.

## Account access and API access are different

Codex supports ChatGPT account sign-in, and `codex exec` reuses saved authentication. Its documentation includes account-authenticated automation on trusted private runners. API usage has a separate billing/credit balance. See [Codex authentication](https://learn.chatgpt.com/docs/auth?surface=cli) and [non-interactive operation](https://learn.chatgpt.com/docs/non-interactive-mode).

As verified on 2026-11-01, eligible ChatGPT Pro and Business subscribers can activate included API credits. They do not increase signed-in Codex limits, and the benefit excludes Codex usage through API keys. Eligibility and activation for this user's account were not checked; no API fallback was enabled. See [API credit eligibility and coverage](https://developers.openai.com/api/docs/guides/chatgpt-api-credits).

Anthropic permits an end user to sign into the unmodified Claude Code client with their subscription. Its documentation distinguishes that use from third-party applications collecting or routing users' subscription credentials. This harness calls the unmodified client; it does not implement Claude login or use Claude subscription tokens in Pi's API provider. See [Claude authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance).

These integrations consume the selected account's allowance. They do not multiply that allowance or guarantee unlimited use. Any account-level extra-usage/credit settings remain under the provider's control; an OAuth session is not proof of zero additional billing. The harness does not configure an API fallback or change those settings.

## Implementation

`src/workers/cli.ts` performs an official-client authentication-status check before each invocation. A recognized ChatGPT/Claude account method is required; an API login, unknown method, missing client or failed check is reported without making a model request. The process environment omits API keys, gateway overrides, cloud credentials and nested-agent variables. An already configured `CLAUDE_CODE_OAUTH_TOKEN` is forwarded only to the unmodified Claude client; the harness never logs, persists, refreshes or sends it to another backend. Normal client-managed credential storage remains inside the official client.

The reviewer runs in a fresh temporary directory, receives the evidence in stdin, and suppresses tools/customizations through explicit client options. Codex uses read-only execution with shell, app, browser, plugin and delegation features disabled. Claude uses safe/restricted modes with an empty tool list. This is an evidence review interface, not a general coding worker or an OS isolation boundary for untrusted native software.

The wrapper requires a successful terminal protocol result. Partial text, malformed output, failed turns, timeouts, missing authentication and usage limits are distinct failures. It bounds output and wall time, terminates the process group on Unix, and preserves escalation after the immediate child exits. Processes that deliberately escape their group and Windows descendant termination remain outside this qualification; server worker isolation still needs a separate boundary.

The wrapper records token counts when reported. It deliberately does not convert a client's cost estimate into a subscription invoice. There is no automatic retry, account rotation or switch to paid APIs. Scheduling a retry after a quota reset remains future controller work; the current council records a blocked reviewer.

## Commands

```sh
npm run harness -- smoke codex
npm run harness -- smoke claude
npm run harness -- review packet.json codex .harness/decisions
```

The smoke commands each make one short real model request. Offline tests use injected clients and make no model calls. `review` makes three independent reviewer calls and, when needed, up to two proposal revisions with repeated reviews. It returns exit code 2 when the decision remains blocked or requires revision, and writes a complete JSON/Markdown record. It cannot start training.

To mix providers, call `runCliCouncil` with a backend per reviewer. Each invocation creates a fresh session; one reviewer does not inherit another reviewer's conversation. Model selection is optional and explicit. Actual tier defaults should be selected from measured task performance, not invented provider rankings.

The bounded reviser can modify proposal text only. It cannot invent new evidence, mark a check passed or silently change the research question. A missing experiment or source therefore remains missing after criticism; the next controller stage must actually obtain it.

## Qualified versions and remaining work

Local smoke tests used Codex CLI 0.156.1 and Claude Code 2.1.281 on macOS with Node 25.9.0. Client flags and event formats can change; repeat qualification before upgrading or deploying on a Droplet. The automated suite checks parsing, API-auth rejection, environment separation, quota behavior, deadlines, descendant cleanup and council wiring. CI does not log in to either service.

Pending: a persistent work queue, usage-reset scheduling, crash reconciliation for an interrupted client invocation, controller-wide stop and concurrency limits, permission-scoped coding workers, and server authentication setup. Pi remains an optional runtime backend for injected providers; its conversation recovery does not automatically apply to these separate CLI processes.
