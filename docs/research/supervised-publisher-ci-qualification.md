# Native supervised RL and PDF qualification

Source `ac4c4833034116037e1270682dd18434a6f9c11a` passed [CI run 41408770639](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41408770639). The controller now has actual Linux evidence for the fixed conventional RL integration and the bounded PDF parser. These tests do not qualify CoworkerRL training, arbitrary environments or autonomous scientific decisions.

## Observed checks

| Job | Result | Runtime and scope |
|---|---|---|
| Offline checks, job125156749612 | 471 passed, zero failed, four explicit native skips; typecheck and diff check passed | Node24.22.1 |
| Offline checks, job125156749474 | Same counts and checks | Node25.9.0 |
| Conventional RL, job125156749596 | 26 Python tests; direct native Gymnasium test; new supervised native test all passed | Python3.11.17, Gymnasium1.4.0, NumPy2.3.5; hash-locked dependency installation |
| Publisher PDF, job125156749481 | Real parser/archive test passed with no skip | Python3.12.15, pypdf6.10.0, hash-locked installation; mandatory process memory/CPU limits |
| Linux supervisor, job125156749512 | Seven native cases plus their parent passed | systemd255.4-1ubuntu8.18; existing success, failure, timeout, cancellation, recovery and deadline cases |

The new supervised test admits one replica, binds the real deployment and command, starts the fixed Gymnasium worker, reopens the ledger and journal, and observes the original service without preparing another launch. It verifies the successful terminal observation and cgroup cleanup, then collects exact intent/receipt/result bytes. Execution becomes succeeded while scientific evaluation remains unassessed. Collection leaves the action and its accounting unchanged. Only one manager start occurred.

The PDF test creates a small synthetic three-page document. It verifies real extraction into the persistent archive, exact PDF/page provenance, whitespace-only page handling, partial coverage under page/text limits, encrypted input and malformed input. Successful extraction retains its explicitly unreviewed scientific scope. This qualifies that synthetic path; the previously retrieved 2021 NeurIPS paper has not been processed through this parser.

## Failed first attempt and correction

The first expanded workflow at `3ec4bfb6de3fa6c08ab13168171a7105a92487b7`, [run41408608858](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41408608858), passed the PDF test but failed the new supervised fixture before its assertions could establish success. The diagnostic argument eagerly serialized an action containing BigInt accounting fields. That JavaScript exception establishes a test defect, not a worker failure or success.

Commit `ac4c483` restricts the diagnostic to JSON-safe identifiers/state and captures the owned unit name before the assertion so failure cleanup can target it. No production execution logic changed. Read-only independent review found no equivalent unsafe diagnostic elsewhere in the fixture. The second complete CI run above qualifies the corrected source.

## Limits and next work

The supervised fixture runs only when explicitly enabled in isolated Linux CI. Its copied Python environment and staged source live outside the runner's hidden home directory. The declared image identifier is synthetic and is not an OCI attestation; deployment immutability and installed package bytes remain separate operational requirements. No service or container was started on the local Mac.

One fixed-map policy run is an engineering fixture, not evidence of a treatment effect. The integration does not implement general checkpoint resume, protected holdout evaluation, remote allocation release or CoworkerRL's CUDA/vLLM/helper/judge stack. The full research objective still requires those components and a campaign loop that actually satisfies missing-evidence requests before using them to support decisions.
