import { freezeSnapshot, isId, isText, ResearchValidationError, createEvidencePacket, validateRevision, verifyEvidencePacket } from "./evidence.js";
import { validateReview } from "./validation.js";
import type { CouncilOptions, CouncilResult, CouncilRound, EvidencePacket, ObjectionState, ReviewOutcome } from "./types.js";

class CallbackTimeout extends Error {}

async function boundedCallback(callback: (signal: AbortSignal) => Promise<unknown>, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error("Council callback deadline exceeded"));
      reject(new CallbackTimeout("Council callback deadline exceeded"));
    }, timeoutMs);
  });
  try { return await Promise.race([Promise.resolve().then(() => callback(controller.signal)), timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

function recordObjections(round: CouncilRound, states: Map<string, ObjectionState>): void {
  for (const outcome of round.reviews) {
    if (outcome.status !== "valid" || !outcome.review) continue;
    for (const objection of outcome.review.objections) {
      const key = `${outcome.reviewerId}/${objection.id}`;
      const previous = states.get(key);
      states.set(key, {
        ...structuredClone(objection), key, reviewerId: outcome.reviewerId,
        firstRound: previous?.firstRound ?? round.round, lastRound: round.round, status: "open",
      });
    }
    for (const resolution of outcome.review.resolutions) {
      const existing = states.get(resolution.objectionKey);
      if (!existing) throw new Error("Validated objection resolution lost its target");
      existing.status = resolution.disposition === "unresolved" ? "open" : resolution.disposition;
      existing.lastRound = round.round;
      existing.resolution = structuredClone(resolution);
    }
  }
}

function assessment(round: CouncilRound, objections: ObjectionState[]): Pick<CouncilResult, "status" | "blockers" | "dissent"> {
  const blockers: string[] = [];
  const dissent: string[] = [];
  let needsRevision = false;
  for (const check of round.packet.checks) if (check.status !== "passed") blockers.push(`Independent check ${check.id} is ${check.status}`);
  for (const outcome of round.reviews) {
    if (outcome.status !== "valid" || !outcome.review) {
      blockers.push(`Reviewer ${outcome.reviewerId}: ${outcome.status}`);
      continue;
    }
    const review = outcome.review;
    if (review.recommendation !== "approve") {
      needsRevision = true;
      dissent.push(`${outcome.reviewerId}: ${review.recommendation} — ${review.rationale.text}`);
      if (review.recommendation === "reject" || review.recommendation === "abstain") blockers.push(`Reviewer ${outcome.reviewerId}: ${review.recommendation}`);
    }
    for (const criterion of review.criteria) if (criterion.status !== "satisfied") {
      needsRevision = true;
      dissent.push(`${outcome.reviewerId}/${criterion.criterionId}: ${criterion.status} — ${criterion.summary}`);
    }
  }
  for (const objection of objections) if (objection.status === "open") {
    dissent.push(`${objection.key}: ${objection.text} Required action: ${objection.requiredAction}`);
    if (objection.severity === "blocking" || (objection.category === "validity" && objection.severity === "material")) blockers.push(`Unresolved ${objection.category} objection ${objection.key}`);
  }
  return { status: blockers.length ? "blocked" : needsRevision ? "revise" : "approved", blockers, dissent };
}

/** All model calls are injected. This controller never fetches sources or executes experiments. */
export async function runCouncil(options: CouncilOptions): Promise<CouncilResult> {
  const maxRevisions = options.maxRevisions ?? 2;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const issues: string[] = [];
  if (!isId(options.councilId)) issues.push("councilId: invalid ID");
  if (!Number.isSafeInteger(maxRevisions) || maxRevisions < 0 || maxRevisions > 5) issues.push("maxRevisions: expected integer from zero to five");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) issues.push("timeoutMs: expected integer from 1 to 3600000");
  if (!Array.isArray(options.reviewers) || options.reviewers.length === 0 || options.reviewers.length > 12) issues.push("reviewers: expected one to twelve reviewers");
  else {
    const ids = new Set<string>();
    for (const reviewer of options.reviewers) {
      if (!reviewer || !isId(reviewer.id) || !isText(reviewer.role) || ids.has(reviewer.id)) issues.push("reviewers: unique valid IDs and nonempty roles required");
      else ids.add(reviewer.id);
    }
  }
  if (typeof options.review !== "function") issues.push("review: callback required");
  if (issues.length) throw new ResearchValidationError(issues);
  let packet: EvidencePacket = verifyEvidencePacket(options.packet);
  const reviewers = freezeSnapshot(options.reviewers);
  const rounds: CouncilRound[] = [];
  const objectionStates = new Map<string, ObjectionState>();
  const result: CouncilResult = {
    schemaVersion: 1, councilId: options.councilId, createdAt: (options.now?.() ?? new Date()).toISOString(),
    status: "blocked", stopReason: "revision_limit", maxRevisions, rounds, objections: [], blockers: [], dissent: [],
    limitations: [
      "Approval means this review protocol completed; it is not proof of scientific validity or publication quality.",
      "Citation validation checks IDs and structure, not source truth or semantic support.",
      "Independent rounds prevent this controller from sharing concurrent reviews; they do not make model errors statistically independent.",
      "Callbacks must honor AbortSignal; a timeout does not confirm external work or billing stopped.",
    ],
  };
  for (let round = 0; round <= maxRevisions; round++) {
    const previousRounds = freezeSnapshot(rounds);
    const priorObjections = freezeSnapshot([...objectionStates.values()]);
    // Every request is constructed from the same frozen pre-round state. No output is
    // added to rounds until all reviewers have settled, including missing/error cases.
    const outcomes: ReviewOutcome[] = await Promise.all(reviewers.map(async reviewer => {
      try {
        const raw = await boundedCallback(signal => options.review({ reviewer, round, packet, previousRounds, objections: priorObjections, signal }), timeoutMs);
        return validateReview(raw, { reviewerId: reviewer.id, packet, round, objections: priorObjections });
      } catch (error) {
        return { reviewerId: reviewer.id, status: error instanceof CallbackTimeout ? "timeout" : "error", issues: [error instanceof Error ? error.message : "Reviewer callback failed"] } satisfies ReviewOutcome;
      }
    }));
    const completed: CouncilRound = { round, packet, reviews: outcomes };
    rounds.push(completed);
    recordObjections(completed, objectionStates);
    result.objections = [...objectionStates.values()].map(item => structuredClone(item));
    Object.assign(result, assessment(completed, result.objections));
    if (result.status === "approved") { result.stopReason = "approved"; break; }
    if (round === maxRevisions) { result.stopReason = "revision_limit"; break; }
    if (!options.revise) { result.stopReason = "revision_unavailable"; break; }
    try {
      const revise = options.revise;
      const input = await boundedCallback(signal => revise({ packet, completedRounds: freezeSnapshot(rounds), objections: freezeSnapshot(result.objections), blockers: Object.freeze([...result.blockers]), signal }), timeoutMs);
      const next = createEvidencePacket(input);
      validateRevision(packet, next);
      packet = next;
    } catch (error) {
      result.status = "blocked";
      result.stopReason = error instanceof CallbackTimeout ? "revision_timeout" : "revision_error";
      result.blockers.push(error instanceof Error ? error.message : "Revision callback failed");
      break;
    }
  }
  return result;
}
