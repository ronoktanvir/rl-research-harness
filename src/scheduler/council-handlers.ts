import { createHash } from "node:crypto";
import type { ExperimentLedger, JsonObject } from "../ledger/types.ts";
import { encode, enumValue, hash, id, integer, keys, snapshot, text } from "../ledger/validation.ts";
import { validateReview } from "../research/validation.ts";
import { reviewPrompt, revisionPrompt } from "../workers/council.ts";
import { runCliReview } from "../workers/cli.ts";
import type { CliBackend, CliTask, CliTaskResult } from "../workers/cli.ts";
import { reviewJsonSchema, revisionJsonSchema } from "../workers/output-schema.ts";
import type { HandlerOutcome, ResearchTaskHandler } from "./handlers.ts";
import type { HandlerPolicy, TaskClaim } from "./types.ts";
import { loadCouncilPlan, loadCouncilStage } from "./council-contracts.ts";
import type { CouncilPlan, CouncilStage } from "./council-contracts.ts";
export * from "./council-contracts.ts";

export interface CouncilTaskHandlerOptions {
  ledger: Pick<ExperimentLedger, "getObservation">;
  /** Explicit operator project allowlist; queued input cannot extend it. */
  projects: string[];
  review?: (task: CliTask) => Promise<CliTaskResult>;
  now?: () => Date;
}
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_PROMPT_BYTES = 512_000;
const CLIENT_STATUSES = ["succeeded", "rate_limited", "auth_required", "failed", "cancelled", "timed_out"] as const;

function clientReceipt(raw: unknown, backend: CliBackend): CliTaskResult | null {
  try {
    const value = snapshot(raw);
    keys(value, ["backend", "status", "text", "billing", "sessionId", "usage", "diagnostic"], ["backend", "status", "text", "billing"]);
    enumValue(value.status, CLIENT_STATUSES);
    if (value.backend !== backend || typeof value.text !== "string" || value.billing !== "client_managed_account") return null;
    for (const name of ["sessionId", "diagnostic"]) if (value[name] !== undefined && (typeof value[name] !== "string" || value[name].length > 4096)) return null;
    if (value.usage !== undefined) {
      keys(value.usage, ["input_tokens", "output_tokens", "cached_input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"], []);
      for (const count of Object.values(value.usage)) integer(count);
    }
    return value as unknown as CliTaskResult;
  } catch { return null; }
}
function prompt(stage: CouncilStage, signal: AbortSignal): string {
  return stage.operation === "review" ? reviewPrompt({ ...stage.request, signal }) : revisionPrompt({ ...stage.request, signal });
}
function boundEvidence(stage: CouncilStage): JsonObject {
  return { backend: stage.backend, modelSelector: stage.model, planDigest: stage.planDigest, stageDigest: stage.stageDigest,
    packetDigest: stage.request.packet.digest, operation: stage.operation, round: stage.round,
    stageObservationId: stage.stageObservationId,
    meaning: "An assessment of archived evidence; completion does not establish scientific validity or authorize experiments." };
}

/** One handler execution means at most one official-client invocation. Explicitly
 * resumed quota/auth attempts consume another allowance; completed/uncertain calls
 * are not automatically replayed. Queue recovery, holds and ledger authority remain
 * the runner's responsibility. */
export function createCouncilTaskHandlers(options: CouncilTaskHandlerOptions): ResearchTaskHandler[] {
  const configured = snapshot(options.projects);
  if (!Array.isArray(configured) || !configured.length) throw new Error("Council handlers require configured projects");
  for (const project of configured) id(project);
  if (new Set(configured).size !== configured.length) throw new Error("Duplicate configured project");
  const projects = new Set(configured), ledger = options.ledger, review = options.review ?? runCliReview, now = options.now ?? (() => new Date());

  function stageInput(raw: unknown, projectId: string, operation: CouncilStage["operation"], backend: CliBackend): { stage: CouncilStage; plan: CouncilPlan; prompt: string } {
    const input = snapshot(raw); keys(input, ["stageObservationId"]); id(input.stageObservationId);
    if (!projects.has(projectId)) throw new Error("Project has no trusted council handler configuration");
    const stage = loadCouncilStage(ledger, input.stageObservationId), plan = loadCouncilPlan(ledger, stage.planObservationId);
    if (stage.projectId !== projectId || stage.backend !== backend || stage.operation !== operation) throw new Error("Council stage does not belong to this project or handler");
    if (operation === "revision" && stage.operation === "revision" && stage.request.completedRounds.some(round => round.reviews.some(item => item.status !== "valid"))) throw new Error("Cannot revise from incomplete or invalid reviewer outcomes");
    const generated = prompt(stage, new AbortController().signal);
    if (Buffer.byteLength(generated) > MAX_PROMPT_BYTES) throw new Error("Council stage prompt exceeds 512,000 bytes");
    return { stage, plan, prompt: generated };
  }

  return (["review", "revision"] as const).flatMap(operation => (["codex", "claude"] as const).map(backend => {
    const policy: HandlerPolicy = Object.freeze({ kind: `council-${operation === "review" ? "review" : "revise"}-${backend}`,
      version: "1", callUnits: 1, resourceKey: `${backend}:default`, replay: "never" });
    return Object.freeze({ policy,
      validate(input: unknown, projectId: string): void { stageInput(input, projectId, operation, backend); },
      async execute(raw: TaskClaim, signal: AbortSignal): Promise<HandlerOutcome> {
        let stage: CouncilStage, generated: string, deadline: number, notBefore: number;
        try {
          const claim = snapshot(raw), loaded = stageInput(claim.task.input, claim.task.projectId, operation, backend);
          stage = loaded.stage; generated = loaded.prompt;
          if (claim.task.kind !== policy.kind || claim.task.handlerVersion !== policy.version || encode(claim.task.handler) !== encode(policy)
            || claim.task.taskId !== `council-task:${hash(stage.stageObservationId)}` || claim.task.inputDigest !== hash(claim.task.input)
            || claim.task.deadlineAt !== loaded.plan.request.deadlineAt || claim.task.notBefore !== loaded.plan.request.notBefore) throw new Error("Queued council task differs from archived stage policy");
          deadline = Date.parse(loaded.plan.request.deadlineAt);
          notBefore = Date.parse(loaded.plan.request.notBefore);
        } catch (error) {
          return { status: "rejected", result: { reason: "invalid_council_task_contract", detail: error instanceof Error ? error.message.slice(0, 4096) : "Invalid council stage" } };
        }
        const binding = boundEvidence(stage);
        if (signal.aborted) return { status: "cancelled", result: { ...binding, reason: "cancelled_before_handler_invocation", invocationStarted: false } };
        const current = now().getTime();
        if (!Number.isFinite(current) || current >= deadline) return { status: "rejected", result: { ...binding, reason: "council_deadline_elapsed", invocationStarted: false } };
        if (current < notBefore) return { status: "rejected", result: { ...binding, reason: "council_not_yet_eligible", invocationStarted: false } };
        let client: CliTaskResult | null;
        try {
          client = clientReceipt(await review({ backend, prompt: generated, signal,
            timeoutMs: Math.max(1, Math.min(120_000, Math.floor(deadline - current))),
            ...(stage.model === null ? {} : { model: stage.model }),
            outputSchema: stage.operation === "review" ? reviewJsonSchema({ reviewerId: stage.request.reviewer.id,
              packetDigest: stage.request.packet.digest, round: stage.round }) : revisionJsonSchema() }), backend);
        } catch { return { status: "uncertain", result: { ...binding, reason: "client_invocation_threw", invocationStarted: true } }; }
        if (!client) return { status: "uncertain", result: { ...binding, reason: "invalid_client_result_contract", invocationStarted: true } };
        const { text: reply, ...metadata } = client;
        const evidence: JsonObject = { ...binding, client: metadata as unknown as JsonObject,
          response: { sha256: createHash("sha256").update(reply).digest("hex"), bytes: Buffer.byteLength(reply) } };
        if (client.status === "rate_limited") return { status: "waiting_quota", retryAt: null, result: { ...evidence, reason: "client_reported_quota_without_reset_time" } };
        if (client.status === "auth_required") return { status: "waiting_auth", retryAt: null, result: { ...evidence, reason: "client_requires_authentication" } };
        if (client.status === "timed_out" || client.status === "cancelled") return { status: "uncertain", result: { ...evidence, reason: "invocation_interrupted", invocationStarted: true } };
        if (client.status === "failed") {
          const knownNotInvoked = ["spawn_error", "auth_check_spawn_error", "auth_check_output_limit"].includes(client.diagnostic ?? "");
          return { status: knownNotInvoked ? "failed" : "uncertain", result: { ...evidence, reason: knownNotInvoked ? "client_preflight_failed" : "client_completion_ambiguous" } };
        }
        if (Buffer.byteLength(reply) > MAX_RESPONSE_BYTES) return { status: "failed", result: { ...evidence, reason: "council_response_too_large" } };
        if (stage.operation === "review") {
          const validated = validateReview(reply, { reviewerId: stage.request.reviewer.id, packet: stage.request.packet,
            round: stage.round, objections: stage.request.objections });
          const stored = validated.status === "valid" ? validated : { ...validated, issues: validated.issues.slice(0, 64).map(issue => issue.slice(0, 2048)) };
          return { status: validated.status === "valid" ? "completed" : "failed", result: { ...evidence,
            reviewOutcome: stored as unknown as JsonObject, validationIssueCount: validated.issues.length,
            reason: validated.status === "valid" ? "structured_review_completed" : "review_missing_or_malformed" } };
        }
        try {
          const parsed: unknown = JSON.parse(reply); keys(parsed, ["proposal"]); text(parsed.proposal);
          return { status: "completed", result: { ...evidence, proposal: parsed.proposal, reason: "proposal_revision_completed" } };
        } catch { return { status: "failed", result: { ...evidence, reason: "revision_missing_or_malformed" } }; }
      },
    });
  }));
}
