import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createEvidencePacket, ResearchValidationError, routeResearchTask, runCouncil,
  validateReview, verifyEvidencePacket, writeDecisionArtifacts,
} from "../../src/research/index.js";
import type { EvidencePacket, EvidencePacketInput, ResearchReview, ReviewRequest } from "../../src/research/index.js";

function packetInput(): EvidencePacketInput {
  return {
    schemaVersion: 1, packetId: "reward-study", revision: 1,
    question: "Does the candidate reward improve held-out task success?",
    proposal: "Compare the baseline and candidate at fixed environment steps.",
    createdAt: "2026-11-02T02:00:00.000Z", requiredCriteria: ["independent-evaluation"],
    evidence: [{ id: "artifact:baseline", kind: "artifact", locator: "artifacts/baseline.json", version: "sha:123", summary: "Baseline and evaluator contract test results." }],
    checks: [{ id: "fixture-test", status: "passed", evidenceIds: ["artifact:baseline"] }],
  };
}

function approval(request: ReviewRequest): ResearchReview {
  return {
    schemaVersion: 1, reviewerId: request.reviewer.id, packetDigest: request.packet.digest,
    round: request.round, recommendation: "approve",
    observations: [{ text: "The evaluator contract fixture passes.", evidenceIds: ["artifact:baseline"] }],
    interpretations: [{ text: "The pilot is ready under the specified conditions.", evidenceIds: ["artifact:baseline"] }],
    criteria: [{ criterionId: "independent-evaluation", status: "satisfied", summary: "The registered evaluator is available.", evidenceIds: ["artifact:baseline"] }],
    objections: [], resolutions: [], rationale: { text: "Proceed with the bounded pilot.", evidenceIds: ["artifact:baseline"] },
  };
}

function nextRevision(packet: EvidencePacket): EvidencePacketInput {
  const { digest: _digest, ...input } = structuredClone(packet);
  return { ...input, revision: input.revision + 1, proposal: `${input.proposal} Refine the control.` } as EvidencePacketInput;
}

const reviewers = [{ id: "methods", role: "methods reviewer" }, { id: "domain", role: "domain reviewer" }];

test("evidence packet has stable content identity and no references to mutable caller objects", () => {
  const input = packetInput();
  const packet = createEvidencePacket(input);
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  assert.equal(createEvidencePacket(reordered).digest, packet.digest);
  input.evidence[0]!.summary = "Changed outside the packet";
  assert.notEqual(input.evidence[0]!.summary, packet.evidence[0]!.summary);
  assert.ok(Object.isFrozen(packet.evidence[0]));
  assert.throws(() => { (packet.evidence[0] as { summary: string }).summary = "tampered"; }, TypeError);
  assert.throws(() => verifyEvidencePacket({ ...packet, proposal: "forged content" }), /digest/);
  assert.throws(() => createEvidencePacket({ ...packetInput(), requiredCriteria: [] }), ResearchValidationError);
});

test("first-round assessments remain independent even after another reviewer finishes", async () => {
  let firstFinished = false;
  const result = await runCouncil({
    councilId: "independent", packet: createEvidencePacket(packetInput()), reviewers,
    review: async request => {
      assert.deepEqual(request.previousRounds, []);
      assert.deepEqual(request.objections, []);
      assert.ok(Object.isFrozen(request.packet));
      if (request.reviewer.id === "methods") firstFinished = true;
      else {
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.ok(firstFinished);
        assert.deepEqual(request.previousRounds, []);
      }
      return approval(request);
    },
  });
  assert.equal(result.status, "approved");
  assert.equal(result.rounds.length, 1);
});

test("missing, malformed, rejected, and unsupported reviewer responses never become approval", async t => {
  for (const [label, response, expected] of [
    ["missing", null, "missing"],
    ["text", "Looks fine!", "malformed"],
    ["bare vote", { recommendation: "approve" }, "malformed"],
  ] as const) {
    await t.test(label, async () => {
      const result = await runCouncil({ councilId: `bad-${label.replaceAll(" ", "-")}`, packet: createEvidencePacket(packetInput()), reviewers,
        review: async request => request.reviewer.id === "methods" ? response : approval(request),
      });
      assert.equal(result.status, "blocked");
      assert.equal(result.rounds[0]!.reviews[0]!.status, expected);
      assert.match(result.blockers.join(" "), /methods/);
    });
  }
  const result = await runCouncil({ councilId: "callback-error", packet: createEvidencePacket(packetInput()), reviewers,
    review: async () => { throw new Error("provider unavailable"); },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.rounds[0]!.reviews[0]!.status, "error");
});

test("unknown citations, stale packets, missing criteria, and evidence-free approval are malformed", async t => {
  const cases: [string, (review: ResearchReview) => void][] = [
    ["unknown citation", review => { review.rationale.evidenceIds = ["imaginary-paper"]; }],
    ["stale packet", review => { review.packetDigest = "0".repeat(64); }],
    ["missing criterion", review => { review.criteria = []; }],
    ["no evidence", review => { review.observations = []; review.rationale.evidenceIds = []; }],
  ];
  for (const [label, mutate] of cases) await t.test(label, async () => {
    const result = await runCouncil({ councilId: "bad-review", packet: createEvidencePacket(packetInput()), reviewers: [reviewers[0]!],
      review: async request => { const review = approval(request); mutate(review); return review; },
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.rounds[0]!.reviews[0]!.status, "malformed");
  });
});

test("material validity dissent survives majority approval and silent omission on revision", async () => {
  const result = await runCouncil({ councilId: "preserve-dissent", packet: createEvidencePacket(packetInput()), reviewers,
    maxRevisions: 1, revise: async request => nextRevision(request.packet),
    review: async request => {
      const review = approval(request);
      if (request.reviewer.id === "methods" && request.round === 0) {
        review.recommendation = "revise";
        review.objections = [{ id: "leakage", category: "validity", severity: "material", text: "The test split may overlap development tasks.", evidenceIds: [], requiredAction: "Supply a split-overlap audit." }];
      }
      return review;
    },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.stopReason, "revision_limit");
  assert.match(result.blockers.join(" "), /methods\/leakage/);
  assert.equal(result.objections[0]!.status, "open");
  assert.equal(result.rounds[0]!.reviews[0]!.review!.recommendation, "revise");
  assert.match(result.dissent.join(" "), /split-overlap audit/);
});

test("only original reviewer can resolve an objection using evidence; all history is retained", async () => {
  const result = await runCouncil({ councilId: "resolve-dissent", packet: createEvidencePacket(packetInput()), reviewers,
    maxRevisions: 1,
    revise: async request => {
      assert.equal(request.completedRounds[0]!.reviews.length, 2);
      const next = nextRevision(request.packet);
      next.evidence.push({ id: "artifact:split-audit", kind: "artifact", locator: "artifacts/splits.json", version: "v1", summary: "No development/test overlap found." });
      return next;
    },
    review: async request => {
      const review = approval(request);
      if (request.reviewer.id === "methods" && request.round === 0) {
        review.recommendation = "revise";
        review.objections = [{ id: "leakage", category: "validity", severity: "material", text: "Overlap has not been checked.", evidenceIds: [], requiredAction: "Audit the split." }];
      }
      if (request.reviewer.id === "methods" && request.round === 1) {
        review.resolutions = [{ objectionKey: "methods/leakage", disposition: "resolved", explanation: "The new audit addresses the overlap objection.", evidenceIds: ["artifact:split-audit"] }];
      }
      return JSON.stringify(review);
    },
  });
  assert.equal(result.status, "approved");
  assert.equal(result.objections[0]!.status, "resolved");
  assert.equal(result.rounds.length, 2);
  const last = result.rounds[1]!;
  const forged = { ...last.reviews[0]!.review!, reviewerId: "domain" };
  const outcome = validateReview(forged, { reviewerId: "domain", round: 1, packet: last.packet, objections: result.objections });
  assert.equal(outcome.status, "malformed");
  assert.match(outcome.issues.join(" "), /original reviewer/);
});

test("restating a validity objection as a minor presentation issue cannot erase the blocker", async () => {
  const result = await runCouncil({ councilId: "no-downgrade", packet: createEvidencePacket(packetInput()), reviewers: [reviewers[0]!], maxRevisions: 1,
    revise: async request => nextRevision(request.packet),
    review: async request => ({ ...approval(request), recommendation: "revise", objections: [{ id: "leakage", category: request.round ? "presentation" : "validity", severity: request.round ? "minor" : "material", text: "Potential leakage", evidenceIds: [], requiredAction: "Check split." }] }),
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.objections[0]!.category, "validity");
  assert.equal(result.rounds[1]!.reviews[0]!.status, "malformed");
});

test("array-valued objection enums cannot bypass blocking policy", async t => {
  for (const [label, category, severity] of [
    ["category", ["validity"], "material"],
    ["severity", "scope", ["blocking"]],
    ["both", ["validity"], ["blocking"]],
  ] as const) await t.test(label, async () => {
    const result = await runCouncil({ councilId: `enum-objection-${label}`, packet: createEvidencePacket(packetInput()), reviewers,
      review: async request => request.reviewer.id === "methods" ? {
        ...approval(request), objections: [{ id: "leakage", category, severity, text: "Potential evaluation leakage.", evidenceIds: [], requiredAction: "Audit the split." }],
      } : approval(request),
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.rounds[0]!.reviews[0]!.status, "malformed");
    assert.match(result.rounds[0]!.reviews[0]!.issues.join(" "), /category|severity/);
  });
});

test("array-valued unresolved disposition cannot close a validity objection", async () => {
  const result = await runCouncil({ councilId: "enum-resolution", packet: createEvidencePacket(packetInput()), reviewers, maxRevisions: 1,
    revise: async request => nextRevision(request.packet),
    review: async request => {
      if (request.reviewer.id !== "methods") return approval(request);
      if (request.round === 0) return { ...approval(request), recommendation: "revise", objections: [{ id: "leakage", category: "validity", severity: "material", text: "Potential evaluation leakage.", evidenceIds: [], requiredAction: "Audit the split." }] };
      return { ...approval(request), resolutions: [{ objectionKey: "methods/leakage", disposition: ["unresolved"], explanation: "No split audit has been supplied.", evidenceIds: ["artifact:baseline"] }] };
    },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.rounds[1]!.reviews[0]!.status, "malformed");
  assert.match(result.rounds[1]!.reviews[0]!.issues.join(" "), /disposition/);
  assert.equal(result.objections[0]!.status, "open");
  assert.match(result.blockers.join(" "), /methods\/leakage/);
});

test("review enum validation requires primitive strings", async t => {
  for (const [label, change] of [
    ["recommendation array", (review: ResearchReview) => Object.assign(review, { recommendation: ["approve"] })],
    ["recommendation boxed string", (review: ResearchReview) => Object.assign(review, { recommendation: new String("approve") })],
    ["criterion array", (review: ResearchReview) => Object.assign(review.criteria[0]!, { status: ["satisfied"] })],
    ["criterion null", (review: ResearchReview) => Object.assign(review.criteria[0]!, { status: null })],
  ] as const) await t.test(label, async () => {
    const result = await runCouncil({ councilId: "enum-review", packet: createEvidencePacket(packetInput()), reviewers: [reviewers[0]!],
      review: async request => { const review = approval(request); change(review); return review; },
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.rounds[0]!.reviews[0]!.status, "malformed");
  });
});

test("retained reviews do not change when callback-owned responses mutate", async () => {
  let callbackResponse: ResearchReview | undefined;
  const result = await runCouncil({ councilId: "detached-review", packet: createEvidencePacket(packetInput()), reviewers: [reviewers[0]!],
    review: async request => { callbackResponse = approval(request); return callbackResponse; },
  });
  const retained = structuredClone(result.rounds[0]!.reviews[0]!.review);
  assert.ok(callbackResponse);
  callbackResponse.recommendation = "reject";
  callbackResponse.observations[0]!.text = "Changed after validation";
  callbackResponse.observations[0]!.evidenceIds.push("unknown:mutated");
  callbackResponse.rationale.text = "Changed after validation";
  assert.equal(result.status, "approved");
  assert.deepEqual(result.rounds[0]!.reviews[0]!.review, retained);
});

test("validation retains the same snapshot it inspected even with changing accessors", async () => {
  let reads = 0;
  const result = await runCouncil({ councilId: "review-snapshot", packet: createEvidencePacket(packetInput()), reviewers: [reviewers[0]!],
    review: async request => {
      const review = approval(request);
      Object.defineProperty(review, "recommendation", { enumerable: true, get: () => ++reads === 1 ? "approve" : "reject" });
      return review;
    },
  });
  assert.equal(reads, 1);
  assert.equal(result.status, "approved");
  assert.equal(result.rounds[0]!.reviews[0]!.review!.recommendation, "approve");
});

test("bounded critique stops after initial round plus the configured revisions", async () => {
  let reviewCalls = 0;
  let revisionCalls = 0;
  const result = await runCouncil({ councilId: "bounded", packet: createEvidencePacket(packetInput()), reviewers, maxRevisions: 2,
    review: async request => { reviewCalls++; return { ...approval(request), recommendation: "revise" }; },
    revise: async request => { revisionCalls++; return nextRevision(request.packet); },
  });
  assert.equal(reviewCalls, 6);
  assert.equal(revisionCalls, 2);
  assert.equal(result.status, "revise");
  assert.equal(result.stopReason, "revision_limit");
  await assert.rejects(runCouncil({ councilId: "unbounded", packet: createEvidencePacket(packetInput()), reviewers, maxRevisions: 100, review: async request => approval(request) }), /zero to five/);
});

test("unresponsive reviewers time out, receive cancellation, and block approval", async () => {
  let signal: AbortSignal | undefined;
  const result = await runCouncil({ councilId: "timeout", packet: createEvidencePacket(packetInput()), reviewers: [reviewers[0]!], timeoutMs: 10,
    review: request => { signal = request.signal; return new Promise(() => {}); },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.rounds[0]!.reviews[0]!.status, "timeout");
  assert.ok(signal?.aborted);
});

test("revision cannot alter cited evidence or weaken external checks", async t => {
  for (const change of ["evidence", "checks", "criteria"] as const) await t.test(change, async () => {
    const result = await runCouncil({ councilId: `bad-revision-${change}`, packet: createEvidencePacket(packetInput()), reviewers: [reviewers[0]!],
      review: async request => ({ ...approval(request), recommendation: "revise" }),
      revise: async request => {
        const next = nextRevision(request.packet);
        if (change === "evidence") next.evidence[0]!.summary = "Rewrite history";
        if (change === "checks") next.checks = [];
        if (change === "criteria") next.requiredCriteria = ["easier-standard"];
        return next;
      },
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.stopReason, "revision_error");
    assert.equal(result.rounds.length, 1);
  });
});

test("unanimous model approval cannot override a failed independent check", async () => {
  const input = packetInput();
  input.checks[0]!.status = "failed";
  const result = await runCouncil({ councilId: "failed-check", packet: createEvidencePacket(input), reviewers, review: async request => approval(request) });
  assert.equal(result.status, "blocked");
  assert.match(result.blockers.join(" "), /fixture-test is failed/);
});

test("routing keeps numerical work deterministic and escalates consequence or ambiguity", () => {
  const base = { kind: "extract", consequence: "low", ambiguity: "low", verifierAvailable: true, contradictoryEvidence: false, repeatedFailures: 0 };
  assert.equal(routeResearchTask(base).executor, "economy");
  assert.equal(routeResearchTask({ ...base, verifierAvailable: false }).executor, "capable");
  assert.equal(routeResearchTask({ ...base, repeatedFailures: 2 }).executor, "strong");
  assert.equal(routeResearchTask({ ...base, kind: "measure", consequence: "high", contradictoryEvidence: true }).executor, "deterministic");
  assert.equal(routeResearchTask({ ...base, kind: "design", consequence: "high" }).council, true);
  assert.throws(() => routeResearchTask({ ...base, repeatedFailures: -1 }), ResearchValidationError);
  assert.throws(() => routeResearchTask({ ...base, kind: "choose-cheapest-always" }), ResearchValidationError);
});

test("evidence and routing enum validation reject non-string equivalents", () => {
  for (const kind of [["artifact"], new String("artifact"), null]) {
    const input = packetInput();
    assert.throws(() => createEvidencePacket({ ...input, evidence: [{ ...input.evidence[0], kind }] }), /kind/);
  }
  for (const status of [["passed"], new String("passed"), true]) {
    const input = packetInput();
    assert.throws(() => createEvidencePacket({ ...input, checks: [{ ...input.checks[0], status }] }), /status/);
  }
  const base = { kind: "design", consequence: "high", ambiguity: "high", verifierAvailable: true, contradictoryEvidence: false, repeatedFailures: 0 };
  for (const key of ["kind", "consequence", "ambiguity"] as const) {
    for (const value of [[base[key]], new String(base[key]), null]) {
      assert.throws(() => routeResearchTask({ ...base, [key]: value }), new RegExp(`routing\\.${key}`));
    }
  }
});

test("auditable JSON and Markdown publish together and identical retries preserve the bundle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "research-council-"));
  try {
    const result = await runCouncil({ councilId: "audit", packet: createEvidencePacket(packetInput()), reviewers, review: async request => approval(request) });
    const first = await writeDecisionArtifacts(directory, result);
    const retry = await writeDecisionArtifacts(directory, result);
    assert.equal(first.directory, retry.directory);
    assert.deepEqual(JSON.parse(await readFile(first.jsonPath, "utf8")), result);
    const markdown = await readFile(first.markdownPath, "utf8");
    assert.match(markdown, /Observation:/);
    assert.match(markdown, /Interpretation:/);
    assert.match(markdown, /artifact:baseline/);
    assert.match(markdown, /does not certify scientific validity/);
    await assert.rejects(writeDecisionArtifacts(directory, { ...result, councilId: "../../elsewhere" }), /unsafe/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("artifact JSON, digest, and Markdown use one snapshot before asynchronous writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "research-council-snapshot-"));
  try {
    const result = await runCouncil({ councilId: "audit-snapshot", packet: createEvidencePacket(packetInput()), reviewers, review: async request => approval(request) });
    const expected = structuredClone(result);
    const pending = writeDecisionArtifacts(directory, result);
    result.councilId = "changed-after-call";
    result.status = "blocked";
    result.blockers.push("Mutation after write began");
    result.rounds[0]!.reviews[0]!.review!.rationale.text = "Mutation after write began";
    const written = await pending;
    assert.deepEqual(JSON.parse(await readFile(written.jsonPath, "utf8")), expected);
    const markdown = await readFile(written.markdownPath, "utf8");
    assert.match(markdown, /Status: \*\*approved\*\*/);
    assert.doesNotMatch(markdown, /Mutation after write began|changed-after-call/);
    const expectedWrite = await writeDecisionArtifacts(directory, expected);
    assert.equal(written.digest, expectedWrite.digest);
    assert.equal(written.directory, expectedWrite.directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
