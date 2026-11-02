import { hash, keys } from "../../ledger/validation.ts";
import { freezeSnapshot } from "../../research/evidence.ts";

export const CONVENTIONAL_PINS = Object.freeze({ pythonMinor: "3.11", gymnasium: "1.4.0", numpy: "2.3.5" });
export const CONVENTIONAL_INPUT_BYTES = 131_072;
export const CONVENTIONAL_OUTPUT_BYTES = 4 * 1024 * 1024;
export const FROZEN_LAKE_MAP = ["SFFF", "FHFH", "FFFH", "HFFG"] as const;

export interface ConventionalSpec {
  schemaVersion: 1; kind: "frozenlake-q-learning"; requestId: string;
  environment: { id: "FrozenLake-v1"; mapName: "4x4"; isSlippery: boolean; maxEpisodeSteps: number };
  algorithm: { name: "tabular-q-learning"; learningRate: number; discount: number; epsilonStart: number; epsilonEnd: number };
  replicates: { replicateId: string; policySeed: number; trainingEpisodeSeeds: number[] }[];
  evaluation: { episodeSeeds: number[]; randomActionSeeds: number[] };
  limits: { maxTransitions: number; maxEpisodeTransitions: number };
}
export interface ConventionalRequest extends ConventionalSpec { requestDigest: string }
export interface Episode {
  episodeIndex: number; resetSeed: number; actionSeed: number | null; return: number; steps: number; finalState: number;
  terminated: boolean; truncated: boolean; harnessCutoff: boolean; success: boolean;
}
export interface EpisodeSummary {
  episodes: number; successes: number; successRate: number; meanReturn: number; totalTransitions: number;
  terminated: number; truncated: number; harnessCutoffs: number;
}
export interface EpisodeBatch { episodes: Episode[]; summary: EpisodeSummary }
export interface ConventionalResult {
  schemaVersion: 1; kind: "frozenlake-q-learning-result"; requestId: string; requestDigest: string;
  environment: ConventionalSpec["environment"] & { map: string[]; rewardSchedule: number[]; slipSuccessRate: number };
  algorithm: ConventionalSpec["algorithm"] & {
    epsilonSchedule: string; policyRng: string; trainingActionStream: string; randomBaselineActionStream: string;
    trainingTieBreak: string; evaluationTieBreak: string; bootstrapMask: string; evaluationUpdates: false;
  };
  versions: { python: string; gymnasium: string; numpy: string };
  randomBaseline: EpisodeBatch;
  replicates: { replicateId: string; policySeed: number; training: EpisodeBatch; qTable: number[][];
    greedyActions: number[]; evaluation: EpisodeBatch & { baseline: "shared-random-policy" } }[];
  totalTransitions: number; resumeSupported: false;
}

function invalid(reason: string): never { throw new Error(`Invalid conventional RL protocol: ${reason}`); }
function same(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) invalid(label);
}
function number(value: unknown, minimum: number, maximum: number): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) invalid("number outside allowed range");
}
function integer(value: unknown, minimum: number, maximum: number): asserts value is number {
  number(value, minimum, maximum); if (!Number.isSafeInteger(value)) invalid("expected an integer");
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) invalid("invalid identity");
}
function array(value: unknown, minimum: number, maximum: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalid("array size outside bound");
}
function seeds(value: unknown, maximum: number): asserts value is number[] {
  array(value, 1, maximum); for (const seed of value) integer(seed, 0, 0xffff_ffff);
  if (new Set(value).size !== value.length) invalid("duplicate seeds");
}

/** Copy inert JSON without invoking accessors or a toJSON hook from in-process callers. */
function inert(value: unknown, remaining: { nodes: number }, depth = 0): unknown {
  if (--remaining.nodes < 0 || depth > 16) invalid("input complexity bound exceeded");
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (!value || typeof value !== "object") invalid("expected JSON data");
  const isArray = Array.isArray(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || (!isArray && Object.getPrototypeOf(value) !== Object.prototype)) invalid("expected plain JSON data");
  const output: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(descriptors)) {
    if (isArray && key === "length") continue;
    if (!Object.hasOwn(field, "value") || !field.enumerable) invalid("accessor or hidden JSON field");
    Object.defineProperty(output, key, { value: inert(field.value, remaining, depth + 1), enumerable: true });
  }
  if (!isArray) return output;
  if (Object.keys(output).length !== value.length || Object.keys(output).some((key, index) => key !== String(index))) invalid("sparse or decorated array");
  return Object.values(output);
}

/** Operator request only selects a fixed environment and algorithm, never executable code. */
export function prepareConventionalRequest(raw: unknown): ConventionalRequest {
  const spec = inert(raw, { nodes: 30_000 });
  keys(spec, ["schemaVersion", "kind", "requestId", "environment", "algorithm", "replicates", "evaluation", "limits"]);
  if (spec.schemaVersion !== 1 || spec.kind !== "frozenlake-q-learning") invalid("unsupported experiment");
  identifier(spec.requestId);
  const env = spec.environment, algorithm = spec.algorithm, limits = spec.limits, evaluation = spec.evaluation;
  keys(env, ["id", "mapName", "isSlippery", "maxEpisodeSteps"]);
  if (env.id !== "FrozenLake-v1" || env.mapName !== "4x4" || typeof env.isSlippery !== "boolean") invalid("unsupported environment");
  integer(env.maxEpisodeSteps, 1, 100);
  keys(algorithm, ["name", "learningRate", "discount", "epsilonStart", "epsilonEnd"]);
  if (algorithm.name !== "tabular-q-learning") invalid("unsupported algorithm");
  number(algorithm.learningRate, Number.MIN_VALUE, 1); number(algorithm.discount, 0, 1);
  number(algorithm.epsilonStart, 0, 1); number(algorithm.epsilonEnd, 0, algorithm.epsilonStart);
  keys(limits, ["maxTransitions", "maxEpisodeTransitions"]);
  integer(limits.maxTransitions, 1, 1_000_000); integer(limits.maxEpisodeTransitions, 1, 100);
  keys(evaluation, ["episodeSeeds", "randomActionSeeds"]);
  seeds(evaluation.episodeSeeds, 1000); seeds(evaluation.randomActionSeeds, 1000);
  if (evaluation.episodeSeeds.length !== evaluation.randomActionSeeds.length) invalid("evaluation seed schedules differ in length");
  const used = new Set<number>();
  const reserve = (values: number[]) => { for (const seed of values) { if (used.has(seed)) invalid("random stream seed sets overlap"); used.add(seed); } };
  reserve(evaluation.episodeSeeds); reserve(evaluation.randomActionSeeds);
  array(spec.replicates, 1, 8);
  const ids = new Set<string>();
  let episodes = (spec.replicates.length + 1) * evaluation.episodeSeeds.length;
  for (const replica of spec.replicates) {
    keys(replica, ["replicateId", "policySeed", "trainingEpisodeSeeds"]); identifier(replica.replicateId);
    if (ids.has(replica.replicateId)) invalid("duplicate replica identity"); ids.add(replica.replicateId);
    integer(replica.policySeed, 0, 0xffff_ffff); seeds(replica.trainingEpisodeSeeds, 2000);
    reserve([replica.policySeed, ...replica.trainingEpisodeSeeds]); episodes += replica.trainingEpisodeSeeds.length;
  }
  if (episodes > 12_000 || episodes * Math.min(env.maxEpisodeSteps, limits.maxEpisodeTransitions) > limits.maxTransitions) invalid("worst-case episode/transition allowance exceeded");
  const request = { ...spec, requestDigest: hash(spec) } as unknown as ConventionalRequest;
  if (Buffer.byteLength(JSON.stringify(request)) > CONVENTIONAL_INPUT_BYTES) invalid("request byte bound exceeded");
  return request;
}

export function summarizeEpisodes(episodes: Episode[]): EpisodeSummary {
  const count = (key: "success" | "terminated" | "truncated" | "harnessCutoff") => episodes.filter(item => item[key]).length;
  return { episodes: episodes.length, successes: count("success"), successRate: count("success") / episodes.length,
    meanReturn: episodes.reduce((sum, item) => sum + item.return, 0) / episodes.length,
    totalTransitions: episodes.reduce((sum, item) => sum + item.steps, 0), terminated: count("terminated"),
    truncated: count("truncated"), harnessCutoffs: count("harnessCutoff") };
}

function verifyBatch(raw: unknown, request: ConventionalRequest, resetSeeds: number[], actionSeeds: (number | null)[], evaluated = false): EpisodeBatch {
  keys(raw, evaluated ? ["episodes", "summary", "baseline"] : ["episodes", "summary"]);
  if (evaluated && raw.baseline !== "shared-random-policy") invalid("baseline identity changed");
  array(raw.episodes, resetSeeds.length, resetSeeds.length);
  const horizon = request.environment.maxEpisodeSteps, cap = request.limits.maxEpisodeTransitions;
  for (const [index, item] of raw.episodes.entries()) {
    keys(item, ["episodeIndex", "resetSeed", "actionSeed", "return", "steps", "finalState", "terminated", "truncated", "harnessCutoff", "success"]);
    if (item.episodeIndex !== index || item.resetSeed !== resetSeeds[index] || item.actionSeed !== actionSeeds[index]) invalid("episode seed/identity mismatch");
    integer(item.steps, 1, Math.min(horizon, cap)); integer(item.finalState, 0, 15);
    for (const name of ["terminated", "truncated", "harnessCutoff", "success"]) if (typeof item[name] !== "boolean") invalid("nonboolean episode flag");
    const terminal = [5, 7, 11, 12, 15].includes(item.finalState);
    if (item.terminated !== terminal || item.truncated !== (item.steps === horizon)
      || item.harnessCutoff !== (item.steps === cap && !item.terminated && !item.truncated)
      || !(item.terminated || item.truncated || item.harnessCutoff)
      || item.success !== (item.finalState === 15) || item.return !== (item.success ? 1 : 0)) invalid("episode reward/end semantics disagree");
  }
  const episodes = raw.episodes as unknown as Episode[], expected = summarizeEpisodes(episodes);
  keys(raw.summary, Object.keys(expected));
  for (const [key, value] of Object.entries(expected)) if (raw.summary[key] !== value) invalid(`summary ${key} disagrees with episode records`);
  return raw as unknown as EpisodeBatch;
}

/** Validate the fixed worker's complete observation. This is not proof of scientific validity. */
export function validateConventionalResult(input: unknown, boundRequest: ConventionalRequest): ConventionalResult {
  const { requestDigest, ...spec } = inert(boundRequest, { nodes: 30_000 }) as ConventionalRequest;
  const request = prepareConventionalRequest(spec);
  if (requestDigest !== request.requestDigest) invalid("request digest disagrees with specification");
  const raw = inert(input, { nodes: 250_000 });
  if (Buffer.byteLength(JSON.stringify(raw)) > CONVENTIONAL_OUTPUT_BYTES) invalid("result byte bound exceeded");
  keys(raw, ["schemaVersion", "kind", "requestId", "requestDigest", "environment", "algorithm", "versions", "randomBaseline", "replicates", "totalTransitions", "resumeSupported"]);
  if (raw.schemaVersion !== 1 || raw.kind !== "frozenlake-q-learning-result" || raw.requestId !== request.requestId
    || raw.requestDigest !== request.requestDigest || raw.resumeSupported !== false) invalid("result identity or capability mismatch");
  const expectedEnv = { ...request.environment, map: [...FROZEN_LAKE_MAP], rewardSchedule: [1, 0, 0], slipSuccessRate: 1 / 3 };
  keys(raw.environment, Object.keys(expectedEnv));
  for (const [key, value] of Object.entries(expectedEnv)) same(raw.environment[key], value, `environment ${key} changed`);
  const expectedAlgorithm = { ...request.algorithm, epsilonSchedule: "linear_per_episode_start_to_end_single_episode_uses_start",
    policyRng: "python.random.Random/MT19937", trainingActionStream: "replicate_continuous", randomBaselineActionStream: "per_episode",
    trainingTieBreak: "seeded_uniform_argmax", evaluationTieBreak: "lowest_action_index", bootstrapMask: "not_terminated", evaluationUpdates: false };
  keys(raw.algorithm, Object.keys(expectedAlgorithm));
  for (const [key, value] of Object.entries(expectedAlgorithm)) same(raw.algorithm[key], value, `algorithm ${key} changed`);
  keys(raw.versions, ["python", "gymnasium", "numpy"]);
  if (typeof raw.versions.python !== "string" || !/^3\.11\.\d+$/.test(raw.versions.python)
    || raw.versions.gymnasium !== CONVENTIONAL_PINS.gymnasium || raw.versions.numpy !== CONVENTIONAL_PINS.numpy) invalid("unqualified runtime version");
  const baseline = verifyBatch(raw.randomBaseline, request, request.evaluation.episodeSeeds, request.evaluation.randomActionSeeds);
  array(raw.replicates, request.replicates.length, request.replicates.length);
  let transitions = baseline.summary.totalTransitions;
  for (const [index, replica] of raw.replicates.entries()) {
    keys(replica, ["replicateId", "policySeed", "training", "qTable", "greedyActions", "evaluation"]);
    const declared = request.replicates[index]!;
    if (replica.replicateId !== declared.replicateId || replica.policySeed !== declared.policySeed) invalid("replica identity changed");
    const training = verifyBatch(replica.training, request, declared.trainingEpisodeSeeds, declared.trainingEpisodeSeeds.map(() => declared.policySeed));
    const evaluation = verifyBatch(replica.evaluation, request, request.evaluation.episodeSeeds, request.evaluation.episodeSeeds.map(() => null), true);
    array(replica.qTable, 16, 16); array(replica.greedyActions, 16, 16);
    for (const [state, row] of replica.qTable.entries()) {
      array(row, 4, 4); for (const value of row) number(value, 0, 1);
      const values = row as number[];
      if (replica.greedyActions[state] !== values.indexOf(Math.max(...values))) invalid("greedy policy differs from frozen table");
      if ([5, 7, 11, 12, 15].includes(state) && values.some(value => value !== 0)) invalid("terminal-state action values changed");
    }
    transitions += training.summary.totalTransitions + evaluation.summary.totalTransitions;
  }
  if (raw.totalTransitions !== transitions || transitions > request.limits.maxTransitions) invalid("transition total disagrees");
  return freezeSnapshot(raw) as unknown as ConventionalResult;
}
