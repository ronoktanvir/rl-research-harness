# RL research harness

A research controller for designing RL experiments, challenging proposals against evidence, and monitoring training. **CoworkerRL is the first integration target.** The intended system supports conventional RL and LLM post-training through separate adapters, with an always-on Droplet controller.

The current code provides subscription-backed reviewers, durable review/revision councils, a qualified Pi runtime adapter, an experiment ledger connected to a local Linux supervisor, CoworkerRL capture/assessment and persistent diagnostic workflows, a bounded conventional RL adapter, attempt/byte/native-output checks, a persistent task queue, and bounded arXiv metadata/abstract ingestion. CoworkerRL execution, general training adapters, automated full-paper assessment, autonomous experiment selection and Droplet deployment remain unfinished. See [implementation status](docs/implementation-status.md) for exact qualification and live failures.

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

`npm run harness -- coworker-plan attempt-request.json` prints an immutable [attempt preview](docs/integrations/coworker-attempt-plan.md) with manifest-bound settings and command arguments. It validates declarations only; it does not inspect source/checkpoint bytes, run native preflight, admit a job or start training.

To preserve an observation and export operational context:

```sh
npm run harness -- capture .harness/coworker.sqlite coworker capture-001 /path/to/CoworkeRL path/within/project/report.json
npm run harness -- coworker-assess .harness/coworker.sqlite coworker capture-001
npm run harness -- ledger-status .harness/coworker.sqlite coworker
npm run harness -- ledger-export .harness/coworker.sqlite coworker .harness/projects
```

Reusing a capture ID retrieves its existing observation; use a new ID for a fresh read. Historical reports do not become executable experiment manifests. [Project state](docs/project-state.md) explains exports and local stop/resume commands.

The [deterministic assessment](docs/integrations/coworker-assessment.md) scans all captured steps, archives ranked diagnostic requests and produces a council evidence packet. It uses no model calls and preserves missing evaluation/baseline evidence. The [historical assessment](docs/research/coworker-assessment-2026-11-02.md) records the actual 30-step archive result.

The [assessment workflow](docs/assessment-workflow.md) connects captured evidence to a zero-call queue task and persistent unresolved work items. `assessment-prepare`, `assessment-run` and `assessment-advance` preserve source/rule bindings across restart. Completing an assessment does not resolve its scientific questions.

The [local conventional adapter](docs/integrations/conventional-local.md) runs fixed-map FrozenLake with separately trained policies, frozen evaluation and one shared random baseline. It requires a pinned Python 3.11 environment and an explicit `conventional-run` command. The [first real qualification](docs/research/conventional-qualification-2026-11-02.md) retains all three policy outcomes; it is an engineering result, not a general learning claim or a CoworkerRL campaign.

## Use existing subscriptions

```sh
npm run harness -- smoke codex
npm run harness -- smoke claude
npm run harness -- review packet.json codex .harness/decisions
```

Each smoke command makes one short model call. The review command performs independent methods, systems and adversarial reviews, with up to two proposal revisions, then saves JSON/Markdown decisions. It uses the selected official client's account authentication and does not silently switch to paid APIs. See [subscription workers](docs/subscription-workers.md) for allowance/billing distinctions, tested versions and limits.

For persisted tasks and invocation caps, configure the [local controller](docs/local-controller.md), then use `report-review-prepare`, `queue-run` and `report-review-aggregate`. The queue stores each review separately, holds clients that report quota/authentication problems, and leaves interrupted calls uncertain. Its caps count official-client invocations, not provider requests or charges. The standalone `review` command above is separate and does not use these queue caps.

For complete persisted criticism rounds, use `council-prepare` and `council-run`; the [durable council guide](docs/durable-council.md) explains recovery and evidence constraints. Official clients now receive explicit [output schemas](docs/structured-output.md), with scientific validation still performed independently by the controller. [Literature discovery](docs/literature-discovery.md) constructs source-linked evidence from captured arXiv responses while preserving unknown full-paper and venue checks.

A council's approval means its review protocol completed; it does not certify scientific validity. Unknown checks, malformed reviewers and unresolved material validity objections block approval. Model revisions cannot invent new evidence or check results. The [council API](docs/council-implementation.md) documents the evidence schema and callable interfaces.

## Code map

| Path | Responsibility |
|---|---|
| `src/cli.ts` | Inspection/review commands and explicit bounded local FrozenLake execution; no CoworkerRL launch command |
| `src/workers/` | Official clients, authentication checks, deadlines, output parsing and council wiring |
| `src/research/` | Versioned evidence, review validation, bounded criticism, routing and decision bundles |
| `src/runtime/` | Optional pinned Pi runtime with persistent conversations and injected models/tools |
| `src/ledger/` | Authoritative manifests, runs, reservations, dispatch identities, observations, accounting and stop barriers |
| `src/controller/` | Single-submission/reconciliation coordinator and ledger-derived project summaries |
| `src/execution/` | Ledger-connected dispatch/cancellation/status, durable job intents, deadline-gated systemd execution and process/cleanup evidence |
| `src/scheduler/` | Persistent tasks, invocation admission, account holds, bounded local runner and archived-report review plans |
| `src/literature/` | Bounded arXiv queries, strict Atom parsing, captured response provenance and abstract-scoped evidence packets |
| `src/integrations/coworker/` | CoworkerRL capture/assessment, confined file reader, attempt previews, artifact bytes and native-preflight output interpretation |
| `src/integrations/conventional/` | Fixed Python worker, bounded protocol, pinned dependencies and auditable local experiment artifacts |
| `test/` | Offline tests, real process-interruption tests and adversarial input cases |

A resumed conversation is not proof that remote training resumed. Pi state and Markdown remain separate from the authoritative experiment ledger. [Ledger qualification](docs/ledger-implementation.md) and [dispatch qualification](docs/controller-dispatch.md) describe tested local guarantees and the remaining remote-worker requirements.

The [local supervisor](docs/local-supervisor.md) records intent before start and queries existing jobs after lost responses. Its [cleanup evidence](docs/cleanup-evidence.md) and [deadline contract](docs/execution-deadline.md) state the tested guarantees and host assumptions. [Linux qualification](docs/systemd-qualification.md) uses explicit CPU-only CI tests; ordinary tests skip service creation. Native trainer readiness, immutable deployment and allocation release require separate evidence.

The [supervised backend](docs/supervised-backend.md) connects admitted actions to that supervisor and keeps execution separate from evaluation and billing. It requires a trusted deployment resolver; none is installed for CoworkerRL. The [native preflight contract](docs/integrations/coworker-native-preflight.md) explains why passing the native flag alone cannot enable training.

## Design and evidence

- [Reuse plan](docs/reuse-plan.md), [Pi audit](docs/repo-audits/pi.md), [Ouroboros audit](docs/repo-audits/ouroboros.md): pinned source evidence and reuse decisions.
- [Architecture](docs/architecture.md), [research protocol](docs/research-protocol.md), [roadmap](docs/roadmap.md): the complete target and acceptance gates.
- [Research evidence](docs/research/evidence-and-standards.md): selected primary literature, publication status and limitations; recent selected work reaches October 14, 2026, without claiming an exhaustive search.
- [Full-paper application](docs/research/paper-qualification-2026-11-02.md): manually inspected NeurIPS evaluation methodology mapped to proposed CoworkeRL checks; no new experimental result or automated literature service.
- [Pi qualification](docs/runtime-qualification.md), [CoworkerRL integration](docs/integrations/coworker.md): tested boundaries and unknowns.
- [Runtime decision](docs/decisions/0001-runtime.md), [subscription decision](docs/decisions/0002-subscription-workers.md): tradeoffs and reversal conditions.
- [Project context](context/PROJECT.md), [agent instructions](AGENTS.md), [templates](docs/templates/research-records.md): continuity without treating proposals as completed capabilities.
- [Independent code review](docs/reviews/2026-11-01-foundation.md): defects, corrections and regressions.

No cloud resource or CoworkerRL training campaign has been launched by this project. Credentials, databases and generated decisions are excluded from version control.
