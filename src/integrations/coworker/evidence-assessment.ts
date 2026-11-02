import type { ExperimentLedger, ObservationRecord } from "../../ledger/types.ts";
import { digestValue, encode, hash, id, keys, timestamp } from "../../ledger/validation.ts";
import { freezeSnapshot } from "../../research/evidence.ts";
import { assessCoworkerCapture, COWORKER_ASSESSMENT_SOURCE } from "./assessment.ts";
import type { AssessmentFinding, CoworkerDiagnosticRequest } from "./assessment.ts";
import { copyCoworkerInvestigationData, loadCoworkerInvestigation } from "./investigation.ts";
import type { CoworkerInvestigationExecution } from "./investigation-worker.ts";

export type EvidenceAssessmentArchive = Pick<ExperimentLedger, "getObservation">;
export interface CoworkerEvidenceAssessmentBinding {
  projectId: string; assessmentObservationId: string; assessmentObservationDigest: string;
  investigationObservationId: string; investigationObservationDigest: string;
}
export interface EvidenceReference { observationId: string; digest: string; pointer: string }
export interface InvestigationCriterion {
  id: string; category: "byte_correspondence" | "producer_measurement" | "scientific_requirement";
  status: "supported" | "not_established"; claim: string; observation: string;
  limitations: string[]; evidence: EvidenceReference[];
}
export interface InvestigationNextAction {
  actionId: string; rank: number; kind: string; title: string; reason: string;
  method: string[]; requiredEvidence: string[]; criterionIds: string[]; dependsOn: string[];
  mode: "read_only_investigation" | "protocol_design"; executionAuthorized: false;
}
export interface InvestigationRequestUpdate {
  kind: CoworkerDiagnosticRequest["kind"]; answeredCriterionIds: string[]; unresolvedCriterionIds: string[];
  disposition: "partially_supported" | "not_updated"; originalRequestUnresolved: true;
}
export interface CoworkerEvidenceAssessment {
  schemaVersion: 1; kind: "coworker-investigation-evidence-assessment.v1"; rulesVersion: 1; rulesDigest: string; digest: string;
  binding: CoworkerEvidenceAssessmentBinding & { captureId: string; captureDigest: string };
  criteria: InvestigationCriterion[]; requestUpdates: InvestigationRequestUpdate[];
  priorDiagnosticFindings: AssessmentFinding[]; nextActions: InvestigationNextAction[];
  recommendation: { actionId: string; reason: string; changesIf: string[] };
  scientificEvaluation: "unassessed"; interventionAuthorized: false; limitations: string[];
}

const RULE_DEFINITIONS = [
  "Credit only verified stage-specific correspondence. An incomplete result retains no numerical comparison payload.",
  "Completed comparison supports selected declarations, saved world joins, disjoint configuration IDs and producer counts only.",
  "Report all saved errors and incomplete producer records. Inspection completion is not trainer or evaluator health.",
  "Source bytes, adapter bytes and declared base condition do not prove historical execution, tensor semantics or a matched training control.",
  "One inspected trained policy stays one training replica; evaluation rows never establish general-effect uncertainty.",
  "Broad original requests stay unresolved. Preserve capture-time integrity findings; this reader does not repair them.",
  "Prioritize original integrity requests, partial-artifact repair, producer-failure accounting, remaining protocol provenance, semantic audit, protected evaluation and matched replication design.",
  "Action dependencies gate supported interpretation, not independent raw collection or prospective drafting. Plans carry no execution authority.",
] as const;
export const COWORKER_EVIDENCE_ASSESSMENT_RULES = freezeSnapshot({ version: 1, definitions: RULE_DEFINITIONS, digest: hash(RULE_DEFINITIONS) });

function binding(raw: unknown): CoworkerEvidenceAssessmentBinding {
  const value = copyCoworkerInvestigationData(raw);
  keys(value, ["projectId", "assessmentObservationId", "assessmentObservationDigest", "investigationObservationId", "investigationObservationDigest"]);
  id(value.projectId); id(value.assessmentObservationId); id(value.investigationObservationId);
  digestValue(value.assessmentObservationDigest); digestValue(value.investigationObservationDigest);
  return value as unknown as CoworkerEvidenceAssessmentBinding;
}
function observed(archive: EvidenceAssessmentArchive, eventId: string): ObservationRecord {
  const raw = archive.getObservation(eventId); if (!raw) throw new Error("Evidence assessment observation is missing");
  const value = copyCoworkerInvestigationData(raw); keys(value, ["eventId", "projectId", "runId", "actionId", "jobId", "source", "sequence", "observedAt", "payload", "digest"]);
  const { digest, ...body } = value; digestValue(digest); timestamp(value.observedAt);
  if (value.eventId !== eventId || value.runId !== null || value.actionId !== null || value.jobId !== null || value.sequence !== 0 || hash(body) !== digest) throw new Error("Evidence assessment observation envelope is invalid");
  return value as unknown as ObservationRecord;
}

/** Recompute from verified archive chains; no source reads, writes, queue or model calls. */
export function assessCoworkerInvestigationEvidence(archive: EvidenceAssessmentArchive, raw: CoworkerEvidenceAssessmentBinding): CoworkerEvidenceAssessment {
  const input = binding(raw), record = observed(archive, input.assessmentObservationId);
  if (record.projectId !== input.projectId || record.digest !== input.assessmentObservationDigest || record.source !== COWORKER_ASSESSMENT_SOURCE) throw new Error("Evidence assessment source binding differs");
  const priorBinding = record.payload.binding;
  keys(priorBinding, ["projectId", "captureId", "captureDigest"]); id(priorBinding.captureId); digestValue(priorBinding.captureDigest);
  const capture = observed(archive, priorBinding.captureId);
  const assessed = assessCoworkerCapture(capture, { projectId: input.projectId, captureId: capture.eventId, captureDigest: priorBinding.captureDigest });
  if (record.eventId !== assessed.assessmentId || record.observedAt !== assessed.observedAt || encode(record.payload) !== encode(assessed)) throw new Error("Evidence assessment differs from the recomputed capture assessment");
  const investigation = loadCoworkerInvestigation({ getObservation: eventId => archive.getObservation(eventId),
    appendObservation() { throw new Error("Evidence assessment is read-only"); } }, input.investigationObservationId);
  if (investigation.projectId !== input.projectId || investigation.digest !== input.investigationObservationDigest) throw new Error("Investigation observation binding differs");
  const requestIdentity = investigation.payload.requestIdentity;
  keys(requestIdentity, ["projectId", "investigationId", "captureId", "captureDigest", "localArtifacts"]);
  if (requestIdentity.projectId !== input.projectId || requestIdentity.captureId !== capture.eventId || requestIdentity.captureDigest !== capture.digest) throw new Error("Investigation and assessment belong to different captures");
  // loadCoworkerInvestigation already validates execution, result and every stage.
  const execution = investigation.payload.execution as unknown as CoworkerInvestigationExecution | null;
  const result = execution?.result ?? null, checks = execution?.observations ?? [];
  const captureReport = (capture.payload.reportObservation as Record<string, unknown>).report as {
    source: { runtimeRevision: string | null; sourceTreeDigest: string | null; baseRevision: string | null };
    steps: { checkpointReported: { adapterSha256: string | null } }[];
  };
  const declared = captureReport.source;
  // A structurally valid receipt must not contradict values already retained in
  // its capture. This checks known joins, not arbitrary worker truthfulness.
  if (result && ((declared.runtimeRevision !== null && result.source.commit !== declared.runtimeRevision.toLowerCase())
    || (declared.sourceTreeDigest !== null && result.source.pythonSourceSha256 !== declared.sourceTreeDigest.toLowerCase())
    || (declared.baseRevision !== null && Object.values(result.cells).some(cell => !declared.baseRevision!.toLowerCase().startsWith(cell.baseModelRevision))))) {
    throw new Error("Investigation source or model declaration contradicts the captured report");
  }
  const finalAdapter = captureReport.steps.at(-1)?.checkpointReported.adapterSha256;
  const adapterCheck = checks.find(check => check.check === "adapter" && check.status === "verified");
  if (finalAdapter && adapterCheck && adapterCheck.files[0]?.sha256 !== finalAdapter.toLowerCase()) {
    throw new Error("Investigation adapter declaration contradicts the captured final checkpoint");
  }
  const ref = (pointer: string): EvidenceReference => ({ observationId: investigation.eventId, digest: investigation.digest, pointer });
  const sourceRef: EvidenceReference = { observationId: record.eventId, digest: record.digest, pointer: "/payload" };
  const criteria: InvestigationCriterion[] = [];
  const stage = (name: string) => checks.findIndex(check => check.check === name);
  const isVerified = (name: string) => { const index = stage(name); return index >= 0 && checks[index]!.status === "verified"; };
  const add = (criterionId: string, category: InvestigationCriterion["category"], supported: boolean, claim: string,
    observation: string, limitations: string[], pointers: string[]) => criteria.push({ id: criterionId, category,
    status: supported ? "supported" : "not_established", claim, observation, limitations,
    evidence: pointers.length ? pointers.map(ref) : [ref("/payload/execution"), sourceRef] });
  const correspondence = (criterionId: string, check: string, claim: string, established: string, limit: string) => {
    const index = stage(check), entry = checks[index];
    add(criterionId, "byte_correspondence", isVerified(check), claim,
      isVerified(check) ? established : entry ? `Selected ${check} check failed: ${entry.reason}. This does not identify a false scientific hypothesis.`
        : `Selected ${check} check was not verified in this receipt.`, [limit], index >= 0 ? [`/payload/execution/observations/${index}`] : []);
  };
  correspondence("report-manifest-correspondence", "report", "Selected report bytes and shared manifest declarations correspond.",
    "The captured report hash and the selected shared manifest declarations were verified.", "Shared declarations are not a complete executable manifest or execution attestation.");
  correspondence("python-source-correspondence", "source", "Declared Python source bytes can be reconstructed from the saved archive mapping.",
    result ? `${result.source.pythonFiles} Python blobs (${result.source.pythonBytes} bytes) reproduce the declared source digest.`
      : "The source reconstruction stage completed; only its bounded file references are retained in this incomplete receipt.",
    "The saved commit-to-tree mapping is a declaration. Python bytes omit other dependencies, environment and historical execution custody.");
  correspondence("adapter-byte-correspondence", "adapter", "Selected adapter bytes match the captured final checkpoint declaration.",
    "The selected whole-file adapter digest matches the report's final checkpoint declaration.", "Whole-file correspondence does not establish tensor behavior, loaded serving state or resumability.");
  for (const name of ["trained", "baseline"] as const) correspondence(`${name}-record-joins`, `${name}_evaluation`,
    `Selected ${name} saved results join uniquely to their trace and planned world identities.`,
    result ? `${result.cells[name].rows} saved ${name} records have verified unique joins and declared checksum correspondence.`
      : `The ${name} evaluation check completed, but row counts are not retained in this incomplete receipt.`,
    "Record correspondence does not validate semantic outcome labels, actual model loading or historical evaluator behavior.");
  add("selected-comparison-correspondence", "producer_measurement", result !== null,
    "Selected conditions share worlds/settings and reported model/runtime/schema declarations; configuration identifiers are disjoint.",
    result ? `Verified ${result.evaluationConfigCount} evaluation and ${result.trainingConfigCount} training configuration IDs with zero overlap, the same selected worlds/settings and corresponding producer declarations.`
      : "The comparison result is unavailable. Verified cell stages alone do not establish comparison consistency or split separation.",
    ["Identifier disjointness does not establish protected or blind holdout access. Selected declarations do not identify every evaluator, helper or judge parameter."],
    result ? ["/payload/execution/result"] : []);
  add("producer-outcome-recount", "producer_measurement", result !== null, "Saved producer labels can be recounted exactly for the selected comparison.",
    result ? `Producer-credited facts: trained ${result.cells.trained.producerTargetsCredited}, bare base ${result.cells.baseline.producerTargetsCredited}; clean-success flags: ${result.cells.trained.producerCleanSuccessCount} and ${result.cells.baseline.producerCleanSuccessCount}. These are saved labels, not semantic rescoring.`
      : "No complete count payload was retained; no score, difference or rate is inferred from file references.",
    ["Credited facts and clean-success flags are different outcomes. Neither is independently validated task success."], result ? ["/payload/execution/result/cells"] : []);
  add("producer-failure-accounting", "producer_measurement", result !== null, "Saved producer completeness, statuses, errors and resumed coverage are retained.",
    result ? ["trained", "baseline"].map(name => { const c = result.cells[name as "trained" | "baseline"]; return `${name}: ${c.producerCompleteCount}/${c.rows} producer-complete, ${c.producerStatusOkCount} ok, ${c.producerStatusOtherCount} other statuses, ${c.producerErrorCount} errors; ${c.summaryRan} new plus ${c.summaryResumedFrom} resumed`; }).join("; ")
      : "Completeness and failure counts are unavailable in this receipt's retained result.", ["A completed inspection does not mean every producer episode succeeded or that training was healthy."], result ? ["/payload/execution/result/cells"] : []);
  add("bare-base-comparator-observed", "producer_measurement", result !== null, "The selected comparison includes a declared empty-adapter base condition.",
    result ? "The saved baseline condition declares the empty-adapter hash and corresponding base/tokenizer declarations."
      : "A complete selected comparison is unavailable.", ["An untrained base condition is not a matched training control, and declarations do not prove actual historical model loading."], result ? ["/payload/execution/result/comparator", "/payload/execution/result/cells/baseline"] : []);
  add("training-replication-scope", "producer_measurement", result !== null, "The inspected comparison has one trained-policy replica.",
    result ? `The comparison contains ${result.scientificReplicationCount} trained-policy replica; its ${result.cells.trained.rows} evaluation rows do not add training replicas.`
      : "No complete selected comparison is available; independent training replication is not inferred.", ["No interval, significance claim or universal minimum seed count follows from these records."], result ? ["/payload/execution/result/scientificReplicationCount"] : []);
  const unresolved = [
    ["original-execution-provenance", "Complete original deployment, data, reward/evaluator, selection and execution provenance are established.", "Selected byte matches leave original dependency/model bytes, complete evaluator/helper/judge configuration, selection history and execution custody unestablished."],
    ["semantic-evaluator-validity", "Independent semantic task-success evaluation is calibrated against adjudicated outcomes.", "The worker recounts producer labels; it does not test scorer false positives, false negatives or whether credited facts are used correctly."],
    ["protected-evaluation-policy", "Evaluation access, selection and feedback policies preserve the intended held-out claim.", "Distinct configuration IDs do not establish access restrictions, blindness or separation from adaptive selection."],
    ["matched-training-control", "A matched training control isolates the proposed mechanism under comparable budgets.", "The selected base comparator does not establish a trained control with matched initialization, data, tuning, training and inference budgets."],
    ["general-training-effect", "The target effect, independent training replication and uncertainty design support the intended generalization.", "One trained-policy comparison does not establish effects over new training runs. The estimand and prospective replication design remain unspecified."],
  ];
  if (assessed.requests.some(item => item.kind === "verify_checkpoint")) unresolved.push(["native-checkpoint-resume", "A proposed resume boundary has native state and capability verification.", "Adapter byte correspondence does not test optimizer/scheduler/RNG state, native loading or resume equivalence."]);
  for (const [criterionId, claim, observation] of unresolved) add(criterionId!, "scientific_requirement", false, claim!, observation!,
    ["Not established by this inspection means additional evidence is required; it does not prove the claim false or evidence nonexistent elsewhere."], []);

  const related: Partial<Record<CoworkerDiagnosticRequest["kind"], string[]>> = {
    recover_manifest: ["report-manifest-correspondence", "python-source-correspondence", "adapter-byte-correspondence", "original-execution-provenance"],
    collect_independent_evaluation: ["trained-record-joins", "baseline-record-joins", "selected-comparison-correspondence", "producer-outcome-recount", "producer-failure-accounting", "semantic-evaluator-validity", "protected-evaluation-policy"],
    design_matched_baseline: ["bare-base-comparator-observed", "selected-comparison-correspondence", "training-replication-scope", "matched-training-control", "general-training-effect"],
    verify_checkpoint: ["adapter-byte-correspondence", "native-checkpoint-resume"],
  };
  const requestUpdates = assessed.requests.map(item => {
    const selected = criteria.filter(criterion => related[item.kind]?.includes(criterion.id));
    const answeredCriterionIds = selected.filter(criterion => criterion.status === "supported").map(criterion => criterion.id);
    return { kind: item.kind, answeredCriterionIds, unresolvedCriterionIds: selected.filter(criterion => criterion.status === "not_established").map(criterion => criterion.id),
      disposition: answeredCriterionIds.length ? "partially_supported" as const : "not_updated" as const, originalRequestUnresolved: true as const };
  });
  const nextActions: InvestigationNextAction[] = [];
  const action = (kind: string, mode: InvestigationNextAction["mode"], title: string, reason: string, method: string[], requiredEvidence: string[], criterionIds: string[], dependsOn: string[] = []) => {
    const actionId = `next:${kind}`; nextActions.push({ actionId, rank: nextActions.length + 1, kind, title, reason, method, requiredEvidence, criterionIds, dependsOn, mode, executionAuthorized: false }); return actionId;
  };
  const priorDiagnostics = assessed.requests.filter(item => !["recover_manifest", "collect_independent_evaluation", "design_matched_baseline", "verify_checkpoint"].includes(item.kind));
  const preserveDiagnostic = (prior: typeof assessed.requests[number]) => action(`original-${prior.kind}`, "read_only_investigation",
    prior.action, "The original capture-time diagnostic remains unresolved; the artifact reader did not evaluate or repair its cause.",
    ["Inspect the cited original findings without inferring present worker state.", "Retain any unavailable evidence and specify a prospective check if historical custody cannot be recovered."], [prior.completionEvidence], []);
  for (const prior of priorDiagnostics.filter(item => item.priority !== "evidence")) preserveDiagnostic(prior);
  if (!result) action("repair-selected-evidence", "read_only_investigation", "Recover or correct the selected failed evidence stage.",
    `The inspection is incomplete (${investigation.payload.reason}); preserve earlier verified stages and diagnose the bounded failure.`,
    ["Inspect the failed stage and selected paths; do not substitute a different run by label.", "After evidence changes, request a new explicit investigation ID and verify its capture binding."],
    ["A new typed investigation receipt explaining the selected failure or completing the missing checks."], criteria.filter(c => c.category !== "scientific_requirement" && c.status !== "supported").map(c => c.id));
  if (result && Object.values(result.cells).some(c => c.producerErrorCount > 0 || c.producerStatusOtherCount > 0 || c.producerCompleteCount !== c.rows)) action("account-producer-failures", "read_only_investigation",
    "Resolve the interpretation of saved failures and incomplete episodes.", "The receipt retained producer errors, non-ok statuses or incomplete records; inspection completion does not remove them.",
    ["Classify recorded failures separately from task failure and preserve every selected denominator.", "Recover the declared retry and penalty policy before comparing corrected summaries."],
    ["Per-case failure categories and a frozen accounting rule with both original and any corrected measurements."], ["producer-failure-accounting", "semantic-evaluator-validity"]);
  for (const prior of priorDiagnostics.filter(item => item.priority === "evidence")) preserveDiagnostic(prior);
  const provenance = action("recover-protocol-provenance", "read_only_investigation", "Recover and freeze the remaining evaluation and execution protocol.",
    "Selected byte and row correspondence narrows provenance gaps but leaves measurement and selection assumptions unresolved.",
    ["Recover scorer/verifier definition, helper and judge identities, inference and tool limits, checkpoint selection and evaluation-access history.", "Separate recovered artifacts, producer declarations and unavailable historical facts; define a prospective reproduction where custody cannot be recovered."],
    ["Versioned protocol and claim-to-artifact map with explicit unresolved fields and a fixed task-success definition."], ["original-execution-provenance", "semantic-evaluator-validity", "protected-evaluation-policy"]);
  const semantic = action("audit-semantic-success", "read_only_investigation", "Audit scorer semantics against adjudicated counterexamples and sampled outcomes.",
    "Saved credited-fact totals can describe the wrong capability even when every hash and arithmetic check agrees.",
    ["Specify known-correct, known-incorrect, unsupported-fact, acquired-but-misused and duplicate/irrelevant-fact cases with independently justified expected outcomes.",
      "Declare a sampling policy for historical positives, negatives and controls; do not estimate population error rates from a deliberately enriched sample.",
      "Compare labels to adjudicated references, retain disagreement categories and separate fact credit from task completion."],
    ["Per-case expected and observed labels, adjudication provenance, discrepancy taxonomy and the sampling policy."], ["semantic-evaluator-validity", "producer-outcome-recount"], [provenance]);
  const holdout = action("design-protected-evaluation", "protocol_design", "Define a prospective protected evaluation and selection policy.",
    "Disjoint identifiers do not establish blindness or protect a reused evaluation set from adaptive selection.",
    ["Specify train/development/final evaluation roles, access logging, checkpoint selection and inference/tool budgets.", "Declare which feedback triggers a fresh final evaluation set or a narrower claim."],
    ["Versioned access/selection protocol and a testable release rule, without claiming historical blindness."], ["protected-evaluation-policy"], [provenance]);
  action("design-matched-replication", "protocol_design", "Draft matched training arms and a claim-specific replication design.",
    "A bare-base comparison and many episodes from one policy cannot isolate a training mechanism or its run-to-run variation.",
    ["State the proposed mechanism, target effect and observation that would refute it.", "Match initialization, data access, tuning effort, training budgets and frozen evaluation; record unavoidable mismatches.",
      "Choose independent training runs as the replication unit for claims across training runs; define uncertainty methods for that target without treating episodes as replicas.", "Retain all runs and failures, preregister selection/stopping rules and request execution resources only after the protocol is reviewable."],
    ["Prospective arm manifest, estimand, independent replication and uncertainty plan, controls, stopping criteria and unresolved resource requirements."], ["matched-training-control", "general-training-effect"], [semantic, holdout]);
  if (assessed.requests.some(item => item.kind === "verify_checkpoint")) action("inspect-resume-contract", "read_only_investigation", "Inspect the native checkpoint and resume requirements before proposing recovery.",
    "The original checkpoint diagnostic remains open despite any adapter byte match.", ["Inventory native state requirements and identify a separately authorized load/round-trip test; do not execute it from this plan."],
    ["Native capability/state inventory and a defined verification protocol."], ["native-checkpoint-resume"]);
  const first = nextActions[0]!;
  const body = { schemaVersion: 1 as const, kind: "coworker-investigation-evidence-assessment.v1" as const, rulesVersion: 1 as const,
    rulesDigest: COWORKER_EVIDENCE_ASSESSMENT_RULES.digest, binding: { ...input, captureId: capture.eventId, captureDigest: capture.digest },
    criteria, requestUpdates, priorDiagnosticFindings: assessed.findings.map(f => ({ ...f, references: { ...f.references, sample: [...f.references.sample] } })), nextActions,
    recommendation: { actionId: first.actionId, reason: first.reason, changesIf: ["A new verified receipt changes evidence availability or observed failure accounting.",
      "A separately grounded research question changes the proposed claim or mechanism.", "Independent methodological review identifies a more discriminating check within the available authority."] },
    scientificEvaluation: "unassessed" as const, interventionAuthorized: false as const,
    limitations: ["This is a versioned evidence-assessment and action-planning policy, not a learned estimate of information gain or proof of scientific validity.",
      "Recommendations are prospective requests with unimplemented execution handlers; neither their ordering nor council approval dispatches them.",
      "Action dependencies gate supported interpretation, not independent raw evidence collection or prospective drafting.",
      "Original assessments and scientific follow-ups remain immutable and unresolved. Narrow supported criteria do not imply broad completion.",
      "No new literature search, semantic rescoring, model call, training, authorization or resource settlement is performed."] };
  return freezeSnapshot<unknown>({ ...body, digest: hash(body) }) as CoworkerEvidenceAssessment;
}
