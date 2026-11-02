# First persisted account-backed report review

On 2026-11-02 UTC, the local controller admitted exactly two official-client reviewer tasks against the existing `historical-main-s11` CoworkerRL capture. One used signed-in Codex and one used signed-in Claude Code. Both clients reported successful completion with `client_managed_account` billing metadata. This demonstrates the local subscription-client route; it does not establish the account's remaining quota, final charges, server authentication persistence or future availability.

## Observed result

| Reviewer | Client result | Structured review result |
|---|---|---|
| Codex methods | Succeeded | Valid; recommendation `revise` |
| Claude reward/verifier | Succeeded | Failed validation: review text was not parseable as a JSON object |

The queue retained both outcomes and charged two cumulative local invocation units. Both global and project caps were two; neither was replenished. There was no retry or API fallback. The malformed response is a known integration limitation, not evidence that subscription authentication failed. Its response hash/length and validation diagnostic are retained; the current handler does not archive raw malformed text, so the precise formatting cause is not established.

Aggregation used stored results only and published a **blocked** council decision. Missing independent evaluation and baseline checks independently prevent approval. The methods reviewer also called for original experiment/checkpoint provenance, reward-versus-evaluator separation, controlled effect estimates and verification of update/metric instrumentation. These are model-proposed investigations based on the bounded archive. They do not demonstrate that the trainer is defective or that any proposed test has passed.

The historical report contains thirty step entries; the reviewer packet samples first/last entries while preserving the total count and full diagnostic code/severity counts. Current-checkout hashes are explicitly distinguished from the original producer. No new experiment was registered, no CoworkerRL code was modified, and no training job or cloud resource was launched.

## Local evidence identities

- Runtime configuration: `.harness/controller.json`; cumulative allowance consumed: 2 of 2 globally and for `coworker`.
- Queue: `.harness/research-queue.sqlite`; experiment observations: `.harness/coworker.sqlite`.
- Campaign: `historical-main-s11-evidence-review-v1`.
- Plan observation: `report-plan:4812edfb4a0f580b5a912612c1110bdce8267ce7b403fd2d60aaf3c9a08af24e`.
- Plan digest: `499fb9b8a7bac811e306afbc77c93a2d54c71f697cbbe93539ef2fa59ccd98bf`.
- Evidence packet digest: `fe7b4cbf9ba9d39d3144b7351c5ffd641145bb78529bf041d3e7a1b52c366e47`.
- Decision digest: `1c3abaf811deafd9ec3210e23028d8ab28b8d26d0c10a9cb5ea759ad0ca5098c`.
- Decision bundle: `.harness/decisions/report-council:4812edfb4a0f580b5a912612c1110bdce8267ce7-1c3abaf811deafd9ec3210e23028d8ab28b8d26d0c10a9cb5ea759ad0ca5098c/` (`decision.json` and `decision.md`).

The `.harness` directory is ignored and is not a repository backup. Repeating preparation with the exact saved request recovers existing tasks; aggregation invokes no clients. Do not replace the failed review with invented content or mark this campaign approved. A future structured-output change requires separate offline qualification and a separately admitted live check if needed; it does not retroactively repair this result.

## Remaining qualification

Current initial-review persistence is useful, but reliable structured output from both clients, durable criticism rounds, paper retrieval, autonomous experiment choice and controlled training execution remain incomplete. The passing local/Linux offline suite does not establish these missing capabilities.
