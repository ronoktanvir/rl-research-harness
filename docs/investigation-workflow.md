# Historical investigation workflow

This workflow turns one completed CoworkerRL assessment into a bounded read-only investigation task. It verifies the selected source, adapter and evaluation records, archives an exact receipt and keeps every scientific follow-up unresolved. It does not choose an experiment or authorize training.

## Configure and run

Set `investigationPythonExecutable` in the trusted controller configuration to an absolute Python 3.11+ executable path. The fallback `/usr/bin/python3` is suitable only when that interpreter meets the requirement; macOS may provide an older version. The helper uses only the standard library in isolated, no-site mode. Configuration does not grant extra client invocations.

Create a request using an existing completed assessment workflow and explicit artifact selectors:

```json
{
  "workflowId": "run1-investigation-001",
  "assessmentWorkflowObservationId": "assessment-workflow:<existing-digest>",
  "investigationId": "run1-investigation-001",
  "localArtifacts": {
    "adapterPath": ".local-artifacts/artifacts/probing-helper-artifacts/grpo-run1/main-s11/adapter-step-29/adapter_model.safetensors",
    "trainedTracePath": ".local-artifacts/artifacts/probing-helper-artifacts/heldout-diagnostic/s11-trained/step0-trace.jsonl",
    "baselineTracePath": ".local-artifacts/artifacts/probing-helper-artifacts/heldout-diagnostic/s11-baseline/step0-trace.jsonl",
    "trainedEvaluationDirectory": "artifacts/probing-helper-artifacts/heldout-diagnostic/s11-trained",
    "baselineEvaluationDirectory": "artifacts/probing-helper-artifacts/heldout-diagnostic/s11-baseline"
  },
  "notBefore": "2026-11-02T12:00:00.000Z",
  "deadlineAt": "2026-11-02T12:05:00.000Z"
}
```

Replace the existing workflow ID, selectors and eligibility times with the intended captured evidence. These example paths do not establish its identity; the capture supplies the report hash and the reader verifies the correspondence.

```sh
npm run harness -- investigation-prepare .harness/controller.json request.json
npm run harness -- investigation-run .harness/controller.json <returned-workflow-observation-id>
npm run harness -- investigation-advance .harness/controller.json <returned-workflow-observation-id>
```

Preparation checks capture compatibility, project root, artifact selection and any existing investigation identity before enqueueing. It persists the workflow before queue admission. Repeating preparation with the same request repairs a missing enqueue; changing its request under the same workflow ID fails.

The task depends on the exact completed assessment. `investigation-run` selects only that task, uses zero model-call units and obeys the shared parallelism limit and persistent stop barrier. It does not drain unrelated work. SIGINT/SIGTERM persists a stop barrier before requesting cancellation. A changed helper hash, interpreter path, timeout or limit cannot silently replace the worker pinned into a queued task.

## Completion and recovery

The queue task completes when a valid investigation receipt is archived, including a receipt that says inspection was incomplete. Workflow output remains `status: "evidence_required"`; `inspectionStatus` separately reports `completed` or `incomplete`. The CLI returns exit code **2** for this unresolved scientific state. A receipt never changes scientific follow-ups, experiment runs or evaluation conclusions.

A completed task reloads from verified archive records without reading project files or invoking the worker. It checks the exact request, worker descriptor, output receipt and original assessment/follow-up bindings. Free-form queue text cannot replace those records.

After a controller crash, a running task becomes uncertain and requires explicit read-only reconciliation; merely calling `investigation-run` does not replay it. The queue allows two attempts. The underlying archive supports up to three interrupted read-only attempts when no output was committed, but any committed outcome is final for that investigation ID. A new ID explicitly asks for a fresh observation. See the [archive protocol](integrations/coworker-investigation.md) for output recovery and limits.

## Qualification boundaries

Offline tests cover exact task selection, zero-call execution, persistent stop, pre-execution cancellation, enqueue recovery, deleted-source replay, source upgrades, malformed input and forged completion. A separate cross-process CLI test uses tiny synthetic files through the actual Python parser, capture, assessment, queue and archive. Injected archive tests do not claim that file inspection occurred. The [independent review](reviews/2026-11-02-historical-investigation.md) records corrected defects; actual project qualification is reported separately.

The current parser supports one inspected historical source algorithm. It is not a generic experiment discovery engine. Matching bytes and saved producer counts do not validate a scorer, prove a protected holdout, establish a causal training effect or demonstrate checkpoint resumability.
