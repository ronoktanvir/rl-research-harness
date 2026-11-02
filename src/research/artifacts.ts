import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson, isId, ResearchValidationError } from "./evidence.js";
import type { CouncilResult } from "./types.js";

function markdownText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\\`*_\[\]{}|#]/g, "\\$&").replace(/\r?\n/g, " ");
}

/** A human-readable projection; the JSON preserves the complete structured record. */
export function renderDecisionMarkdown(result: CouncilResult): string {
  const lines = [
    `# Council decision: ${markdownText(result.councilId)}`,
    "", `Status: **${result.status}**. Stop reason: ${result.stopReason}.`,
    `Created: ${result.createdAt}. Completed rounds: ${result.rounds.length}. Maximum revisions: ${result.maxRevisions}.`,
    "", "Approval records completion of this review protocol. It does not certify scientific validity.",
    "", "## Final blockers", "",
    ...(result.blockers.length ? result.blockers.map(text => `- ${markdownText(text)}`) : ["None recorded."]),
    "", "## Preserved dissent", "",
    ...(result.dissent.length ? result.dissent.map(text => `- ${markdownText(text)}`) : ["No unresolved dissent recorded in the final assessment."]),
  ];
  for (const round of result.rounds) {
    lines.push("", `## Round ${round.round}: packet revision ${round.packet.revision}`, "", `Packet: ${markdownText(round.packet.packetId)}. SHA-256: \`${round.packet.digest}\`.`, "", `Question: ${markdownText(round.packet.question)}`, "", `Proposal: ${markdownText(round.packet.proposal)}`);
    for (const outcome of round.reviews) {
      lines.push("", `### ${markdownText(outcome.reviewerId)}: ${outcome.status}`, "");
      if (!outcome.review) { lines.push(...outcome.issues.map(issue => `- ${markdownText(issue)}`)); continue; }
      const review = outcome.review;
      lines.push(`Recommendation: **${review.recommendation}**. ${markdownText(review.rationale.text)} Evidence: ${review.rationale.evidenceIds.map(markdownText).join(", ") || "none"}.`);
      for (const [label, statements] of [["Observation", review.observations], ["Interpretation", review.interpretations]] as const) {
        for (const statement of statements) lines.push("", `- ${label}: ${markdownText(statement.text)} [Evidence IDs: ${statement.evidenceIds.map(markdownText).join(", ")}]`);
      }
      for (const criterion of review.criteria) lines.push("", `- Criterion ${markdownText(criterion.criterionId)}: ${criterion.status}. ${markdownText(criterion.summary)} [Evidence IDs: ${criterion.evidenceIds.map(markdownText).join(", ") || "none"}]`);
      for (const objection of review.objections) lines.push("", `- Objection ${markdownText(objection.id)} (${objection.category}, ${objection.severity}): ${markdownText(objection.text)} Required action: ${markdownText(objection.requiredAction)} [Evidence IDs: ${objection.evidenceIds.map(markdownText).join(", ") || "none"}]`);
      for (const resolution of review.resolutions) lines.push("", `- ${markdownText(resolution.objectionKey)}: ${resolution.disposition}. ${markdownText(resolution.explanation)} [Evidence IDs: ${resolution.evidenceIds.map(markdownText).join(", ") || "none"}]`);
    }
    lines.push("", "Evidence register:", "");
    for (const item of round.packet.evidence) lines.push(`- ${markdownText(item.id)} (${item.kind}, ${markdownText(item.version)}): ${markdownText(item.summary)} Location: ${markdownText(item.locator)}${item.sha256 ? ` SHA-256: ${item.sha256}` : ""}`);
  }
  lines.push("", "## Limits", "", ...result.limitations.map(item => `- ${markdownText(item)}`), "");
  return lines.join("\n");
}

/** Writes a complete immutable bundle using same-filesystem directory rename.
 * This is atomic publication, not a promise of power-loss durability or a database.
 */
export async function writeDecisionArtifacts(directory: string, result: CouncilResult): Promise<{ directory: string; jsonPath: string; markdownPath: string; digest: string }> {
  // Capture and derive all representations before the first asynchronous boundary.
  // A caller changing its result while files are written cannot split the bundle.
  const snapshot = structuredClone(result);
  if (!isId(snapshot.councilId)) throw new ResearchValidationError(["councilId: unsafe artifact ID"]);
  const json = `${JSON.stringify(snapshot, null, 2)}\n`;
  const digest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
  const markdown = renderDecisionMarkdown(snapshot);
  const base = resolve(directory);
  const destination = join(base, `${snapshot.councilId}-${digest}`);
  const temporary = join(base, `.council-${randomUUID()}`);
  const jsonPath = join(destination, "decision.json");
  const markdownPath = join(destination, "decision.md");
  await mkdir(base, { recursive: true });
  await mkdir(temporary);
  try {
    await writeFile(join(temporary, "decision.json"), json, { flag: "wx", mode: 0o600 });
    await writeFile(join(temporary, "decision.md"), markdown, { flag: "wx", mode: 0o600 });
    try { await rename(temporary, destination); }
    catch (error) {
      // Identical writes may race. Only reuse an existing complete, matching bundle.
      const [existingJson, existingMarkdown] = await Promise.all([
        readFile(jsonPath, "utf8"), readFile(markdownPath, "utf8"),
      ]).catch(() => { throw error; });
      if (existingJson !== json || existingMarkdown !== markdown) throw new Error("Existing council artifact does not match its content address", { cause: error });
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return { directory: destination, jsonPath, markdownPath, digest };
}
