import { createHash } from "node:crypto";
import type { JsonObject } from "./types.js";
export class QueueError extends Error {
  constructor(public readonly code: "invalid" | "conflict" | "missing" | "denied" | "owned" | "closed", message: string) { super(message); this.name = "QueueError"; }
}
export function fail(code: QueueError["code"], message: string): never { throw new QueueError(code, message); }
export function snap<T>(value: T): T { try { return structuredClone(value); } catch { return fail("invalid", "Expected cloneable data"); } }
export function object(value: unknown): asserts value is Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("invalid", "Expected plain object"); }
export function keys(value: unknown, allowed: string[], required = allowed): asserts value is Record<string, unknown> { object(value); if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail("invalid", "Unexpected or missing fields"); }
export function id(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)) fail("invalid", "Invalid identifier"); }
export function integer(value: unknown, min = 0): asserts value is number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) fail("invalid", "Expected a bounded safe integer"); }
export function text(value: unknown): asserts value is string { if (typeof value !== "string" || !value.trim() || value.length > 100_000) fail("invalid", "Expected nonempty text"); }
export function timestamp(value: unknown): asserts value is string { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) fail("invalid", "Expected ISO timestamp"); }
export function enumValue<T extends string>(value: unknown, allowed: readonly T[]): asserts value is T { if (typeof value !== "string" || !allowed.includes(value as T)) fail("invalid", "Invalid enumeration value"); }
export function ids(value: unknown): asserts value is string[] { if (!Array.isArray(value)) fail("invalid", "Expected ID array"); for (const item of value) id(item); if (new Set(value).size !== value.length) fail("invalid", "Duplicate IDs"); }
function canonical(value: unknown, depth: number): string {
  if (depth > 40) fail("invalid", "JSON nesting exceeds limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) fail("invalid", "Sparse array"); return `[${value.map(item => canonical(item, depth + 1)).join(",")}]`; }
  object(value); return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(",")}}`;
}
export function encode(value: unknown): string { const data = canonical(value, 0); if (Buffer.byteLength(data) > 2_097_152) fail("invalid", "Record exceeds 2 MiB"); return data; }
export function json(value: unknown): asserts value is JsonObject { object(value); encode(value); }
export function evidence(value: unknown): asserts value is JsonObject { json(value); if (!Object.keys(value).length) fail("invalid", "Nonempty reconciliation evidence required"); }
export function hash(value: unknown): string { return createHash("sha256").update(encode(value)).digest("hex"); }
export function parse<T>(value: unknown): T { return JSON.parse(value as string) as T; }
export function scope(value: unknown): asserts value is string { id(value); if (value !== "global" && !/^project:[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) fail("invalid", "Only global/project budget scopes are supported"); }
