# Evidence-informed research planning

The evidence-planning projection turns an archived investigation into a bounded next-action proposal. It distinguishes what the investigation established from the scientific questions it left open. It does not rewrite the original assessment, close its evidence requests, or authorize execution.

## Supported criteria and remaining requirements

`assessCoworkerInvestigationEvidence` revalidates the capture, its deterministic assessment, and the investigation's intent, worker output and result chain. Its input binds exact observation IDs and digests to one project and capture. The function reads only the archive; it does not reread project files, invoke a model, rescore outcomes or run training.

Supported criteria are narrow. Depending on the retained checks, they can establish report/manifest correspondence, reconstruction of declared Python source bytes, adapter-file correspondence, exact saved trace/result joins, selected comparison settings, and recounts of producer labels. A saved commit-to-tree mapping remains a declaration. A matching adapter hash does not establish tensor behavior or historical model loading. Recounting credited facts does not validate task success.

Scientific requirements remain explicit: semantic evaluator validity, protected evaluation access and selection, complete original provenance, matched training controls, and an estimand with an appropriate training-run replication design. Native checkpoint/resume verification remains open where requested. One trained policy's evaluation rows do not become independent training replicas. “Not established” describes this evidence's scope; it does not prove that evidence is absent elsewhere.

The projection records which subcriteria now support each original request. A request can become partially supported while its original disposition stays unresolved. Prior numerical, serving and optimizer findings remain capture-time evidence. The old capture-only statement that evaluation or comparison evidence was unavailable is not repeated as the current state after additional artifacts have been inspected.

## Partial investigations

An incomplete investigation can retain a verified prefix of stages and the bounded references from its failed stage. Those references support only their recorded checks. A failed or missing stage does not become supported because its file reference exists. When the complete comparison payload is unavailable, the assessor does not infer counts, differences or comparison validity from file hashes alone. Producer errors, incomplete flags and resumed-record accounting remain visible even when inspection itself completed.

## Packet and council scope

`buildCoworkerPlanningPacket(archive, binding, createdAt)` calls the assessor and returns a new immutable `EvidencePacket`. It performs no archive writes or council dispatch. A new packet and council identity avoid rewriting a previous council's fixed evidence and checks.

The packet's passed checks certify archive binding, deterministic derivation and prospective-planning scope. Unresolved scientific requirements remain evidence that reviewers must address; they are not relabeled as passed scientific checks. Reviewers must distinguish established facts from unknowns, compare alternatives, specify falsifiable completion evidence, respect controls and replication, and preserve execution authority.

A council may endorse the prospective plan while scientific evaluation remains `unassessed`. Its scope carries `executionAuthorized: false` and `interventionAuthorized: false`. An `approved` planning result does not approve a historical learning claim, permit training, release a resource allowance, or dispatch an action. Recommendations describe work with separately required handlers and authority. Proposal prose must not be parsed into an execution instruction.

## Citation identity

Derived summaries use `derived-assessment:<digest>`, with the assessment rules digest as their version and the canonical assessment-body digest as `sha256`. This locator identifies a reproducible projection, not a ledger observation at that digest. The derivation records retain the exact source observation bindings; criterion summaries retain observation IDs, digests and JSON pointers. Prior diagnostic findings cite their actual assessment observation and its digest. These identities establish content correspondence, not external authenticity or historical execution custody.

## Command interface

The controller entry points are:

```text
npm run harness -- evidence-update <config.json> <request.json>
npm run harness -- evidence-status <config.json> <evidence-observation-id>
npm run harness -- evidence-packet <config.json> <evidence-observation-id> <output.json>
```

`evidence-update` archives the deterministic projection from bound observations; `evidence-status` recovers its verified state; and `evidence-packet` exports the planning packet for a separate council. The first two commands return exit code 2 with `evidence_required`; export returns zero when the packet is saved. Export will reuse an identical destination but refuses to overwrite different content.

The update request contains `projectId`, an explicit `updateId`, and three references named `investigationWorkflow`, `investigation`, and `followups`. Each reference contains `observationId` and `observationDigest`. These digests identify the **outer ledger observations**, not the workflow payload's own digest. The workflow reference derives and verifies the original assessment and capture chain; callers cannot supply criterion outcomes.

The first archive requires the exact investigation task and current attempt to have completed with the matching receipt. It saves a bounded controller observation of that completion. Offline loading recomputes the projection from archived records without queue or project-file access. A lost acknowledgement after the append recovers the same record. The completion witness is trusted controller testimony, not a cryptographic proof against arbitrary ledger writers. Reusing an update ID with different references fails; a changed evidence basis needs a new update.

None of these operations supplies execution authority or independently completes scientific validation. An exported packet can be included in an explicitly prepared new council campaign under its existing invocation limits; exporting does not enqueue or run that campaign.
