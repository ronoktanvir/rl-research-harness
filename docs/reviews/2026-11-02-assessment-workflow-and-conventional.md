# Assessment workflow and conventional RL review

The review covered the new archived-assessment workflow, its queue/CLI integration, the fixed Python FrozenLake worker, TypeScript request/result validation, process wrapper and local artifacts. Separate reviewers examined scientific semantics and implementation boundaries; findings below were corrected before publication. This does not qualify CoworkerRL execution or unattended deployment.

## Findings and corrections

| Finding | Consequence | Correction and evidence |
|---|---|---|
| Nested accessors could run while cloning a malformed flat workflow request | Rejected input could still execute caller code | Validate inert descriptor values before copying; workflow regression verifies zero getter calls |
| A recovered follow-up observation needed its exact event identity checked | Content/digest agreement alone could accept a wrongly identified supplied record | Check event ID along with project, source and recomputed content |
| Shared evaluation/baseline seeds would reproduce the same random baseline per trained policy | Repeated references could exaggerate baseline sample size and waste transitions | Execute/archive one baseline; budget formula and reports count it once |
| Action and environment seeds could accidentally initialize identical random streams | Correlated action/transition choices could contaminate the intended experiment | Separate explicit policy RNG and reset seeds; enforce disjoint declared schedules |
| Public result validation trusted caller-owned data and a supplied request digest | Later changes could produce a summary inconsistent with its quoted digest | Inert bounded copies, request-digest recomputation and frozen detached output; independent TypeScript regressions |
| Artifact execution reread mutable input/options after asynchronous intent writes | Intent could describe a different request/interpreter/timeout from the actual invocation | Capture request and worker options before the first await; independent mutation regression verifies all three |
| Summary projection trusted a mutable result object | Altered counts or policy tables could be described under an unchanged stdout digest | Reconstruct summaries from digest-checked raw stdout, revalidate the request and terminal process state; independent offline regression covers deserialized mutations |

## Actual qualification

- Full local Node suite: **434 passed, 0 failed, 2 explicit native-suite skips of 436**. Type checking and whitespace checks passed.
- Python semantic suite: **19 passed**, including 10 independent methodological cases. These use scripted environments and do not need scientific dependencies.
- Real pinned Gymnasium case: **passed**. It exercised deterministic and slippery dynamics with three training replicas per request and repeated each request to check exact output reproducibility. No positive learning threshold was required.
- A separate explicit local CLI invocation saved complete artifacts: **20,516 transitions**, three final-policy success counts **3/50, 5/50 and 36/50**, one shared baseline **0/50**. See [qualification details](../research/conventional-qualification-2026-11-02.md).
- The actual historical Coworker capture advanced through its persisted workflow to **three unresolved requests**: recover provenance, collect independent evaluation, and design a matched baseline. The global client counter stayed **2 consumed / 2 configured**; existing resource holds were unchanged and no run was registered.

Historical workflow ID: `assessment-workflow:4ff1eebcb8d4ebd2f33e5703875ee242039cd43e23ecf468be3e474ee6b5a845`. Full local workflow/diagnostics remain in ignored `.harness/historical-assessment-workflow.json` and the existing local stores. The task completion means that evidence requests were archived; no investigation was marked resolved.

## Scope that remains open

The conventional command is an explicit local engineering operation with a new-directory intent marker. It has no broker admission, remote launch recovery, host-crash durability, protected holdout or resumable checkpoint. Its result parser detects internal protocol inconsistencies, not fabricated but internally consistent data from an arbitrary trainer. The fixed worker and dependencies are trusted code; isolated Python mode and a scrubbed environment are not an OS security boundary.

The assessment workflow preserves questions but does not collect or adjudicate their evidence. Native Coworker deployment, complete input closure, full-paper ingestion, scientific campaign selection and Droplet operations remain required. No provider-model calls, cloud allocations or changes to the arXiv hold were made during this work.
