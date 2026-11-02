import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "./types.js";

export class LedgerError extends Error {
  constructor(public readonly code: "invalid" | "conflict" | "missing" | "denied" | "owned" | "closed", message: string) {
    super(message); this.name = "LedgerError";
  }
}
export function fail(code: LedgerError["code"], message: string): never { throw new LedgerError(code, message); }
export function snapshot<T>(input: T): T {
  try { return structuredClone(input); } catch { return fail("invalid", "Input must contain cloneable data"); }
}
export function object(value: unknown, label = "input"): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("invalid", `${label} must be a plain object`);
}
export function keys(value: unknown, allowed: string[], required = allowed): asserts value is Record<string, unknown> {
  object(value);
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail("invalid", "Unexpected or missing input fields");
}
export function text(value: unknown, label = "text"): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 100_000) fail("invalid", `${label} must be nonempty text`);
}
export function id(value: unknown, label = "ID"): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)) fail("invalid", `${label} has an invalid format`);
}
export function integer(value: unknown, minimum = 0): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail("invalid", `Expected an integer >= ${minimum}`);
}
export function enumValue<T extends string>(value: unknown, allowed: readonly T[]): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail("invalid", `Expected one of ${allowed.join(", ")}`);
}
export function timestamp(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) fail("invalid", "Expected an ISO timestamp");
}
export function digestValue(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("invalid", "Expected a lowercase SHA-256 digest");
}
export const MAX_MONEY = 9_223_372_036_854_775_807n;
export function money(value: unknown): asserts value is bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_MONEY) fail("invalid", "Money must be nonnegative bigint microdollars within signed 64-bit range");
}
export function decimalMoney(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) fail("invalid", "Money JSON must use canonical decimal strings");
  money(BigInt(value));
}
function canonical(value: unknown, depth: number): string {
  if (depth > 40) fail("invalid", "JSON nesting exceeds 40 levels");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) fail("invalid", "Sparse arrays are not JSON data");
    return `[${value.map(item => canonical(item, depth + 1)).join(",")}]`;
  }
  object(value, "JSON value");
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(",")}}`;
}
export function encode(value: unknown): string {
  const result = canonical(value, 0);
  if (Buffer.byteLength(result) > 2 * 1024 * 1024) fail("invalid", "Record exceeds 2 MiB");
  return result;
}
export function jsonObject(value: unknown): asserts value is JsonObject { object(value); encode(value); }
export function hash(value: unknown): string { return createHash("sha256").update(encode(value)).digest("hex"); }
export function parse<T>(value: unknown): T { return JSON.parse(value as string) as T; }
export function jsonValue(value: unknown): JsonValue { return parse<JsonValue>(encode(value)); }
export function ids(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) fail("invalid", "Expected ID list");
  for (const item of value) id(item);
  if (new Set(value).size !== value.length) fail("invalid", "Duplicate IDs");
}
export function policyScope(scopeId: string): void {
  id(scopeId);
  if (scopeId !== "global" && !/^project:[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(scopeId)) fail("invalid", "Stop and policy scopes must be global or project:<projectId>");
}
