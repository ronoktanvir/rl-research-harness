# Offline native credit calibration

`credit-calibrate` runs a reviewed extraction function on a synthetic fixture and compares its observations with separately declared expected labels. It detects counterexamples; it cannot approve a scientific experiment. The [actual qualification](research/credit-calibration-qualification.md) found a current-v2 false positive despite reproducing its existing regression suite.

## Use

Create a request object with `source: { path, sha256 }` and `corpus`. `path` is the canonical absolute path of the selected extraction file, and `sha256` must be one of the two reviewed hashes in [the registry](../src/integrations/coworker/credit-calibration.ts). `corpus` is the JSON object in [the example fixture](../examples/calibration/coworker-credit-cases.json), or another explicitly authored fixture following its schema. The two supported source versions are legacy Run-1 extraction and the inspected v2 extraction. Other code requires a reviewed registry change.

```sh
npm run harness -- credit-calibrate request.json /absolute/python3.11 new-output-directory
npm run test:calibration
```

The interpreter must support Python 3.11+ and the POSIX file primitives used by the probe. An interpreter path is trusted configuration, not an attestation of every interpreter/dependency byte. The command requires a new output directory and refuses to overwrite or automatically replay a previous invocation. It writes an intent first, then execution evidence and a Markdown report, and a receipt last. An interrupted directory without a receipt remains incomplete evidence.

Exit codes are 0 for no counterexample in the scored fixture, 3 when counterexamples are found, 2 for an incomplete or unassessed check, and 1 for command/input errors. Exit 0 is not scientific approval. The command does not enter the research queue, change a ledger decision, repair the project scorer or launch training.

## What executes and what stays separate

The parent snapshots the request and probe source before execution. It strips expected labels and rationales from the probe input, launches the trusted interpreter with `-I -S -B`, a minimal environment and no project import path, and enforces a 30-second maximum deadline and 128 KiB combined output cap. There are no automatic retries.

The Python probe checks every source-path component without following symbolic links, requires a regular singly linked file, caps its size at 128 KiB, checks its descriptor metadata around the read and verifies its captured bytes against the fixed registry before execution. Both supported modules were inspected and use only standard-library dependencies. This is permission to execute those exact reviewed modules, not isolation for arbitrary Python or a general network/filesystem sandbox.

Requests are limited to 256 KiB, 128 cases, 16 facts per case and 8,192 characters per memo, with smaller bounds for identifiers and fact fields. The probe rejects duplicate JSON keys, unsupported types, duplicate IDs and output that could exceed its cap. The parent also bounds inert input while traversing it, rather than first serializing an unbounded object.

Each result binds the complete scored input digest and source hash. Parent validation requires exact ordered case/fact joins and either a Boolean verdict with no error or a null verdict with an explicit scorer error. A per-fact exception is retained as `scorer_exception`; a non-Boolean native result is `invalid_verdict`. Source/loading/process failures remain incomplete executions. None becomes a negative prediction.

## Interpretation

`known` counts successful native verdicts whose expected labels are Boolean. `unknown` counts successful verdicts whose expected label is unknown. `errors` counts facts without a valid native verdict, even if their declared expectation is unknown. Together these categories equal `total`; errors and unknowns are excluded from the confusion counts. Every original expectation and rationale remains in the per-fact record.

Any observed false positive or false negative produces `counterexamples_found`. With no observed disagreement but at least one scorer error, or no scored known labels, the conclusion is `unassessed`. Otherwise the conclusion is only `no_counterexample_in_fixture`. Reports retain per-case disagreements and reasons instead of reducing the decision to a percentage.

The [rubric](research/credit-calibration-rubric.md) defines affirmative metric/value/unit credit. It does not establish lawful disclosure, attributable arrival, source correctness, helper quality, judge calibration, reasoning validity or whole-task success. These selected, related synthetic cases do not estimate a population error rate or training effect. The next integration must preserve those distinctions when combining extraction with provenance and independent semantic annotations.
