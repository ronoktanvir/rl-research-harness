import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { JsonObject } from '../../src/ledger/types.ts';
import { parseCliResult, runCliReview } from '../../src/workers/cli.ts';
import type { CliTask } from '../../src/workers/cli.ts';
import { MAX_OUTPUT_SCHEMA_BYTES, reviewJsonSchema, revisionJsonSchema, serializeOutputSchema } from '../../src/workers/output-schema.ts';
import type { ProcessRequest, ProcessResult } from '../../src/workers/process.ts';

const response = (stdout: string, overrides: Partial<ProcessResult> = {}): ProcessResult => ({ stdout, stderr: '', exitCode: 0, stopped: null, ...overrides });
const codex = (text: string) => [
  { type: 'item.completed', item: { type: 'agent_message', text } }, { type: 'turn.completed' },
].map(event => JSON.stringify(event)).join('\n');
const claude = (answer: unknown, fields: Record<string, unknown> = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
  result: 'Narrative is not the structured answer.', structured_output: answer, session_id: 'fixture-session', usage: { output_tokens: 4 }, ...fields });

test('schemas close every record and fix reviewer identity without replacing semantic evidence checks', () => {
  const schema = reviewJsonSchema({ reviewerId: 'methods', packetDigest: 'a'.repeat(64), round: 2 });
  const properties = schema.properties as JsonObject;
  assert.deepEqual((properties.reviewerId as JsonObject).enum, ['methods']);
  assert.deepEqual((properties.round as JsonObject).enum, [2]);
  assert.deepEqual((properties.recommendation as JsonObject).enum, ['approve', 'revise', 'reject', 'abstain']);
  function check(value: unknown) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const item = value as JsonObject;
      if (item.type === 'object') {
        assert.equal(item.additionalProperties, false);
        assert.deepEqual(item.required, Object.keys(item.properties as JsonObject));
      }
      Object.values(item).forEach(check);
    } else if (Array.isArray(value)) value.forEach(check);
  }
  check(schema);
  assert.ok(Buffer.byteLength(serializeOutputSchema(schema)) < MAX_OUTPUT_SCHEMA_BYTES);
  assert.deepEqual(revisionJsonSchema(), { type: 'object', properties: { proposal: { type: 'string' } }, required: ['proposal'], additionalProperties: false });
  assert.throws(() => reviewJsonSchema({ reviewerId: 'methods', packetDigest: 'changed', round: 0 }));
});

test('schema serialization rejects lossy, executable, cyclic, external-reference and oversized values before invoking a client', async () => {
  const cyclic: JsonObject = { type: 'object' }; cyclic.cycle = cyclic;
  let getterCalls = 0;
  const getter = { type: 'object', get description() { getterCalls++; return 'side effect'; } };
  const invalid: unknown[] = [
    { type: 'array' }, { type: 'object', description: 'x'.repeat(MAX_OUTPUT_SCHEMA_BYTES) },
    { type: 'object', maximum: Infinity }, { type: 'object', property: undefined }, { type: 'object', enum: new Array(2) },
    { type: 'object', toJSON: () => ({ type: 'object' }) }, getter, cyclic,
    { type: 'object', $ref: 'https://untrusted.invalid/schema' }, { type: 'object', $dynamicRef: 'file:///private/schema' },
  ];
  let calls = 0;
  for (const outputSchema of invalid) await assert.rejects(runCliReview({ backend: 'codex', prompt: 'fixture', outputSchema: outputSchema as JsonObject }, {
    execute: async () => { calls++; return response(''); },
  }));
  assert.equal(calls, 0);
  assert.equal(getterCalls, 0);
  assert.equal(JSON.parse(serializeOutputSchema({ type: 'object', $ref: '#/$defs/review' })).$ref, '#/$defs/review');
});

test('Codex reads an exclusively created private schema snapshot and cleanup runs after completion', async () => {
  const schema = revisionJsonSchema();
  const original = structuredClone(schema);
  const requests: ProcessRequest[] = [];
  let schemaPath = '';
  const result = await runCliReview({ backend: 'codex', prompt: 'fixture', outputSchema: schema }, { execute: async request => {
    requests.push(request);
    if (requests.length === 1) {
      schema.properties = { changed: { type: 'boolean' } };
      return response('Logged in using ChatGPT');
    }
    schemaPath = request.args[request.args.indexOf('--output-schema') + 1]!;
    assert.equal(schemaPath, join(request.cwd, 'output-schema.json'));
    assert.equal(request.args.at(-1), '-');
    assert.deepEqual(JSON.parse(await readFile(schemaPath, 'utf8')), original);
    if (process.platform !== 'win32') {
      assert.equal((await stat(schemaPath)).mode & 0o777, 0o600);
      assert.equal((await stat(request.cwd)).mode & 0o777, 0o700);
    }
    return response(codex('{"proposal":"bounded revision"}'));
  } });
  assert.equal(result.status, 'succeeded');
  assert.equal(requests.length, 2);
  await assert.rejects(access(schemaPath));
  await assert.rejects(access(requests[0]!.cwd));
});

test('schema workspace is removed after auth refusal or an injected process exception', async () => {
  for (const throws of [false, true]) {
    let cwd = '';
    const run = runCliReview({ backend: 'codex', prompt: 'fixture', outputSchema: revisionJsonSchema() }, { execute: async request => {
      cwd = request.cwd;
      assert.equal(JSON.parse(await readFile(join(cwd, 'output-schema.json'), 'utf8')).type, 'object');
      if (throws) throw new Error('fixture interruption');
      return response('not logged in', { exitCode: 1 });
    } });
    if (throws) await assert.rejects(run, /fixture interruption/u);
    else assert.equal((await run).status, 'auth_required');
    await assert.rejects(access(cwd));
  }
});

test('mutating a caller task during preflight cannot alter validated prompt, backend or schema selection', async () => {
  const task: CliTask = { backend: 'codex', prompt: 'original evidence', timeoutMs: 1234, outputSchema: revisionJsonSchema() };
  let calls = 0;
  const result = await runCliReview(task, { execute: async request => {
    if (++calls === 1) {
      task.backend = 'claude'; task.prompt = 'x'.repeat(600_000); task.timeoutMs = 9_999_999; delete task.outputSchema;
      return response('Logged in using ChatGPT');
    }
    assert.equal(request.executable, 'codex');
    assert.equal(request.input, 'original evidence');
    assert.equal(request.timeoutMs, 1234);
    assert.equal(request.args.includes('--output-schema'), true);
    return response(codex('{"proposal":"same submission"}'));
  } });
  assert.equal(calls, 2);
  assert.equal(result.backend, 'codex');
  assert.equal(result.status, 'succeeded');
});

test('Claude receives one literal bounded schema argument and reads structured_output rather than result prose', async () => {
  const requests: ProcessRequest[] = [];
  const schema: JsonObject = { ...revisionJsonSchema(), description: 'Literal $(not-a-command) `also-literal` "quotes"' };
  const result = await runCliReview({ backend: 'claude', prompt: 'fixture', outputSchema: schema }, { execute: async request => {
    requests.push(request);
    if (requests.length === 1) return response('{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}');
    assert.deepEqual(JSON.parse(request.args[request.args.indexOf('--json-schema') + 1]!), schema);
    assert.equal(request.args.filter(arg => arg === '--json-schema').length, 1);
    return response(claude({ proposal: 'Use existing evidence.' }));
  } });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(JSON.parse(result.text), { proposal: 'Use existing evidence.' });
  assert.equal(result.sessionId, 'fixture-session');
  assert.deepEqual(result.usage, { output_tokens: 4 });
  assert.equal(requests.length, 2);
});

test('known terminal completion preserves missing and malformed answers for research validation without repair or fallback', () => {
  const missing = JSON.parse(claude({ proposal: 'unavailable' })); delete missing.structured_output;
  const result = parseCliResult('claude', response(JSON.stringify(missing)), { structuredOutput: true });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.text, '');
  assert.equal(parseCliResult('claude', response(claude(null)), { structuredOutput: true }).text, 'null');
  assert.equal(parseCliResult('codex', response(codex('```json\n{}\n```')), { structuredOutput: true }).text, '```json\n{}\n```');
  // Existing unstructured callers still read result, never silently switch formats.
  assert.equal(parseCliResult('claude', response(claude({ proposal: 'different' }))).text, 'Narrative is not the structured answer.');
});

test('schema mode cannot turn failed, partial, cancelled or rate-limited protocol output into success', () => {
  const schemaMode = { structuredOutput: true };
  assert.equal(parseCliResult('claude', response(claude({ proposal: 'partial' }, { subtype: 'error', is_error: true, result: 'Usage limit exceeded' })), schemaMode).status, 'rate_limited');
  assert.equal(parseCliResult('claude', response(claude({ proposal: 'partial' }), { exitCode: 1 }), schemaMode).status, 'failed');
  assert.equal(parseCliResult('codex', response(codex('{}'), { stopped: 'cancelled' }), schemaMode).status, 'cancelled');
  assert.equal(parseCliResult('codex', response('{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}'), schemaMode).status, 'failed');
});
