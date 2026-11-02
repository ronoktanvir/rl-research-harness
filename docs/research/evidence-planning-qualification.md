# Actual Run-1 evidence-planning qualification

The controller derived and archived an updated research assessment from the completed Run-1 investigation. Ten narrow subcriteria are supported; five scientific requirements remain unestablished. These counts describe the assessment's categories, not a percentage of research validity. All three original scientific requests remain unresolved but now carry explicit partial support.

## Source and result

This qualification consumes the [automated investigation](automated-investigation-qualification.md), observation digest `b01b649f9eb06910ed722ee3419bcb9c773f48e526d3cf7fd3f87347218c8786`, and its original assessment/follow-up chain. It performs no new file inspection, measurement, model call or training.

- Update observation: `coworker-evidence-update:d5c2f53503fb773b5f865352cd85b12246e76e47595bec59a4f3d537848a6667`.
- Outer observation digest: `c2e797cc3893b7d1942685b89821b23b76a60cf1249da36456ad9efe114274f9`.
- Payload digest: `c4b6326ad01e2d118c61ed1c47f1f75868a315103edd0ca039ae32226fd90e1d`.
- Evidence-assessment digest: `e700df8950f83cf0fd49e477c5bb3a4586158394f10026b7124c4f3dcd3decab`.
- Rules digest: `2851a663de02c4d13b5d786da7cf132f7cba6252d9f850e5ad8411dd953d201e`.
- Planning packet digest: `95cde1e03486aeca94f3c4802a1e6c36664bcfe11df35dae502c70442dc1b1d6`.
- Created at: `2026-11-02T08:42:22.234Z`.

The update is retained in ignored `.harness/coworker.sqlite`; the request, command outputs, before/after snapshot and qualification projection are in `.harness/`. The exported `.harness/coworker-planning-packet.json` contains 30 bounded evidence items, six review criteria and three planning-scope checks. Runtime records and private project content are not committed.

## What the assessment changes

The supported subcriteria cover report/manifest correspondence, reconstructed Python bytes, adapter bytes, the two conditions' saved record joins, selected comparison declarations, label recounting, failure accounting, the declared bare-base comparator and the one-policy replication scope. They replace the outdated working assumption that no evaluation/comparison artifacts have been inspected.

The open requirements concern complete original execution/protocol provenance, independent semantic evaluator validity, protected evaluation/selection policy, a matched training control, and a claim-specific replication/uncertainty design. The previous scientific requests remain immutable. The new record links partial support to their exact work-item IDs rather than rewriting the earlier assessment.

The deterministic recommendation is `next:recover-protocol-provenance`: recover the scorer/verifier definition, helper/judge identities, inference/tool limits, checkpoint-selection policy and evaluation-access history. Subsequent alternatives specify a semantic-success audit, protected prospective evaluation, and matched training/replication design. Each includes expected discriminating evidence and conditions affecting interpretation. Their ranking is a versioned planning policy, not an empirical estimate of information gain or a demonstration of scientific judgment.

The packet is suitable for a new planning council under separately available invocation authority. No council was dispatched. A future planning endorsement cannot validate the historical claim or authorize training; the packet and update retain `scientificEvaluation: "unassessed"` and `executionAuthorized: false`.

## Recovery and preserved state

Separate CLI processes created the update, recovered an identical status and exported the exact packet. `evidence-update` and `evidence-status` returned exit code 2 with `evidence_required`; packet export returned zero. Before/after comparisons confirmed unchanged original investigation/workflow/follow-up observations, queue tasks, experiment runs/actions, budget records and account/arXiv holds. Both local live invocation units remain consumed. No hold was released and no allowance increased.

The [independent review](../reviews/2026-11-02-evidence-planning.md) records corrected cross-record inconsistencies, partial-evidence limits and citation identity. A separate check recomputed the actual outer observation, payload and assessment digests and verified the exported packet against its archived copy. Reopening the ledger increments its authority-fencing epoch; that expected ownership effect is separate from unchanged experiment records, stop policy, budgets and holds.

## Code and CI qualification

Implementation commits `0de132e` and `86e057666ae80497c165cb5c99bac4ee665d30fb` passed 524 local TypeScript tests, with four explicit native skips, typecheck and whitespace checks. All jobs passed in [Linux CI run 41415263620](https://github.com/ronoktanvir/rl-research-harness/actions/runs/41415263620) at the latter source revision:

| Job | Verified scope |
|---|---|
| `125177460925`, Node 24.22.1 | 524 TypeScript passes, zero failures, four native skips; 15 investigation Python cases on Python 3.11.17; typecheck and diff check |
| `125177460872`, Node 25.9.0 | Same counts and checks |
| `125177460849`, conventional RL | 26 Python cases, actual Gymnasium fixture and supervised execution/recovery/collection fixture |
| `125177460899`, Linux supervisor | Seven actual service cases plus their parent, eight reported passes |
| `125177461009`, publisher PDF | Actual bounded parser/archive fixture on Python 3.12.15 |

The broader harness still lacks autonomous campaign selection/execution, complete scientific evaluation and unattended Droplet deployment. The next selected research action is still a prospective request; this qualification does not claim its protocol recovery or semantic audit has been performed.
