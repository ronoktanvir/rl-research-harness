# Foundation code review

Date: 2026-11-01. Independent agents reviewed code they did not author; the orchestrator integrated changes. Review acceptance is evidence of scrutiny, not proof of correctness.

| Finding | Consequence | Correction and regression |
|---|---|---|
| Council enum coercion with `String(...)` | Arrays passed validation but bypassed strict-string blocker checks | Require primitive strings; end-to-end malformed objection and resolution cases |
| Mutable result reread during artifact writes | JSON and Markdown could disagree in one bundle | One snapshot and cached JSON/digest/Markdown before I/O; immediate-mutation test |
| Pi request fields reread across awaits | Payload hash could differ from admitted message | Snapshot fields once; changing-getter and caller-mutation tests |
| Escalation cleared when direct child exited | A TERM-ignoring descendant survived timeout | Preserve process-group SIGKILL escalation; actual descendant-process regression |
| Ancestors checked separately from leaf open | Swapped symlink could escape the project | Isolated trusted Python helper with descriptor-relative no-follow traversal; deterministic ancestor-swap tests |
| Auth preflight failures reported as login failures | Missing client/timeout produced misleading remediation | Preserve operational failure categories; preflight regressions |
| CLI council parsed JSON before core validation | Malformed review was recorded as provider/callback error | Pass successful review text to core validation; malformed-response wiring regression |

Further checks detach reviewer outputs before validation, preserve invalid/missing reviews as blockers, withhold peer opinions until a round settles, and constrain proposal revisions to existing evidence. A second bounded review verified the required fixes; tests capture the reproduced cases.

## Verification scope

Offline tests exercise real Pi SQLite state and kill subprocesses during tool execution. They test input validation, artifact consistency, process cleanup and confined reads. They make no external model requests and do not execute CoworkerRL training code.

All 72 tests passed locally. [Linux CI](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41380408556) passed with Node 24 and 25 at commit `33c77ebb42bec8f5fca7dcac51295b892597eff3`, including type checks and the complete offline suite.

Separate live smoke checks used Codex CLI 0.156.1 and Claude Code 2.1.281 with recognized account authentication and received the requested short response. This verifies basic client integration, not unattended quota recovery, billing accuracy or scientific quality.

CoworkerRL was inspected read-only at HEAD `84b219f64f1152f8b02babea388bfbbfff41e75a`, with hashes of selected current files. A historical report was parsed without inferring live job state or verified optimizer restoration.

The [full status audit](../implementation-status.md) tracks outstanding work. No training backend, Droplet service, hard spending gateway or automatic literature watcher is represented as complete.
