# Local conventional RL adapter

The harness can run one bounded conventional RL experiment: fixed-map FrozenLake with tabular Q-learning, multiple training seeds, frozen-policy evaluation and a shared random baseline. This is a working CPU adapter for engineering qualification. General trainers, remote execution, streaming monitoring, resumable checkpoints and autonomous experiment selection remain unfinished.

## Install and run

Use Python 3.11 in a private environment. The lock includes exact wheel hashes for Gymnasium 1.4.0, NumPy 2.3.5 and their base dependency closure. Rendering extras and training frameworks are unnecessary. The runner checks these two package versions and the Python minor version before environment creation and records the patch version; this does not attest arbitrary installed code or the host.

```sh
python3.11 -m venv .harness/conventional-venv
.harness/conventional-venv/bin/python -m pip --require-hashes -r src/integrations/conventional/requirements.lock
npm run harness -- conventional-run examples/conventional-frozenlake.json /absolute/path/to/.harness/conventional-venv/bin/python .harness/frozenlake-example
```

The example is deliberately tiny and has no expectation of learning. Operator JSON specifies every training, evaluation and action-stream seed. The wrapper derives the request digest; a caller cannot provide it. Unsupported environment names, code, model paths, overlapping seed schedules and insufficient worst-case transition allowances are rejected before execution. See the [Python protocol](conventional-python-runner.md) for all bounds and semantics.

The process receives the exact runner source bytes whose SHA-256 appears in the summary. It runs with Python isolated mode, a fresh temporary working directory, a small explicit environment and no shell. The command allows at most 120 seconds and 4 MiB combined output, preserves cancellation/timeout/failure separately and never retries. This is process hygiene for trusted fixed code, not an OS boundary for untrusted experiments. It does not invoke CoworkerRL, model clients or cloud services.

The local command is explicit operator execution; it does not use the experiment ledger or queue admission. Do not install it as an autonomous campaign action before binding it to the broker and qualified supervisor. Its transition/time limits do not establish controller-wide concurrency or spend limits.

## Artifacts and interruption

The output directory must not already exist. `intent.json` is written before process execution and binds a detached request, selected interpreter and timeout. `worker-stdout.txt` and `worker-stderr.txt` preserve the process output. `summary.json` and `report.md` are derived views; `receipt.json` is written last after the artifact writes finish.

An intent alone does not say whether a process started or finished. A directory with no receipt requires inspection and is never automatically replayed. Explicit repetition uses a new directory and should use a new experiment identity when it represents a new scientific replicate. There is no global uniqueness claim across arbitrary local output directories, no remote reconciliation and no host-crash durability claim for these files.

Accepted output must agree with the request identity, pinned versions, fixed environment/reward settings, algorithm, seeds, every episode's endpoint flags and recomputed summaries. Policy digests identify the frozen Q-tables. The result digest identifies the **exact stdout bytes**, not a normalized JSON reserialization. Public validation detaches and freezes results; summary generation verifies hashes and reconstructs measurements from stdout instead of trusting mutable projections. These checks detect protocol inconsistency, not a dishonest trainer that fabricates a consistent trajectory.

## Scientific interpretation and tests

Each independently trained policy is one replication unit. Evaluation episodes characterize that policy on the specified map and seeds. The shared baseline is measured once; its repeated use does not multiply its sample size. The final policy is evaluated without updates or checkpoint selection, but evaluation runs in the same trusted worker and its seeds are visible to the experiment author. This is not a protected final holdout. See [methods and source qualifications](conventional-methods.md).

```sh
npm run test:conventional
HARNESS_TEST_CONVENTIONAL_PYTHON=/absolute/path/to/.harness/conventional-venv/bin/python \
  node --import tsx --test test/conventional/native.test.ts
```

Ordinary tests use scripted environments or injected processes. The opt-in native case runs the actual pinned library on deterministic and slippery dynamics, with three training replicas, a shared baseline and an exact repeat for each condition. It checks reproducibility and valid reporting without requiring an improvement. The [first qualification record](../research/conventional-qualification-2026-11-02.md) preserves the actual local results and their limits.
