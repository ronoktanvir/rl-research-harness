import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { prepareCoworkerAttempt } from "../../src/integrations/coworker/attempt-plan.ts";
import { coworkerAttemptFixture } from "../integrations/coworker-attempt-fixtures.ts";

const execute = promisify(execFile);

test("CLI previews a synthetic attempt without reading trainer paths or creating runtime state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-plan-cli-"));
  const requestPath = join(directory, "request.json");
  try {
    const input = coworkerAttemptFixture();
    await writeFile(requestPath, JSON.stringify(input));
    const { stdout } = await execute(process.execPath, ["--import", "tsx", "src/cli.ts", "coworker-plan", requestPath], { timeout: 10_000 });
    const plan = JSON.parse(stdout) as ReturnType<typeof prepareCoworkerAttempt>;
    assert.deepEqual(plan, prepareCoworkerAttempt(input));
    assert.equal(plan.launchSupported, false);
    assert.equal(plan.qualification, "declarations_only");
    assert.deepEqual(await readdir(directory), ["request.json"]);

    input.manifest.digest = "0".repeat(64);
    await writeFile(requestPath, JSON.stringify(input));
    await assert.rejects(execute(process.execPath, ["--import", "tsx", "src/cli.ts", "coworker-plan", requestPath], { timeout: 10_000 }), /manifest digest mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
