# Historical investigation review — 2026-11-02

The reviewed slice can inspect selected historical evidence, retain bounded byte references and recount producer labels without treating those observations as scientific approval. No material defect remains in the reviewed worker, archive and queue integration after the corrections below. This is a bounded code review and offline fixture qualification, not qualification against the actual Run-1 dataset.

## Scope and corrected findings

The review covered the [Python reader](../../src/integrations/coworker/investigation-worker.py), [typed process boundary](../../src/integrations/coworker/investigation-worker.ts), [immutable archive](../../src/integrations/coworker/investigation.ts), [handler](../../src/scheduler/investigation-handlers.ts), [workflow](../../src/scheduler/investigation-workflow.ts), and related configuration and command integration.

- **Capture identity replaced dataset constants.** The expected report path, SHA-256 and byte count derive from the verified capture. Selected evaluation directories, source-tree bytes, adapter bytes and episode counts vary. Two independent synthetic datasets pass through the actual production parser without replacing expected real-data hashes. The inspected source-algorithm compatibility restriction remains explicit; supporting another historical format requires a reviewed extension.
- **Comparison provenance now crosses both conditions.** The first parser compared a selected settings hash but omitted base revision, evaluator source and schema correspondence. It could accept a different model or evaluator as the baseline. Trace base revisions now bind to the captured report's full revision, tokenizer declarations bind to the report, and the two conditions must agree on evaluator/source metadata. Tests alter every affected identity while updating file checksums, so a checksum failure cannot conceal an incorrect comparison join.
- **Completed results require their supporting checks.** A typed completed result previously permitted an empty check list. It now requires all six ordered verified stages with exact file references matching the retained result. Missing or contradictory checks cannot be archived as completed evidence.
- **Cached failure labels retain their types.** String coercion accepted an array containing a recognized failure label. The archive now requires a primitive string. An independent regression rehashes the altered output and final envelope, demonstrating that self-consistent digests do not bypass semantic validation.
- **Queue preflight preserves rejection and inert input.** Cloning task/workflow input previously evaluated getters before stricter validation; definite source/root conflicts could also reach execution and become an uncertain queue outcome. Bounded inert copying now precedes field reads, and the handler checks pure archive preparation before enqueue and invocation. Wrong-root fixtures leave no investigation intent or queued task, and getter fixtures record zero invocations.
- **Interpreter selection is usable and explicit.** The local default `/usr/bin/python3` reports Python 3.9.6, below the reader's 3.11 minimum. Trusted configuration now supports an absolute `investigationPythonExecutable`, included in the immutable worker descriptor. This setting is outside task-controlled input. The default remains deployment-dependent; it does not establish runtime compatibility by itself.

## Verification and recovery evidence

The final focused run passed 36 TypeScript tests and 15 Python tests, plus `npm run check` and `git diff --check`. The [independent Python tests](../../test/integrations/coworker_investigation_independent_test.py) cover duplicate rows and decoded JSON keys, exact trace/result joins, strict integer and boolean types, wrong comparison identities, variable positive datasets, and retained failure counts without private text. The [independent TypeScript tests](../../test/integrations/coworker-investigation-independent.test.ts) cover capture-driven identity, mutation isolation, cached enum validation and check/result correspondence.

Archive and workflow fixtures additionally cover committed-output projection repair, bounded read-only reinspection after unrecorded outcomes, explicit reconciliation of uncertain queue work, recovery after source deletion, worker-upgrade conflicts, exact task selection, persisted stop authority and pre-execution cancellation. Inspection consumes zero model-call units but still uses shared queue parallelism and ledger stop authority. An archived output, including incomplete evidence, is final for its investigation identity. Neither a restart nor an ordinary queue run silently repeats uncertain work.

The focused commands were:

```sh
node --import tsx --test test/integrations/coworker-investigation*.test.ts test/scheduler/investigation-workflow.test.ts test/scheduler/config.test.ts
python3 -I -B -m unittest discover -s test/integrations -p '*investigation*test.py' -v
npm run check
git diff --check
```

## Conclusions the evidence does not support

Source-tree and blob hashes establish current byte correspondence; the saved commit-to-tree mapping does not authenticate a Git commit or attest historical execution. Whole-adapter SHA-256 does not establish tensor equivalence, serving state or resumability. The empty-adapter baseline is a producer declaration, not proof of the historical loaded model or a matched training control.

Exact row joins permit recounting saved labels. They do not validate semantic task success or the scorer. Disjoint configuration IDs do not establish a protected blind holdout, and evaluation episodes remain observations of one trained policy rather than independent training replications. The archive therefore leaves scientific evaluation unassessed and every diagnostic follow-up unresolved. This review performed no real project inspection, provider call, training, network retrieval or service execution; actual historical qualification must be recorded separately.
