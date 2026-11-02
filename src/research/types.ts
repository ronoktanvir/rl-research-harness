export type EvidenceKind = "source" | "artifact";

export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  locator: string;
  version: string;
  summary: string;
  /** Hash of a locally verified artifact, when one is available. */
  sha256?: string;
}

export interface EvidenceCheck {
  id: string;
  status: "passed" | "failed" | "unknown";
  evidenceIds: string[];
}

export interface EvidencePacketInput {
  schemaVersion: 1;
  packetId: string;
  revision: number;
  question: string;
  proposal: string;
  createdAt: string;
  requiredCriteria: string[];
  evidence: EvidenceItem[];
  /** Caller-supplied outcomes of independent checks; model votes cannot override them. */
  checks: EvidenceCheck[];
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object ? { readonly [P in keyof T]: DeepReadonly<T[P]> } : T;

export type EvidencePacket = DeepReadonly<EvidencePacketInput & { digest: string }>;

export interface EvidenceStatement {
  text: string;
  evidenceIds: string[];
}

export interface ReviewObjection {
  id: string;
  category: "validity" | "feasibility" | "scope" | "presentation";
  severity: "blocking" | "material" | "minor";
  text: string;
  evidenceIds: string[];
  requiredAction: string;
}

export interface ObjectionResolution {
  objectionKey: string;
  disposition: "resolved" | "unresolved" | "withdrawn";
  explanation: string;
  evidenceIds: string[];
}

export interface CriterionAssessment {
  criterionId: string;
  status: "satisfied" | "unsatisfied" | "uncertain";
  summary: string;
  evidenceIds: string[];
}

export interface ResearchReview {
  schemaVersion: 1;
  reviewerId: string;
  packetDigest: string;
  round: number;
  recommendation: "approve" | "revise" | "reject" | "abstain";
  observations: EvidenceStatement[];
  interpretations: EvidenceStatement[];
  criteria: CriterionAssessment[];
  objections: ReviewObjection[];
  resolutions: ObjectionResolution[];
  rationale: EvidenceStatement;
}

export interface Reviewer {
  id: string;
  role: string;
}

export interface ObjectionState extends ReviewObjection {
  key: string;
  reviewerId: string;
  firstRound: number;
  lastRound: number;
  status: "open" | "resolved" | "withdrawn";
  resolution?: ObjectionResolution;
}

export interface ReviewOutcome {
  reviewerId: string;
  status: "valid" | "missing" | "malformed" | "error" | "timeout";
  review?: ResearchReview;
  issues: string[];
}

export interface CouncilRound {
  round: number;
  packet: EvidencePacket;
  reviews: ReviewOutcome[];
}

export interface ReviewRequest {
  reviewer: DeepReadonly<Reviewer>;
  round: number;
  packet: EvidencePacket;
  /** Empty in round zero; populated only after all prior reviewers have settled. */
  previousRounds: DeepReadonly<CouncilRound[]>;
  objections: DeepReadonly<ObjectionState[]>;
  signal: AbortSignal;
}

export interface RevisionRequest {
  packet: EvidencePacket;
  completedRounds: DeepReadonly<CouncilRound[]>;
  objections: DeepReadonly<ObjectionState[]>;
  blockers: readonly string[];
  signal: AbortSignal;
}

export interface CouncilResult {
  schemaVersion: 1;
  councilId: string;
  createdAt: string;
  status: "approved" | "revise" | "blocked";
  stopReason: "approved" | "revision_limit" | "revision_unavailable" | "revision_error" | "revision_timeout";
  maxRevisions: number;
  rounds: CouncilRound[];
  objections: ObjectionState[];
  blockers: string[];
  dissent: string[];
  limitations: string[];
}

export interface CouncilOptions {
  councilId: string;
  packet: EvidencePacket;
  reviewers: Reviewer[];
  review: (request: ReviewRequest) => Promise<unknown>;
  revise?: (request: RevisionRequest) => Promise<unknown>;
  /** Zero to five; default two. Counts revisions after the initial round. */
  maxRevisions?: number;
  /** Per callback, not total campaign; default 60 seconds. */
  timeoutMs?: number;
  now?: () => Date;
}
