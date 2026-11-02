# CoworkerRL observed replay

The local adapter reconstructs one saved current-v2 episode with CoworkeRL's actual `build_observed_replay`, then applies its native extraction code to the same memo and instantiated fact definitions. It saves separate observations for authorized reading, numeric credit and policy termination. Semantic evaluation, task success and scientific evaluation remain **unassessed**.

This implements the local artifact adapter selected in [Decision0003](decisions/0003-native-observed-replay.md). It does not register an experiment, update the research ledger, launch training or call a model. Queue integration and scientific assessment remain separate work. See [actual qualification](research/observed-replay-adapter-qualification.md) and [independent review](reviews/2026-11-02-observed-replay.md).

## Commands and outcomes

```sh
npm run harness -- observed-replay request.json /absolute/path/to/python3.11 /new/private/output
npm run harness -- observed-replay-read /existing/private/output
npm run harness -- observed-replay-recover /existing/private/output
```

Execution requires a canonical absolute Python 3.11+ path on POSIX, the pinned source package and the selected raw input files. A new output directory is mandatory. Exit 0 means mechanical replay completed; an invalid-policy termination can still be a completed replay. Exit 2 means the attempt is incomplete or rejected. Invalid requests, missing bundles or existing output directories fail with exit 1. None of these exit codes certifies scientific success.

`observed-replay-read` validates and reopens saved evidence without reading the original project or invoking Python. `observed-replay-recover` can recreate missing report/receipt projections after a valid execution record was saved. It cannot reconstruct a missing execution, overwrite contradictory content or retry an interrupted attempt. An intentional repeat needs a separate output directory.

[Replay evidence planning](replay-evidence-planning.md) imports a complete verified bundle into the ledger, binds independent annotation claims and exports a prospective review packet. Its cached reads survive removal of the copied artifact root. The integration does not enqueue native replay, call a council or authorize experiments; current-v2 evidence cannot close historical Run-1 requests.

The command prints a summary of status, cleanup status, counts and evidence identities. The private `execution.json` contains the task, memo, all world fact definitions, observed messages and native observations. Treat that content as project data, not instructions. Keep these bundles outside version control.

## Explicit input identity

A request contains these fields; `prepareObservedReplayRequest` computes the optional `requestDigest` from the normalized request. Expected semantic labels and alias overrides are not accepted.

| Field | Required meaning |
|---|---|
| `schemaVersion`, `kind` | `1`, `coworker-observed-replay` |
| `sourceRoot` | Canonical absolute directory containing the reviewed `probing/` package |
| `artifactRoot` | Canonical absolute root containing the selected input artifacts |
| `sourceManifestSha256` | `39de34e0600e0df12aff786ea298bf71d36c84e28f4be2860bf243832943a895` |
| `episode` | Actual catalog `configId` and integer `seed` from 0 through 2147483647 |
| `result` | Root-relative path, complete-file SHA256/byte count and exact original `resultId` |
| `trace` | Root-relative path, complete-file SHA256/byte count and exact original `traceId` |
| `provenance` | Separate root-relative provenance file path, SHA256 and byte count |

The result and trace are original JSONL files. The worker scans the whole bounded file, validates its hash and unique record identities, and selects the requested ID. It retains the exact selected line's hash and one-based line number. Duplicate decoded JSON keys, ambiguous records, cross-linked pairs, judged results and mismatched native identities reject. Paths cannot traverse parents or follow symlinks; files must be regular and singly linked. Reads use pinned directory descriptors and detect metadata changes.

The provenance file has exactly:

```json
{
  "schemaVersion": 1,
  "kind": "coworker-memory-read-provenance",
  "backend": "mem",
  "readPageSize": 20,
  "systemPrompt": "EXACT SEPARATELY RETAINED SYSTEM PROMPT",
  "contractVersion": "EXACT CAPTURED NATIVE CONTRACT VERSION"
}
```

The two uppercase strings are placeholders, not working defaults. Obtain these declarations from the capture producer. Do not infer the backend from an inference-server label, copy the prompt out of the trace to pass validation, or clear judge fields. The adapter verifies agreement under the supported protocol; declarations do not authenticate historical execution. Qualification uses explicit synthetic fixture declarations and does not fill historical provenance gaps.

## Source, execution and evidence boundaries

The checked-in [manifest](../src/integrations/coworker/observed-replay-source-manifest.json) pins 150 source/data files totaling 3,524,091 bytes. The factory embeds that complete manifest into the worker before hashing its executable source and writing intent. The child verifies and stages every source file before importing the real catalog, instantiating the selected episode and calling native replay/extraction. Task-package-only configurations are unsupported. Updating native source requires a reviewed manifest/profile change and new qualification; the request cannot supply its own manifest or import path.

The child uses Python's isolated, no-site, no-bytecode modes and standard-library dependencies. A minimal environment omits ambient credentials. Audit guards deny network, subprocess, environment mutation and unsupported file effects during native execution; imports are confined to the staged package and interpreter runtime. Source bytes are checked again after replay. These controls apply to reviewed pinned Python, not arbitrary hostile code or native extensions. Runtime versions and imported project modules are recorded; interpreter paths are declarations, not binary attestations.

Bounds are explicit: request 64 KiB; each source file 2 MiB and source total 32 MiB; result file 16 MiB; trace file 64 MiB; JSONL line 8 MiB; 1000 records/file; provenance 256 KiB; 128 turns; 2048 transcript messages; 256 world facts and 64 required facts. The native JSON response is capped at 512 KiB without truncation; the parent caps combined stdout/stderr at 1 MiB and execution at 60 seconds. These do not establish a global memory quota.

For each required fact, the result retains native credit or an explicit scorer error, authorized observation witnesses and their conjunction. Every required target is represented once. It also preserves all nonrequired world facts, labels, definitions, periods, populations, denominators, aliases and source ownership. Repeated reads cannot inflate the required-fact denominator. Read pages bind reconstructed message IDs to the next inference request hash; this is **validated state reconstruction**, not IDs supplied on the read wire or proof of historical custody. The next-request hash uses Python's native JSON number spelling; request and fact-definition digests have string/integer schemas shared with the controller.

The bundle is written in order: synced intent, synced execution, derived report, final receipt. The receipt binds the intent, execution and report; offline load revalidates the result relationships and regenerates the expected report. Local artifact roots and controller code remain trusted. A writer able to replace a complete self-consistent bundle can forge its origin; these receipts are not signatures or execution attestations.

The parent removes its private source staging after completion, timeout or cancellation. Removal failure preserves the known process outcome and records cleanup as `pending`, with its path retained privately. Read/recover never deletes that path. A controller crash can still leave source-only staging behind; managed-worker crash cleanup remains future integration. Source staging cleanup is unrelated to training termination, cloud release or billing.

## Verification

`npm run test:replay` runs the default Python boundary tests and independent TypeScript tests. Actual native tests require the retained private fixture archive through `RLH_COWORKER_REPLAY_QUALIFICATION`; ordinary CI deliberately skips those fixtures. The [qualification record](research/observed-replay-adapter-qualification.md) distinguishes default checks, real source execution, failure cases and offline recovery.
