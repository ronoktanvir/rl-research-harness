# Pi repository audit for the RL research harness

**Recommendation: use Pi as the agent execution substrate, with an owned research controller around it. Prefer a pinned `pi-durable` release behind a small adapter for the long-running service; use `pi-coding-agent` as an isolated coding worker or operator interface.** The current repository already contains durable tasks, stored conversations, tool replay rules, owned child work, remote execution environments and model-provider adapters. Reimplementing those primitives would consume effort that belongs in experiment design, evidence validation and training supervision.

This is a source audit, not a deployment certification. Source and selected test bodies were inspected; upstream code, test suites, npm installs and example agents were not executed.

## Snapshot and release boundary

- Audit date: **2026-11-01, America/Los_Angeles**.
- Repository: [earendil-works/pi](https://github.com/earendil-works/pi).
- Main snapshot: [`c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8`](https://github.com/earendil-works/pi/commit/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8), committed 2026-11-01 23:11:22 UTC.
- Latest GitHub release observed: [v1.4.0](https://github.com/earendil-works/pi/releases/tag/v1.4.0), published 2026-10-21. Release tag resolves to [`4a080252f06caf63a525d7873c5d94d3c23887e0`](https://github.com/earendil-works/pi/commit/4a080252f06caf63a525d7873c5d94d3c23887e0).
- The [npm registry](https://registry.npmjs.org/@earendil-works%2Fpi-durable/latest) returned `@earendil-works/pi-durable@1.4.0` with a published tarball. The package manifest requires Node.js >=22.19.0. Registry `gitHead` was absent; the tarball was not downloaded or matched byte-for-byte to the release source.
- **Durable is explicitly experimental**, including in the release README. Its API can change between releases. Main contains extensive unreleased breaking changes to schemas, watches, storage commits and other interfaces. A `package.json` version of 1.4.0 on main does not mean that every current-main API exists in the npm 1.4.0 package. [Release warning](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/README.md#L1-L5); [unreleased changes](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/durable/CHANGELOG.md#L3-L56).

The top README says the CLI skips built-in subagents, but the repository's Durable package contains owned conversations and working subagent examples. These are different layers, not evidence that Durable is absent or that the CLI supplies a complete council. [Package list and CLI positioning](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/README.md).

## What to take

| Component | Observed implementation | Recommendation and reason |
|---|---|---|
| `@earendil-works/pi-ai` | Provider-neutral message/model interfaces, streaming and token/cost types. Cost totals distinguish provider-billed values from estimates. | Depend on it for model access and worker selection. Keep task routing and benchmark-based model choice in the research controller. |
| `@earendil-works/pi-durable` | Stored conversations, task phases, submissions, checkpoints, ownership, waits, retries, compaction and usage. | Primary candidate for the always-on agent service. Wrap its API so an upstream migration does not rewrite experiment logic. |
| `ToolTask`, `defineTool`, tool hooks | Arguments are validated; `beforeTool` can block or modify a call; execution intent is committed before effects; replay policy controls recovery. | Define typed tools such as `submit_experiment`, `inspect_run`, `request_stop`, `collect_checkpoint`, and `read_evidence`. Do not funnel every experiment operation through an unrestricted shell string. |
| Owned child conversations and tasks | Child work can be tied to a task; waits and aborts traverse ownership; background work forms an explicit boundary. | Adapt into specialist researchers, method critics and implementation workers. Add role policy, bounded fan-out, cost reservations and decision records. |
| SQLite backend and task recovery | Atomic storage commits, reopen reconciliation, task checkpoints and reusable request IDs. | Suitable initial single-service persistence on a droplet after fault testing. Keep external experiment job identifiers and launch receipts as separate typed records. |
| Compaction and immutable transcript entries | Summaries change the active model context; older entries remain stored. | Reuse compaction mechanics, but retrieve authoritative project records for every consequential decision. A summary is a convenience, not the source of truth. |
| `@earendil-works/pi-env` | SSH remote environment with daemon deployment, host-key checking and file/process operations. | Consider for remote file inspection and controlled commands. Add a durable training-job API; a remote shell connection is not a training scheduler. |
| `pi-coding-agent` SDK / RPC | In-process TypeScript API or JSONL child-process protocol, session persistence, tool/runtime events. | Useful for scoped code tasks and Python interoperability. Do not mistake CLI session history for Durable task execution guarantees. |
| `pi-telemetry` integration and conformance tests | Durable emits task/request/commit metadata and provides storage/env testing interfaces. | Connect to operational telemetry and reuse conformance expectations. Scientific training metrics require separate schemas. |

Source anchors: [tool intent/replay](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/durable/src/harness/tool.ts#L149-L226), [scheduler reopen](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/durable/src/harness/scheduler.ts#L428-L479), [atomic SQLite commits](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/durable/src/storage/sqlite/storage.ts#L213-L258), [cost type](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/ai/src/types.ts#L459-L486), [usage ledger](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/durable/src/harness/usage.ts#L6-L54), [compaction implementation](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/durable/src/harness/compaction.ts#L68-L114), [SSH options](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/env/src/ssh.ts#L77-L109).

### Durable recovery is useful, but external effects still need idempotency

The recovery implementation checks **both the persisted and current tool replay policy**. If both are safe, it invokes the tool again; otherwise it records an interruption that may have partially executed. This behavior is present in the release, not merely in current-main plans. Nested calls also have durable keys that reattach to earlier tasks/results, while explicitly rejecting reuse with different arguments. [Release tool implementation](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/harness/tool.ts#L168-L197); [main nested-call reuse](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/durable/src/harness/tool.ts#L907-L965).

For a training launch, a controller can crash after a remote scheduler accepted the job but before the local receipt was committed. Marking the launch tool replay-safe does not close that gap. The experiment adapter must assign a stable launch key, query the remote backend for that key on retry, and recover the existing job. Where the backend cannot enforce uniqueness, the adapter needs reconciliation and an explicit ambiguous state instead of silently launching twice. Pi's own recovery test models this distinction: the effect API is called twice but its idempotency mechanism applies the transfer once. [Test body](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/durable/test/harness-tasks-recovery.test.ts#L113-L145).

This matters for both project families:

- **Conventional RL:** one experiment request may expand into several seeds, environment versions and evaluation jobs. Stable IDs must distinguish the intended replication from accidental duplication.
- **LLM post-training / verifiable rewards:** rollout generation, policy updates, reward verification and evaluation are distinct jobs with distinct artifacts. Resuming an agent conversation does not recover optimizer state, checkpoint lineage or distributed-worker membership.

### Child agents are execution primitives; a council remains application logic

The foreground subagent example creates one child owned by the tool task, looks for an existing child on replay, removes its own subagent extension from the child, and submits with a stable request ID. Those are directly reusable patterns for bounded delegation. [Foreground example](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/durable/test/examples/21-subagent-foreground.ts#L41-L75).

The background example deliberately allows child agents to outlive the parent turn and its ordinary abort. Its reporter tasks use stable submission IDs to avoid duplicate message/report admission. That is useful for a literature scout or run analyst, but it changes shutdown semantics: a global project stop needs to stop background work as well as foreground work. [Background ownership design](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/durable/test/examples/22-subagent-background.ts#L57-L126); [documented abort boundary](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/durable/README.md#L712-L757).

Build council policy above this layer:

1. Give independent reviewers the same immutable evidence packet before sharing opinions.
2. Require a structured recommendation, cited observations, assumptions, objections and a falsifying experiment.
3. Run a bounded critique/revision round; escalate only unresolved disagreements that could change the experiment.
4. Have the orchestrator record the decision and dissent, then admit work through deterministic budget/resource checks.
5. Measure whether the council improves decisions over a single-agent baseline. More agents are not evidence of better science.

The coding-agent extension example is a useful prototype, but its children launch with `--no-session`, its concurrency limits are local constants, and its work is managed by subprocesses. Prefer Durable's owned-task pattern for the production council. [CLI child launch](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/coding-agent/examples/extensions/subagent/index.ts#L298-L348); [parallel limits](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/coding-agent/examples/extensions/subagent/index.ts#L34-L35).

### Context preservation should combine transcripts with authoritative records

Pi's compaction prompt retains goals, constraints, decisions and next steps. The runtime preserves old entries while placing a summary at the head of the model's active context. That is the right underlying mechanism for long tasks, but repeated summaries can omit details, stale assumptions or contradictory evidence. [Summary schema](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/durable/src/harness/compaction.ts#L72-L107); [context derivation](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/durable/src/harness/context.ts#L147-L208).

Use separate project records for the research question, environment/reward specification, data lineage, planned comparison, accepted decisions, rejected hypotheses, active runs and unresolved objections. Each context packet should identify record versions and run/artifact IDs. In particular, preserve negative results and protocol changes; otherwise a compacted agent can repeat failed work or retroactively reinterpret an exploratory result as confirmatory.

## What to adapt cautiously or leave out

**Do not adopt the entire CLI as the research control plane.** Its session manager is valuable conversational infrastructure, but it writes JSONL session entries and rebuilds conversational context. Durable owns a different contract: persistent task phases and recovery of in-flight work. Keep the distinction explicit. [Session manager persistence](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/coding-agent/src/core/session-manager.ts#L1124-L1188); [SDK factory](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/coding-agent/src/core/sdk.ts#L191-L206).

**Do not use usage totals as hard spend limits.** The inspected `pi.usage` code accumulates model/tool usage after responses; some costs are catalog estimates. The research controller needs reservations before admitting parallel requests or GPU jobs, then reconciliation after actual spend. Include failed attempts, compaction, literature retrieval and subagents. Current-main deferred progress can lose some partial content and usage at a crash, so provider billing cannot be reconstructed perfectly from partial transcript accounting. [Usage implementation](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/durable/src/harness/usage.ts#L24-L54); [cost semantics](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/ai/src/types.ts#L459-L486); [deferred-progress change](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/durable/CHANGELOG.md#L48-L50).

**Do not rely on per-run turn limits to bound autonomous work.** Main adds `maxTurns`, but `onYield` continuations reset the run's turn counter; the source explicitly assigns bounding that loop to the extension. The published release cannot be assumed to contain the new limit at all. Persist project-level limits on calls, dollars, elapsed time, fan-out, recursion depth and critique rounds outside the individual model loop. [Continuation reset](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/durable/src/harness/generation.ts#L858-L883); [unreleased turn limit](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/durable/CHANGELOG.md#L148-L153).

**Do not treat tool filtering or SSH as operating-system isolation.** Pi's README explicitly states there is no built-in permission system restricting filesystem, process, network or credential access. Tool hooks are helpful policy enforcement points, but code that runs with the host process's authority can still act with that authority. Run coding workers with narrow project mounts and resource limits, keep cloud/provider credentials with the controller or narrowly scoped broker, and expose allowlisted experiment operations. [Permissions statement](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/README.md#L88-L96).

**Do not take live plugin reload or runtime self-modification as a requirement.** A research assistant should propose and test harness changes against replay and regression cases before promotion. A model that edits its decision policy or launch adapter during a running campaign can invalidate both the experiment and its recovery assumptions. Chord's plugin/runtime machinery may become useful later, but depend on it transitively through Durable first instead of making custom plugin architecture an MVP goal.

**Defer TUI styling, sharing/publication integrations and broad code-mode execution.** They do not resolve the user's central problem. A small status/control interface, typed tools, evidence records and reliable job reconciliation have higher priority.

## Droplet deployment implications

The smallest defensible deployment is one supervising service on the droplet, one owner of the Durable SQLite store, separate isolated agent workers, and external training executors where the required compute lives. The droplet can coordinate work without being the machine that trains every model.

The SQLite adapter uses WAL with `synchronous = NORMAL`. The documented guarantee distinguishes process crashes from host/power failures, where newest commits may be lost. Storage has no cross-process ownership lock. Therefore deployment must enforce a single writer, handle service restarts, back up the database and artifacts, and test restoration. If the required durability calls for a stronger synchronous setting, configure/test the underlying database adapter rather than assuming the default provides it. [SQLite configuration](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/chord/src/sqlite/node.ts#L196-L209); [storage ownership and durability documentation](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/durable/README.md#L850-L892).

Pi's remote environment verifies the deployed daemon by hash and configures SSH without agent or X11 forwarding. These are useful transport choices, but the training backend still needs persistent jobs, heartbeat/metric collection, cancellation, checkpoint discovery and reconnect handling. [Daemon verification](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/env/src/ssh.ts#L378-L416); [remote environment scope](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/env/README.md#L1-L34).

## TypeScript versus Python integration

Use a **small TypeScript agent service plus Python experiment adapters** as the default design. Durable and Pi's native APIs are TypeScript; the ML environment and training ecosystem can remain Python. Connect them through a versioned, typed job API that returns stable run IDs and structured results. Keep bulk metrics, datasets and checkpoints in their normal stores rather than streaming them through a model transcript.

If the project must be Python-led, Pi's coding-agent RPC is a usable subprocess boundary. Its protocol is JSONL; responses can arrive asynchronously and must be correlated by IDs. A successful `prompt` response means admission, not completion. Clients must keep reading until `agent_settled`, handle process exits/deadlines and drain stderr separately. This RPC controls the coding-agent session; it is not automatically a remotely exposed Durable service. [RPC contract](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/coding-agent/docs/rpc.md#L1-L102); [RPC implementation](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L386-L448).

Condition that would reverse the TypeScript-first choice: the eventual project already has a reliable Python workflow controller and introducing a second service would add more operational cost than Durable saves. In that case use Pi as a bounded worker and preserve the existing experiment controller.

## Extraction order and acceptance gates

| Order | Deliverable | Acceptance evidence required |
|---|---|---|
| 1 | Pin coherent Pi release packages; place model and Durable APIs behind adapters | One model/tool round, one stored session, reopen/resume, package versions recorded |
| 2 | Typed experiment launcher and run registry for each training family | A lost launch response and controller restart recover the same job; no duplicate GPU allocation |
| 3 | Structured metrics/checkpoint ingestion | Detect a stalled run, non-finite metric, failed reward verifier and absent checkpoint without relying on a model reading arbitrary logs |
| 4 | Owned specialist agents with project budgets | Parent/child cancellation, background global stop, fan-out and cost reservations tested |
| 5 | Evidence-grounded council and context packets | Same evidence packet produces auditable decisions, citations resolve, contradiction/negative-result records survive compaction |
| 6 | Controlled autonomous campaign | Baselines, seed/split plans, termination rules and reproduction artifact all verified before unattended expansion |

Suggested fault cases include a process death immediately before launch, immediately after remote acceptance, during tool output, during a checkpoint upload, during child-agent reporting and while budgets are almost exhausted. Reconcile independently of the LLM. For ordinary RL, verify environment termination/truncation and evaluation isolation; for LLM training, verify reward correctness, data/split provenance and checkpoint-to-rollout lineage. These are new harness responsibilities, not capabilities demonstrated by Pi.

## Evidence quality and remaining unknowns

This audit inspected implementation in the agent loop, durable scheduler/tool/usage/context/compaction modules, SQLite backend/adapter, SDK/session manager, RPC server, SSH helper and subagent examples. Selected recovery test bodies verify that the codebase is deliberately testing interruption and effect idempotency: [unsafe-tool recovery](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/durable/test/harness-tools-recovery.test.ts#L109-L134), [safe-policy combinations](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/durable/test/harness-tools-recovery.test.ts#L200-L227), and [intent/effect/outcome recovery](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/durable/test/harness-tasks-recovery.test.ts#L113-L145). The tree also contains tests for ownership, storage failure, compaction, nested-tool restart, telemetry and turn limits; their existence is not a claim that they passed in this environment.

No evidence inspected establishes that Pi selects scientifically valid RL environments, detects reward hacking, performs defensible statistical comparisons, keeps up with literature, or produces conference-quality conclusions. Those are application behaviors that need their own benchmark and review process. The unresolved operational questions are the user's training backends, allowed cloud spend, expected campaign concurrency, model-provider policy, and acceptable recovery/downtime targets.

## License and provenance

The root [LICENSE](https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/LICENSE) is MIT and attributes copyright to Mario Zechner (2025). Its text requires the copyright and permission notices in copies or substantial portions. Retain upstream notices and a source/version manifest for copied code; review bundled dependency notices when distributing a build. This reports the file's contents and does not assess the licensing of every dependency.

Prefer maintained package dependencies over copying large internal modules. Copy narrowly scoped examples only when adapting them to an owned interface; record the original SHA and the local changes. The durable scheduler is too interconnected to be a sensible casual extraction target.

