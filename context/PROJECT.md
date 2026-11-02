# Project context

Updated: 2026-11-01, America/Los_Angeles.

## User's objective

A self-guiding research assistant should make good decisions about RL environment design, execute and monitor model training, run research projects autonomously on a Droplet, delegate to agents suited to task complexity, and convene councils for consequential decisions. It should consult current papers, evaluate novelty and methodological validity against strong research, criticize its own proposals, and retain context in Markdown to reduce drift.

The user explicitly selected **both conventional RL environments/policy training and LLM post-training/agent tasks/verifiable rewards, with separate adapters**.

## Present deliverable and status

The current task is an evidence-based assessment of `razzant/ouroboros` and `earendil-works/pi`, followed by a reuse recommendation and durable design documents. It is not a request to provision cloud resources or launch training immediately.

Status: repository assessment and design completed; two independent repository audits, a primary-literature review, an initial architecture critique and a second review of the corrections are saved. No application runtime, cloud deployment, training run, or dependency installation has been completed. Upstream test bodies were inspected; tests were not executed.

Recommendation: qualify a pinned Pi durable runtime behind an owned interface; adapt selected Ouroboros memory, delegation, review and recovery contracts; build the research/experiment broker and separate Python adapters. The runtime decision remains provisional until implementation acceptance tests pass.

Next implementation action: select the first tiny experiment in each track, define budgets and permitted worker access, then perform Stage 0 of `docs/roadmap.md`. The present user request was an assessment; these implementation stages are proposed next work.

## Working assumptions

- Start with one user and one controller owner, while allowing concurrent agents and remote experiment workers.
- Use a CPU Droplet for orchestration and separately allocated CPU/GPU workers when workloads require them. Small smoke experiments may run locally.
- Prefer maintained library dependencies behind narrow interfaces over copying whole projects. Extract ideas where their implementation is tightly coupled to the original application.
- Use a shared experiment ledger and scientific review policy; keep domain-specific training and evaluation in adapters.
- Treat autonomy as acting within configured authority, resource limits, and verifiable state. Routine work inside those limits should proceed without repeated human confirmation.

These are recommendations, not additional user requirements. Change them when evidence or the user's priorities justify it.

## Unknowns that affect implementation

First concrete project and datasets; available GPUs or provider; monthly/per-project compute and model-call budgets; permitted external actions; target model families; storage retention; expected concurrency; and required recovery time. These do not prevent the repository assessment. Select them before enabling an unattended paid deployment.

## Read next

- `docs/reuse-plan.md`: what to adopt, adapt, and build.
- `docs/architecture.md`: authority, state, workers, and failure handling.
- `docs/research-protocol.md`: research council, experiments, evaluation, and literature.
- `docs/roadmap.md`: staged implementation and acceptance criteria.
- `docs/repo-audits/`: inspected code and limitations.
- `docs/research/evidence-and-standards.md`: research evidence and source status.
- `docs/decisions/0001-runtime.md`: provisional runtime choice and reversal criteria.

## Continuity rules

The user's objective above is authoritative. Audit observations are tied to a commit. Architecture and roadmap sections are proposals until implementation evidence exists. Later agents should not turn a proposal into a completed capability merely because it appears in a document.

Record every experiment under a stable ID with a config digest, code revision, dataset/environment/evaluator versions, lineage, resource limits, outcome, and artifact references. Record negative results. Preserve evidence and disagreements when compacting context.
