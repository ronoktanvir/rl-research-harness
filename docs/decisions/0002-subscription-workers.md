# Decision 0002: support official subscription-backed clients

Date: 2026-11-01. Status: accepted for the bounded review implementation; unattended server qualification pending.

## Decision and evidence

Use the user's existing Codex and Claude Code subscriptions through their unmodified official clients as supported worker backends. Keep the Pi adapter available as a separate optional backend. The research controller owns evidence and decisions regardless of the worker's model loop.

The user asked whether an owned harness could use existing ChatGPT/Claude allowances instead of requiring separate API spending. Current official documentation supports account-authenticated Codex and end-user subscription login to Claude Code; details and limitations are linked in [subscription workers](../subscription-workers.md). Both installed clients returned the requested short response in live smoke tests using recognized account authentication.

This supplements Decision 0001: Pi remains useful reusable infrastructure, but direct model APIs are not the only way to execute agent work. There is one research controller, with selectable workers, rather than two peer project orchestrators.

## Boundaries

Do not extract subscription tokens into Pi's provider adapters. Do not silently fall back to paid API credentials, rotate accounts to evade quotas, or interpret a client cost estimate as the user's bill. Surface quota/authentication failures and preserve unfinished work. The Droplet and training hardware are independently charged resources.

## Consequence and reversal condition

The first integration can use existing accounts without committing to a paid API budget. The tradeoff is dependence on client behavior, subscription limits and server authentication lifecycle. Use explicitly configured API workers if the user later requires throughput or operational control that the subscription clients do not provide. Recheck provider documentation and installed client behavior when authentication rules or command interfaces change.
