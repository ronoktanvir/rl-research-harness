import { encode, timestamp } from "../../ledger/validation.ts";
import { createEvidencePacket } from "../../research/evidence.ts";
import type { EvidenceItem, EvidencePacket } from "../../research/types.ts";
import { assessCoworkerInvestigationEvidence } from "./evidence-assessment.ts";
import type { CoworkerEvidenceAssessmentBinding, EvidenceAssessmentArchive } from "./evidence-assessment.ts";

export const COWORKER_PLANNING_SCOPE = "prospective_research_action_planning";
export const COWORKER_PLANNING_REVIEW_CRITERIA = Object.freeze([
  "uses-established-evidence", "preserves-scientific-unknowns", "compares-next-action-alternatives",
  "specifies-falsifiable-completion-evidence", "respects-controls-and-replication", "preserves-execution-authority",
]);

/** Builds a fresh planning packet from independently revalidated archive bindings.
 * Passed packet checks certify the planning contract, not scientific requirements.
 * Neither this pure projection nor a council's approval authorizes an action.
 */
export function buildCoworkerPlanningPacket(archive: EvidenceAssessmentArchive,
  binding: CoworkerEvidenceAssessmentBinding, createdAt: string): EvidencePacket {
  timestamp(createdAt);
  const assessment = assessCoworkerInvestigationEvidence(archive, binding);
  const scope = { decisionScope: COWORKER_PLANNING_SCOPE, executionAuthorized: false, interventionAuthorized: false,
    scientificEvaluation: "unassessed", approvalMeaning: "A council may endorse this prospective plan; endorsement does not validate historical scientific claims or authorize execution.",
    revisionBoundary: "Evidence, criteria and checks remain fixed within this council. New verified evidence requires a new packet and council.",
    actionBoundary: "Alternatives and recommendations are planning records, not executable commands. Do not infer dispatch authority from proposal prose." };
  const derivedLocator = `derived-assessment:${assessment.digest}`;
  const evidence: EvidenceItem[] = [
    { id: "planning:scope", kind: "artifact", locator: derivedLocator, version: assessment.rulesDigest, sha256: assessment.digest,
      summary: encode({ ...scope, limitations: assessment.limitations }) },
    { id: "planning:derivation", kind: "artifact", locator: derivedLocator, version: assessment.rulesDigest, sha256: assessment.digest,
      summary: encode({ schemaVersion: assessment.schemaVersion, kind: assessment.kind, rulesVersion: assessment.rulesVersion,
        rulesDigest: assessment.rulesDigest, evidenceAssessmentDigest: assessment.digest, binding: assessment.binding,
        meaning: "The deterministic assessor revalidated the bound capture, prior assessment and investigation receipt. This is a derived planning projection, not a new measurement." }) },
    { id: "planning:request-progress", kind: "artifact", locator: derivedLocator,
      version: assessment.rulesDigest, sha256: assessment.digest, summary: encode({ sourceReference: { observationId: assessment.binding.assessmentObservationId, digest: assessment.binding.assessmentObservationDigest, pointer: "/payload/requests" }, observationScope: "Current evidence coverage of the original requests; original request records remain unresolved.",
        updates: assessment.requestUpdates }) },
    { id: "planning:recommendation", kind: "artifact", locator: derivedLocator, version: assessment.rulesDigest, sha256: assessment.digest,
      summary: encode({ recommendation: assessment.recommendation, executionAuthorized: false,
        reviewInstruction: "Assess the recommendation against the alternatives and state which evidence would change it. A rank is a deterministic planning recommendation, not established research superiority." }) },
  ];
  for (const criterion of assessment.criteria) {
    evidence.push({ id: `planning:criterion:${criterion.id}`, kind: "artifact", locator: derivedLocator,
      version: assessment.rulesDigest, sha256: assessment.digest, summary: encode({ ...criterion,
        interpretation: criterion.category === "scientific_requirement"
          ? "Scientific requirement status is evidence for planning. It is not a passed independent check or a scientific approval."
          : "Support applies only to the stated observation scope; retained producer labels are not independently adjudicated outcomes." }) });
  }
  for (const action of assessment.nextActions) {
    evidence.push({ id: `planning:alternative:${action.actionId}`, kind: "artifact", locator: derivedLocator,
      version: assessment.rulesDigest, sha256: assessment.digest, summary: encode(action) });
  }
  // The old comparison finding correctly described the capture-only projection.
  // Its blanket absence statement is not a current description after inspection.
  for (const finding of assessment.priorDiagnosticFindings) {
    if (finding.ruleId === "scientific-comparison") continue;
    evidence.push({ id: `planning:prior:${finding.ruleId}`, kind: "artifact",
      locator: `ledger-observation:${assessment.binding.assessmentObservationId}`, version: assessment.binding.assessmentObservationDigest,
      summary: encode({ observationScope: "Prior capture-time diagnostic finding. The byte/identity investigation does not independently resolve numerical, optimizer or serving validity.", finding }) });
  }
  return createEvidencePacket({ schemaVersion: 1, packetId: `coworker-planning:${assessment.digest}`, revision: 1, createdAt,
    question: "Which prospective evidence-gathering or protocol-design action is best supported by the verified investigation, and what evidence would change that choice?",
    proposal: `Consider recommended action ${assessment.recommendation.actionId} against the archived alternatives. Account for both established subcriteria and unresolved requirements, preserve capture-time integrity findings, specify falsifiable completion evidence, and keep execution unauthorized. Council approval endorses planning only; it does not establish learning benefit, scorer validity, historical execution, or permission to run an experiment.`,
    requiredCriteria: [...COWORKER_PLANNING_REVIEW_CRITERIA], evidence,
    checks: [
      { id: "planning-archive-bindings-verified", status: "passed", evidenceIds: ["planning:derivation"] },
      { id: "planning-evidence-derivation-verified", status: "passed", evidenceIds: ["planning:derivation", "planning:request-progress"] },
      { id: "planning-authority-scope-fixed", status: "passed", evidenceIds: ["planning:scope"] },
    ] });
}
