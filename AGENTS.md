# Working instructions for this research harness

## Read first

Read `context/PROJECT.md`, then `docs/reuse-plan.md` and `docs/architecture.md`. Read the relevant pinned repository audit before changing an integration. The root README is the document index.

## Preserve the objective

Build toward a self-guiding research assistant that designs RL environments, runs and monitors experiments, searches current literature, and makes evidence-grounded decisions. Support both conventional RL and LLM post-training through separate adapters. The intended deployment is an always-on Droplet controller with independently managed experiment workers.

Do not silently substitute a chat bot, coding assistant, paper summarizer, or self-modifying agent demo for this objective. Do not treat conference acceptance, agent consensus, or an improving reward curve as proof of research validity.

## Evidence and continuity

- Separate observed facts, interpretations, proposals, and verified implementation status.
- Cite repository claims to inspected commits and source locations. Recheck upstream before implementation; `main` is not a dependency pin.
- Ground paper claims in the primary source and record version, venue status, retrieval date, limitations, and the exact claim supported.
- Record major decisions, rejected alternatives, dissent, and evidence that would reverse the decision. Preserve old decisions as superseded rather than silently rewriting history.
- At handoff, update the status and next action in `context/PROJECT.md`. Keep it short; link to detailed evidence instead of copying all context into it.
- Markdown holds human-readable knowledge. Runtime job state, costs, and commands require structured persistent records; do not use conversational summaries as a job database.

## Research and execution

- Establish baselines, evaluator validity, resource limits, and stopping rules before costly experiments.
- Run scientific design reviews independently before sharing other reviewers' conclusions. Bound criticism rounds and require each unresolved objection to point to a test, source, or decision consequence.
- Match agent capability to consequence and ambiguity; use deterministic code for counters, limits, health checks, and invariants.
- Never label an ambiguous external launch safe to replay without an idempotency or reconciliation mechanism. Cancellation of a local task is not confirmation that a remote job stopped.
- Changes to environment, reward, dataset, evaluator, model, or hyperparameters create a new experiment configuration; do not silently rewrite a running experiment's identity.
- Keep runtime upgrades and agent-proposed code changes in reviewed candidates with validation and rollback. Adopted architecture decisions are provisional until their acceptance tests pass.

## Communicate clearly

Lead with the conclusion or current outcome. Explain the decisive mechanism and qualification. Use precise source-backed language, preserve uncertainty that changes the decision, and avoid generic praise, template prose, or repetitive summaries.

## Current scope

The user has authorized implementation, a private GitHub repository, thoughtful commits, and independent agent code review. CoworkerRL is the first real integration target. The initial assessment is complete; implementation is now underway. No cloud budget, paid model-call allowance, GPU allocation, or production training campaign has been configured. Local development and deterministic tests can proceed. Do not describe proposed components as built or tested.

## Code and review

Use small, typed modules with explicit ownership of state and side effects. Explain non-obvious invariants in comments. Keep money in integer microdollars and distinguish reserved exposure from settled charges. Give tests failure-oriented names and exercise real persistence boundaries where appropriate. Run `npm run check` and relevant tests before committing code. Keep coherent commits; include independent review findings and their resolution in the handoff. Never commit credentials, local databases, dependency directories or runtime artifacts.
