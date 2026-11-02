import { createHash } from 'node:crypto';
import { isAbsolute, win32 } from 'node:path';
import type { ExperimentLedger, JsonObject } from '../ledger/types.ts';
import { captureCoworkerReport } from '../integrations/coworker/capture.ts';
import { writeProjectSummary } from '../controller/project-summary.ts';
import { freezeSnapshot, verifyEvidencePacket } from '../research/evidence.ts';
import { validateReview } from '../research/validation.ts';
import type { EvidencePacket, ReviewRequest } from '../research/types.ts';
import { reviewPrompt } from '../workers/council.ts';
import { runCliReview } from '../workers/cli.ts';
import type { CliBackend, CliTask, CliTaskResult } from '../workers/cli.ts';
import { reviewJsonSchema } from '../workers/output-schema.ts';
import type { HandlerPolicy, TaskClaim, TaskOutcomeInput } from './types.ts';

export type HandlerOutcome = Pick<TaskOutcomeInput, 'status' | 'result' | 'retryAt'>;
export interface ResearchTaskHandler {
  readonly policy: HandlerPolicy;
  validate(input: unknown, projectId: string): void;
  execute(claim: TaskClaim, signal: AbortSignal): Promise<HandlerOutcome>;
}
export interface ResearchTaskHandlerOptions {
  ledger: ExperimentLedger;
  /** Trusted operator configuration, never supplied inside queued task input. */
  projects: Record<string, { root: string; summaryDirectory: string }>;
  review?: (task: CliTask) => Promise<CliTaskResult>;
  capture?: typeof captureCoworkerReport;
  exportProject?: typeof writeProjectSummary;
  now?: () => Date;
}

const VERSION = '1';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CLIENT_STATUSES = ['succeeded', 'rate_limited', 'auth_required', 'failed', 'cancelled', 'timed_out'];
const MAX_RESPONSE_BYTES = 1_000_000;

function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('Task input must be a plain object');
  }
}
function keys(value: unknown, allowed: string[], required: string[]): asserts value is Record<string, unknown> {
  object(value);
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw new Error('Unexpected or missing task input field');
  }
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('Task identity must be a valid string ID');
}
function timestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/u.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('Observation time must be an ISO timestamp');
  }
}
function selectedReport(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.includes('\0') || isAbsolute(value) || win32.isAbsolute(value)) {
    throw new Error('Report must be a project-relative report.json');
  }
  const parts = value.split(/[\\/]/u);
  if (parts.some(part => !part || part === '.' || part === '..') || parts.at(-1) !== 'report.json') {
    throw new Error('Report must be a project-relative report.json without traversal');
  }
}

interface ReviewInput { packet: EvidencePacket; reviewer: { id: string; role: string }; model: string | null; timeoutMs: number }
function reviewInput(raw: unknown): ReviewInput {
  keys(raw, ['packet', 'reviewer', 'model', 'timeoutMs'], ['packet', 'reviewer', 'model']);
  keys(raw.reviewer, ['id', 'role'], ['id', 'role']);
  id(raw.reviewer.id);
  if (typeof raw.reviewer.role !== 'string' || !raw.reviewer.role.trim() || raw.reviewer.role.length > 4096) throw new Error('Reviewer role must contain 1–4096 characters');
  if (raw.model !== null && (typeof raw.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u.test(raw.model))) {
    throw new Error('Model must be an explicit client model identifier or null for the client default');
  }
  const timeoutMs = raw.timeoutMs ?? 120_000;
  if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error('Review timeout must be 1–300,000 milliseconds');
  }
  const packet = verifyEvidencePacket(raw.packet as EvidencePacket);
  const input = { packet, reviewer: { id: raw.reviewer.id, role: raw.reviewer.role }, model: raw.model, timeoutMs };
  // Validate the exact fixed prompt before enqueue/invocation, not only the packet alone.
  if (Buffer.byteLength(prompt(input, new AbortController().signal)) > 512_000) throw new Error('Review prompt exceeds 512,000 bytes');
  return input;
}
function prompt(input: ReviewInput, signal: AbortSignal): string {
  const request: ReviewRequest = { packet: input.packet, reviewer: freezeSnapshot(input.reviewer), round: 0,
    previousRounds: Object.freeze([]), objections: Object.freeze([]), signal };
  return reviewPrompt(request);
}

function outcome(status: HandlerOutcome['status'], result: JsonObject): HandlerOutcome { return { status, result }; }
function clientResult(raw: unknown, backend: CliBackend): CliTaskResult | null {
  try {
    const value: unknown = structuredClone(raw);
    keys(value, ['backend', 'status', 'text', 'billing', 'sessionId', 'usage', 'diagnostic'], ['backend', 'status', 'text', 'billing']);
    if (value.backend !== backend || typeof value.status !== 'string' || !CLIENT_STATUSES.includes(value.status)
      || typeof value.text !== 'string' || value.billing !== 'client_managed_account') return null;
    for (const field of ['sessionId', 'diagnostic']) if (value[field] !== undefined && (typeof value[field] !== 'string' || value[field].length > 4096)) return null;
    if (value.usage !== undefined) {
      keys(value.usage, ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'], []);
      if (Object.values(value.usage).some(number => typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0)) return null;
    }
    return value as unknown as CliTaskResult;
  } catch { return null; }
}

/** Each review handler executes one official-client review. It never invokes a whole council,
 * chooses another account/model, guesses a reset time, or retries an uncertain invocation.
 */
export function createResearchTaskHandlers(options: ResearchTaskHandlerOptions): ResearchTaskHandler[] {
  const projects = freezeSnapshot(options.projects);
  object(projects);
  for (const [projectId, config] of Object.entries(projects)) {
    id(projectId); keys(config, ['root', 'summaryDirectory'], ['root', 'summaryDirectory']);
    for (const path of [config.root, config.summaryDirectory]) if (typeof path !== 'string' || path.includes('\0') || !isAbsolute(path)) {
      throw new Error('Configured project roots and summary directories must be absolute paths');
    }
  }
  const review = options.review ?? runCliReview;
  const capture = options.capture ?? captureCoworkerReport;
  const exportProject = options.exportProject ?? writeProjectSummary;
  const now = options.now ?? (() => new Date());
  const ledger = options.ledger;

  function project(projectId: string) {
    id(projectId);
    const config = Object.hasOwn(projects, projectId) ? projects[projectId] : undefined;
    if (!config) throw new Error('Project has no trusted handler configuration');
    return config;
  }
  function handler(policy: HandlerPolicy, validateInput: (input: unknown) => void,
    run: (input: JsonObject, projectId: string, signal: AbortSignal) => Promise<HandlerOutcome>): ResearchTaskHandler {
    const fixed = Object.freeze({ ...policy });
    return Object.freeze({ policy: fixed,
      validate(input: unknown, projectId: string) { project(projectId); validateInput(structuredClone(input)); },
      async execute(rawClaim: TaskClaim, signal: AbortSignal) {
        let claim: TaskClaim;
        try {
          claim = structuredClone(rawClaim);
          const assigned = claim.task.handler;
          if (claim.task.kind !== fixed.kind || claim.task.handlerVersion !== fixed.version
            || assigned.kind !== fixed.kind || assigned.version !== fixed.version || assigned.replay !== fixed.replay
            || assigned.callUnits !== fixed.callUnits || assigned.resourceKey !== fixed.resourceKey) throw new Error('Queued handler metadata does not match the fixed handler');
          project(claim.task.projectId); validateInput(claim.task.input);
        } catch (error) {
          return outcome('rejected', { reason: 'invalid_task_contract', detail: error instanceof Error ? error.message.slice(0, 4096) : 'Input could not be validated' });
        }
        if (signal.aborted) return outcome('cancelled', { reason: 'cancelled_before_handler_invocation', invocationStarted: false });
        return run(claim.task.input, claim.task.projectId, signal);
      },
    });
  }

  const reviewers = (['codex', 'claude'] as const).map(backend => handler({ kind: `cli-review-${backend}`,
    version: VERSION, replay: 'never', callUnits: 1, resourceKey: `${backend}:default` }, input => { reviewInput(input); },
  async (raw, _projectId, signal) => {
    const input = reviewInput(raw);
    let client: CliTaskResult | null;
    try {
      client = clientResult(await review({ backend, prompt: prompt(input, signal), timeoutMs: input.timeoutMs, signal,
        outputSchema: reviewJsonSchema({ reviewerId: input.reviewer.id, packetDigest: input.packet.digest, round: 0 }),
        ...(input.model !== null ? { model: input.model } : {}) }), backend);
    } catch {
      return outcome('uncertain', { reason: 'client_invocation_threw', backend, modelSelector: input.model, invocationStarted: true });
    }
    if (!client) return outcome('uncertain', { reason: 'invalid_client_result_contract', backend, modelSelector: input.model, invocationStarted: true });
    const { text, ...metadata } = client;
    const evidence: JsonObject = { backend, modelSelector: input.model, client: metadata as unknown as JsonObject,
      packetDigest: input.packet.digest, reviewerId: input.reviewer.id, round: 0,
      response: { sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) },
      executionMeaning: 'One reviewer invocation; task completion does not imply scientific approval.' };
    if (client.status === 'rate_limited') return { status: 'waiting_quota', retryAt: null, result: { ...evidence, reason: 'client_reported_quota_without_reset_time' } };
    if (client.status === 'auth_required') return { status: 'waiting_auth', retryAt: null, result: { ...evidence, reason: 'client_requires_authentication' } };
    if (client.status === 'timed_out' || client.status === 'cancelled') return outcome('uncertain', { ...evidence, reason: 'invocation_interrupted', invocationStarted: true });
    if (client.status === 'failed') {
      // The current client adapter discards process details. Only diagnostics proving a
      // preflight/spawn failure establish that no reviewer request could have completed.
      const knownNotInvoked = ['spawn_error', 'auth_check_spawn_error', 'auth_check_output_limit'].includes(client.diagnostic ?? '');
      return outcome(knownNotInvoked ? 'failed' : 'uncertain', { ...evidence,
        reason: knownNotInvoked ? 'client_preflight_failed' : 'client_completion_ambiguous' });
    }
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) return outcome('failed', { ...evidence, reason: 'review_response_too_large' });
    const validated = validateReview(text, { reviewerId: input.reviewer.id, packet: input.packet, round: 0, objections: [] });
    // Many tiny invalid entries can expand into a much larger diagnostic list. Preserve
    // the total count while bounding stored diagnostics so a bad reply cannot prevent
    // the scheduler from durably recording this failed assessment.
    const storedReview = validated.status === 'valid' ? validated : { ...validated,
      issues: validated.issues.slice(0, 64).map(issue => issue.slice(0, 2048)) };
    return outcome(validated.status === 'valid' ? 'completed' : 'failed', { ...evidence,
      reviewOutcome: storedReview as unknown as JsonObject, validationIssueCount: validated.issues.length,
      reason: validated.status === 'valid' ? 'structured_review_completed' : 'review_missing_or_malformed' });
  }));

  const captures = handler({ kind: 'coworker_capture', version: VERSION, replay: 'reconcile_safe', callUnits: 0, resourceKey: null }, raw => {
    keys(raw, ['captureId', 'reportPath', 'observedAt'], ['captureId', 'reportPath']);
    id(raw.captureId); selectedReport(raw.reportPath); if (raw.observedAt !== undefined) timestamp(raw.observedAt);
  }, async (raw, projectId) => {
    try {
      const observed = await capture(ledger, { captureId: raw.captureId as string, projectId, root: project(projectId).root,
        reportPath: raw.reportPath as string, ...(typeof raw.observedAt === 'string' ? { observedAt: raw.observedAt } : {}) });
      return outcome('completed', { kind: 'coworker_capture', observation: { eventId: observed.eventId, digest: observed.digest,
        source: observed.source, projectId: observed.projectId, observedAt: observed.observedAt, runId: observed.runId },
        meaning: 'Archived observation; no manifest registration, job-state confirmation or scientific validation.' });
    } catch (error) { return outcome('failed', { reason: 'capture_failed', errorType: error instanceof Error ? error.name : 'UnknownError' }); }
  });
  const summaries = handler({ kind: 'project_summary', version: VERSION, replay: 'reconcile_safe', callUnits: 0, resourceKey: null }, raw => {
    keys(raw, ['observedAt'], []); if (raw.observedAt !== undefined) timestamp(raw.observedAt);
  }, async (raw, projectId) => {
    try {
      const clock = typeof raw.observedAt === 'string' ? new Date(raw.observedAt) : now();
      const artifact = await exportProject(ledger, projectId, project(projectId).summaryDirectory, clock);
      return outcome('completed', { kind: 'project_summary', artifact,
        meaning: 'Immutable projection of ledger state; not a new authority or scientific assessment.' });
    } catch (error) { return outcome('failed', { reason: 'project_summary_failed', errorType: error instanceof Error ? error.name : 'UnknownError' }); }
  });
  return [...reviewers, captures, summaries];
}
