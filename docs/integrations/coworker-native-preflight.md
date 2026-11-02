# CoworkeRL native preflight contract

The harness can prepare the native `--preflight-only` command and interpret a bounded result. **A passing receipt establishes only a matching local-contract output; it never authorizes training or establishes full native admission.** The module contains no executor and does not import CoworkeRL, inspect credentials, contact a provider, read project artifacts or create an experiment run.

The source inspection reconfirmed CoworkeRL HEAD `84b219f64f1152f8b02babea388bfbbfff41e75a` with no tracked changes. Only named source files were inspected. No untracked research artifact inventory, native package import, trainer execution, dependency installation, provider call or checkpoint tensor read occurred. The actual native runtime has not been qualified by this work.

## Native entrypoint and evidence

The prepared command is the frozen attempt command with Python's `-B` flag prepended and `--preflight-only` appended:

```text
<declared-python> -B -s -m probing.verl.fit_loop <unchanged frozen flags> --preflight-only
```

Working directory and the explicit non-inherited environment remain those of the validated attempt preview. This preserves the source `PYTHONPATH`, training seed, and declared source revision. `-B` suppresses Python bytecode writes; it does not disable dependency caches, runtime imports or arbitrary side effects. The preparer does not create the run, adapter or helper-cache directories named in the unchanged arguments.

Native `main` constructs `FitLoopConfig`, calls `preflight(config)`, prints a success marker, then computes and prints objective metadata. The expected successful stdout is exactly two newline-terminated records:

```text
preflight: PASS
{"training_objective": ...}
```

The marker is printed **before** `objective_metadata` can still raise. Therefore a marker alone is insufficient; the interpreter requires exit code zero, no interrupted/truncated-process indication, and the complete valid second record. Unexpected stdout prefixes, extra records or missing final newline remain unknown. Dependency warnings may appear on stderr, whose hash is retained. See [native CLI dispatch](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/src/probing/verl/fit_loop.py:1950) and [output ordering](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/src/probing/verl/fit_loop.py:1990).

The native local checks cover explicit task selection, declared caps, selected objective/decoding settings, reward/task compatibility, initialization mode, prompt limits, mutually exclusive initialization/resume declarations, registered advantage estimator and an elision canary. The canary uses scripted responses and an in-memory session; its helper transport deliberately raises if called. This is source evidence for the inspected path, not an observed network-isolation test. See [preflight checks](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/src/probing/verl/fit_loop.py:364), [canary](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/src/probing/verl/fit_loop.py:264), and [in-memory provisioning](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/src/probing/mattermost_mem.py:222).

The objective record uses `coworkerl-fit-loop-objective/v2`. It reports installed verl version `0.8.0`, the declared actor and correction settings, the full resolved actor config and eight imported implementation names with source/module SHA-256 values. Native code checks the package version, resolved pins and selected function signatures before emitting this record. The harness checks its schema, fixed scientific declarations, applied actor settings, group size and digest formats. It retains the metadata; it does not independently recompute the reported implementation hashes or treat unused actor defaults as active training settings. See [metadata production](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/src/probing/verl/fit_loop.py:769) and [objective declaration](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/src/probing/verl/objective.py:1).

## Harness API and identity

[`native-preflight.ts`](../../../src/integrations/coworker/native-preflight.ts) exports two pure functions:

- `prepareCoworkerNativePreflight(plan)` reconstructs the exact preview from its declarations and rejects any substituted command or self-hashed alteration. It returns a frozen declaration containing the preview, derived command, required worker conditions and a digest.
- `interpretCoworkerNativePreflight(declaration, observation)` reconstructs the declaration again, verifies supplied plan/declaration digests, validates timestamps and the complete process result, and returns a frozen receipt.

An observation contains `planDigest`, `declarationDigest`, `startedAt`, `completedAt` and `process: {exitCode, stdout, stderr, stopped}`. Process output is limited to 128,000 UTF-8 bytes across both streams. Inert input has a 1 MiB accounting limit, 40,000-node bound and maximum depth 32; getters, non-JSON values, sparse arrays and duplicate JSON output keys are rejected. A nonzero completed process produces `failed`; interrupted execution, missing exit information or malformed success output produces `unknown`.

The receipt binds the exact plan, declaration, command, target action and manifest. It retains validated objective metadata, process status and SHA-256/byte counts of the captured UTF-8 output strings. The caller must archive the originating worker/job observation and output if it needs reconstructible raw evidence. These hashes are not signatures, and the parser cannot establish that an arbitrary supplied result came from CoworkeRL. Its explicit evidence origin is `controller_supplied_process_result_not_independently_attested`.

The declaration's target action ID is the attempt's proposed training action, **not a new preflight job identity**. A controller that executes preflight must admit and identify that separate operation, retain its worker binding, and reconcile ambiguous launches without replay. This module does not perform that admission, schedule work or write a ledger validation.

## What remains pending

The native flag does not call the training path's numerical-receipt verification, live serving/sampling checks, empty-output-directory admission, initial-adapter fingerprinting, model/tokenizer loading, CUDA execution, checkpoint inspection or resume-boundary verification. These occur later in [`_run_admitted`](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/src/probing/verl/fit_loop.py:1249). Even a nonexistent resume path can pass the earlier declaration checks.

Native checkpoints separately require a completed-step schema, exact file inventory/checksums and adapter tensor fingerprint. Resume additionally requires matching origin run evidence, a tensor-verified checkpoint, and no later reserved step or later-step artifacts. Expected scientific/config identity and optimizer/RNG restoration are further checks. Hashing `checkpoint.json`, or passing local preflight, cannot substitute for those contracts. See [checkpoint inspection and boundary](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/src/probing/verl/checkpoint.py:279).

Faithful selections also read referenced task configs, human approval and interpretation notes beyond the experiment-manifest file hashed by the current artifact verifier. Their complete immutable execution-time input closure is not established by this receipt. See [task-package loading](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/src/probing/faithful_tasks.py:62) and [semantic binding](/Users/ronoktanvir/CoworkeRL/experiments/coworkerl-v2/src/probing/faithful_eval.py:126).

Any actual preflight must run within a separately qualified, bounded supervisor with no credentials, denied network, immutable read-only source/inputs and separately admitted resource limits. Heavyweight torch, peft, transformers, verl and other imports occur before argument handling; their import behavior is not qualified here. The generic supervisor's existence alone does not establish this stricter preflight boundary. Image/interpreter identity, freshness, scientific review, spend authority and allocation cleanup all remain separate.

Nine offline tests cover declaration tampering, getters, exact command derivation, complete output, marker-before-failure, interruption, duplicate keys, formula/config drift, identity and size bounds, resume limitations and a harmless real subprocess. That subprocess only echoes synthetic metadata; it deliberately does not qualify the native dependencies or trainer.
