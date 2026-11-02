# Project context

Updated: 2026-11-01, America/Los_Angeles.

## User's objective

A self-guiding research assistant should make good decisions about RL environment design, execute and monitor model training, run research projects autonomously on a Droplet, delegate to agents suited to task complexity, and convene councils for consequential decisions. It should consult current papers, evaluate novelty and methodological validity against strong research, criticize its own proposals, and retain context in Markdown to reduce drift.

The user explicitly selected **both conventional RL environments/policy training and LLM post-training/agent tasks/verifiable rewards, with separate adapters**.

## Present deliverable and status

The task includes the assessment, implementation, a private repository, thoughtful commits and independent code review. The user selected **CoworkerRL** at `/Users/ronoktanvir/CoworkeRL` as the first integration and asked to use existing ChatGPT/Claude allowances. Building the harness does not start a full training campaign.

Status: assessment complete; `ronoktanvir/rl-research-harness` created and verified private. Code provides a Pi runtime adapter, durable structured councils, subscription-backed CLI reviewers with output schemas, an authoritative experiment ledger connected to a local supervisor, CoworkerRL captures/assessments and persistent diagnostic workflows, a bounded conventional RL adapter, ledger-derived project snapshots, a local task queue and bounded arXiv metadata ingestion. Independent reviews corrected recovery, accounting, authority, validation, source provenance and task-filtering defects. See `docs/implementation-status.md` for exact qualification gaps. No cloud resource or CoworkerRL training run has been launched.

Recommendation: own the research controller, support official subscription-backed workers and retain pinned Pi as an optional runtime. Adapt selected Ouroboros contracts; keep conventional RL and LLM adapters separate. Design requirements remain unimplemented wherever acceptance evidence is missing.

Prior integration source `1a5c6bef7a5886d5d6d04d5562279a259fa96117` passes 415 offline tests on Node 24/25 plus seven real Linux CPU cases in CI run 41398760542. The production transport confirms owned cgroup cleanup after manager metadata removal and requires a notify gate that refuses late execution and prevents main-PID runtime extensions. Fresh cancellation authority is tested offline; native fixtures exercise authorized cancellation. `docs/systemd-qualification.md` preserves prior failures and exact evidence. The deadline is conditional on documented host, clock, latency and no-suspend assumptions; this does not qualify training or cloud resource release. The latest independent findings are in `docs/reviews/2026-11-02-integration-and-assessment.md`.

The queue preserves consumed invocation units, uncertain interrupted work and shared account holds. The durable council now passes a full five-step review/revision cycle across reopening without repeating calls or changing independent checks. All calls in that new qualification are injected offline fixtures. A local observation remains under capture ID `historical-main-s11` in ignored `.harness/coworker.sqlite`; it has no registered run or executable manifest. The earlier two-client live review returned one valid Codex review and malformed Claude text, leaving a blocked council. Its two-unit local allowance remains consumed; the new schema support has not retroactively repaired that failure or been tested with additional live calls. See `docs/live-report-review.md` and implementation status for exact versions/checks.

Two arXiv requests for RL, verifiable rewards and reward hacking papers failed: a 20-second timeout, then a separate attempt with a 60-second bound returned HTTP 429 without Retry-After. No paper evidence was obtained. The 429 response is archived, its shared hold remains active, and a network-disabled admission check confirmed a new query identity is rejected before fetching. Do not release that unknown hold or bypass it with another project/ID. See `docs/live-literature-qualification.md`. Next action: bounded live structured-council qualification and actual training-adapter contracts, followed by full-paper evidence from independently available primary sources. Read the complete requirements audit before claiming completion; local implementation need not wait for training/deployment choices.

CoworkeRL's execution source was inspected at unchanged HEAD `84b219f64f1152f8b02babea388bfbbfff41e75a`. `docs/integrations/coworker-execution-contract.md` identifies the real entrypoint and native checkpoint/resume rules. Build a fixed supervised worker around a frozen admitted attempt, with stable job identity before spawn and separately observed execution/allocation states. The trainer's CUDA/vLLM stack and direct helper/judge API usage are separate from subscription review workers. Lifecycle fixtures must remain labeled as fixtures; actual training/provider qualification has not occurred.

The `coworker-plan` command produces a declaration-only attempt preview. Separate byte verification and native-preflight output interpretation retain `launchSupported: false`; neither imports or executes CoworkeRL. `docs/supervised-backend.md` describes the implemented ledger/worker bridge, including fresh cancellation authority, exact observation IDs, full declaration agreement across stores and bounded read-only deployment resolution. It has no default CoworkeRL resolver. Next execution work is a concrete immutable deployment/input-closure binding, actual native preflight/serving qualification and checkpoint/collection integration. The native preflight flag omits numerical, live-serving, model/CUDA, checkpoint/resume and output-directory checks; its PASS marker precedes a possible metadata exception. Manager queuing remains unbounded, but the gate refuses late trainer execution; it does not cancel or refund an external allocation.

The `coworker-assess` command now derives and archives rule-bound findings, diagnostic requests and a council packet without model calls. It assessed all 30 entries in `historical-main-s11`; no scoped numerical/serving/order trigger was observed, while optimizer/checkpoint verification and independent evaluation/baseline remain unestablished. See `docs/research/coworker-assessment-2026-11-02.md`. Independent review fixed invalid-index classification and changed the rule digest; both earlier and corrected derived observations remain stored. This is retrospective evidence work, not live intervention or proof of learning. The assessment workflow now connects this capture to a zero-call task and three persistent unresolved evidence requests. Execution of the investigations and campaign selection remain unfinished.

A manual full-paper review now maps the official NeurIPS 2021 statistical-evaluation paper to proposed CoworkeRL replication/comparability tests. It preserves historical-versus-v2 distinctions and does not implement automated full-paper ingestion. See `docs/research/paper-qualification-2026-11-02.md`. The subscription clarification is recorded in `docs/subscription-workers.md`: account allowance, local invocation caps and training infrastructure/API costs are separate. No additional model calls or allowance changes occurred in this slice.

The fixed conventional adapter now executes FrozenLake with explicit seeds and horizons, frozen-table evaluation and one shared random baseline. The local CLI qualification recorded 20,516 transitions and evaluation successes of 3/50, 5/50 and 36/50; all outcomes are retained without a significance/generalization claim. See `docs/integrations/conventional-local.md`, `docs/research/conventional-qualification-2026-11-02.md` and `docs/reviews/2026-11-02-assessment-workflow-and-conventional.md`. This slice passes 434 offline TypeScript tests (two deliberate native skips), 19 scripted Python tests and the opt-in real Gym test locally. Source `73c1191a7be6a80c6d9966857d4ee34f48c222ad` also passes Linux CI run `41401284085`: 434 offline tests on Node 24/25, all 19 Python cases, the real Gymnasium acceptance case and all seven supervisor cases plus their parent. Next work is conventional ledger/supervisor admission and evidence-request completion, alongside actual Coworker deployment/input closure and full-paper evidence. No additional provider call, CoworkerRL campaign, cloud allocation or allowance/hold change occurred.

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
- `docs/durable-council.md`, `docs/council-handlers.md`, `docs/structured-output.md`: persisted criticism and official-client formatting contracts.
- `docs/literature-discovery.md`, `docs/live-literature-qualification.md`, `docs/reviews/2026-11-01-research-cycle.md`: source capture, holds, actual retrieval failures and independent qualification.

## Continuity rules

The user's objective above is authoritative. Audit observations are tied to a commit. Architecture and roadmap sections are proposals until implementation evidence exists. Later agents should not turn a proposal into a completed capability merely because it appears in a document.

Record every experiment under a stable ID with a config digest, code revision, dataset/environment/evaluator versions, lineage, resource limits, outcome, and artifact references. Record negative results. Preserve evidence and disagreements when compacting context.
