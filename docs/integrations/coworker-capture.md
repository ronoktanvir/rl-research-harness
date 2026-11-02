# Persistent CoworkeRL report captures

A capture archives monitoring evidence without inventing a historical run configuration. It uses the authoritative ledger's observation store, with `runId`, `actionId` and `jobId` all null. It never registers a manifest, changes execution or evaluation state, records a bill, or enables training.

## Identity and retries

Import `captureCoworkerReport` from `src/integrations/coworker/capture.ts` and pass the controller-owned ledger:

```ts
const observation = await captureCoworkerReport(ledger, {
  captureId: 'coworker-history-001',
  projectId: 'coworker',
  root: '/path/to/CoworkeRL',
  reportPath: 'artifacts/example/report.json',
});
```

The capture ID is the ledger observation's event ID. Its request identity binds the project ID, canonical project root and normalized project-relative report path. Reusing the ID for another source or another observation type is an error. The optional `observedAt` supplies a capture clock; it is not an original producer timestamp.

An existing matching ID returns the previously committed observation before rereading report or source files. New source contents, missing report files or a different current time do not silently replace that record. Use a **new capture ID** to request another observation. Concurrent requests in the same controller retain whichever matching capture commits first. The project root must remain resolvable so its canonical identity can be checked; root aliases resolving elsewhere conflict.

Observations use sequence zero and declare themselves unordered snapshots. A file's modification time, last step index and capture time do not establish authoritative producer-event ordering. The ledger retains each event and its payload digest; the capture API does not project them into a supposedly current trainer state.

## What the payload preserves

| Evidence category | Preserved content | Interpretation boundary |
|---|---|---|
| Capture provenance | Project/root/report request identity, capture time, ledger digest | Identifies this observation, not when the original run occurred |
| Reader identity | Adapter schema version and SHA-256 of the five harness reader/capture source files | Observed source snapshot; not executable-process or interpreter attestation |
| Current checkout | HEAD, hashes/lengths/times of the fixed source/config files, unavailable references, selection counts and diagnostics | Does not establish which source or selections produced the historical report |
| Report provenance | Report path, exact-byte hash, length, modification time, age and read diagnostics | Hash identifies observed raw bytes; raw contents are not archived |
| Parsed evidence | Existing sanitized numeric projection, explicit producer flags and source identifiers | Producer reports remain distinct from verified execution, checkpoint or evaluation facts |
| Original-run gaps | Missing or unverified source state, environment/dependencies, complete configuration, model/tokenizer, data/splits, reward/evaluator, seeds, resource limits, stop/evaluation policy and checkpoint lineage | No executable manifest is manufactured from partial evidence |

The current checkout and report are read independently. Each reference identifies bytes observed by its own bounded read; the capture is **not** an atomic project snapshot. Missing, unreadable, malformed and stale reports can still be captured as observations with their diagnostics. Missing metrics remain missing.

The file reader accepts reports up to 16 MiB, but the ledger currently limits each serialized record to 2 MiB. A sanitized projection that exceeds the ledger limit is rejected without creating a partial observation or silently dropping steps. Large-history chunking requires an explicit linked-record format and is not implemented here.

The original run remains unregistered. Execution, allocation and billing settlement remain unknown; scientific evaluation remains unassessed. Reported GPU spend is retained only in the sanitized metric projection with its declared scope. It is not converted into a settled ledger charge or permission to release a reservation.

The underlying [read-only integration](coworker.md) limits file access and requires a trusted Python 3.11+ interpreter. The capture stores local project paths and selected metrics in the local ledger, so the ledger remains private runtime data. It excludes raw configuration, endpoint URLs, credentials, traces and checkpoint tensor contents. Neither local databases nor captures belong in the source repository.

## Linking evidence to a verified run later

Run linkage requires separate evidence: an independently established immutable manifest, original source/data/evaluator identity, and a justified mapping from report bytes to that run. Register the verified manifest/run through the normal ledger API, then append a new evidence-bearing observation referencing the original capture's event ID and digest. Do not alter the archived capture, copy current checkout hashes into the original manifest, or infer the mapping merely because directory names match.

This module intentionally offers no automatic linking function. A later linking policy must also distinguish a claim of provenance from trusted execution or scientific evaluation facts; neither a link nor a successful parse validates the research.

## Qualification

Seven integration tests use temporary projects and fictional reports. They exercise real ledger persistence/reopen, unchanged retry after report removal, fresh captures after source/report change, conflicting source identities, concurrent same-ID captures, sanitized payloads, explicit original-run gaps, missing-report observations and rejection of an oversized projection without partial storage. Qualification covers these local archival behaviors, not remote liveness, original-run reconstruction or scientific validity.
