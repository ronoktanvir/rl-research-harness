import { isAbsolute, normalize } from "node:path";

export function replayError(message: string): never { throw new Error(`Observed replay: ${message}`); }

/** Copy inert JSON while charging bytes during traversal, before allocating a large serialization. */
export function replayJson(raw: unknown, maxBytes: number): unknown {
  let nodes = 0, bytes = 0;
  const charge = (n: number) => { bytes += n; if (bytes > maxBytes) replayError("JSON byte limit"); };
  const walk = (v: unknown, depth: number): unknown => {
    if (++nodes > 100_000 || depth > 32) replayError("JSON structural limit");
    if (v === null || typeof v === "boolean") { charge(v === null || v === true ? 4 : 5); return v; }
    if (typeof v === "number" && Number.isFinite(v)) { charge(JSON.stringify(v).length); return v; }
    if (typeof v === "string") {
      if (v.length > maxBytes || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)) replayError("invalid JSON text");
      charge(Buffer.byteLength(JSON.stringify(v))); return v;
    }
    if (!v || typeof v !== "object" || (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype)) replayError("expected inert JSON");
    if (Array.isArray(v) && v.length > 100_000) replayError("array limit");
    const ds = Object.getOwnPropertyDescriptors(v);
    if (Reflect.ownKeys(v).some(k => typeof k !== "string") || Object.values(ds).some(d => !Object.hasOwn(d, "value"))) replayError("non-JSON property");
    if (Array.isArray(v)) {
      if (Object.keys(ds).length !== v.length + 1) replayError("sparse or augmented array");
      charge(2 + Math.max(0, v.length - 1));
      return Array.from({ length: v.length }, (_, i) => { if (!ds[i]) replayError("sparse array"); return walk(ds[i]!.value, depth + 1); });
    }
    charge(2 + Math.max(0, Object.keys(ds).length - 1));
    return Object.fromEntries(Object.entries(ds).map(([k, d]) => {
      if (!d.enumerable || k.length > maxBytes) replayError("invalid JSON property");
      charge(Buffer.byteLength(JSON.stringify(k)) + 1); return [k, walk(d.value, depth + 1)];
    }));
  };
  return walk(raw, 0);
}
export function replayText(v: unknown, max = 512, empty = false): asserts v is string {
  if (typeof v !== "string" || (!empty && !v.trim()) || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) replayError("invalid bounded text");
}
export function replayInteger(v: unknown, max: number, min = 0): asserts v is number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) replayError("invalid bounded integer");
}
export function replayAbsolute(v: unknown): asserts v is string {
  replayText(v, 4096);
  if (!isAbsolute(v) || normalize(v) !== v || v === "/" || v.includes("\\")) replayError("expected canonical absolute directory");
}
export function replayRelative(v: unknown): asserts v is string {
  replayText(v, 2048);
  if (isAbsolute(v) || v.includes("\\") || v.split("/").some(p => !p || p === "." || p === "..")) replayError("unsafe relative path");
}
export function replayArray(v: unknown, max: number): asserts v is unknown[] {
  if (!Array.isArray(v) || v.length > max) replayError("invalid bounded array");
}
export function replayUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) replayError("duplicate identifier");
}

/** JSON.parse supplies grammar checks; the token pass rejects duplicate decoded object keys. */
export function parseReplayJson(raw: string, maxBytes: number): unknown {
  if (Buffer.byteLength(raw) > maxBytes) replayError("JSON byte limit");
  const parsed: unknown = JSON.parse(raw);
  const stack: { object: boolean; keys: Set<string>; expectingKey: boolean }[] = [];
  for (const match of raw.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/gu)) {
    const token = match[0];
    if (token === "{" || token === "[") stack.push({ object: token === "{", keys: new Set(), expectingKey: token === "{" });
    else if (token === "}" || token === "]") stack.pop();
    else {
      const parent = stack.at(-1);
      if (token === "," && parent?.object) parent.expectingKey = true;
      else if (token.startsWith('"') && parent?.object && parent.expectingKey) {
        const key = JSON.parse(token) as string;
        if (parent.keys.has(key)) replayError("duplicate JSON key");
        parent.keys.add(key); parent.expectingKey = false;
      }
    }
    if (stack.length > 32) replayError("JSON depth limit");
  }
  return replayJson(parsed, maxBytes);
}
