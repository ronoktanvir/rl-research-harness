import { isEnumValue, isRecord, onlyKeys, ResearchValidationError } from "./evidence.js";

export type TaskKind = "measure" | "extract" | "implement" | "diagnose" | "design" | "synthesize" | "assess-claim";
export type TaskTier = "deterministic" | "economy" | "capable" | "strong";

export interface RoutingInput {
  kind: TaskKind;
  consequence: "low" | "moderate" | "high";
  ambiguity: "low" | "high";
  verifierAvailable: boolean;
  contradictoryEvidence: boolean;
  repeatedFailures: number;
}

export interface RoutingDecision {
  schemaVersion: 1;
  executor: TaskTier;
  council: boolean;
  reasons: string[];
  /** Provider/model mapping remains a deployment policy evaluated on local tasks. */
  model: null;
}

export function routeResearchTask(input: unknown): RoutingDecision {
  const issues: string[] = [];
  try { input = structuredClone(input); }
  catch { throw new ResearchValidationError(["routing: expected cloneable data"]); }
  if (!isRecord(input)) throw new ResearchValidationError(["routing: expected object"]);
  onlyKeys(input, ["kind", "consequence", "ambiguity", "verifierAvailable", "contradictoryEvidence", "repeatedFailures"], "routing", issues);
  if (!isEnumValue(input.kind, ["measure", "extract", "implement", "diagnose", "design", "synthesize", "assess-claim"])) issues.push("routing.kind: unsupported task kind");
  if (!isEnumValue(input.consequence, ["low", "moderate", "high"])) issues.push("routing.consequence: unsupported level");
  if (!isEnumValue(input.ambiguity, ["low", "high"])) issues.push("routing.ambiguity: unsupported level");
  for (const key of ["verifierAvailable", "contradictoryEvidence"]) if (typeof input[key] !== "boolean") issues.push(`routing.${key}: boolean required`);
  if (!Number.isSafeInteger(input.repeatedFailures) || (input.repeatedFailures as number) < 0) issues.push("routing.repeatedFailures: nonnegative integer required");
  if (issues.length) throw new ResearchValidationError(issues);
  const task = input as unknown as RoutingInput;
  if (task.kind === "measure") return { schemaVersion: 1, executor: "deterministic", council: false, reasons: ["Counters, hashes, aggregation and admission checks belong to deterministic code; interpretation is a separate task."], model: null };
  const reasons: string[] = [];
  const scientificJudgment = ["design", "synthesize", "assess-claim"].includes(task.kind);
  if (scientificJudgment) reasons.push("The task requires scientific synthesis or methodological judgment.");
  if (task.contradictoryEvidence) reasons.push("Contradictory evidence requires explicit resolution.");
  if (task.repeatedFailures >= 2) reasons.push("Repeated failure requires a different diagnostic approach.");
  if (task.consequence === "high") reasons.push("The decision has high consequences.");
  if (task.ambiguity === "high") reasons.push("High ambiguity requires stronger interpretation.");
  const strong = scientificJudgment || task.contradictoryEvidence || task.repeatedFailures >= 2 || task.consequence === "high" || task.ambiguity === "high";
  const council = task.consequence === "high" && (scientificJudgment || task.contradictoryEvidence || task.ambiguity === "high");
  if (strong) return { schemaVersion: 1, executor: "strong", council, reasons, model: null };
  if (task.kind === "extract" && task.verifierAvailable && task.consequence === "low") return { schemaVersion: 1, executor: "economy", council: false, reasons: ["Bounded extraction has a verifier and low consequences."], model: null };
  return { schemaVersion: 1, executor: "capable", council: false, reasons: ["Implementation, diagnosis, or unverified extraction needs a capable worker."], model: null };
}
