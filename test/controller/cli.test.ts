import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { openExperimentLedger } from "../../src/ledger/index.ts";

const execute = promisify(execFile);
async function command(...args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execute(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { timeout: 10_000 });
  return JSON.parse(stdout) as Record<string, unknown>;
}

test("operator commands persist independent global and project stop barriers across processes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-operator-"));
  const path = join(directory, "ledger.sqlite");
  try {
    const initial = await command("ledger-status", path, "future-project");
    assert.equal(initial.projectAuthority, null);
    assert.equal(initial.actionCount, 0);
    await command("ledger-stop", path, "project:future-project", "Preemptive project stop");
    await command("ledger-stop", path, "global", "Global maintenance");
    await command("ledger-resume", path, "global", "Global maintenance complete");
    const status = await command("ledger-status", path, "future-project");
    assert.equal((status.globalAuthority as { stopped: boolean }).stopped, false);
    assert.equal((status.projectAuthority as { stopped: boolean }).stopped, true);
    await command("ledger-resume", path, "project:future-project", "Project explicitly resumed");
    const resumed = await command("ledger-status", path, "future-project");
    assert.equal((resumed.projectAuthority as { stopped: boolean }).stopped, false);
    await assert.rejects(command("ledger-resume", path, "project:missing", "No scope exists"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("operator CLI refuses to take ownership from a running controller", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-operator-owner-"));
  const path = join(directory, "ledger.sqlite");
  const owner = openExperimentLedger({ path });
  try { await assert.rejects(command("ledger-status", path, "study"), /Another controller owns/); }
  finally { owner.close(); await rm(directory, { recursive: true, force: true }); }
});
