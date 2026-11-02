import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';
import type { ExperimentLedger, JsonObject, ObservationRecord } from '../../ledger/types.ts';
import { inspectCoworkerProject, inspectCoworkerRun } from './index.ts';
import { projectRoot } from './files.ts';

const SOURCE = 'coworker-report-capture.v1';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const READER_FILES = ['capture.ts', 'index.ts', 'files.ts', 'read_file.py', 'report.ts'] as const;

export interface CoworkerCaptureRequest {
  /** One durable observation identity. A different ID explicitly requests a fresh read. */
  captureId: string;
  projectId: string;
  root: string;
  reportPath: string;
  /** Capture clock, not original producer time. Defaults to the current UTC time. */
  observedAt?: string;
}

export type CoworkerObservationArchive = Pick<ExperimentLedger, 'getObservation' | 'appendObservation'>;

export class CoworkerCaptureConflict extends Error {
  constructor() {
    super('Capture ID already belongs to another requested source or observation type');
    this.name = 'CoworkerCaptureConflict';
  }
}

function reportPath(value: string): string {
  const parts = value.split(/[\\/]/u);
  if (isAbsolute(value) || win32.isAbsolute(value) || value.includes('\0')
    || parts.some(part => !part || part === '.' || part === '..') || parts.at(-1) !== 'report.json') {
    throw new Error('Capture requires a project-relative report.json without traversal');
  }
  return parts.join('/');
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function recoverCapture(existing: ObservationRecord, identity: { projectId: string; canonicalRoot: string; reportPath: string }, requestDigest: string): ObservationRecord {
  const saved = existing.payload.requestIdentity;
  if (existing.source !== SOURCE || existing.projectId !== identity.projectId || existing.runId !== null
    || existing.actionId !== null || existing.jobId !== null || existing.payload.requestDigest !== requestDigest
    || !saved || typeof saved !== 'object' || Array.isArray(saved)
    || saved.projectId !== identity.projectId || saved.canonicalRoot !== identity.canonicalRoot || saved.reportPath !== identity.reportPath) {
    throw new CoworkerCaptureConflict();
  }
  return structuredClone(existing);
}

async function readerIdentity(): Promise<JsonObject> {
  const sourceFiles = await Promise.all(READER_FILES.map(async path => ({
    path, sha256: createHash('sha256').update(await readFile(new URL(path, import.meta.url))).digest('hex'),
  })));
  return { version: SOURCE, sourceFiles, sourceDigest: digest(sourceFiles),
    meaning: 'Observed harness source files; not an attestation of the loaded process or interpreter.' };
}

function unknownManifestFields(): JsonObject[] {
  return [
    ['complete_code_state', 'Producer source identifiers may be present; original dirty patch and complete source bytes are not verified.'],
    ['environment_image_and_dependencies', 'Current pyproject references do not establish the original image or dependency lock.'],
    ['adapter_configuration_and_hyperparameters', 'The safe report projection retains only planned steps, first step and training seed; it is not complete training configuration.'],
    ['model_and_tokenizer_versions', 'Original model, reference model, tokenizer and template versions are not observed by this reader.'],
    ['data_versions_and_splits', 'Current selection counts do not establish the original data versions, split hashes or held-out protection.'],
    ['reward_and_evaluator_versions', 'Reward and evaluator identities have not been independently established.'],
    ['complete_seeds_and_determinism', 'A producer-reported training seed does not establish all seeds, RNG states or determinism settings.'],
    ['resource_limits_and_stop_policy', 'An original compute allowance, deadline, allocation identity and stopping policy are not observed.'],
    ['evaluation_and_selection_policy', 'No frozen evaluation, model-selection or confirmatory-analysis policy is established.'],
    ['artifact_destinations_and_checkpoint_lineage', 'Producer checkpoint flags do not verify original destinations, checkpoint contents or resume lineage.'],
  ].map(([field, reason]) => ({ field: field!, status: 'not_established', reason: reason! }));
}

/** Archive evidence only. This never registers a run, validates a manifest, or updates job state.
 * Retries recover the stored capture before inspecting report/current source bytes again.
 */
export async function captureCoworkerReport(
  archive: CoworkerObservationArchive,
  request: CoworkerCaptureRequest,
): Promise<ObservationRecord> {
  // Capture caller data before the first await so mutation cannot change request identity.
  const input = structuredClone(request);
  if (typeof input.captureId !== 'string' || !ID.test(input.captureId)
    || typeof input.projectId !== 'string' || !ID.test(input.projectId) || typeof input.root !== 'string'
    || typeof input.reportPath !== 'string' || !input.root.trim()) {
    throw new Error('Capture and project IDs, project root and report path are required');
  }
  const selectedReport = reportPath(input.reportPath);
  const existing = archive.getObservation(input.captureId);
  // Resolve only the root needed to bind identity. An existing capture never rereads its report.
  const root = await projectRoot(input.root);
  const requestIdentity = { projectId: input.projectId, canonicalRoot: root, reportPath: selectedReport };
  const requestDigest = digest(requestIdentity);
  if (existing) return recoverCapture(existing, requestIdentity, requestDigest);
  const observedAt = input.observedAt ?? new Date().toISOString();
  if (typeof observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT/u.test(observedAt) || !Number.isFinite(Date.parse(observedAt))) {
    throw new Error('Capture observedAt must be an ISO timestamp');
  }
  const [project, observation, reader] = await Promise.all([
    inspectCoworkerProject(root),
    inspectCoworkerRun(root, selectedReport, { now: new Date(observedAt) }),
    readerIdentity(),
  ]);
  const capture = {
    schemaVersion: 1, kind: SOURCE, requestIdentity, requestDigest, reader,
    ordering: 'unordered_file_snapshot', consistency: 'per_file_observations_not_an_atomic_project_snapshot',
    currentCheckout: {
      meaning: 'Observed at capture time; not asserted to be the checkout that produced the report.',
      revision: project.revision, workingTreeState: project.workingTreeState,
      files: project.files, missingOrUnreadable: project.missingOrUnreadable,
      selections: project.selections, diagnostics: project.diagnostics,
    },
    reportObservation: observation,
    originalRun: {
      registration: 'unregistered', manifestDigest: null,
      producerReportedSource: observation.report?.source ?? null,
      partialProducerConfiguration: observation.report?.configuration ?? null,
      missingManifestFields: unknownManifestFields(),
      execution: 'unknown', allocation: 'unknown', billingSettlement: 'unknown', scientificEvaluation: 'unassessed',
      costMeaning: observation.report?.spendMeaning ?? 'unspecified',
    },
    limits: [
      'This capture archives a sanitized projection and hashes, not the raw report or an executable manifest.',
      'File modification time and step count do not establish producer ordering, liveness or successful completion.',
      'Reported spend is evidence about a producer estimate, not a ledger charge or settled bill.',
      'No run linkage, execution validation, independent evaluation or training dispatch was performed.',
    ],
  };
  // All fields are generated above or by the bounded, sanitized reader. The ledger independently
  // snapshots and JSON-validates the payload at its authoritative persistence boundary.
  // Another same-owner caller can finish during the reads; preserve its first committed capture.
  const raced = archive.getObservation(input.captureId);
  if (raced) return recoverCapture(raced, requestIdentity, requestDigest);
  return archive.appendObservation({ eventId: input.captureId, projectId: input.projectId,
    runId: null, actionId: null, jobId: null, source: SOURCE, sequence: 0, observedAt,
    payload: capture as unknown as JsonObject });
}
