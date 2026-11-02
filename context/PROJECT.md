# Project context

Updated: 2026-11-01, America/Los_Angeles.

## User's objective

A self-guiding research assistant should make good decisions about RL environment design, execute and monitor model training, run research projects autonomously on a Droplet, delegate to agents suited to task complexity, and convene councils for consequential decisions. It should consult current papers, evaluate novelty and methodological validity against strong research, criticize its own proposals, and retain context in Markdown to reduce drift.

The user explicitly selected **both conventional RL environments/policy training and LLM post-training/agent tasks/verifiable rewards, with separate adapters**.

## Present deliverable and status

The task includes the assessment, implementation, a private repository, thoughtful commits and independent code review. The user selected **CoworkerRL** at `/Users/ronoktanvir/CoworkeRL` as the first integration and asked to use existing ChatGPT/Claude allowances. Building the harness does not start a full training campaign.

Status: assessment complete; `ronoktanvir/rl-research-harness` created and verified private. Code provides a Pi runtime adapter, structured council, subscription-backed CLI reviewers, an authoritative local experiment ledger, an injected-backend dispatch coordinator, persistent CoworkerRL captures, ledger-derived Markdown/JSON project snapshots and a local task queue with resumable archived-report plans. Independent reviews corrected recovery, accounting, authority, validation, file traversal and evidence-compaction defects. See `docs/implementation-status.md` for exact gaps. No cloud resource or CoworkerRL training run has been launched.

Recommendation: own the research controller, support official subscription-backed workers and retain pinned Pi as an optional runtime. Adapt selected Ouroboros contracts; keep conventional RL and LLM adapters separate. Design requirements remain unimplemented wherever acceptance evidence is missing.

The published source at `4ad955cb3a256c61ffc6df99837db378e0116971` passes 199 local offline tests and Linux CI on Node 24 and 25. The queue preserves consumed invocation units, uncertain interrupted work and shared account holds. A local observation remains under capture ID `historical-main-s11` in ignored `.harness/coworker.sqlite`; it has no registered run or executable manifest. A two-client review completed both account-backed calls: Codex returned a valid review, Claude returned unparseable review text, and the saved council remained blocked. The two-unit local allowance is consumed; no extra call or retry was made. See `docs/live-report-review.md` for identities and evidence. Next action: qualify structured client output and persist criticism/revision steps, then literature/adapter integration. Read the full requirements audit before claiming completion. Training/deployment limits can be selected later; local implementation need not wait.

## Working assumptions

- Start with one user and one controller owner, while allowing concurrent agents and remote experiment workers.
- Use a CPU Droplet for orchestration and separately allocated CPU/GPU workers when workloads require them. Small smoke experiments may run locally.
- Prefer maintained library dependencies behind narrow interfaces over copying whole projects. Extract ideas where their implementation is tightly coupled to the original application.
- Use a shared experiment ledger and scientific review policy; keep domain-specific training and evaluation in adapters.
- Treat autonomy as acting within configured authority, resource limits, and verifiable state. Routine work inside those limits should proceed without repeated human confirmation.

These are recommendations, not additional user requirements. Change them when evidence or the user's priorities justify it.

## Unknowns that affect implementation

CoworkerRL is selected, but its first campaign, available GPUs/provider, compute limits, allowed external actions, retention, concurrency and recovery objectives remain unspecified. Subscription clients work locally; unattended server authentication and usage-reset handling remain unqualified. These do not prevent implementation or read-only integration. Do not interpret the subscription question as a request to train immediately.

## Read next

- `docs/reuse-plan.md`: what to adopt, adapt, and build.
- `docs/architecture.md`: authority, state, workers, and failure handling.
- `docs/research-protocol.md`: research council, experiments, evaluation, and literature.
- `docs/roadmap.md`: staged implementation and acceptance criteria.
- `docs/repo-audits/`: inspected code and limitations.
- `docs/research/evidence-and-standards.md`: research evidence and source status.
- `docs/decisions/0001-runtime.md`: provisional runtime choice and reversal criteria.
- `docs/ledger-implementation.md`, `docs/controller-dispatch.md`: implemented local authority/recovery and remaining external guarantees.
- `docs/project-state.md`, `docs/integrations/coworker-capture.md`: operational context export and historical evidence capture.
- `docs/local-controller.md`, `docs/task-queue.md`, `docs/task-handlers.md`, `docs/report-review.md`: local task operations and evidence-review recovery.
- `docs/live-report-review.md`, `docs/reviews/2026-11-01-scheduler.md`: account-backed validation, its malformed-output limitation and independent corrections.

## Continuity rules

The user's objective above is authoritative. Audit observations are tied to a commit. Architecture and roadmap sections are proposals until implementation evidence exists. Later agents should not turn a proposal into a completed capability merely because it appears in a document.

Record every experiment under a stable ID with a config digest, code revision, dataset/environment/evaluator versions, lineage, resource limits, outcome, and artifact references. Record negative results. Preserve evidence and disagreements when compacting context.
