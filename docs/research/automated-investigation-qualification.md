# Automated historical investigation qualification

The fixed investigation worker reproduced the earlier manual Run-1 byte-correspondence and producer-count findings through the actual controller queue. The archived inspection completed; scientific evaluation remained unassessed and all three original follow-up requests remained unresolved. No model call, training run or cloud resource was started.

## Exact scope and identity

The qualification used Node 25.9.0 and the existing Python 3.11.9 interpreter at `/Library/Frameworks/Python.framework/Versions/3.11/bin/python3.11`. Trusted configuration selected this interpreter; invocation limits stayed at two already-consumed units. Source is implemented by commits `75d65d9` and `8f02e5c`, with CI configuration at `f62d2cace4459d759c2f797f668b81cbb4f45605`.

The workflow bound project `coworker`, original capture `historical-main-s11` and capture digest `45a2895985fcef74a2cf3596cf76f4ddfd00b2625fa22e7158a8727390e8e5bd`. The capture supplied the expected Run-1 report hash `8d73572a733f05bcdf9eacda9af3bb5f92394745c6cd77c00786fe245df80c5a`. The five explicit artifact selectors are the Run-1 adapter and `heldout-diagnostic/s11-trained` and `s11-baseline` paths documented in [the manual investigation](historical-evidence-followup.md). No later Phase2 evidence was substituted.

- Workflow: `investigation-workflow:a183aa8ee43f7c0b05d7f32193b62aa4b873bcc7a7888fa583be44268177513f`.
- Result: `coworker-investigation:a183aa8ee43f7c0b05d7f32193b62aa4b873bcc7a7888fa583be44268177513f`.
- Result observation digest: `b01b649f9eb06910ed722ee3419bcb9c773f48e526d3cf7fd3f87347218c8786`.
- Observed at: `2026-11-02T08:23:35.513Z`.
- Fixed Python helper SHA-256: `b83098e8621019621f70b5ef392880ce69e96a6c10174f93ffb28e00ece12be8`.
- Exact canonical input bytes SHA-256: `49fd11aef22d1e5fad5365c78a03e956fe3ea95cf8a006d702fc7835010964c6`.
- Typed result SHA-256: `a600c533339b7b2f72c439cb9315b83431cbe170d8aa9c2b55211ffece0fe6b0`.

These references are retained in ignored `.harness/coworker.sqlite`; the request, command outputs, boundary snapshots and qualification projection remain in `.harness/`. Private trace contents and local databases are not repository artifacts.

## Observed checks

All six stages completed: captured report/manifest, source, adapter, trained evaluation, baseline evaluation and comparison. The helper exited zero without interruption, emitted 9,165 bytes of bounded metadata and no stderr. Its packaged source ran in isolated, no-site mode; it did not import CoworkeRL or execute the script embedded in the manual investigation artifact.

The source check verified 75 Python blobs containing 1,037,901 bytes and reproduced digest `739f568e0d8f481c8f9237809d83d39248d2f79a20e68cb2dcba8e82f23a7275`. The 349,243,752-byte adapter matched the report and all trained trace declarations. Both trace file hashes matched the previous manual investigation.

| Saved measurement | Trained policy | Bare-base condition |
|---|---:|---:|
| Unique joined evaluation records | 384 | 384 |
| Producer-credited facts | 23 | 17 |
| Producer clean-success flags | 1 | 0 |

The six evaluation configuration IDs were disjoint from the twelve training IDs. Selected worlds, model/tokenizer declarations, reported runtime-source and schema declarations, and selected decoding settings agreed across the two conditions. These checks permit an exact recount of saved labels; they do not independently validate those labels, prove blindness or isolate a causal training effect. The comparison still contains one trained policy and lacks a matched training control.

## Recovery and preserved boundaries

Separate CLI processes prepared, ran and reopened the workflow. A second `investigation-run` returned exactly the same progress and archived result with the attempt count still one. Both runs returned exit code 2 because the workflow remains `evidence_required`. The synthetic CLI test separately deletes its source tree before reopening, demonstrating that completed replay uses the archive.

Before/after checks compared complete project run/action records, the original follow-up plan, global/project budget records, account resource holds and arXiv availability/hold records. They were unchanged; the transient availability query timestamp was excluded from this comparison. The arXiv hold remains active, both invocation units remain consumed and no allowance was increased.

Current byte correspondence is not historical execution attestation. The source mapping, model and evaluator declarations remain declarations; adapter hashing does not validate tensors or resumability. Per-file bounded reads are not an atomic project snapshot, and the reader's byte/record/time bounds are not a universal process-memory guarantee.

## Verification

Local qualification passed 504 TypeScript tests, with four explicit native skips, and all 15 investigation Python tests. Typecheck and whitespace checks passed. [Independent review](../reviews/2026-11-02-historical-investigation.md) corrected comparison joins, completion evidence, enum coercion, preflight timing, getter validation and interpreter selection. The new CLI test exercised the production parser through capture, assessment, queue, archive and restart using synthetic data.

All jobs passed in [Linux CI run 41412900324](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41412900324) at source `f62d2cace4459d759c2f797f668b81cbb4f45605`:

| Job | Observed result |
|---|---|
| `125169787659`, Node 24.22.1 | 504 TypeScript passes, zero failures, four native skips; all 15 investigation Python tests on Python 3.11.17; typecheck and diff check passed |
| `125169787577`, Node 25.9.0 | Same counts and checks, with Python 3.11.17 |
| `125169787673`, conventional RL | All 26 Python tests, real bounded Gymnasium test and admitted/supervised execution with recovery and collection passed |
| `125169787310`, Linux supervisor | All seven service cases plus their parent passed, eight reported tests |
| `125169787524`, publisher PDF | Actual parser/archive fixture passed on Python 3.12.15 |

An independent reviewer checked the actual bounded receipt against this document and recomputed its observation, input, execution and result digests. The final wording distinguishes reported runtime-source/schema declarations from a complete independent evaluator identity. This qualification does not establish autonomous scientific judgment or unattended remote deployment.
