import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openExperimentLedger } from "../../src/ledger/index.ts";
import type { ObservationInput } from "../../src/ledger/index.ts";
import { writeProjectSummary } from "../../src/controller/project-summary.ts";

const now = new Date("2026-11-02T12:00:00.000Z");
function observation(eventId: string): ObservationInput {
  return { eventId, projectId: "study", runId: null, actionId: null, jobId: null,
    source: "fixture", sequence: 0, observedAt: now.toISOString(), payload: { historical: true } };
}

test("JSON and Markdown preserve one ledger snapshot when state changes during publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-summary-"));
  const ledger = openExperimentLedger({ path: join(directory, "ledger.sqlite"), now: () => now });
  try {
    ledger.appendObservation(observation("first-capture"));
    const publication = writeProjectSummary(ledger, "study", join(directory, "summaries"), now);
    ledger.appendObservation(observation("later-capture"));
    ledger.stopScope({ scopeId: "global", expectedEpoch: ledger.getScope("global").epoch, reason: "Later stop" });
    const result = await publication;
    const json = await readFile(result.snapshotPath, "utf8");
    const markdown = await readFile(result.markdownPath, "utf8");
    const state = JSON.parse(json);
    assert.equal(state.observations.length, 1);
    assert.equal(state.observations[0].eventId, "first-capture");
    assert.equal(state.globalAuthority.stopped, false);
    assert.equal(state.runs.length, 0);
    assert.match(markdown, /Global admission: \*\*open\*\*/);
    assert.match(markdown, /first-capture/);
    assert.doesNotMatch(markdown, /later-capture|Later stop/);
    assert.equal(createHash("sha256").update(json).digest("hex"), result.digest);
    assert.match(markdown, new RegExp(result.digest));
    assert.equal(ledger.getScope("global").stopped, true);
  } finally { ledger.close(); await rm(directory, { recursive: true, force: true }); }
});

test("publication retries preserve exact money and reject a corrupted existing bundle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-summary-retry-"));
  const ledger = openExperimentLedger({ path: join(directory, "ledger.sqlite"), now: () => now });
  try {
    ledger.configureBudget({ scopeId: "global", parentScopeId: null, expectedRevision: 0, limitMicrodollars: 9_007_199_254_740_993n });
    const first = await writeProjectSummary(ledger, "study", join(directory, "summaries"), now);
    const repeated = await writeProjectSummary(ledger, "study", join(directory, "summaries"), now);
    assert.deepEqual(repeated, first);
    assert.equal(JSON.parse(await readFile(first.snapshotPath, "utf8")).globalBudget.limitMicrodollars, "9007199254740993");
    await writeFile(first.markdownPath, "tampered summary");
    await assert.rejects(writeProjectSummary(ledger, "study", join(directory, "summaries"), now), /conflicts/);
    assert.equal(await readFile(first.markdownPath, "utf8"), "tampered summary");
  } finally { ledger.close(); await rm(directory, { recursive: true, force: true }); }
});
