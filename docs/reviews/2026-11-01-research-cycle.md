# Review of the durable research cycle

Separate agents implemented and reviewed structured client output, archived critic/reviser contracts and arXiv evidence capture. The orchestrator implemented the durable campaign driver and operator commands. Review focused on whether the system could repeat work, fabricate provenance, bypass scope or confuse protocol completion with research validity.

| Finding or boundary | Resolution |
|---|---|
| A claim can expire tasks and return no runnable work, leaving the campaign's earlier pending view stale | Refresh deterministic advancement before returning. A regression verifies a blocked final decision with zero calls. |
| A falsy invalid task selection could be interpreted as unrestricted execution | Snapshot and forward every explicitly supplied selection; strict queue validation rejects invalid values and an empty list selects nothing. |
| Caller mutation during authentication or campaign advancement could change the intended operation | Snapshot client task fields and campaign options before asynchronous work; retain the original cancellation signal. |
| Self-consistent stage hashes do not prove that arbitrary archived review history occurred | Keep archive writes controller-exclusive. The workflow derives context from bound cached results; document the lower-level builder's trust boundary explicitly. |
| Public XML parser byte bounds accepted a nonfinite limit during development | Validate finite bounded limits. Independent tests also check namespace spoofing and invalid calendar dates. |
| A transport ignoring cancellation might outlive the timeout | Retain the process connection quarantine until the underlying operation settles; preserve the failed/unresolved capture identity. |
| Paper metadata can change without an arXiv version increment | Bind derived observations to the exact raw response digest and discovery identity. Rehashing tampered derived data cannot bypass comparison with captured bytes. |
| A live 429 response did not originally hold later query identities | Persist a service-level hold derived from the saved response. Known retry times control availability; unknown times require explicit release. New project/ID admission is checked against the same hold. |
| Truncating an oversized Retry-After value could turn its prefix into an immediate retry; clock rollback could bypass a known deadline after release | Preserve invalid/oversized headers as unknown, and compare known availability with the original server-derived time even after release. |
| A 429 response header followed by a stalled or oversized body could lose the known refusal | Archive a labeled headers-only receipt before body processing, derive one hold from that receipt and preserve complete response provenance separately. Legacy raw-only holds retain their original identity. |

Independent review found no remaining material defect in the documented local controller scope. Tests cover structured-output transport and semantic validation, five-step council recovery, immutable source capture, byte/time limits, raw-to-derived provenance, task filtering and offline CLI publication. The tests do not establish live provider schema compliance, full-paper validity, exhaustive literature coverage, conference acceptance, remote service isolation or autonomous experiment quality.

The prior malformed Claude review remains a historical failed result. New schema support does not retroactively validate it. Live literature retrieval outcomes are recorded separately in the implementation status; a timed-out request supplies no paper evidence.
