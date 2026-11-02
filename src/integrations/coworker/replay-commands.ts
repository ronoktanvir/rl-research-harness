import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { openExperimentLedger } from "../../ledger/index.ts";
import { readObservedReplayJson } from "./observed-replay-artifacts.ts";
import { importCoworkerReplayEvidence, loadCoworkerReplayEvidence, summarizeCoworkerReplayEvidence } from "./replay-evidence.ts";
import { archiveCoworkerReplayAnnotations, assessCoworkerReplayEvidence, loadCoworkerReplayAnnotations, prepareCoworkerReplayAssessmentBinding } from "./replay-assessment.ts";
import { buildCoworkerReplayPlanningPacket } from "./replay-planning.ts";

export const REPLAY_EVIDENCE_USAGE = `Persistent replay evidence and prospective planning (no model calls or training):
  npm run harness -- replay-evidence-import <ledger.sqlite> <request.json> <absolute-artifact-root>
  npm run harness -- replay-evidence-status <ledger.sqlite> <observation-id>
  npm run harness -- replay-annotate <ledger.sqlite> <annotations.json>
  npm run harness -- replay-assess <ledger.sqlite> <binding.json>
  npm run harness -- replay-packet <ledger.sqlite> <binding.json> <new-packet.json>`;
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

export async function replayEvidenceCommand(args: string[]): Promise<number | null> {
  const [command, ...rest] = args;
  const count = command === "replay-evidence-import" || command === "replay-packet" ? 3
    : ["replay-evidence-status", "replay-annotate", "replay-assess"].includes(command ?? "") ? 2 : null;
  if (count === null || rest.length !== count) return null;
  const ledger = openExperimentLedger({ path: rest[0]! });
  try {
    if (command === "replay-evidence-import") {
      const record = await importCoworkerReplayEvidence(ledger, await readObservedReplayJson(rest[1]!, 32_768), { artifactRoot: rest[2]! });
      print(summarizeCoworkerReplayEvidence(record)); return 0;
    }
    if (command === "replay-evidence-status") {
      print(summarizeCoworkerReplayEvidence(loadCoworkerReplayEvidence(ledger, rest[1]!))); return 0;
    }
    if (command === "replay-annotate") {
      const record = archiveCoworkerReplayAnnotations(ledger, await readObservedReplayJson(rest[1]!, 300_000), {});
      print({ observationId: record.eventId, observationDigest: record.digest, projectId: record.projectId,
        semanticEvaluation: "unassessed", meaning: "Bound annotation declarations archived; authorship, timing, blindness and truth are not independently established." });
      return 0;
    }
    const raw = await readObservedReplayJson(rest[1]!, 32_768);
    const assessment = assessCoworkerReplayEvidence(ledger, prepareCoworkerReplayAssessmentBinding(raw));
    if (command === "replay-assess") {
      print({ assessmentDigest: assessment.digest, binding: assessment.binding, declaredOrigin: assessment.origin.kind,
        originStatus: assessment.originStatus, replay: assessment.replay, counts: assessment.counts,
        recommendation: assessment.recommendation, openScientificRequirements: assessment.openScientificRequirements,
        historicalRequestUpdates: assessment.historicalRequestUpdates, semanticEvaluation: assessment.semanticEvaluation,
        taskSuccess: assessment.taskSuccess, scientificEvaluation: assessment.scientificEvaluation, executionAuthorized: assessment.executionAuthorized });
      return 0;
    }
    const replay = loadCoworkerReplayEvidence(ledger, assessment.binding.replayObservationId);
    const annotation = assessment.binding.annotationObservationId ? loadCoworkerReplayAnnotations(ledger, assessment.binding.annotationObservationId) : null;
    const createdAt = annotation && Date.parse(annotation.observedAt) > Date.parse(replay.observedAt) ? annotation.observedAt : replay.observedAt;
    const packet = buildCoworkerReplayPlanningPacket(ledger, assessment.binding, createdAt), path = resolve(rest[2]!);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(packet, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    print({ packetId: packet.packetId, packetDigest: packet.digest, path, evidenceItems: packet.evidence.length,
      executionAuthorized: false, meaning: "Evidence packet exported for prospective review; no council or action was dispatched." });
    return 0;
  } finally { ledger.close(); }
}
