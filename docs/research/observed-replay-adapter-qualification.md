# Observed replay adapter qualification

The new local adapter executes the real pinned v2 replay path, persists its complete observation projection and reloads it without the original inputs. Both previously retained combined counterexamples survive this integration. It remains a mechanical observation tool: semantic interpretation, task success and scientific validity are unassessed.

Qualification date: 2026-11-02. The source-only registry contains 150 files, 3,524,091 bytes, canonical SHA256 `39de34e0600e0df12aff786ea298bf71d36c84e28f4be2860bf243832943a895`. The composed Python wrapper, including the embedded registry, is SHA256 `4e59bcbdeac2a9959f420a0153be98a39952842848ed3aac83c7fc170886634b`. CPython 3.11.9 executed with the isolation flags and limits described in the [adapter protocol](../observed-replay.md).

The underlying episodes come from the [prior native capture qualification](observed-replay-qualification.md): actual catalog/world/driver/store/replay with fake policy/helper transports. New adapter invocations use those persisted raw pairs; they do not call the transports. Explicit test provenance was obtained from the pinned fixture declarations, not copied from the trace under validation. This synthetic provenance is not historical execution evidence.

## Actual results

| Saved case | Required/world facts | Selected fact's native credit | Authorized observed | Observed numeric credit |
|---|---|---|---|---|
| Denied quotation | 2/10 |true|true|true|
| Unread holder reply plus read policy echo | 2/10 |true|false|false|

The denied quotation remains a numeric false positive under the earlier prewritten semantic rubric. The production adapter does not accept that rubric as an input or promote the case to semantic success. The mixed case preserves the native distinction between a legitimate disclosure and a separate read of the policy's own assertion. Both results retain the other required fact and all nonrequired world definitions.

Final denied-quotation evidence is in ignored `.harness/observed-replay-adapter-denied-v2`:

- Request: `f2bf8b161f3b5b27b992c389a9077874e0784acf87b4407477a369beef727978`.
- Execution: `06ed3b93e86542c8730c57f1ccae8db989f8b41d6af22ed4b9c2c1f397c84f1d`.

An earlier `denied-v1` bundle remains as an intermediate qualification before explicit staging-cleanup status was added; it is not the final receipt schema and was not overwritten.

## Lifecycle and failure evidence

Seven fresh Node CLI invocations are retained in ignored `.harness/observed-replay-adapter-lifecycle-2026-11-02-v1`: successful mixed-case replay; rejection of an actually wrong separate system-prompt declaration; cancellation after intent was saved; offline reload after removing only the qualification's own copied source/input files; refusal of an existing output directory without changing its contents; recreation of missing report/receipt projections; and fresh reload of the recovered bundle.

The completed execution and report/receipt bytes remain identical through reload/recovery. Cancellation is evidence for a bounded local attempt after intent, not proof that Python had begun native replay. Completed, rejected and cancelled attempts all recorded source staging cleanup as removed. Original source and retained raw fixture hashes were rechecked unchanged.

| Retained identity | Digest |
|---|---|
| Mixed-case request |`a61c925682cb05bf40c01b01680c99864f161dffee6fb14dcb84a328dbf862e2`|
| Mixed-case execution |`91e3e3386e6b0d8f6ee8b3ef16f42f1b2a242e826fe4ca2fb23a3fccf0abe046`|
| Mixed-case receipt's declared digest |`568c63f8f7a3573a441c7dfb48d4210886e45575c3543060f829a6ed6416cd68`|
| Lifecycle qualification file SHA256 |`498268213f4a0490dcdf1a2eb09670bb790ee51a4257f967ac3fd86490c14ecf`|
| Lifecycle inventory file SHA256 |`d261390adf5920cc7cb5e1ea6ca75986a4d3d10838e47e81410be5265345891d`|

The lifecycle inventory covers 37 files totaling 110,367 bytes. Raw input copies were intentionally removed to test offline behavior; the original qualification archive remains intact. This evidence bundle does not register a run or update the research ledger.

## Independent tests and remaining scope

Independent Python qualification passes 22 tests: 10 default tests and 12 opt-in cases against the retained actual source/pairs. They cover all world/required facts and metadata, native call-cap invalid-policy termination, original identity and read/inference witnesses, output bounds, malformed/ambiguous files, judged/cross-linked records, wrong provenance/world, source drift, symlinks/hardlinks/FIFOs, stable descriptor-relative reads and denied side effects.

The 24 independent TypeScript tests cover request identity and inert input, complete required rows, source/read ownership, native import name/path binding, errors versus false outcomes, immutable scientific statuses, saved evidence validation and offline projection recovery. Review corrected two evidence-join defects and a cleanup exception that could discard a known outcome; fault injection now confirms that pending cleanup preserves the result. See [the independent review](../reviews/2026-11-02-observed-replay.md).

The final local full suite reports 564 tests: 560 passed and four explicitly skipped native suites. `npm run test:replay` separately passes all 24 TypeScript tests and the ten default Python cases, with twelve private-source cases explicitly skipped in that default command. Those twelve passed in the separate opted-in qualification above. Typecheck and whitespace checks pass. An intermediate run failed two synthetic tests whose rejection-code spelling differed from the real worker; the fixtures now use the actual code and also check rejection of unknown codes. The semantic labels were unchanged.

## Linux CI

Source `cfc80867790fa35cf2f22df0e0bc6ac82d0cea8c` passes [CI41426337585](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41426337585). This includes implementation commit `5ebcb17` and the subsequent replay-boundary workflow step. Job status and decoded logs were checked after completion.

| Job | ID | Verified result |
|---|---|---|
| Node24.22.1 |125213738117|560 TypeScript passes, four explicit native skips; 15 investigation, 16 scorer-probe and ten replay Python passes |
| Node25.9.0 |125213738317|Same counts; both Python jobs use CPython3.11.17 |
| Linux supervisor |125213738300|Seven real CPU service cases plus their parent pass |
| Conventional RL |125213738289|26 Python cases and both native/supervised Gymnasium acceptance tests pass |
| Publisher PDF |125213738004|Native parser/archive acceptance test passes on CPython3.12.15 |

The scorer-probe command explicitly skips two private-source tests and the replay command skips twelve. Separate local qualification supplies the native replay evidence above; CI does not contain the private CoworkeRL package or fixtures. These service tests ran in isolated Linux CI, not on the user's machine.

These results do not validate a semantic evaluator, authenticate historical custody, evaluate live helpers or qualify unattended deployment. Next work is to archive these observations into the research evidence/planning workflow, preserve independently bound semantic annotations, and design the missing controls. The adapter cannot close the existing scientific evidence requests on its own.
