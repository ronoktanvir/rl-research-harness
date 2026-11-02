# First conventional RL execution qualification

The fixed FrozenLake adapter completed a real local CPU experiment at `2026-11-02T06:33:56.907Z`–`06:33:57.147Z`. This establishes the tested execution, measurement and artifact path. It does not establish algorithm superiority, generalization, statistical significance or autonomous research quality. CoworkerRL was not run.

## Exact observation

| Field | Recorded value |
|---|---|
| Request | `local-frozenlake-qualification-2026-11-02` |
| Request digest | `f0c8f0f50e46970721ed738b544341f8753c8f8d0ded878122dca4e394e95ae2` |
| Runner source SHA-256 | `2b2219e0dc95a3e22724278d3017e8a0802c20363d6afb2beaf8928225460465` |
| Exact stdout SHA-256 | `cf445392413fb35fbd1d4dfa378c75cbaee7247ef3b61f4a22fe2a1c7a7a96e5` |
| Runtime | macOS; Python 3.11.9; Gymnasium 1.4.0; NumPy 2.3.5 |
| Work | 3 training replicas × 500 episodes; 50 evaluation episodes per policy; one 50-episode random baseline |
| Limits | 170,000 declared worst-case transitions; episode horizon/cap 100; command timeout 120 seconds |
| Actual transitions | 20,516 across training, evaluation and the shared baseline |
| Process | Exit 0; no timeout, cancellation or output-limit stop |

The environment was the fixed 4×4 slippery map with success probability one third, goal reward one and other rewards zero. Tabular Q-learning used learning rate 0.2, discount 0.95 and epsilon decreasing linearly from 1 to 0.1. Training policy seeds were 50,000–50,002; environment seeds were 1,000–1,499, 2,000–2,499 and 3,000–3,499. Common evaluation seeds were 10,000–10,049; baseline action seeds were 20,000–20,049. No checkpoint was selected using evaluation results.

| Training replica | Training successes / 500 | Final-policy successes / 50 | Final-policy truncations | Difference from shared baseline |
|---|---:|---:|---:|---:|
| r0 | 1 | 3 | 0 | 0.06 |
| r1 | 18 | 5 | 1 | 0.10 |
| r2 | 39 | 36 | 2 | 0.72 |

The shared baseline achieved **0/50**, with 382 transitions. Those 50 episodes are one baseline dataset, not 150 independent baseline observations. The wide variation among trained policies is why the individual outcomes are retained. Fifty conditional episodes per trained policy do not turn three training replicas into 150 training replicas; zero baseline successes do not establish a zero population success probability.

The ignored runtime directory `.harness/conventional-qualification-2026-11-02/` holds the intent, exact stdout/stderr, summary, Markdown report and final receipt. The request is in `.harness/conventional-qualification-request.json`. These local artifact paths are not shared GitHub attachments; no runtime database, dependency environment or raw artifact was committed.

## Separate acceptance evidence

Nineteen Python tests use scripted environments, including independent cases for simultaneous termination/truncation, bootstrap from the final observation, immutable evaluation, reward/goal mismatch and a valid all-zero result. These cases verify semantics without claiming actual environment performance.

The opt-in native test separately executed both deterministic and slippery FrozenLake with three policies and a shared baseline, then repeated each exact request. Both pairs produced identical result-byte digests. The test does not require a positive advantage, so weak or negative outcomes cannot be discarded merely to pass qualification. The same acceptance test passed on Linux/Python 3.11.17 at source `73c1191a7be6a80c6d9966857d4ee34f48c222ad` in [CI run 41401284085](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41401284085), job `125133444732`, alongside all 19 Python cases. Exact-repeat checks are within each runtime; this does not claim identical output bytes across Python patch versions or hosts.

Still missing: protected independent evaluation, stronger controls, uncertainty estimation, alternate maps/tasks, search-budget qualification, remote supervision, checkpoint resume and campaign admission. The next useful integration is to register and evaluate this evidence through the same experiment authority used by other workloads, while preserving the separate adapter semantics.
