# CoworkeRL attempt-preview review

The implementation now produces a fixed, manifest-bound command proposal. It does not control training. Review compared the mapping against CoworkeRL revision `84b219f64f1152f8b02babea388bfbbfff41e75a`, the ledger's actual admission rules and independent invalid-input cases.

## Findings and corrections

| Finding | Consequence | Correction and evidence |
|---|---|---|
| Omitting the helper-cache flag still enables native caching | A declared disabled cache would misdescribe the run | Require attempt-local caching and emit its derived JSONL path; independent regression checks both declaration and argv |
| Operation revision zero and overly long project IDs passed initial preview checks | A preview could use identities the ledger cannot admit | Reuse ledger validation, require positive revision, test the project-length boundary and compare action identity with actual temporary-ledger admission |
| Exported source lacked the trainer's source-revision environment declaration | A source archive without Git metadata could fail native identity checks | Bind `PROBING_RUNTIME_SOURCE_SHA` to the inspected revision; this remains a declaration pending worker verification |
| A colon in the source root becomes a Python import-path separator | One declared root could select an additional source directory | Reject the separator and retain only the v2 package path |
| Shuffled control accepted unsupported group sizes | The native control path requires exact G4 and could fail after rollout work | Reject other group sizes when shuffled control is selected; independent regression covers rejected and accepted cases |

An initial root-review suggestion to add the historical package to `PYTHONPATH` was withdrawn after checking the current v2 README and package source. The packages share an import name, not a required combined import path. The final preview selects v2 only.

The independent reviewer reported no remaining material finding within this pure-preview scope. Fourteen focused plan tests, including five independent regressions, pass; the separate CLI test confirms previewing synthetic declarations without trainer files. The complete source suite passes **293 offline tests**, TypeScript checks and whitespace validation at source commit `835eeaae37b0d63b323310234e79850d44965381`. Both Node 24 and 25 jobs in [Linux CI](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41390286397) passed for that exact source.

## Subscription-path review

A separate read-only review found no accidental API fallback or credential-persistence defect in the current official-client wrapper. Its account-authentication checks, environment filtering and no-fallback behavior remain intact. A misleading comment about replenishing an account was corrected to describe the actual cumulative local invocation allowance. Provider quota and any provider-managed extra usage remain separate.

No new model call was made, and the two-unit local validation allowance was not changed. Output schemas and durable revisions remain offline-qualified; the earlier malformed live Claude review is preserved as a failure. The proposed five-call live qualification is documented separately, not executed or automatically admitted.

## Practical limits

Tests do not attest file hashes, source cleanliness, model/dependency contents, native numerical qualification, selection-manifest validity or actual checkpoint recovery. Path checks are lexical. No CoworkeRL process, systemd service, GPU or paid cloud allocation was started. Supervisor execution and live scientific qualification remain required before enabling training.
