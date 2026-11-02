# Durable historical CoworkeRL investigation

This integration checks selected historical artifacts and archives the resulting evidence. It does not reconstruct an executable experiment manifest, admit training, validate the scorer or close a scientific follow-up. The original capture remains unregistered historical evidence; the result preserves `scientificEvaluation: "unassessed"` and `followupDisposition: "unresolved"`.

## Capture and deployment boundary

[`normalizeCoworkerInvestigationRequest`](../../src/integrations/coworker/investigation.ts) accepts `{projectId, investigationId, captureId, captureDigest, localArtifacts}`. The selection contains five relative paths: `adapterPath`, `trainedTracePath`, `baselineTracePath`, `trainedEvaluationDirectory` and `baselineEvaluationDirectory`. The operator supplies the canonical project root separately through configuration. Neither task input nor archived source material selects an executable, script or unrestricted filesystem root.

Preparation verifies the capture's observation digest, envelope, report reference and sanitized projection. The worker's expected report path, SHA-256 and byte count come from that capture. They are not global constants identifying the author's original dataset. Source compatibility is currently restricted to the inspected historical algorithm at `ccfd25df63f55e408b67e984710eb6d3dd9e609f`; a Phase2 capture cannot substitute merely because both runs are called `main-s11`. This compatibility restriction does not establish that the original trainer executed those bytes.

The selected evaluation directories must be distinct children of the same parent under `artifacts/probing-helper-artifacts/`. Each trace is the explicit `.local-artifacts/<evaluation-directory>/step0-trace.jsonl` counterpart. The adapter belongs to the captured report's directory and its step is checked against the report. There is no glob search, automatic alternate-file selection or cross-run join by label.

## Fixed reader and retained evidence

[`createCoworkerInvestigationWorker`](../../src/integrations/coworker/investigation-worker.ts) reads and hashes the packaged Python helper at trusted setup, then executes those exact bytes with an operator-selected Python 3.11-or-newer interpreter in isolated, no-site mode. It never imports CoworkeRL code or executes a script found in the earlier manual investigation artifact. Its descriptor pins the helper hash, interpreter path, timeout and limits before an archival intent exists. These are observations and declared bounds, not an attestation of the interpreter's bytes.

The helper traverses paths relative to directory descriptors without following symlinks. It reads bounded metadata, streams adapter and trace hashes, verifies archived Python blob identities and the inspected source-digest calculation, and joins selected producer results to traces. The six ordered check stages are report, source, adapter, trained evaluation, baseline evaluation and comparison. A missing or mismatched later artifact retains the earlier check references; it does not become a successful comparison.

The source commit-to-tree link is a saved declaration; verifying the referenced tree and blob bytes does not authenticate a Git commit object. Likewise, `comparator: "bare_base"` means the selected producer records declare the empty-adapter condition. It does not prove that the historical serving process loaded the claimed base-model bytes.

The descriptor declares 4 MiB metadata, 8 MiB per trace line, 800 MiB per trace, 400 MiB adapter, 1,000 records and 64 KiB combined process output limits. The default timeout is 120 seconds, with a 300-second ceiling. Raw prompts, trace bodies, model answers and process output text are not archived. Results retain bounded file references, field availability, source/input/output digests, producer counts and explicit failure reasons. Input uses canonical JSON; `inputDigest` identifies the worker request body and `inputBytesSha256` identifies the complete serialized request, including its digest field. Process output hashes refer to the bounded text captured by the process transport.

## Archival APIs and recovery

`validateCoworkerInvestigationPreparation(archive, request, {root, worker: descriptor})` checks the complete request, capture and existing identity without appending or reading source files. Queue handlers should call it before admission, so a wrong root or unsupported capture fails before a task starts. `copyCoworkerInvestigationData` provides a bounded inert JSON copy for those controller input boundaries; nested getters are rejected without invocation.

`prepareCoworkerInvestigation(archive, request, {root, worker: descriptor, now?})` applies those same checks and writes immutable intent without reading project files or starting the helper. `runCoworkerInvestigation(archive, request, {root, worker, signal?, now?})` writes an attempt before invoking the reader. `coworkerInvestigationObservationId(projectId, investigationId)` returns the stable result ID. `loadCoworkerInvestigation(archive, resultId)` verifies saved provenance without a worker or source-file read.

The intent binds the exact request, capture, root, worker descriptor and input digest. Each attempt has its own sequence, start observation and output receipt. A committed output is authoritative even if writing the final result fails: another `run` repairs that projection offline. A completed or incomplete archived outcome is final for its investigation ID. Reusing that ID returns the original observation even if files were removed; a new ID explicitly requests new observations. A changed worker, timeout, interpreter, selection or capture conflicts with the existing intent.

Only an interrupted attempt with no durable output can repeat under the same request. This is authorized read-only reinspection, recorded explicitly as a new attempt; it does not assert identical filesystem contents. The wrapper permits at most three such attempts and blocks overlapping same-identity calls in its process. Separate controllers require their own coordination; the ledger retains its existing exclusive-owner requirement. A thrown worker or invalid output produces a bounded incomplete receipt without retaining exception messages or arbitrary output fields.

## Meaning and qualification

A completed result means the selected byte-correspondence and producer-count checks completed. A partial result identifies the failed stage and available preceding references. Neither establishes semantic scorer correctness, protected holdout access, causal benefit, a matched training control, historical execution custody or checkpoint resumability. One trained policy remains one training replica regardless of its evaluation episode count.

The wrapper appends observations only. It does not modify runs, actions, evaluation state, budgets, holds or outstanding scientific requests. Its ledger is a trusted controller store; self-consistent hashes do not make arbitrary writers trustworthy. Offline tests cover capture identity, strict output schemas, source and input drift, interruption, bounded retries, projection repair and recovery without files. Positive parser fixtures and actual historical qualification must be reported separately; neither should be inferred from injected archival tests.
