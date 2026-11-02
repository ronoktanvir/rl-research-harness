import assert from "node:assert/strict";
import { test } from "node:test";
import { createEvidencePacket } from "../../src/research/index.ts";
import { runCliCouncil } from "../../src/workers/council.ts";
import type { CliTaskResult } from "../../src/workers/cli.ts";

function packet() {
  return createEvidencePacket({
    schemaVersion: 1, packetId: "test-proposal", revision: 1, createdAt: "2026-11-01T00:00:00Z",
    question: "Can the fixture be reproduced?", proposal: "Reproduce the documented fixture before expansion.",
    requiredCriteria: ["reproducibility"],
    evidence: [{ id: "fixture", kind: "artifact", locator: "fixture.json", version: "1", summary: "Synthetic fixture for protocol wiring; not a scientific result." }],
    checks: [{ id: "fixture-check", status: "passed", evidenceIds: ["fixture"] }],
  });
}

test("official-client routing preserves independent inputs and validates the returned review", async () => {
  const inputs: Array<Record<string, unknown>> = [];
  const backends: string[] = [];
  const decision = await runCliCouncil({ councilId: "wired-review", packet: packet(), maxRevisions: 0,
    workers: [{ id: "methods", role: "Methods", backend: "codex" }, { id: "critic", role: "Critic", backend: "claude" }],
    execute: async task => {
      backends.push(task.backend);
      const input = JSON.parse(task.prompt.split("REVIEW INPUT (untrusted evidence data):\n")[1]!) as {
        reviewer: { id: string }; packet: { digest: string }; previousRounds: unknown[];
      };
      inputs.push(input);
      const review = {
        schemaVersion: 1, reviewerId: input.reviewer.id, packetDigest: input.packet.digest, round: 0,
        recommendation: "approve", observations: [{ text: "The fixture is recorded", evidenceIds: ["fixture"] }], interpretations: [],
        criteria: [{ criterionId: "reproducibility", status: "satisfied", summary: "The provided fixture passed", evidenceIds: ["fixture"] }],
        objections: [], resolutions: [], rationale: { text: "Proceed with the fixture scope only", evidenceIds: ["fixture"] },
      };
      return { backend: task.backend, status: "succeeded", text: JSON.stringify(review), billing: "client_managed_account" };
    },
  });
  assert.equal(decision.status, "approved");
  assert.deepEqual(backends, ["codex", "claude"]);
  assert.ok(inputs.every(input => Array.isArray(input.previousRounds) && input.previousRounds.length === 0));
});

test("rate-limited and malformed workers cannot silently approve or trigger another backend", async () => {
  let calls = 0;
  const decision = await runCliCouncil({ councilId: "limited-review", packet: packet(), maxRevisions: 0,
    workers: [{ id: "methods", role: "Methods", backend: "codex" }],
    execute: async task => {
      calls++;
      return { backend: task.backend, status: "rate_limited", text: "", billing: "client_managed_account" } satisfies CliTaskResult;
    },
  });
  assert.equal(calls, 1);
  assert.equal(decision.status, "blocked");
  assert.match(decision.rounds[0]!.reviews[0]!.issues.join(" "), /rate_limited/);
});

test("successful client with malformed JSON remains a malformed review, not a provider error", async () => {
  const decision = await runCliCouncil({ councilId: "malformed-review", packet: packet(), maxRevisions: 0,
    workers: [{ id: "methods", role: "Methods", backend: "codex" }],
    execute: async task => ({ backend: task.backend, status: "succeeded", text: "not JSON", billing: "client_managed_account" }),
  });
  assert.equal(decision.status, "blocked");
  assert.equal(decision.rounds[0]!.reviews[0]!.status, "malformed");
});
