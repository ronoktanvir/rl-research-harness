import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LedgerError } from "../ledger/index.ts";
import type { ActionRecord, BudgetRecord, ExperimentLedger, ObservationRecord, RunRecord, ScopeState } from "../ledger/types.ts";

interface ProjectState {
  schemaVersion: 1;
  projectId: string;
  observedAt: string;
  throughEvent: number;
  globalAuthority: ScopeState;
  projectAuthority: ScopeState | null;
  globalBudget: BudgetRecord | null;
  projectBudget: BudgetRecord | null;
  runs: RunRecord[];
  actions: ActionRecord[];
  observations: Pick<ObservationRecord, "eventId" | "digest" | "source" | "observedAt" | "runId">[];
}

function optional<T>(read: () => T): T | null {
  try { return read(); }
  catch (error) { if (error instanceof LedgerError && error.code === "missing") return null; throw error; }
}

function capture(ledger: ExperimentLedger, projectId: string, now: Date): ProjectState {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(projectId)) throw new Error("Invalid summary project ID");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Invalid summary clock");
  // The owner holds the database lock. These synchronous reads have no callback/await
  // boundary at which another task in this process could mutate the ledger.
  const runs = ledger.listRuns(projectId);
  const actions = ledger.listActions(projectId);
  const observations = ledger.listObservations(projectId).map(({ eventId, digest, source, observedAt, runId }) => ({ eventId, digest, source, observedAt, runId }));
  return { schemaVersion: 1, projectId, observedAt: now.toISOString(), throughEvent: ledger.events().at(-1)?.sequence ?? 0,
    globalAuthority: ledger.getScope("global"), projectAuthority: optional(() => ledger.getScope(`project:${projectId}`)),
    globalBudget: optional(() => ledger.getBudget("global")), projectBudget: optional(() => ledger.getBudget(`project:${projectId}`)),
    runs, actions, observations };
}

function cell(value: string | number | bigint): string {
  return String(value).replace(/[\\`*_[\]<>|]/g, "\\$&").replace(/[\r\n]+/g, " ");
}

function render(state: ProjectState, digest: string): string {
  const lines = [`# Project state: ${cell(state.projectId)}`, "",
    `Observed ${state.observedAt}; ledger event sequence ${state.throughEvent}. Snapshot SHA-256: \`${digest}\`.`, "",
    "This file is a projection of recorded state. It does not grant authority, validate a research claim, or replace the ledger. Missing or historical observations do not establish current job liveness.", "",
    "## Admission and resources", "",
    `Global admission: **${state.globalAuthority.stopped ? "stopped" : "open"}** (epoch ${state.globalAuthority.epoch}).`,
    state.projectAuthority ? `Project admission: **${state.projectAuthority.stopped ? "stopped" : "open"}** (epoch ${state.projectAuthority.epoch}).` : "Project authority: not configured.",
    "An open barrier alone does not authorize work: policy, validation, allowances and worker capability are also required.", "",
  ];
  for (const scope of [state.globalAuthority, state.projectAuthority]) {
    if (scope?.reason) lines.push(`${cell(scope.scopeId)} last authority-change reason: ${cell(scope.reason)}`, "");
  }
  lines.push("| Scope | Limit (microdollars) | Recorded charges | Remaining reservation | Available |",
    "|---|---:|---:|---:|---:|");
  for (const budget of [state.globalBudget, state.projectBudget]) {
    if (budget) lines.push(`| ${cell(budget.scopeId)} | ${budget.limitMicrodollars} | ${budget.chargedMicrodollars} | ${budget.outstandingMicrodollars} | ${budget.availableMicrodollars} |`);
  }
  if (!state.globalBudget && !state.projectBudget) lines.push("| Not configured | — | — | — | — |");
  lines.push("", "Amounts describe ledger accounting, not a provider invoice or a guarantee that external liability has ended. Global figures include other projects.", "",
    "## Registered experiments", "", `${state.runs.length} registered run(s). Execution and evaluation are separate recorded facts.`, "");
  if (state.runs.length) {
    lines.push("| Run | Manifest | Execution | Evaluation |", "|---|---|---|---|");
    for (const run of state.runs.slice(-30)) lines.push(`| ${cell(run.runId)} | ${run.manifestDigest} | ${run.execution} | ${run.evaluation} |`);
    if (state.runs.length > 30) lines.push("", `Showing the latest 30 registrations; state.json contains all ${state.runs.length}.`);
  }
  const unresolved = state.actions.filter(action => !action.reservation.finalized);
  lines.push("", "## Unresolved actions", "", `${unresolved.length} action(s) have unfinalized exposure. This includes never-dispatched reservations; it does not mean all are running.`, "");
  if (unresolved.length) {
    lines.push("| Action | Dispatch | Job | Allocation | Charges / remaining reservation |", "|---|---|---|---|---|");
    for (const action of unresolved.slice(0, 30)) lines.push(`| ${cell(action.actionId)} | ${action.state} | ${cell(action.jobId ?? "unconfirmed")} | ${action.allocation} | ${action.reservation.chargedMicrodollars} / ${action.reservation.outstandingMicrodollars} |`);
    if (unresolved.length > 30) lines.push("", `Showing the first 30 unresolved actions; state.json contains all ${state.actions.length} actions. Do not treat omitted actions as settled.`);
  }
  lines.push("", "## Observation references", "", `${state.observations.length} archived observation(s). Full archived observation payloads remain in the ledger; state.json contains their identities and content digests.`, "");
  for (const observation of state.observations.slice(-20)) lines.push(`- ${cell(observation.eventId)} — ${cell(observation.source)}, ${observation.observedAt}, run ${cell(observation.runId ?? "unregistered")}; digest ${observation.digest}.`);
  if (state.observations.length > 20) lines.push("", "Only the latest 20 observation references are shown here.");
  lines.push("", "## Continuity limits", "",
    "Keep hypotheses, literature claims, council decisions and unresolved scientific objections in their linked research records. This operational snapshot cannot infer them from metrics or replace them. A newer snapshot supersedes this view; it does not rewrite the underlying events.", "");
  return lines.join("\n");
}

/** Publish JSON and Markdown from one captured state in one same-filesystem rename.
 * This is atomic directory publication, not a power-loss-certified backup procedure.
 */
export async function writeProjectSummary(ledger: ExperimentLedger, projectId: string, outputDirectory: string,
  now = new Date()): Promise<{ directory: string; markdownPath: string; snapshotPath: string; digest: string }> {
  const state = capture(ledger, projectId, now);
  const json = `${JSON.stringify(state, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2)}\n`;
  const digest = createHash("sha256").update(json).digest("hex");
  const markdown = render(state, digest);
  outputDirectory = resolve(outputDirectory);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const directory = join(outputDirectory, `${projectId}-${state.throughEvent}-${digest}`);
  const markdownPath = join(directory, "PROJECT.md"), snapshotPath = join(directory, "state.json");
  const temporary = await mkdtemp(join(outputDirectory, ".project-state-"));
  try {
    await writeFile(join(temporary, "state.json"), json, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await writeFile(join(temporary, "PROJECT.md"), markdown, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { await rename(temporary, directory); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      const [existingJson, existingMarkdown] = await Promise.all([readFile(snapshotPath, "utf8"), readFile(markdownPath, "utf8")]);
      if (existingJson !== json || existingMarkdown !== markdown) throw new Error("Existing project bundle conflicts with its content identity");
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return { directory, markdownPath, snapshotPath, digest };
}
