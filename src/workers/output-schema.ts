import type { JsonObject } from '../ledger/types.ts';

export const MAX_OUTPUT_SCHEMA_BYTES = 65_536;

/** Bound and snapshot inert JSON before any asynchronous client work. This is a
 * transport check, not a complete JSON Schema validator; the client owns its
 * supported schema dialect and research validators own semantic acceptance.
 */
export function serializeOutputSchema(schema: JsonObject): string {
  let nodes = 0;
  let bytes = 0;
  function add(text: string): string {
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_OUTPUT_SCHEMA_BYTES) throw new Error('Output schema exceeds 65,536 bytes');
    return text;
  }
  function visit(value: unknown, depth: number): string {
    if (++nodes > 4096 || depth > 32) throw new Error('Output schema exceeds structural bounds');
    if (value === null || typeof value === 'boolean') return add(JSON.stringify(value));
    if (typeof value === 'number' && Number.isFinite(value)) return add(JSON.stringify(value));
    if (typeof value === 'string') {
      if (Buffer.byteLength(value) > MAX_OUTPUT_SCHEMA_BYTES) throw new Error('Output schema exceeds 65,536 bytes');
      return add(JSON.stringify(value));
    }
    if (!value || typeof value !== 'object' || Object.getOwnPropertySymbols(value).length) throw new Error('Output schema must contain plain JSON');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 4096
        || Object.keys(descriptors).length !== value.length + 1) throw new Error('Output schema arrays must be dense plain JSON');
      const items: string[] = [];
      add('[]');
      for (let i = 0; i < value.length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error('Output schema must contain plain JSON');
        if (i) add(',');
        items.push(visit(descriptor.value, depth + 1));
      }
      return `[${items.join(',')}]`;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Output schema must contain plain JSON');
    add('{}');
    const entries: string[] = [];
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!('value' in descriptor) || !descriptor.enumerable) throw new Error('Output schema must contain plain JSON');
      // Schemas cannot request external document resolution through this worker.
      if (['$ref', '$dynamicRef', '$recursiveRef'].includes(key)
        && (typeof descriptor.value !== 'string' || !descriptor.value.startsWith('#'))) throw new Error('Output schema references must be local');
      if (entries.length) add(',');
      entries.push(`${visit(key, depth + 1)}${add(':')}${visit(descriptor.value, depth + 1)}`);
    }
    return `{${entries.join(',')}}`;
  }
  const serialized = visit(schema, 0);
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('type' in value) || value.type !== 'object') {
    throw new Error('Output schema must describe an object');
  }
  return serialized;
}

function record(properties: JsonObject): JsonObject {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}
function list(items: JsonObject): JsonObject { return { type: 'array', items }; }
function text(): JsonObject { return { type: 'string' }; }
function evidenceIds(): JsonObject { return list(text()); }
function claim(): JsonObject { return record({ text: text(), evidenceIds: evidenceIds() }); }
function choice(values: string[]): JsonObject { return { type: 'string', enum: values }; }

/** Formatting contract only: evidence existence, criteria coverage, objection
 * ownership and the acceptability of a recommendation remain core checks.
 */
export function reviewJsonSchema(identity: { reviewerId: string; packetDigest: string; round: number }): JsonObject {
  if (typeof identity.reviewerId !== 'string' || !identity.reviewerId.trim() || identity.reviewerId.length > 128
    || typeof identity.packetDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(identity.packetDigest)
    || !Number.isSafeInteger(identity.round) || identity.round < 0) throw new Error('Invalid review schema identity');
  return record({
    schemaVersion: { type: 'integer', enum: [1] },
    reviewerId: choice([identity.reviewerId]), packetDigest: choice([identity.packetDigest]),
    round: { type: 'integer', enum: [identity.round] },
    recommendation: choice(['approve', 'revise', 'reject', 'abstain']),
    observations: list(claim()), interpretations: list(claim()),
    criteria: list(record({ criterionId: text(), status: choice(['satisfied', 'unsatisfied', 'uncertain']), summary: text(), evidenceIds: evidenceIds() })),
    objections: list(record({ id: text(), category: choice(['validity', 'feasibility', 'scope', 'presentation']), severity: choice(['blocking', 'material', 'minor']),
      text: text(), evidenceIds: evidenceIds(), requiredAction: text() })),
    resolutions: list(record({ objectionKey: text(), disposition: choice(['resolved', 'unresolved', 'withdrawn']), explanation: text(), evidenceIds: evidenceIds() })),
    rationale: claim(),
  });
}

export function revisionJsonSchema(): JsonObject { return record({ proposal: text() }); }
