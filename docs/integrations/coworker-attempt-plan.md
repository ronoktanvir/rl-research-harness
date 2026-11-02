# CoworkeRL attempt preview

The harness can now turn a declared CoworkeRL configuration into an immutable command preview. **It cannot launch that command.** The preview binds the proposed run to a manifest, source revision, inputs and resource limits so a reviewer and future worker can assess the same proposal.

## Use and output

```sh
npm run harness -- coworker-plan attempt-request.json
```

The command reads one bounded JSON request and prints JSON to stdout. It does not open the experiment ledger, inspect CoworkeRL files, execute Python, contact an inference endpoint or allocate resources. A successful preview returns `qualification: "declarations_only"` and `launchSupported: false`.

The corresponding API is `prepareCoworkerAttempt(input: unknown)` in `src/integrations/coworker/attempt-plan.ts`. Its input contains:

- A `ManifestRecord`, including its canonical digest.
- A `CreateRunInput`, with project/run/replica identity and optional parent-checkpoint lineage.
- A positive launch operation revision.
- A complete `CoworkerAttemptConfiguration`. The manifest's adapter configuration must contain exactly these declarations under adapter name `coworkerl-v2-fit-loop` and kind `llm_posttraining`.

The output contains the validated declarations, ledger-compatible action/backend identity, executable, argument array, working directory, explicit environment declaration and deterministic output paths. It is copied and recursively frozen; changing the caller's object cannot change an existing preview. Canonical hashing makes object-key order irrelevant while binding all substantive declarations.

The synthetic fixture in `test/integrations/coworker-attempt-fixtures.ts` illustrates the shape. Its paths, hashes, model names, rates and limits are test declarations. It is not a configured campaign, a measured worker image or an authorization to train.

## Trainer mapping

This implementation targets inspected CoworkeRL revision `84b219f64f1152f8b02babea388bfbbfff41e75a` and the fixed entrypoint `python -s -m probing.verl.fit_loop`. It rejects other source revisions and declared dirty patches. `PYTHONPATH` selects only the v2 package; historical packages use the same import namespace and must not be mixed into the execution environment.

Supported command settings include explicit task selection/configuration IDs, helper provider/model, local serving endpoint, initialization and training seeds, steps, group size, reward mode, judge model, faithful-task instrument identity, prompt budget, learning rate, provider-call caps and the trainer's cooperative GPU/time limits. Optional initialization and checkpoint resume declarations map to the native flags. Replay manifests, arbitrary extra arguments and caller-supplied environment variables are unsupported. The base model and initialization mode are restricted to the inspected contract.

The trainer has additional settings that its CLI does not expose. Those remain defaults of the pinned source; the preview does not claim that every internal training parameter is independently configurable. Native preflight still has to check selections, numerical qualification receipts, model/serving compatibility and the full scientific contract.

Writable paths derive from the stable launch action identity under a declared output root. Distinct run IDs or launch revisions therefore receive distinct directories. Exact repeats produce the same paths; this is useful for reconciliation, **not permission to repeat an uncertain launch**. Native nonempty-output and resume-boundary checks remain required. The helper cache is always explicitly scoped to that attempt because omitting its flag does not disable the trainer's cache.

## What validation establishes

The preview rejects inconsistent manifest/run/source/environment bindings, invalid seed and resume declarations, unsupported settings, malformed values and limits that exceed the declared duration or cost envelope. It uses the ledger's identity and canonical-hash functions. A test compares preview identity against actual admission in a temporary offline ledger.

Paths are checked lexically for traversal and overlap between writable output and declared read-only inputs/source. The endpoint is restricted to credential-free loopback HTTP. These checks do not resolve symlinks, verify permissions or authenticate a service. Arbitrary credentials have no configuration field; future execution must obtain narrowly scoped training credentials through its own trusted boundary.

Hashes are declarations until a worker verifies the bytes. The preview does not attest source-tree cleanliness, immutable model contents, checkpoint tensor completeness, origin-run evidence, container contents, API prices or native preflight success. The trainer's GPU estimate is also separate from helper/judge costs, idle allocation charges and eventual provider billing. Supervisor caps in the configuration are proposed controls and are not enforced by this pure function.

## Qualification and next boundary

Offline tests cover ledger identity, replica/output separation, manifest and lineage conflicts, caller mutation, unsupported arguments, resource violations, path/URL constraints and CLI use with nonexistent trainer paths. No CoworkeRL process runs in these tests.

The next [Linux worker contract](linux-worker-contract.md) must independently verify frozen artifacts, admission and current authority before any effect, persist start intent, supervise execution and reconcile uncertain outcomes. Its implementation and actual Linux/cgroup qualification are still missing. A preview neither reserves money nor grants that future worker permission to execute.
