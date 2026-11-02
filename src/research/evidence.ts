import { createHash } from "node:crypto";
import type { DeepReadonly, EvidencePacket, EvidencePacketInput } from "./types.js";

export class ResearchValidationError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(issues.join("; "));
    this.name = "ResearchValidationError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
}

export function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 100_000;
}

export function isEnumValue<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

export function onlyKeys(value: Record<string, unknown>, allowed: string[], path: string, issues: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.push(`${path}.${key}: unknown field`);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  throw new ResearchValidationError(["Evidence must contain only finite JSON values"]);
}

export function freezeSnapshot<T>(value: T): DeepReadonly<T> {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (typeof item !== "object" || item === null || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy);
  return copy as DeepReadonly<T>;
}

export function checkEvidenceIds(value: unknown, allowed: ReadonlySet<string>, path: string, issues: string[], required = true): void {
  if (!Array.isArray(value) || value.some(id => typeof id !== "string")) {
    issues.push(`${path}: expected evidence ID array`);
    return;
  }
  if (required && value.length === 0) issues.push(`${path}: evidence required`);
  if (new Set(value).size !== value.length) issues.push(`${path}: duplicate evidence ID`);
  for (const id of value) if (!allowed.has(id)) issues.push(`${path}: unknown evidence ID ${String(id)}`);
}

export function createEvidencePacket(input: unknown): EvidencePacket {
  const issues: string[] = [];
  try { input = structuredClone(input); }
  catch { throw new ResearchValidationError(["packet: expected cloneable data"]); }
  if (!isRecord(input)) throw new ResearchValidationError(["packet: expected object"]);
  onlyKeys(input, ["schemaVersion", "packetId", "revision", "question", "proposal", "createdAt", "requiredCriteria", "evidence", "checks"], "packet", issues);
  if (input.schemaVersion !== 1) issues.push("packet.schemaVersion: expected 1");
  if (!isId(input.packetId)) issues.push("packet.packetId: invalid ID");
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 1) issues.push("packet.revision: expected positive integer");
  for (const key of ["question", "proposal"]) if (!isText(input[key])) issues.push(`packet.${key}: nonempty text required`);
  if (typeof input.createdAt !== "string" || !/^\d{4}-\d\d-\d\dT/.test(input.createdAt) || !Number.isFinite(Date.parse(input.createdAt))) issues.push("packet.createdAt: ISO timestamp required");
  if (!Array.isArray(input.requiredCriteria) || !input.requiredCriteria.length || input.requiredCriteria.some(id => !isId(id)) || new Set(input.requiredCriteria).size !== input.requiredCriteria.length) issues.push("packet.requiredCriteria: nonempty unique criterion IDs required");
  const ids = new Set<string>();
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) issues.push("packet.evidence: nonempty array required");
  else for (const [index, item] of input.evidence.entries()) {
    const path = `packet.evidence[${index}]`;
    if (!isRecord(item)) { issues.push(`${path}: expected object`); continue; }
    onlyKeys(item, ["id", "kind", "locator", "version", "summary", "sha256"], path, issues);
    if (!isId(item.id)) issues.push(`${path}.id: invalid ID`);
    else if (ids.has(item.id)) issues.push(`${path}.id: duplicate ID`);
    else ids.add(item.id);
    if (!isEnumValue(item.kind, ["source", "artifact"])) issues.push(`${path}.kind: expected source or artifact`);
    for (const key of ["locator", "version", "summary"]) if (!isText(item[key])) issues.push(`${path}.${key}: nonempty text required`);
    if (item.sha256 !== undefined && (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256))) issues.push(`${path}.sha256: lowercase SHA-256 required`);
  }
  const checkIds = new Set<string>();
  if (!Array.isArray(input.checks)) issues.push("packet.checks: array required");
  else for (const [index, check] of input.checks.entries()) {
    const path = `packet.checks[${index}]`;
    if (!isRecord(check)) { issues.push(`${path}: expected object`); continue; }
    onlyKeys(check, ["id", "status", "evidenceIds"], path, issues);
    if (!isId(check.id) || checkIds.has(check.id)) issues.push(`${path}.id: unique ID required`);
    else checkIds.add(check.id);
    if (!isEnumValue(check.status, ["passed", "failed", "unknown"])) issues.push(`${path}.status: invalid status`);
    checkEvidenceIds(check.evidenceIds, ids, `${path}.evidenceIds`, issues, check.status !== "unknown");
  }
  if (issues.length) throw new ResearchValidationError(issues);
  const digest = createHash("sha256").update(canonicalJson(input)).digest("hex");
  return freezeSnapshot({ ...(input as unknown as EvidencePacketInput), digest });
}

export function verifyEvidencePacket(packet: EvidencePacket): EvidencePacket {
  const { digest, ...input } = packet;
  const verified = createEvidencePacket(input);
  if (digest !== verified.digest) throw new ResearchValidationError(["packet.digest: does not match content"]);
  return verified;
}

export function validateRevision(previous: EvidencePacket, next: EvidencePacket): void {
  const issues: string[] = [];
  if (next.packetId !== previous.packetId || next.question !== previous.question) issues.push("revision: packet identity and research question must remain fixed");
  if (next.revision !== previous.revision + 1) issues.push("revision: must increment by one");
  if (canonicalJson(next.requiredCriteria) !== canonicalJson(previous.requiredCriteria)) issues.push("revision: required criteria cannot change within a council");
  for (const old of previous.evidence) {
    const item = next.evidence.find(candidate => candidate.id === old.id);
    if (!item || canonicalJson(item) !== canonicalJson(old)) issues.push(`revision: preserve evidence ${old.id}; use a new ID for new evidence`);
  }
  if (canonicalJson(next.checks) !== canonicalJson(previous.checks)) issues.push("revision: independent checks cannot be rewritten by the revision callback; start a new council after authoritative revalidation");
  if (issues.length) throw new ResearchValidationError(issues);
}
