# Live arXiv retrieval qualification

Two separately identified public API attempts were made on 2026-11-02 UTC. Neither produced paper evidence. The request was bounded to three results and 256 KiB, sorted by descending submission date:

```text
all:"reinforcement learning" AND (all:"verifiable rewards" OR all:"reward hacking")
```

| Discovery | Bound | Observed outcome |
|---|---:|---|
| `rlvr-reward-validity-2026-11-02-v1` | 20 seconds | Timed out before a complete response was saved |
| `rlvr-reward-validity-2026-11-02-v2` | 60 seconds | HTTP 429; no Retry-After header |

Between attempts, host-only HEAD checks through Node and curl returned HTTP 200. That establishes host reachability from the machine; it does not establish why the first API request timed out. The second attempt used a new discovery identity after the first attempt's cooldown, preserving the original failed snapshot. Requests stopped after the 429 response.

The second response was captured at `2026-11-02T04:12:29.251Z`, with raw-response SHA-256 `467622e2f17f01d302d6c790b13078569f17d71cd83910558535019a594e07c1`. Its query/response/result identities share suffix `65520bb8f30cce73210a4d77947e3f099bc4807f5f5c0e58853c2648e71caf00`. The failed first query uses suffix `216e3fda901dd618aa30b0f803598a2b13d415fe7e56c570d327f387de28fc45`.

## Operational consequence

The 429 response exposed a missing cross-query service hold. The implementation now derives a persistent hold from captured rate-limit responses and consults it before a new request, regardless of project or discovery ID. A valid reported retry time permits admission after that time; a missing or invalid time remains unknown and requires explicit operator release. The original query is never automatically retried.

The historical response was used to repair its hold without network access. `literature-status` reported `available: false`, `retryAt: null`, `released: false`, and `blocked: true`. A further admission check used a network-disabled injected transport and observed `arxiv_service_held` with **zero fetch calls**. The hold remains active; no release was performed.

Hold identity: `arxiv-hold:f3a449f1d9b37e40de444bd4b9293cafc69fda76925d5589613230131f2d307a`. Runtime evidence lives in ignored `.harness/coworker.sqlite`; request files and command logs are also local ignored artifacts. They are not a repository backup or a successful paper search.

## What remains unqualified

Offline parser, provenance, recovery and rate-hold tests pass against fixtures. The live path has demonstrated a saved failure and enforced service hold, **not successful live paper ingestion**, broad literature coverage or paper-quality assessment. Full-paper retrieval, verified venue decisions, novelty analysis and recurring literature updates remain separate work. The archived failures must never be described as reviewed papers.
