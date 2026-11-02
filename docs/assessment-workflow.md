# Persistent assessment and diagnostic follow-ups

The assessment workflow connects one archived Coworker report to the local research queue and a durable diagnostic plan. It runs a deterministic assessment, verifies its saved result, then records ranked evidence requests. It does not call a model, reread the project, start training, or declare those requests resolved.

## Executable work and evidence requests

`createResearchTaskHandlers` registers `coworker_assessment`, version `1`, with zero client invocation units, no account resource key, and `reconcile_safe` replay policy. Its input contains only `captureId`, `captureDigest` and the current `rulesDigest`; project identity comes from the queued task and existing trusted project configuration. There is no root path, arbitrary command, model selector or paid fallback in this contract.

The handler uses `archiveCoworkerAssessment`. Its completed result identifies the assessment observation, observation digest, assessment payload digest, capture and rules. A structurally valid assessment with integrity findings still completes the deterministic task. Completion means that the assessment was archived, not that the research passed.

After the completed queue result and assessment archive agree exactly, the workflow publishes the assessment's diagnostic requests as stable work items. Each item preserves its priority, rank, action, finding and evidence references, and required completion evidence. Every item remains `unresolved`, with `mode: evidence_request` and `executionAuthorized: false`. Missing evaluation or a baseline is not converted into an automatic evaluation job.

Dependencies describe requirements for interpretation. Recovered provenance is needed to claim that an evaluation or baseline is comparable, or that a checkpoint has the claimed lineage. Observed integrity defects must be resolved before the affected trajectory supports improvement claims. Those dependencies do not forbid collecting raw evidence or drafting a prospective protocol with unknowns explicit. Rank expresses diagnostic priority; it is not an execution order that silently blocks all other evidence gathering.

## API and recovery

The configured CLI exposes `assessment-prepare <config.json> <request.json>`, `assessment-advance <config.json> <workflow-observation-id>`, and `assessment-run <config.json> <workflow-observation-id>`. Preparation returns the stable workflow and task IDs. Advance/run return exit code 2 while evidence is required or work is pending/blocked; a completed deterministic assessment is not presented as completed research. Run installs the existing durable stop-on-signal behavior and selects only this workflow's task.

The implementation is in `src/scheduler/assessment-workflow.ts`:

- `prepareAssessmentWorkflow(ledger, queue, handlers, request, now?)` accepts `{projectId, workflowId, captureId, captureDigest, notBefore, deadlineAt}`. It validates the capture and fixed handler, archives immutable workflow intent, then enqueues one assessment task. The returned workflow includes `observationId` and `task.taskId`.
- `loadAssessmentWorkflow(ledger, observationId)` checks the archive and regenerates the expected workflow from the bound capture and available rules. It rejects self-hashed changes to the task or evidence binding.
- `advanceAssessmentWorkflow(ledger, queue, observationId, now?)` reads existing state only until a verified assessment is complete. It returns `pending`, `blocked`, or `evidence_required`; the last includes the immutable follow-up plan.
- `runAssessmentWorkflow(ledger, queue, handlers, observationId, runnerOptions)` executes at most the one selected task through the existing bounded runner, then advances the workflow. Caller-supplied task filters cannot broaden that selection.

Repeating preparation with the same request repairs a missing enqueue after a crash. It preserves the archived creation time and existing task state. Reusing a workflow ID with a different capture, digest or schedule conflicts. Assessment and follow-up identities derive from bound content; a retry does not replace a previous finding or create a fresh experiment identity.

A crash after assessment archival but before recording the queue result leaves the task uncertain. The workflow does not replay it automatically. The controller may explicitly reconcile and requeue the deterministic task under the queue's existing bounded policy; the assessment archive then returns the same verified record. Failed, rejected, cancelled, expired and uncertain tasks do not publish follow-ups. An expired queued task becomes blocked after the runner's claim reconciles its deadline.

An implementation with a different assessment rules digest cannot silently reinterpret an existing workflow. The old archive remains evidence; processing under changed rules requires a separately identified workflow. The current loader deliberately fails closed when the old rule implementation is unavailable.

## Authority and qualification

Zero invocation units do not bypass the queue's global/project stop, deadline or concurrency controls. The workflow does not change invocation caps, resume held accounts, release the arXiv hold, or create an experiment run. It can proceed when an invocation allowance is exhausted if the existing zero-call task and concurrency policy permit it.

Tests use real local ledger/queue persistence and small synthetic report files. They cover interrupted enqueue, reopening after source deletion, exact task selection, stop and expiration, crash after assessment archival, explicit reconciliation, forged completion, rule/request mismatch, getter rejection, and unchanged exhausted caps/account holds. They do not establish live trainer monitoring, scientific benefit, external evidence collection, or completion of the requested investigations.

This is one step in the research loop: observed capture → deterministic assessment → persistent diagnostic requests. Completing those requests, evaluating new evidence and admitting a controlled experiment require further typed integrations and independently checked evidence. See [Coworker assessment](integrations/coworker-assessment.md), [task queue](task-queue.md), and [research protocol](research-protocol.md).
