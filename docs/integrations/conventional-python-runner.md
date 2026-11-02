# Bounded conventional RL Python runner

`src/integrations/conventional/runner.py` implements one CPU experiment contract: tabular Q-learning on the fixed Gymnasium FrozenLake 4×4 map, followed by evaluation of each frozen table and one shared uniform-random baseline. It does not launch a general trainer, allocate infrastructure, admit a ledger action, or resume a checkpoint.

The executable accepts one JSON request through standard input and emits one complete JSON result through standard output. Invoke it with the separately prepared interpreter using `-I -B`; the controller must supply a scrubbed environment, timeout, cancellation and output limits. The module itself writes no artifacts, reads no credentials and makes no network requests. Its environment factory is fixed. The injectable Python factory exists for offline tests, not as a wire-protocol capability.

## Request and limits

The exact required fields are:

```text
schemaVersion: 1
kind: "frozenlake-q-learning"
requestId, requestDigest
environment: {id:"FrozenLake-v1", mapName:"4x4", isSlippery, maxEpisodeSteps}
algorithm: {name:"tabular-q-learning", learningRate, discount, epsilonStart, epsilonEnd}
replicates: [{replicateId, policySeed, trainingEpisodeSeeds}]
evaluation: {episodeSeeds, randomActionSeeds}
limits: {maxTransitions, maxEpisodeTransitions}
```

The wrapper owns the request digest; Python validates its format and echoes it, without claiming to authenticate it. Inputs reject extra fields, duplicate JSON keys, nonfinite numbers, booleans substituted for numbers, overlapping seed sets and duplicate identities. Validation finishes before scientific dependencies are imported.

Bounds are 128 KiB input, 4 MiB output, eight training replicas, 2,000 training episodes per replica, 1,000 evaluation episodes, 12,000 total episode records, and one million declared transitions. Both episode horizons are between one and 100. Admission requires enough transitions for the worst case:

```text
(training episodes across replicas + replica count × evaluation episodes
 + shared baseline episodes) × min(environment horizon, collector cap)
```

Thus an accepted request never needs to silently omit the baseline or interrupt an episode to meet its transition allowance. An external timeout can still interrupt the process; no complete result is then available.

## Learning and measurement

Environment reset seeds, training-policy seeds and baseline-action seeds are explicit and disjoint. A replica's `random.Random` stream spans its training episodes and controls exploration, random actions and uniform argmax ties. Epsilon changes linearly from its start to end value; a single episode uses the start value. Greedy evaluation resolves ties to the lowest action index and receives an immutable table.

The TD target bootstraps after environment truncation or a collector cutoff, but never after termination. The collector stops after either environment flag or its own cap; it preserves simultaneous termination and truncation. These semantics follow Gymnasium's distinction between an MDP terminal state and an external time limit. [Gymnasium time-limit guidance](https://gymnasium.farama.org/tutorials/gymnasium_basics/handling_time_limits/).

Success requires the observed terminal goal state, with reward checked separately against the fixed reward schedule. Goal, holes, map and spaces are fixed; no rendering or custom environment code is accepted. The factory explicitly sets slip success probability to one third and rewards to `(1, 0, 0)`. [FrozenLake specification](https://gymnasium.farama.org/environments/toy_text/frozen_lake/).

Every episode retains reset/action seed, return, transition count, final state, termination, truncation, collector cutoff and success. Summaries contain counts, success rate and mean return. The random baseline executes once on the same evaluation reset seeds and has explicit per-episode action seeds. Every learned-table comparison references that shared measurement; repeating a reference does not create another baseline replicate.

The independently trained Q-table is the training replication unit. Evaluation episodes measure a fixed policy on this one map; they are not independent training replicas or unseen environment designs. No significance test, confidence interval, policy selection, solved threshold or learning-benefit claim is produced. Time-limited success also differs from the discounted continuing-task objective used by Q-learning.

## Result, dependencies and qualification

The result includes the request identity, fixed environment/algorithm semantics, exact dependency versions, shared baseline, per-replica training and evaluation records, 16×4 Q-tables, greedy actions and total physical transitions. Q-tables are exportable learned parameters; optimizer/RNG/collector state is not a resumable checkpoint, and `resumeSupported` is false. The controller can hash the canonical policy data and complete output bytes separately.

The real entry point requires Python 3.11, Gymnasium 1.4.0 and NumPy 2.3.5 before creating an environment; it records the Python patch version. Version strings alone are not deployment attestation. A separately controlled dependency installation and source-bound execution wrapper remain necessary.

Nineteen offline tests cover protocol bounds, resource cleanup, version rejection, distinct random streams, exact-cap goal flags, terminal versus truncated TD targets, actual final-observation bootstrapping, immutable greedy evaluation, reward consistency and shared-baseline accounting. They use scripted environments; the process test rejects malformed input before importing Gymnasium. These tests do not establish performance on the real environment. Any later real execution must be recorded separately with its exact request, installed dependencies and result.
