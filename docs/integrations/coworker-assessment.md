# Deterministic CoworkeRL capture assessment

The assessment turns an archived CoworkeRL report into evidence-linked diagnostic requests without invoking a model or trainer. It scans every archived step and diagnostic, computes scoped integrity checks, ranks the follow-up work and produces an existing-council-compatible evidence packet. **It does not infer current health, authorize intervention or establish learning improvement.**

## APIs and persistence

Run `npm run harness -- coworker-assess <ledger.sqlite> <project-id> <capture-id>` to archive the assessment and print its findings, requests and evidence packet. It acquires the same exclusive local ledger ownership as other operator commands. It uses the stored capture even if the original project is no longer available. The [historical 30-step assessment](../research/coworker-assessment-2026-11-02.md) records one actual archived-data check.

`assessCoworkerCapture(observation, {projectId, captureId, captureDigest})` is pure and synchronous. It returns a recursively frozen assessment with:

- Exact capture/project/digest binding, rule version and rule-definition digest.
- A deterministic assessment ID and content digest.
- Complete metric observation counts/ranges and diagnostic counts.
- Findings marked `triggered`, `not_triggered` or `not_assessable`.
- Ranked diagnostic requests with actions, required completion evidence and source references.
- A versioned evidence packet with deterministic checks that council votes cannot override.

`archiveCoworkerAssessment(archive, request)` accepts only the ledger's `getObservation` and `appendObservation` methods. It loads the capture and archives the derived result under source `coworker-capture-assessment.v1`, with null run, action and job IDs. Its stable event ID binds the capture digest and rule-definition digest. Repeating the request verifies and returns exactly the existing record; changed or conflicting content fails. A new capture produces a different assessment. No run registration, execution/evaluation fact, stop state, reservation or billing record is changed.

The assessment uses the capture's observation timestamp to make repeated evaluation deterministic. That timestamp is explicitly a source-observation time, not a claim of a fresh live check or the time a later analyst first inspected it. Rule version 1 is retrospective; it is not a recovered preregistered stopping policy. The rule-definition digest identifies the published definitions, not a signed attestation of executing code.

## Evidence validation

Before interpretation, the module snapshots inert JSON without invoking input getters, enforces structural/byte bounds, verifies the observation digest and checks the requested identity. It accepts only the supported unregistered capture schema. It verifies the capture request digest, reader source-file inventory digest, report path/hash/size reference and consistency of producer source/configuration projections. Claimed execution or evaluation authority in a historical capture is rejected.

All step fields, metric names, finite numeric values, flags and reported hash formats are checked. Inner report diagnostics must remain represented in the outer capture diagnostics. Duplicate or decreasing indices are also detected directly from the steps, so omitting their diagnostic labels cannot hide those defects. Numeric diagnostics on rejected `step_index` fields also trigger step integrity: the reader omits those entries, so their absence from the retained series cannot make ordering pass. The checks authenticate internal consistency and the supplied archive binding. They do not recover raw report bytes or prove a producer assertion true; the capture stores a sanitized projection and file hashes.

## Rules and resulting requests

| Evidence | Finding and requested work |
|---|---|
| Missing report or no steps | Unassessable; obtain a readable, separately identified capture. Missing observations do not establish failure. |
| Malformed or unsupported report | Inspect report schema/source before analyzing metrics. |
| Duplicate, decreasing or structurally invalid steps | Resolve sequence/attempt provenance before interpreting a trajectory. |
| Recorded nonfinite/invalid numeric fields | Inspect the cited numerical/instrumentation failure. Missing loss or gradient values remain unknown, never zero. |
| Explicit failed post-update serving check | Verify adapter/checkpoint reload identity and independent serving evidence. Positive flags remain producer assertions. |
| Explicit skipped optimizer update | Inspect skip reasons and group filtering/variance. Skipping is not automatically erroneous or a stopping condition. |
| Explicit negative checkpoint flags | Request native checkpoint/state/resume-boundary verification. Positive flags do not verify a checkpoint. |
| Producer-reported abort | Recover origin-bound abort evidence; separately reconcile any claimed live job before recovery. |
| Missing original provenance, independent evaluation and baseline | Recover the manifest, specify fixed independent measurements and design a matched baseline/replication comparison. |

Every request is marked `diagnostic_request_only` and has an explicit completion-evidence description. Integrity findings rank before diagnostic questions and missing-evidence work. The module neither schedules paid tasks nor executes these requests. The durable output gives a controller concrete work to select under its own authority and budget.

The analysis examines all entries, including defects outside first/last summary windows. Each finding retains a total reference count and at most twenty reference examples. A diagnostic and a direct step field can both reference the same underlying event, so reference counts are not counts of independent failures or experimental replicas. Metric ranges summarize the observed fields only; they are not trend fits or uncertainty estimates.

## Scientific and operational boundaries

The current capture projection includes loss, gradients, optimizer/group diagnostics, some resource estimates and serving/checkpoint flags. It does not supply training reward, independently measured task success, a comparable baseline, complete configuration or held-out evaluation provenance. Consequently every packet leaves independent-evaluation and baseline checks unknown. Even otherwise favorable findings cannot produce scientific-readiness approval through the current council.

`not_triggered` means no trigger within that rule's observed scope. It does not mean training is healthy, reward is aligned, an optimizer is learning or the experiment is complete. There are no universal KL, entropy, gradient, plateau or reward thresholds. An old report timestamp does not establish a stalled process; reported spend does not settle bills. Acting on a live registered run would require authenticated stream/run identity, a registered intervention policy, fresh ledger authority and verified worker state, which this historical assessment does not possess.

This adapter remains specific to CoworkeRL. A conventional RL adapter should preserve episode/transition identity, environment steps, separate termination/truncation labels, policy/checkpoint identity and independently measured success rather than translating those concepts into CoworkeRL serving flags. The generic finding/evidence pattern is reusable; no conventional environment runner or evaluator is implemented here.

## Offline qualification

Thirteen focused tests use real temporary captures and ledgers, planted middle-step NaNs, missing metrics, malformed reports, duplicated/reordered indices, serving failures, skipped updates, checkpoint negatives and aborts. They also cover identity/reference tampering, getter rejection, caller mutation, stale timestamps, council blocking despite synthetic approval, reopening/idempotency and conflicting archive records. The tests make no model/provider calls and do not import or execute CoworkeRL. No scientific benchmark result or actual training qualification follows from their success.
