# Replay evidence and research planning

The harness can now import a verified replay bundle into the experiment ledger, bind separate semantic annotation claims to that exact episode, and export a prospective research-planning packet. The planner distinguishes a scoring disagreement from numerical credit without an authorized read. It preserves unknowns and proposes the evidence needed to resolve them; it does not authorize experiments or certify semantic truth.

This connects the [local replay adapter](observed-replay.md) to the evidence system. [Actual qualification](research/replay-evidence-planning-qualification.md) uses both retained native counterexamples and the existing CoworkerRL ledger. The [review record](reviews/2026-11-02-replay-evidence.md) explains the tested boundaries.

## Import and offline recovery

```sh
npm run harness -- replay-evidence-import ledger.sqlite import.json /absolute/trusted/artifact-root
npm run harness -- replay-evidence-status ledger.sqlite observation-id
```

The import request contains `projectId`, a stable `evidenceId`, `bundlePath` relative to the configured root, and `expected.requestDigest`, `expected.executionDigest` and `expected.receiptDigest`. The last is the receipt's declared `digest`, not the hash of the complete receipt object. It also contains an explicit `origin` with `kind` (`synthetic_fixture` or `saved_episode_unverified`), a description and a source reference (`locator`, `sha256`). Origin metadata remains an operator assertion; it is not authenticated by supplying a locator or digest.

The importer verifies the complete intent/execution/report/receipt chain, including private replay content, before appending one immutable observation. A failed check creates no partial observation. The event identity binds project and evidence IDs; its payload retains the exact request, configured root, complete bundle and derived scope. All run/action/job links are null. Importing evidence does not register a training run, change budgets or close a scientific request.

Repeating the same identity returns the verified archived observation without reading the bundle or original project. A different root, path, expected identity or origin under that identity is a conflict. Concurrent imports in the single-owner controller retain the first completed observation. Offline loading rechecks the full embedded bundle and derived fields; a changed outer digest cannot make contradictory evidence valid.

Use an operator-owned artifact root whose ancestors stay trusted and unchanged during import. The importer rejects links and checks directory identities before and after reads, but it does not provide descriptor-relative protection against a malicious concurrent ancestor swap. Model-writable or remote artifact ingestion needs a separately enforced store boundary. This limitation does not affect offline ledger loading, which reads no original files. Ledger commands take exclusive ownership; they are not clients for an already-running controller.

## Separate annotations from measurements

```sh
npm run harness -- replay-annotate ledger.sqlite annotations.json
npm run harness -- replay-assess ledger.sqlite binding.json
```

Annotations use `kind: coworker-replay-semantic-annotations.v1`, schema version 1. Their binding names the project, replay observation ID/digest, exact memo SHA256 and complete required-fact-definition SHA256. The annotator supplies an ID, kind, method, authored timestamp, declared timing and declared result exposure. Labels contain a required `factId`, Boolean or `unknown` expectation, and rationale. They cannot supply aliases or replace world definitions. A supplied digest must match; otherwise the normalizer computes it.

Annotations may cover a subset of required facts. Every omitted fact remains represented with an unknown expectation; known lack of acquisition cannot silently provide a semantic label. Duplicate, nonrequired or mismatched facts reject. New labels create a new immutable annotation observation, preserving the old judgment and any disagreement.

Authorship, prewritten timing, blindness and truth remain **not established**. A declaration such as `before_native_result` or `not_seen` is retained as a claim rather than independently verified provenance. The current actual qualification honestly records model-authored, posthoc annotations with results seen, even though their criterion originated in an earlier written fixture.

Assessment bindings name the project and exact replay observation ID/digest, plus an annotation observation ID/digest or two nulls. The assessor revalidates both archive chains and derives per-fact comparisons. Known annotations with Boolean native outputs form the comparison denominator. Unknown labels and scorer errors remain separate; an incomplete replay has null counts, not zero-credit task performance. Native policy termination, authorized reading, numeric credit and semantic expectations remain distinct.

## Evidence available to the council

```sh
npm run harness -- replay-packet ledger.sqlite binding.json /new/private/packet.json
```

The export contains the exact memo, task/brief, all world definitions and aliases, observed messages, source owners, read pages, native verdicts and annotation rationales. Each source item points into an immutable ledger observation. Text segments reconstruct the complete field in order without ellipses; oversize items or packets fail explicitly rather than silently dropping context. Source content is marked as untrusted evidence, never instructions or authority.

The packet also preserves counts, provenance limitations, competing next actions, explicit completion evidence and conditions that would change the recommendation. Priorities address unavailable or terminal-invalid evidence, scorer errors/discrepancies, acquisition-versus-credit ambiguity, missing annotations, provenance, protected controls and replication. These priorities are deterministic recommendations for review, not findings of research superiority.

Export time derives from the latest bound archival timestamp, so repeated exports with the same records produce identical bytes. A new file is required; existing output is refused. Export does not start a council. The existing bounded review/council system can consume the packet when an invocation allowance is configured. Passed packet checks cover archive identity, derivation and planning scope only; semantic/evaluator validity and scientific requirements stay open.

Current-v2 evidence does not update historical Run-1 requests. The two retained native cases produce different recommendations: the denied quotation prompts review of the evaluator/annotation disagreement; the affirmative policy echo prompts review of the acquisition/credit distinction. Neither case establishes learning benefit, generalization or conference-quality research. Those claims need separately designed controls and evaluation.
