# Synthetic fact-credit rubric

This fixture evaluates one narrow construct: whether text affirmatively and consistently assigns the correct signed quantity and unit to the supplied metric. It deliberately separates that label from the output of a legacy or current scorer. A successful extraction check does not establish acquisition, source validity, helper quality, reasoning correctness or task success.

The fixture is [coworker-credit-cases.json](../../examples/calibration/coworker-credit-cases.json), rubric `coworker-affirmative-fact-credit`, version 1. It contains 17 newly written synthetic cases and 19 fact-level annotations: 7 true, 11 false and 1 unknown. The 16 cases without unknown annotations contain 18 scored fact decisions. The JSON carries explicit per-fact rationales; counts refer to annotations, not experiments, trained policies or independent human judgments.

The pre-execution fixture contains 8,205 bytes, with raw-file SHA256 `58b0a3c64f048fbfe2d1db6e66217ab309b605c599ec8e1b6ee0af2cdcfad68a`. This identifies the labels prepared before seeing probe outputs; a canonical-JSON digest, if used by the runner, is a separate identity.

## Label definition and independence

- `true`: the text affirmatively asserts the supplied metric's correct signed quantity and unit, with no unresolved incompatible assertion about that same fact. Exact unit conversions are allowed; rounding tolerance is not assumed.
- `false`: the text does not meet that requirement. This includes an incorrect value/binding, denial, question, hypothetical, comparison bound, or unresolved contradiction. It does not mean the whole response is useless: a well-posed question can be useful while providing no affirmative fact credit.
- `unknown`: available context cannot settle the interpretation. It remains in the report but is excluded from scored agreement and confusion counts. It must never silently become false, successful abstention or a pass.

The research-validity agent wrote these labels before receiving native probe outputs, separately from the agent implementing the executable scorer probe. The author had already inspected historical source and existing regression examples. Therefore the independence is **fixture preparation from execution**, not blinding to implementation, independent human adjudication or an untouched evaluation holdout. No live provider call was made to obtain these labels. Native disagreement must preserve the original label and rationale; a substantive rubric correction requires a new version and an explanation, not adjustment until the scorer passes.

Facts are stipulated ground truth for these synthetic examples. Money suffix `M` means one million dollars; `x` denotes a ratio. Values such as `$17.25M` and `$17,250,000` are exact equivalents. Each example has one implicit entity and time scope unless explicitly stated otherwise; the contradictory ratio example therefore cannot be rescued by inventing another period. The ambiguous-pronoun case intentionally lacks enough context and remains unknown.

The `credit-correct-number-unsupported-conclusion` case is an explicit scope control. Its numeric fact earns true under this rubric while its risk conclusion remains unsupported. That result is a reason not to use extraction agreement as a complete scientific or task-success verdict.

## Relation to the existing 49 checks

The preserved CoworkeRL records under `/Users/ronoktanvir/CoworkeRL/research/repair-audit/2026-09-21/` already report 40 main and 9 supplemental synthetic extraction checks. They were inspected before these labels were prepared; subsequent native reproduction is recorded separately in the [qualification](credit-calibration-qualification.md). This fixture does not copy their 49-case corpus or claim that already-tested themes are novel. The overlaps are intentional paired controls with changed values and separate explicit rationales:

| New fixture IDs | Existing case IDs or distinction |
| --- | --- |
| `credit-money-pair-correct`, `credit-money-pair-swapped`, `credit-other-metric-value` | `money_pair_sentence`, `money_pair_swapped`, and supplemental `unrelated_count_number` test related binding failures. The third new case isolates a target explicitly declared unmeasured. |
| `credit-positive-target-negative-claim`, `credit-negative-target-negative-claim` | `wrong_sign`, `negative_money` provide sign controls. |
| `credit-exact-dollar-conversion`, `credit-missing-million-scale` | `equivalent_dollars`, `wrong_dropped_suffix` provide exact-scale controls. |
| `credit-ratio-asserted`, `credit-ratio-hypothetical`, `credit-ratio-question`, `credit-ratio-negated`, `credit-ratio-comparison-bound` | Related existing controls include `ratio_pair`, `hypothetical`, `question`, `negated_value`, `mere_comparison_bound`. |
| `credit-ratio-contradiction`, `credit-ratio-rejected-alternative` | `contradictory_claims`, `correct_with_explicit_rejected_alternative`. These distinguish an unresolved contradiction from a correct statement that explicitly rejects an alternative. |
| `credit-denied-quotation` | Adds denial across sentences: a quoted/reported assertion followed by an explicit rejection. |
| `credit-ambiguous-referent` | Adds an unknown label requiring retention and exclusion from scored agreement. |
| `credit-correct-number-unsupported-conclusion` | Adds a boundary control showing that numeric credit cannot certify the conclusion. |

The original current-v2 extraction/reward hash matches and changed helper hash are documented in [Run-1 protocol validity](run1-protocol-validity.md). Reproduction of the original 49 cases needs their exact corpus hashes and native source identity; saved pass counts do not replace a new execution receipt. Legacy and v2 outputs must remain separate. Reproducing the legacy predicate accurately is conformance evidence even when it disagrees with this semantic rubric.

## Execution acceptance and interpretation

The native worker receives text and fact definitions, without expected labels or rationales. Its receipt must bind the exact fixture digest, selected source bytes/hash, worker identity and result records. A parse error, wrong source, absent result or duplicate fact ID is an execution/validation failure, never a semantic false result. Enforce strict Boolean observed outputs and exact case/fact joins. Comparison occurs only after native results return.

Report per-category and per-fact disagreements, not just an aggregate percentage. There are 17 selected cases, not 19 independent trials: the paired facts and transformed sentences are deliberately dependent. Exclude the one unknown annotation explicitly, retaining its text identity and reason. A model's or source's agreement with its own behavior is not the expected label's justification.

This is an adversarially selected development corpus. It can demonstrate concrete false positives, false negatives, version differences or scope limits. It cannot estimate their frequency in real-policy outputs, generalize a population error rate, compare learning algorithms, establish conference readiness or resolve the historical evaluation/control requests. Synthetic case labels are not new observations of Run-1 behavior.

## Next provenance cross-product, outside this implementation

Hold a synthetic memo and fact definition fixed while varying lawful disclosure and observation: correct later read, disclosure without read, read before the triggering post, wrong channel, wrong tool-call attribution, and value present only in envelope metadata. Cross each with correct metric use and a misbound metric. Required outputs must separate attributable acquisition from text credit and semantic correctness; a missing or malformed trace remains unassessable rather than a policy failure. Repeated reads cannot multiply per-fact credit, and no-contact episodes stay in the planned denominator.

That proposal does not test source attribution, private-fact ownership, helper interpretation, v2 semantic-instrument accuracy or task usefulness merely by adding trace IDs. Those need distinct ground truth and adjudication. A later historical calibration sample should mask policy/arm labels where possible, retain disagreements and sampling probabilities, and distinguish development examples from a protected final test. None of those procedures has been carried out by writing this fixture.
