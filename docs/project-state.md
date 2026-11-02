# Ledger-derived project context

`ledger-export` publishes an immutable `PROJECT.md` and `state.json` from one captured ledger state. The Markdown is a bounded operational summary; JSON retains all registered run/action records and observation references for the selected project. Full observation payloads stay in the ledger. This is context continuity, not a database backup or a scientific assessment.

```sh
npm run harness -- ledger-export .harness/coworker.sqlite coworker .harness/projects
```

The output identifies the capture time, ledger event sequence and JSON content digest. It separates admission barriers, declared allowances, recorded charges, remaining reservations, trainer execution, scientific evaluation and unresolved actions. Unregistered historical observations remain unregistered. Global allowance figures include all projects and are labeled accordingly.

The exporter reads state synchronously under the existing owner, then derives JSON, its digest and Markdown before any asynchronous write. Both files publish through one same-filesystem directory rename. Identical retries preserve the bundle; an existing bundle with inconsistent bytes causes an error. Tests exercise a ledger mutation during publication, integer amounts above JavaScript's exact-number range, retries and a corrupted bundle.

This mechanism does not certify power-loss durability or provide off-host restore. Generated files do not grant permissions or overwrite source records. Hypotheses, literature evidence, council dissent and research decisions remain in their own records; they cannot be inferred from a job-status table. Automated retrieval and refreshing of these projections by a long-running research controller remain unfinished.

## Local operator commands

```sh
npm run harness -- ledger-status .harness/coworker.sqlite coworker
npm run harness -- ledger-stop .harness/coworker.sqlite project:coworker "Hold new project work"
npm run harness -- ledger-resume .harness/coworker.sqlite project:coworker "Explicitly resume this project"
```

These commands acquire exclusive controller ownership. Opening the ledger advances its authority epoch and recovers interrupted dispatches as unknown. They fail while another controller owns the ledger; they are not a remote stop endpoint for an active daemon. A project can be stopped before its first run is registered. Resuming a project does not clear the global stop, and resuming global authority does not clear a project's stop.

Stopping admission does not assert that a remote job stopped or a paid allocation was released. The library supports separately admitted, narrowly targeted cleanup work; a real backend and always-reachable operator endpoint still need qualification. Current CLI commands cannot launch training.
