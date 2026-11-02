# CoworkeRL historical capture assessment

The deterministic assessor inspected all 30 archived step entries in `historical-main-s11`. It found no recorded step-order, numerical-integrity or post-update-serving trigger within the captured fields. **The result is `additional_evidence_required`, not a finding that training was successful or scientifically valid.**

The input is the already archived, unregistered capture in ignored local `.harness/coworker.sqlite`, project `coworker`. Its capture digest is `45a2895985fcef74a2cf3596cf76f4ddfd00b2625fa22e7158a8727390e8e5bd`; the original capture time is `2026-11-02T03:11:47.847Z`. The assessment reuses that time as source-observation provenance. It does not claim a new live check at that timestamp.

The command `coworker-assess` reads only the stored capture and appends a derived observation. It does not reread the project, import CoworkeRL, call a model, query a serving endpoint or start training. The full result remains an ignored local artifact; source/report references are retained through the capture binding rather than copied into this document.

The corrected-rule assessment is `coworker-assessment:1a376601207baacbf86fcd4f13ada5c2fe7f573d4bff9e871050110de284873a`, with archived observation digest `4281ea4a4d5bb562cb1dd9395d800265f4c2ea9f0b96d783321d8fdda1d0ced2`. Its rule-definition digest is `e88625176bff9e695ca6a65909fe82c95cc94a5289849ba44ac587d9a74f25fe`. Independent review corrected classification of rejected step indices and changed that rule digest; the earlier assessment remains stored under its earlier identity. The historical run's substantive result did not change.

| Observed scope | Result and implication |
|---|---|
| Step order, recorded numeric fields, producer serving flags | No rule trigger in the 30 captured entries. This does not independently verify serving or establish optimizer learning. |
| Optimizer activity and checkpoints | Not assessable from the available declarations. A positive producer checkpoint flag would still require native artifact verification. |
| Execution and cost | The capture is historical, includes a stale-file diagnostic and has no registered job identity. Liveness and total billing remain unknown. |
| Scientific comparison | No independently measured task success, matched baseline or complete original manifest is established. Favorable training diagnostics cannot fill these gaps. |

The saved requests are to recover the original code/model/data/reward/evaluator and selection identities, specify fixed independent task-success measurements, and design a matched baseline with a valid replication unit. Each request describes completion evidence and carries no authority to execute or intervene. The evidence packet leaves evaluation and baseline checks unknown, so council agreement cannot convert this archive into scientific-readiness approval.

See [assessment semantics](../integrations/coworker-assessment.md). This is one real archived-data check of the deterministic path, not a research benchmark or a qualification of autonomous experimental decisions.
