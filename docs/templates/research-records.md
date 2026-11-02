# Research record templates

These are proposed record shapes, not completed experiments. Keep canonical runtime data in structured storage; render these human-readable forms from it where practical. Missing fields should say unknown or not applicable rather than inventing an answer.

## Experiment manifest

```yaml
experiment_id:
revision:
status: proposed
track: conventional_rl | llm_post_training
parent_experiment_id:
question:
hypothesis:
predicted_result:
falsifying_result:
exploratory_or_confirmatory:
closest_prior_work: []
baseline_and_fairness_conditions:
code_commit:
dirty_patch_digest:
image_and_dependency_digests:
environment_or_task_spec:
environment_reward_verifier_versions:
model_reference_reward_model_versions:
tokenizer_and_chat_template_versions:
data_provenance_and_split_hashes:
train_and_evaluation_seeds:
independent_unit_of_replication:
training_budget_steps_tokens_time:
evaluation_protocol_and_sampling_budget:
metrics_and_aggregation:
uncertainty_method:
ablations_and_controls:
checkpoint_selection_rule:
early_stop_and_intervention_policy:
resource_limits_and_cost_reservation:
allowed_tools_network_and_data:
artifact_destination:
required_validation_results: []
council_decision_id:
manifest_digest:
```

The LLM evaluation protocol includes decoding settings, sample count, maximum tokens/tool calls and pass@1/pass@k/selection semantics. Conventional RL includes episode horizon, evaluation policy behavior and held-out task/environment definitions. Define comparison conditions before observing results.

## Run result

```yaml
run_id:
experiment_id_and_revision:
action_id_and_idempotency_key:
backend_job_id:
worker_and_runtime_versions:
manifest_digest:
state: unknown | running | stopped | failed | evaluating | complete
started_at:
last_confirmed_backend_state_at:
ended_at:
exit_reason:
interruption_and_resume_history: []
metrics_artifact_ids: []
checkpoint_ids_and_integrity: []
evaluator_version:
evaluation_result_ids: []
cost_settled:
cost_estimated:
cost_outstanding_exposure:
paid_allocation_release_state:
limitations:
```

Separate a successful process exit from evidence supporting the hypothesis. Keep failed and pruned runs in the registry.

## Decision record

```markdown
# Decision <ID>: <specific choice>
Date / author / project / evidence-packet revision:
Status: proposed | accepted | rejected | superseded

## Decision and reason
Chosen action and the decisive evidence.

## Alternatives
Options compared under the same criteria; why each was rejected or deferred.

## Evidence
Source IDs, exact paper sections, run IDs, artifacts and test outcomes.
Separate observations from interpretations and predictions.

## Criticism and revisions
Independent reviewer findings, required corrections, new evidence, and changes made.
Missing or malformed review remains missing or malformed, not approval.

## Remaining uncertainty and dissent
Unresolved objections, scope limitations, and the test that could resolve each.

## Reversal condition
What observation would change this decision?

## Action
Owner, resource allowance, deadline, stop condition, and next record ID.
```

## Paper and claim record

```yaml
source_id:
title:
authors:
canonical_url_or_doi:
version_and_date:
venue_and_verified_status:
retrieved_at:
search_query_and_search_scope:
source_sections_read:
claim_supported:
method_and_comparison:
author_reported_result:
limitations_and_confounds:
independent_replication_status:
code_data_artifact_links: []
relevance_to_our_project:
contradictory_sources: []
decision_ids: []
```

## Child task and handoff

```yaml
task_id:
parent_id:
project_id:
role_and_required_capability:
objective:
input_record_ids_and_revisions: []
allowed_actions_and_resources:
deadline_and_cost_allowance:
maximum_child_depth_and_count:
output_schema:
acceptance_checks:
completed_work:
unresolved_external_actions: []
failed_attempts_and_negative_results: []
material_objections: []
next_action:
```

Revision-check mutable human-readable notes before publication. Save provenance and history, and reject stale writes. A handoff is orientation to evidence, not a replacement for the evidence.
