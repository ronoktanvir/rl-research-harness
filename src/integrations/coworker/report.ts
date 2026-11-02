export interface CoworkerDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  field: string;
  message: string;
}
export interface CoworkerStep {
  stepIndex: number;
  /** Names preserve the producer's fields; absent values are never synthesized. */
  metrics: Record<string, number>;
  optimizerStepApplied: boolean | null;
  postUpdateServeOk: boolean | null;
  checkpointReported: {
    fullTrainingState: boolean | null;
    roundTripVerified: boolean | null;
    adapterSha256: string | null;
  };
}
export interface CoworkerReport {
  format: 'coworkerl-fit-loop' | 'unsupported';
  source: { runtimeRevision: string | null; sourceTreeDigest: string | null; baseRevision: string | null };
  configuration: { plannedSteps: number | null; firstStepIndex: number | null; trainingSeed: number | null };
  steps: CoworkerStep[];
  reportedAborted: boolean;
  /** A snapshot cannot certify process liveness or successful completion. */
  executionState: 'unknown';
  spendMeaning: 'producer_declared_training_process_gpu_estimate' | 'unspecified';
  diagnostics: CoworkerDiagnostic[];
}

const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const NONFINITE = '__coworker_nonfinite_literal__';
const SCALARS = ['loss', 'grad_norm', 'rows', 'optimizer_updates', 'spend_usd', 'elapsed_seconds',
  'helper_provider_attempts', 'judge_provider_attempts', 'rollout_wall_s', 'judge_wall_s',
  'train_wall_s', 'masking_episodes', 'shuffled_control_permutations'] as const;
const GROUPS = ['groups_formed', 'groups_discarded', 'groups_zero_variance', 'degenerate_group_rate',
  'episodes_excluded_dropped', 'episodes_excluded_no_exact_tokens', 'episodes_trained', 'episodes_per_hour'] as const;
const LOSS = ['surrogate', 'entropy', 'approx_kl', 'clipfrac'] as const;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function hash(value: unknown, lengths = [40, 64]): string | null {
  return typeof value === 'string' && lengths.includes(value.length) && /^[a-f0-9]+$/iu.test(value) ? value : null;
}
function bool(value: unknown): boolean | null { return typeof value === 'boolean' ? value : null; }

/** Python json.dumps permits these literals. Normalize tokens only, never quoted content. */
function normalizeNonfinite(text: string): string {
  const tokens = /"(?:[^"\\]|\\[\s\S])*"|(?<=[\s[:,])(?:-Infinity|Infinity|NaN)(?=[\s,}\]])/gu;
  return text.replace(tokens, token => token.startsWith('"') ? token : JSON.stringify(NONFINITE));
}

export function parseCoworkerReport(text: string): CoworkerReport {
  const diagnostics: CoworkerDiagnostic[] = [];
  const report: CoworkerReport = {
    format: 'unsupported', source: { runtimeRevision: null, sourceTreeDigest: null, baseRevision: null },
    configuration: { plannedSteps: null, firstStepIndex: null, trainingSeed: null }, steps: [],
    reportedAborted: false, executionState: 'unknown', spendMeaning: 'unspecified', diagnostics,
  };
  const issue = (code: string, field: string, message: string, severity: CoworkerDiagnostic['severity'] = 'warning') => {
    diagnostics.push({ code, field, message, severity });
  };
  if (Buffer.byteLength(text) > MAX_REPORT_BYTES) {
    issue('report_too_large', '', 'Report exceeds the 16 MiB read limit.', 'error');
    return report;
  }
  let raw: Record<string, unknown> | null;
  try { raw = object(JSON.parse(normalizeNonfinite(text))); }
  catch {
    issue('invalid_json', '', 'Report is malformed or incomplete JSON; no metrics were inferred.', 'error');
    return report;
  }
  if (!raw || !object(raw.config) || !Array.isArray(raw.steps)) {
    issue('unsupported_report', '', 'Expected a fit-loop report with config object and steps array.', 'error');
    return report;
  }
  report.format = 'coworkerl-fit-loop';
  report.source = { runtimeRevision: hash(raw.runtime_source_sha), sourceTreeDigest: hash(raw.source_tree_digest, [64]),
    baseRevision: hash(raw.base_revision) };
  if (!report.source.runtimeRevision || !report.source.sourceTreeDigest) {
    issue('source_identity_missing', 'source', 'The report does not provide complete source revision/digest evidence.');
  }
  function number(value: unknown, field: string, integer = false): number | null {
    if (value === NONFINITE || (typeof value === 'number' && !Number.isFinite(value))) {
      issue('nonfinite_metric', field, 'Producer recorded a nonfinite numeric value.', 'error');
      return null;
    }
    if (typeof value !== 'number' || (integer && (!Number.isSafeInteger(value) || value < 0))) {
      issue('invalid_metric', field, integer ? 'Expected a nonnegative safe integer.' : 'Expected a finite numeric value.');
      return null;
    }
    return value;
  }
  const config = object(raw.config)!;
  for (const [key, target] of [['steps', 'plannedSteps'], ['step_index_start', 'firstStepIndex'], ['training_seed', 'trainingSeed']] as const) {
    if (config[key] !== undefined) report.configuration[target] = number(config[key], `config.${key}`, true);
  }
  if (typeof raw.spend_usd_basis === 'string' && raw.spend_usd_basis.startsWith('estimated_training_process_gpu_spend;')) {
    report.spendMeaning = 'producer_declared_training_process_gpu_estimate';
  }
  report.reportedAborted = object(raw.aborted) !== null;
  if (report.reportedAborted) issue('producer_reported_abort', 'aborted', 'The report contains an abort record; live backend state remains unknown.');
  let previous = -1;
  const indices = new Set<number>();
  for (const [position, value] of raw.steps.entries()) {
    const path = `steps[${position}]`;
    const step = object(value);
    if (!step) { issue('invalid_step', path, 'Step entry is not an object.', 'error'); continue; }
    const stepIndex = number(step.step_index, `${path}.step_index`, true);
    if (stepIndex === null) continue;
    if (indices.has(stepIndex)) issue('duplicate_step', `${path}.step_index`, 'Duplicate step index retained for inspection.', 'error');
    if (stepIndex < previous) issue('out_of_order_step', `${path}.step_index`, 'Step indices move backwards.', 'error');
    indices.add(stepIndex); previous = stepIndex;
    const metrics: Record<string, number> = {};
    function collect(values: Record<string, unknown>, keys: readonly string[], prefix: string): void {
      for (const key of keys) {
        if (values[key] === undefined) continue;
        const metric = number(values[key], `${path}.${prefix}${key}`);
        if (metric !== null) metrics[`${prefix}${key}`] = metric;
      }
    }
    collect(step, SCALARS, '');
    collect(object(step.groups) ?? {}, GROUPS, 'groups.');
    collect(object(step.loss_decomposition) ?? {}, LOSS, 'loss_decomposition.');
    for (const required of ['loss', 'grad_norm']) {
      if (step[required] === undefined) issue('missing_metric', `${path}.${required}`, 'Expected fit-loop metric is absent; no default was inserted.');
    }
    const checkpoint = object(step.checkpoint) ?? {};
    report.steps.push({ stepIndex, metrics,
      optimizerStepApplied: bool(step.optimizer_step_applied), postUpdateServeOk: bool(step.post_update_serve_ok),
      checkpointReported: { fullTrainingState: bool(checkpoint.full_training_state),
        roundTripVerified: bool(checkpoint.round_trip_verified), adapterSha256: hash(checkpoint.adapter_sha256, [64]) },
    });
    if (step.post_update_serve_ok === false) issue('serving_check_failed', `${path}.post_update_serve_ok`, 'Producer reported an unsuccessful post-update serving check.', 'error');
  }
  if (report.steps.length === 0) issue('no_step_observations', 'steps', 'No valid training-step observations are available.');
  issue('snapshot_not_liveness', '', 'This report does not establish whether a trainer is running, stopped or complete.', 'info');
  issue('independent_evaluation_not_observed', '', 'Training diagnostics do not establish held-out task success or learning benefit.', 'info');
  if (report.steps.some(step => 'spend_usd' in step.metrics)) {
    issue('cost_scope_limited', 'spend_usd', report.spendMeaning === 'unspecified'
      ? 'A spend field exists but this report does not declare its accounting scope; do not treat it as total billing.'
      : 'Spend is the producer-declared training-process GPU estimate; setup, idle, API and storage costs are excluded.', 'info');
  }
  return report;
}
