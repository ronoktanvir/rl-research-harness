import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type ReadProblem = 'missing' | 'unreadable' | 'unsafe_path' | 'too_large' | 'changed_during_read' | 'reader_unavailable';
export interface FileReference {
  path: string;
  sha256: string;
  bytes: number;
  modifiedAt: string;
}
export type FileRead = { ok: true; text: string; reference: FileReference }
  | { ok: false; problem: ReadProblem };

const execute = promisify(execFile);
const helper = fileURLToPath(new URL('./read_file.py', import.meta.url));
const MAX_READ_BYTES = 16 * 1024 * 1024;
const problems = new Set<ReadProblem>(['missing', 'unreadable', 'unsafe_path', 'too_large', 'changed_during_read', 'reader_unavailable']);

export async function projectRoot(path: string): Promise<string> {
  const root = await realpath(resolve(path));
  if (!(await lstat(root)).isDirectory()) throw new Error('Coworker project root must be a directory');
  return root;
}

/** The trusted helper traverses every component relative to pinned directory descriptors.
 * Python isolated/no-site mode never imports source or dependencies from the project.
 */
export async function readProjectFile(root: string, path: string, maxBytes: number): Promise<FileRead> {
  const parts = path.split(/[\\/]/u);
  if (!isAbsolute(root) || root.includes('\0') || isAbsolute(path) || path.includes('\0')
    || parts.some(p => !p || p === '.' || p === '..')) {
    return { ok: false, problem: 'unsafe_path' };
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_READ_BYTES) {
    throw new RangeError(`File read limit must be an integer from zero to ${MAX_READ_BYTES}`);
  }
  try {
    const { stdout } = await execute('python3', ['-I', '-S', helper, root, parts.join('/'), String(maxBytes)], {
      cwd: dirname(helper), encoding: 'utf8', timeout: 20_000,
      // Base64 keeps arbitrary file bytes bounded independently of JSON escaping.
      maxBuffer: 4 * Math.ceil(maxBytes / 3) + 4096,
    });
    const output: unknown = JSON.parse(stdout);
    if (!output || typeof output !== 'object' || !('ok' in output)) return { ok: false, problem: 'reader_unavailable' };
    if (output.ok === false && 'problem' in output && problems.has(output.problem as ReadProblem)) {
      return { ok: false, problem: output.problem as ReadProblem };
    }
    if (output.ok !== true || !('data' in output) || typeof output.data !== 'string'
      || !('mtimeMs' in output) || typeof output.mtimeMs !== 'number' || !Number.isFinite(output.mtimeMs)) {
      return { ok: false, problem: 'reader_unavailable' };
    }
    const bytes = Buffer.from(output.data, 'base64');
    if (bytes.length > maxBytes) return { ok: false, problem: 'too_large' };
    const modified = new Date(output.mtimeMs);
    if (!Number.isFinite(modified.getTime())) return { ok: false, problem: 'unreadable' };
    return { ok: true, text: bytes.toString('utf8'), reference: {
      path: parts.join('/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      modifiedAt: modified.toISOString(),
    } };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, problem: code === 'ENOENT' ? 'reader_unavailable' : 'unreadable' };
  }
}
