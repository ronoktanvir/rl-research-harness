import { basename } from 'node:path';
import { projectRoot, readProjectFile } from './files.ts';
import type { FileReference, ReadProblem } from './files.ts';
import { parseCoworkerReport } from './report.ts';
import type { CoworkerDiagnostic, CoworkerReport } from './report.ts';
export { parseCoworkerReport } from './report.ts';
export type { CoworkerDiagnostic, CoworkerReport, CoworkerStep } from './report.ts';
export type { FileReference } from './files.ts';

const CONFIG_FILES = [
  'experiments/coworkerl-v2/pyproject.toml',
  'experiments/coworkerl-v2/src/probing/configs/selection_manifest.json',
  'experiments/coworkerl-v2/src/probing/verl/config/probing_grpo_trainer.yaml',
  'experiments/coworkerl-v2/src/probing/verl/fit_loop.py',
  'experiments/coworkerl-v2/src/probing/verl/checkpoint.py',
  'experiments/probing/pyproject.toml',
] as const;

export interface CoworkerProjectInspection {
  root: string;
  revision: string | null;
  workingTreeState: 'not_assessed';
  files: FileReference[];
  missingOrUnreadable: { path: string; problem: ReadProblem }[];
  selections: { name: string; configurationCount: number }[];
  diagnostics: CoworkerDiagnostic[];
  capabilities: { inspect: true; launch: false; cancel: false; checkpoint: false };
}

async function revision(root: string): Promise<string | null> {
  const head = await readProjectFile(root, '.git/HEAD', 1024);
  if (!head.ok) return null;
  const text = head.text.trim();
  if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(text)) return text;
  const match = /^ref: (refs\/[A-Za-z0-9_./-]+)$/u.exec(text);
  const ref = match?.[1];
  if (!ref) return null;
  const loose = await readProjectFile(root, `.git/${ref}`, 1024);
  if (loose.ok && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(loose.text.trim())) return loose.text.trim();
  const packed = await readProjectFile(root, '.git/packed-refs', 2 * 1024 * 1024);
  if (!packed.ok) return null;
  for (const line of packed.text.split('\n')) {
    const [sha, name] = line.split(' ');
    if (name === ref && sha && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(sha)) return sha;
  }
  return null;
}

/** Inspect a small fixed set of source/config references; never recurse over research artifacts. */
export async function inspectCoworkerProject(path: string): Promise<CoworkerProjectInspection> {
  const root = await projectRoot(path);
  const result: CoworkerProjectInspection = { root, revision: await revision(root), workingTreeState: 'not_assessed',
    files: [], missingOrUnreadable: [], selections: [], diagnostics: [],
    capabilities: { inspect: true, launch: false, cancel: false, checkpoint: false } };
  for (const file of CONFIG_FILES) {
    const read = await readProjectFile(root, file, 2 * 1024 * 1024);
    if (!read.ok) { result.missingOrUnreadable.push({ path: file, problem: read.problem }); continue; }
    result.files.push(read.reference);
    if (!file.endsWith('selection_manifest.json')) continue;
    try {
      const data: unknown = JSON.parse(read.text);
      if (!data || typeof data !== 'object' || !('schema' in data) || data.schema !== 'coworkerl-v2-selection-manifest'
        || !('selections' in data) || !data.selections || typeof data.selections !== 'object' || Array.isArray(data.selections)) {
        throw new Error('unsupported manifest');
      }
      for (const [name, values] of Object.entries(data.selections)) {
        if (!/^[a-z][a-z0-9_]{0,63}$/u.test(name) || !Array.isArray(values) || !values.every(v => typeof v === 'string')) continue;
        result.selections.push({ name, configurationCount: values.length });
      }
    } catch {
      result.diagnostics.push({ code: 'selection_manifest_unreadable', field: file, severity: 'warning',
        message: 'Selection metadata could not be interpreted; the source reference is retained.' });
    }
  }
  if (!result.revision) result.diagnostics.push({ code: 'git_revision_unavailable', field: '.git/HEAD', severity: 'warning',
    message: 'Normal .git directory revision could not be read; linked worktree git pointers are not followed.' });
  result.diagnostics.push({ code: 'working_tree_not_assessed', field: '', severity: 'info',
    message: 'HEAD is not proof of a clean checkout. References hash the inspected bytes; dirty/untracked state is not inferred.' });
  return result;
}

export interface CoworkerRunInspection {
  root: string;
  reportReference: FileReference | null;
  observationAgeMs: number | null;
  report: CoworkerReport | null;
  diagnostics: CoworkerDiagnostic[];
}

/** Read only the explicitly selected report.json. No traces, secrets, answer keys, or checkpoint weights are opened. */
export async function inspectCoworkerRun(path: string, reportPath: string, options: {
  now?: Date; staleAfterMs?: number;
} = {}): Promise<CoworkerRunInspection> {
  const root = await projectRoot(path);
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? 15 * 60 * 1000;
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new Error('Observation time and stale threshold must be finite; threshold must be nonnegative');
  }
  const result: CoworkerRunInspection = { root, reportReference: null, observationAgeMs: null, report: null, diagnostics: [] };
  if (basename(reportPath) !== 'report.json') {
    result.diagnostics.push({ code: 'unsupported_report_path', field: '', severity: 'error', message: 'Select a project-relative report.json file.' });
    return result;
  }
  const read = await readProjectFile(root, reportPath, 16 * 1024 * 1024);
  if (!read.ok) {
    result.diagnostics.push({ code: `report_${read.problem}`, field: reportPath, severity: 'error', message: 'Report could not be safely read; no training state was inferred.' });
    return result;
  }
  result.reportReference = read.reference;
  result.observationAgeMs = now.getTime() - Date.parse(read.reference.modifiedAt);
  result.report = parseCoworkerReport(read.text);
  result.diagnostics.push(...result.report.diagnostics);
  if (result.observationAgeMs < 0) {
    result.diagnostics.push({ code: 'future_report_timestamp', field: reportPath, severity: 'warning', message: 'File modification time is later than the observation clock; freshness is unreliable.' });
  } else if (result.observationAgeMs > staleAfterMs) {
    result.diagnostics.push({ code: 'stale_report_observation', field: reportPath, severity: 'warning',
      message: 'Report file is older than the observation threshold. Historical or copied artifacts may be old; this does not establish a stalled or failed job.' });
  }
  return result;
}
