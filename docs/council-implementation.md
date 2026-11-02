# Implemented research council core

The initial council implementation provides a bounded, evidence-linked review protocol with dependency-injected model calls. It can reject incomplete assessments, preserve unresolved objections across revisions, and write an auditable decision bundle. It does not determine scientific truth, run experiments, retrieve papers, or make paid calls by itself.

Source: `src/research/`. Tests: `test/research/council.test.ts`. All public functions and types are exported by `src/research/index.ts`.

## Evidence identity and revision rules

`createEvidencePacket(input)` validates a schema-version-1 packet, clones it, hashes canonical JSON with SHA-256, and deeply freezes the resulting snapshot. The digest covers the research question, proposal, required criteria, evidence metadata/summaries, independent-check records, timestamp, and revision. It does not fetch evidence locations or independently verify their content. An optional evidence `sha256` records a hash supplied by the caller; the caller must actually verify that artifact.

```ts
import { createEvidencePacket } from "./src/research/index.js";

const packet = createEvidencePacket({
  schemaVersion: 1,
  packetId: "reward-study",
  revision: 1,
  question: "Does the candidate reward improve held-out task success?",
  proposal: "Compare candidate and baseline at fixed environment steps.",
  createdAt: new Date().toISOString(),
  requiredCriteria: ["independent-evaluation"],
  evidence: [{
    id: "artifact:baseline",
    kind: "artifact",
    locator: "artifacts/baseline.json",
    version: "baseline-v1",
    summary: "Evaluator fixture results and baseline specification.",
  }],
  checks: [{
    id: "evaluator-fixtures",
    status: "passed",
    evidenceIds: ["artifact:baseline"],
  }],
});
```

Within one council, a revision must increment by exactly one. It preserves the packet ID, research question, required criteria, existing evidence records, and independent-check outcomes. It may change the proposal and add evidence under new IDs. This prevents a revision from silently changing the question, rewriting earlier evidence, or removing a failed gate. A failed independent check requires an authoritative rerun and a new council; the revision model cannot mark it passed. Link the new council to the old one in the application ledger when integrating this component.

## Reviewer callback contract

`runCouncil` accepts a review callback instead of choosing a model or provider:

```ts
const result = await runCouncil({
  councilId: "reward-study-review-1",
  packet,
  reviewers: [
    { id: "methods", role: "methods reviewer" },
    { id: "domain", role: "RL domain reviewer" },
  ],
  maxRevisions: 2,
  timeoutMs: 60_000,
  review: async request => modelRuntimeReview(request),
  revise: async request => reviseProposal(request),
});
```

The two callback names in this example are application-supplied functions. The implementation never invokes a provider directly. A callback may return a JSON object or a JSON string; Markdown fences and free-form endorsements are not accepted as review records. `ReviewRequest` contains the reviewer assignment, round, frozen packet, previous completed rounds, known objections, and an `AbortSignal`.

Every reviewer receives the same frozen pre-round state. Round zero contains no other reviews. The controller waits for every review to settle, including failure and timeout cases, before making those records available to a revision callback or subsequent round. This is an information-sharing guarantee within the controller, not statistical independence between models or protection against a callback that deliberately shares external state.

A response must include:

| Field | Requirement |
|---|---|
| `schemaVersion`, `reviewerId`, `packetDigest`, `round` | Match the assigned protocol, reviewer, evidence snapshot, and round. |
| `recommendation` | `approve`, `revise`, `reject`, or `abstain`. |
| `observations`, `interpretations` | Separate arrays of `{ text, evidenceIds }`; each statement cites known evidence IDs. |
| `criteria` | Exactly one assessment for every required criterion: ID, `satisfied`/`unsatisfied`/`uncertain`, summary, and evidence IDs. Satisfied assessments require evidence. |
| `objections` | Stable ID, category, severity, text, evidence IDs, and a concrete required action. Missing-evidence objections may have no evidence IDs. |
| `resolutions` | Existing objection key, `resolved`/`unresolved`/`withdrawn`, explanation, and evidence IDs. Closure requires evidence. |
| `rationale` | Concise decision rationale and evidence IDs; approval requires cited evidence. |

Approval additionally requires an evidence-linked observation and satisfied assessments for all required criteria. A response that contains an unsupported bare approval, stale digest, unknown citation ID, missing criterion, duplicate ID, or unexpected field is recorded as malformed. No response, invalid response, callback error, and timeout are separate outcomes. None counts as an approval.

Enum values must be primitive strings; arrays and boxed strings are rejected even when their string representation matches an allowed value. Object inputs are detached before validation, so the retained review is the snapshot that was validated and later callback mutations cannot rewrite its evidence.

Source existence and semantic support are different checks. An agent can cite a real ID incorrectly; this schema cannot detect that by itself. The independent reviewer and external evidence-validation process remain responsible for substantive support.

## Decision policy and preserved dissent

The current policy is conservative: approval requires every requested reviewer to return a valid approval, all independent checks to pass, and no blocking objection to remain open. There is no majority-vote threshold.

An objection belongs to its original reviewer under a key such as `methods/leakage`. Other reviewers cannot close it. Omitting the objection in a later round does not close it, and relabeling its category or severity is rejected. The original reviewer can resolve or withdraw it with a cited explanation; original text and later resolution remain in the round history. A material validity objection or any objection marked blocking prevents approval. Minor or nonblocking concerns remain visible as dissent even when reviewers approve proceeding.

The result status is:

- `approved`: the protocol's approval conditions passed.
- `revise`: complete assessments request revision without an active hard blocker.
- `blocked`: incomplete assessments, abstention/rejection, failed/unknown independent checks, or unresolved blocking validity concerns prevent approval.

The default limit is two revisions after the initial round. Configured limits must be integers from zero through five, and one to twelve reviewers are allowed. `stopReason` records whether the council approved, reached its revision limit, lacked a revision callback, or encountered a revision error/timeout. Every completed round remains in the result.

Each callback has a deadline and receives cancellation through `AbortSignal`. A timed-out callback may continue performing external work if it ignores cancellation. The model runtime must implement actual cancellation and cost accounting; this module makes no claim that a timeout stops billing. It also does not persist in-progress councils or make callbacks retry-safe across process crashes. Durable execution belongs to the runtime integration.

## Deterministic task routing

`routeResearchTask(input)` maps task kind, consequence, ambiguity, available verification, contradictory evidence, and repeated failures to `deterministic`, `economy`, `capable`, or `strong`. It returns reasons and whether selective council review is recommended. It does not choose a provider/model or authorize spending.

Counters, hashes, measurements, and policy enforcement remain deterministic even when consequential; interpretation is a separate task. Low-consequence extraction can use an economy worker when a verifier is available. Implementation and unverified extraction use a capable worker. Scientific synthesis, substantial ambiguity or consequences, contradictory evidence, and repeated failures escalate to a strong worker. A council is recommended for high-consequence scientific or ambiguous decisions. These are versioned initial heuristics to evaluate on local tasks, not established optimal routing rules.

## Decision artifacts

`writeDecisionArtifacts(directory, result)` writes `decision.json` and `decision.md` into a content-addressed directory named from the council ID and result digest. It stages both files and publishes the directory using a same-filesystem rename; an identical retry reuses the complete matching bundle. It never overwrites a different recorded decision. The Markdown separates observations, interpretations, criterion assessments, objections, resolutions, and rationale; it is a projection of the complete JSON record.

The writer snapshots its input and derives JSON, digest, and Markdown synchronously before starting file operations. A caller changing its result after the call cannot make these representations disagree.

The writer expects the trusted result returned by this controller. It is not a parser for arbitrary external decision JSON, a signed attestation, or a database. Atomic publication does not promise durability after sudden power loss. The owning application must record artifact references in its authoritative ledger and implement backup/retention policy.

## Verification and current limits

The tests cover frozen evidence identity, round-zero independence, missing/malformed/error/timeout responses, unknown citations, stale packet references, unsupported approval, retained validity dissent, unauthorized closure and downgrade attempts, evidence-linked resolution, bounded critique, revision drift, failed independent checks, tier routing, and complete idempotent artifact bundles.

Run:

```sh
node --import tsx --test test/research/*.test.ts
npm run check
```

The model/runtime callback, durable campaign execution, literature retrieval, semantic citation verification, empirical council-quality benchmarks, budget enforcement, and trainer integration must be connected and evaluated separately. Passing these unit tests establishes the stated protocol behavior, not scientific decision quality.
