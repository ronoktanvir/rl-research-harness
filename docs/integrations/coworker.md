# CoworkeRL read-only integration

The harness can inspect CoworkeRL's current source/configuration references and read an explicitly selected training report. It does **not** launch training, contact model providers, change the project, verify live GPU state, or declare that a scientific result is valid.

## Observed project and integration scope

The local project is `/Users/ronoktanvir/CoworkeRL`, spelled **CoworkeRL** in its own README. It was inspected at Git revision `84b219f64f1152f8b02babea388bfbbfff41e75a` on 2026-11-01. The tracked checkout was clean at inspection, with substantial pre-existing untracked research artifacts. No applicable `AGENTS.md` was found in the root or relevant experiment paths. These are inspection facts, not an ongoing assertion that the checkout is unchanged.

The active implementation is `experiments/coworkerl-v2`, distinct from historical `experiments/probing` and `pilots/collaboration`. These packages reuse the `probing` import namespace, so importing them together would be ambiguous. The integration imports **none** of their Python code.

Relevant observed implementation:

- `experiments/coworkerl-v2/README.md` describes an LLM collaboration environment, helper/scorer health checks, and a GRPO training path. API/environment evaluation and the Mattermost tool-loop training driver have different identities.
- `experiments/coworkerl-v2/pyproject.toml` declares Python >=3.11 and optional GRPO dependencies including verl, Torch, PEFT and the helper SDK. This harness does not install them.
- `src/probing/configs/selection_manifest.json` names development, held-out-review, optional, variant and quarantined selections. Its own notes say these are calibration selections, not inherited publication-split approval.
- `src/probing/verl/fit_loop.py:1492` writes `run-manifest.json`; around line 1528 it creates an unversioned `report.json` structure with `config`, source identifiers and `steps`. Around line 1801 it appends step diagnostics, then publishes checkpoints and report updates.
- `src/probing/verl/metrics.py:159` defines group/window denominators. The reader retains emitted values; it does not recompute them using a different denominator.

The v2 source describes complete LoRA/Adam/RNG/loop checkpoints, but the historical completed study documented in the root README has weights-only checkpoints. Neither can be inferred from a generic checkpoint directory name. This integration exposes only the report's explicit checkpoint flags as **producer-reported**, and does not inspect tensor files or certify resumability.

## Available API

Import from `src/integrations/coworker/index.ts`:

```ts
const project = await inspectCoworkerProject('/path/to/CoworkeRL');
const observation = await inspectCoworkerRun(
  '/path/to/CoworkeRL',
  'artifacts/probing-helper-artifacts/phase2-bundle/main-s11/report.json',
  { staleAfterMs: 15 * 60 * 1000 },
);
```

`inspectCoworkerProject` reads a fixed set of source/config files. It returns file paths, SHA-256 hashes, lengths and modification times, a normal `.git` directory's HEAD revision when available, and selection counts. It does not search every research folder or return configuration bodies. `workingTreeState` is always `not_assessed`: HEAD alone does not certify a clean source tree. Linked-worktree `.git` pointers are not followed and yield an unavailable revision.

`inspectCoworkerRun` opens only the project-relative `report.json` chosen by its caller. It returns the exact report-byte hash, observation age, a typed metric projection and diagnostics. `parseCoworkerReport(text)` provides the same parser for a caller that already has report text. `now` can be supplied to the file reader for reproducible observation tests; no injected clock changes the source's timestamps.

Supported projections include step index; loss and gradient norm; group counts/throughput; loss-decomposition diagnostics; elapsed and phase time; helper/judge attempt counts; spend; explicit optimizer-update and serving-check flags; and selected checkpoint flags/hashes. Only known numeric fields and hash-shaped source identifiers are returned. Endpoint URLs, credentials, freeform config, raw traces, checkpoint paths and arbitrary report text are excluded from the returned object.

## Interpretation rules

| Observation | Reader behavior | What it does not establish |
|---|---|---|
| Missing report or field | Emit a diagnostic; retain absence | Zero loss, zero spend, or a failed job |
| Python `NaN`/`Infinity`, or numeric overflow | Record a nonfinite error and omit that metric | A usable numeric measurement |
| Duplicate or decreasing step index | Preserve observations and flag the conflict | A canonical deduplicated training history |
| Malformed/incomplete JSON | Return no parsed metrics | Permission to repair the source or restart training |
| Old file modification time | Warn that this file observation is stale | A stalled process; historical copies are often old |
| Recent file modification time | Report the observed timestamp | A live process; copying a file can refresh its time |
| Abort object or failed serving flag | Preserve the producer's failure indication | Confirmation of remote termination |
| Full-state or round-trip checkpoint flag | Expose it as producer-reported | Independent checkpoint integrity or resume qualification |
| `spend_usd` with declared v2 basis | Identify training-process GPU cost estimate | Total billing, which also includes idle/setup/API/storage |
| Historical spend without a declared basis | Mark accounting scope unspecified | A verified bill or the v2 cost contract |

`executionState` is always `unknown`. The fit-loop report is a snapshot, not a process-liveness or terminal-state receipt. The parser does not equate the last step with completed training, nor training loss with held-out success. Independent evaluation is explicitly unobserved.

## Read boundaries

The file reader requires a trusted **Python 3.11+ `python3` on PATH**, running on macOS or Linux with descriptor-relative `os.open`, `O_DIRECTORY` and `O_NOFOLLOW`. It invokes only the harness's own standard-library helper using `python3 -I -S`, from the helper directory; isolated/no-site mode excludes project modules, user site packages and Python environment customization. No CoworkeRL Python code or dependencies are imported. A missing/unsupported reader fails closed, with no fallback to a weaker path-based read.

After resolving the explicitly selected project root, the helper opens `/` and every root and requested parent component relative to an already-open directory descriptor with `O_DIRECTORY | O_NOFOLLOW`. It opens the final component relative to the pinned parent with `O_NOFOLLOW | O_NONBLOCK`, then requires a regular file. Replacing an ancestor with a symlink either fails the read or leaves the reader attached to the original directory; it cannot redirect the read through the replacement link. No separate path-check/open sequence is relied on for this boundary.

The reader refuses traversal, symbolic links, nonregular files, and reports larger than 16 MiB. Source/config reads are limited to 2 MiB. Reads stop at the allowed length plus one byte even when files grow, and report changes in size, modification time or change time during the read. Helper execution has a 20-second deadline. Nothing is written to CoworkeRL.

Descriptor-relative access protects path traversal; it does not replace OS isolation of an untrusted worker or trusted ownership of the interpreter/helper. A process able to modify the selected regular file can still change its contents. The parser and SHA-256 references identify observed bytes, not atomic consistency across an entire running project. Untrusted remote workspaces still require the worker isolation described in the architecture.

No recursive artifact scan is performed by default: the repository contains large archived workspaces, provider-request records and private evaluation material unrelated to this adapter's job. The caller must select the report it intends to observe. Automatic discovery and a live event/heartbeat protocol can be added only with an explicit artifact-root contract.

## Validation performed

Eleven deterministic tests use invented values and the observed report field names, without copying private run content. They cover source references, credential-field omission, historical optional fields, Python nonfinite literals, malformed JSON, conflicting steps, stale observations, traversal/symlink rejection, missing files, read-only behavior, oversized reports, invalid clocks, root validation and strict read bounds. An instrumented regression swaps a parent directory for an outside symlink immediately before and immediately after its actual descriptor open; neither case reads the outside fixture. These checks ran on macOS with Python 3.11.9; Linux uses the same POSIX primitives but has not been separately exercised in this environment.

A read-only smoke check against the local project found six configured source references and parsed the historical `phase2-bundle/main-s11/report.json` as 30 recorded steps. That check did not execute the upstream project, open checkpoint tensors, call a provider or start training. It does not turn historical evidence into qualification of the current v2 study.

## What remains before a training adapter

Launching requires a separately qualified worker/backend contract, the project's current frozen scientific manifest, model/compute budgets, source identity, helper/judge access, independent evaluation, termination/reconciliation and resource-release policies. The current integration exposes `launch`, `cancel` and `checkpoint` capabilities as false. Training remains outside this implementation slice.
