# RL research harness

A research controller for designing RL experiments, challenging proposals against evidence, and monitoring training. **CoworkerRL is the first integration target.** The intended system supports conventional RL and LLM post-training through separate adapters, with an always-on Droplet controller.

The current code provides subscription-backed reviewers, structured councils, a qualified Pi runtime adapter, an experiment ledger with durable dispatch records, and read-only CoworkerRL capture. Real training backends, a persistent campaign controller and Droplet deployment remain unfinished. See [implementation status](docs/implementation-status.md) for the full scope.

## Run locally

Requires Node 24.12+ or Node 25, npm, and Python 3.11+ for confined file inspection. Install the official Codex or Claude Code client separately for account-backed reviews. Offline tests need no model account.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run harness -- help
npm run harness -- inspect /path/to/CoworkeRL
npm run harness -- observe /path/to/CoworkeRL path/within/project/report.json
```

Inspection reads selected references or an explicit report. It does not execute CoworkerRL code, modify the project or start training. An old report does not establish that a job has stalled.

To preserve an observation and export operational context:

```sh
npm run harness -- capture .harness/coworker.sqlite coworker capture-001 /path/to/CoworkeRL path/within/project/report.json
npm run harness -- ledger-status .harness/coworker.sqlite coworker
npm run harness -- ledger-export .harness/coworker.sqlite coworker .harness/projects
```

Reusing a capture ID retrieves its existing observation; use a new ID for a fresh read. Historical reports do not become executable experiment manifests. [Project state](docs/project-state.md) explains exports and local stop/resume commands.

## Use existing subscriptions

```sh
npm run harness -- smoke codex
npm run harness -- smoke claude
npm run harness -- review packet.json codex .harness/decisions
```

Each smoke command makes one short model call. The review command performs independent methods, systems and adversarial reviews, with up to two proposal revisions, then saves JSON/Markdown decisions. It uses the selected official client's account authentication and does not silently switch to paid APIs. See [subscription workers](docs/subscription-workers.md) for allowance/billing distinctions, tested versions and limits.

A council's approval means its review protocol completed; it does not certify scientific validity. Unknown checks, malformed reviewers and unresolved material validity objections block approval. Model revisions cannot invent new evidence or check results. The [council API](docs/council-implementation.md) documents the evidence schema and callable interfaces.

## Code map

| Path | Responsibility |
|---|---|
| `src/cli.ts` | Explicit inspection and review commands; no training launch command |
| `src/workers/` | Official clients, authentication checks, deadlines, output parsing and council wiring |
| `src/research/` | Versioned evidence, review validation, bounded criticism, routing and decision bundles |
| `src/runtime/` | Optional pinned Pi runtime with persistent conversations and injected models/tools |
| `src/ledger/` | Authoritative manifests, runs, reservations, dispatch identities, observations, accounting and stop barriers |
| `src/controller/` | Single-submission/reconciliation coordinator and ledger-derived project summaries |
| `src/integrations/coworker/` | CoworkerRL references/metrics and descriptor-relative confined file reader |
| `test/` | Offline tests, real process-interruption tests and adversarial input cases |

A resumed conversation is not proof that remote training resumed. Pi state and Markdown remain separate from the authoritative experiment ledger. [Ledger qualification](docs/ledger-implementation.md) and [dispatch qualification](docs/controller-dispatch.md) describe tested local guarantees and the remaining remote-worker requirements.

## Design and evidence

- [Reuse plan](docs/reuse-plan.md), [Pi audit](docs/repo-audits/pi.md), [Ouroboros audit](docs/repo-audits/ouroboros.md): pinned source evidence and reuse decisions.
- [Architecture](docs/architecture.md), [research protocol](docs/research-protocol.md), [roadmap](docs/roadmap.md): the complete target and acceptance gates.
- [Research evidence](docs/research/evidence-and-standards.md): selected primary literature, publication status and limitations; recent selected work reaches October 14, 2026, without claiming an exhaustive search.
- [Pi qualification](docs/runtime-qualification.md), [CoworkerRL integration](docs/integrations/coworker.md): tested boundaries and unknowns.
- [Runtime decision](docs/decisions/0001-runtime.md), [subscription decision](docs/decisions/0002-subscription-workers.md): tradeoffs and reversal conditions.
- [Project context](context/PROJECT.md), [agent instructions](AGENTS.md), [templates](docs/templates/research-records.md): continuity without treating proposals as completed capabilities.
- [Independent code review](docs/reviews/2026-11-01-foundation.md): defects, corrections and regressions.

No cloud resource or CoworkerRL training campaign has been launched by this project. Credentials, databases and generated decisions are excluded from version control.
