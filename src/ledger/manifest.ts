import type { ExperimentManifest } from "./types.js";
import { decimalMoney, digestValue, enumValue, fail, integer, jsonObject, keys, text } from "./validation.js";

/** The manifest binds versions; these checks establish structure, not scientific adequacy. */
export function validateManifest(value: ExperimentManifest): void {
  keys(value, ["schemaVersion", "code", "environment", "adapter", "data", "model", "reward", "evaluator", "seeds", "resources", "evaluationPolicy"]);
  if (value.schemaVersion !== 1) fail("invalid", "Unsupported manifest schema");
  keys(value.code, ["revision", "dirtyPatchSha256"]); text(value.code.revision);
  if (value.code.dirtyPatchSha256 !== null) digestValue(value.code.dirtyPatchSha256);
  keys(value.environment, ["imageDigest", "dependenciesDigest"]);
  if (typeof value.environment.imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.environment.imageDigest)) fail("invalid", "Image digest must use sha256:<64 lowercase hex characters>");
  digestValue(value.environment.dependenciesDigest);
  keys(value.adapter, ["kind", "name", "config"]);
  enumValue(value.adapter.kind, ["conventional_rl", "llm_posttraining"]); text(value.adapter.name); jsonObject(value.adapter.config);
  keys(value.data, ["version", "splitsDigest"]); text(value.data.version); digestValue(value.data.splitsDigest);
  for (const item of [value.model, value.reward, value.evaluator]) { keys(item, ["version"]); text(item.version); }
  if (!Array.isArray(value.seeds) || !value.seeds.length) fail("invalid", "At least one explicit seed is required");
  for (const seed of value.seeds) integer(seed);
  if (new Set(value.seeds).size !== value.seeds.length) fail("invalid", "Duplicate seeds");
  keys(value.resources, ["maxDurationSeconds", "maxCostMicrodollars"]);
  integer(value.resources.maxDurationSeconds, 1);
  if (value.resources.maxDurationSeconds > 31_536_000) fail("invalid", "Duration exceeds one year");
  decimalMoney(value.resources.maxCostMicrodollars); jsonObject(value.evaluationPolicy);
}
