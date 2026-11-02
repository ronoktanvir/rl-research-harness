import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../src/workers/process.ts";
import type { ProcessRequest } from "../../src/workers/process.ts";

function request(script: string, overrides: Partial<ProcessRequest> = {}): ProcessRequest {
  return { executable: process.execPath, args: ["-e", script], cwd: process.cwd(), env: {}, input: "", timeoutMs: 2_000, maxOutputBytes: 4_096, ...overrides };
}

test("subprocess receives stdin literally without shell expansion", async () => {
  const response = await runProcess(request("process.stdin.pipe(process.stdout)", { input: '$(not-a-command) `literal` $HOME' }));
  assert.equal(response.stdout, '$(not-a-command) `literal` $HOME');
  assert.equal(response.exitCode, 0);
});

test("a deadline terminates a hung subprocess", async () => {
  const started = Date.now();
  const response = await runProcess(request("setInterval(()=>{},100)", { timeoutMs: 100 }));
  assert.equal(response.stopped, "timeout");
  assert.ok(Date.now() - started < 2_000);
});

test("output flood is bounded and stopped", async () => {
  const response = await runProcess(request("setInterval(()=>process.stdout.write('x'.repeat(65536)),1)", { maxOutputBytes: 1_000 }));
  assert.equal(response.stopped, "output_limit");
  assert.ok(Buffer.byteLength(response.stdout) <= 1_000);
});

test("abort and missing executables return explicit outcomes", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const response = await runProcess(request("setInterval(()=>{},100)", { signal: controller.signal }));
  assert.equal(response.stopped, "cancelled");
  const absent = await runProcess(request("", { executable: "/missing/rl-harness-worker" }));
  assert.equal(absent.stopped, "spawn_error");
});

test("timeout kills a TERM-ignoring descendant even after the direct child closes", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-process-test-"));
  const pidFile = join(directory, "descendant.pid");
  const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},100)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'}); setInterval(()=>{},100)`;
  let pid: number | undefined;
  try {
    const response = await runProcess(request(parent, { timeoutMs: 500 }));
    pid = Number(await readFile(pidFile, "utf8"));
    assert.equal(response.stopped, "timeout");
    // Give the OS a short interval to reap the orphan after the SIGKILL.
    let alive = true;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { process.kill(pid, 0); } catch { alive = false; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(alive, false, "Descendant survived cancellation escalation");
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } }
    await rm(directory, { recursive: true, force: true });
  }
});
