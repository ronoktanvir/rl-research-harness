"use strict";

// Deliberately small CPU-only service fixture. It has no network operations and
// writes only the one marker in a private directory created by its test owner.
const { appendFileSync, lstatSync, realpathSync, readFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { basename, dirname, isAbsolute, join } = require("node:path");
const { tmpdir } = require("node:os");

const [mode, marker, literal = ""] = process.argv.slice(2);
if (!process.getuid || process.getuid() === 0) throw new Error("Fixture must run as a non-root user");
if (!["success", "failure", "wait", "tree", "child"].includes(mode)) throw new Error("Unknown fixture mode");
if (!marker || !isAbsolute(marker) || basename(marker) !== "events.jsonl") throw new Error("Invalid fixture marker");
const directory = dirname(marker);
const stat = lstatSync(directory);
if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid()
  || (stat.mode & 0o077) !== 0 || dirname(realpathSync(directory)) !== realpathSync(tmpdir())
  || !basename(directory).startsWith("rlh-systemd-fixture-")) {
  throw new Error("Fixture directory must be private, owned, and temporary");
}
if (marker !== join(directory, "events.jsonl")) throw new Error("Invalid marker location");
const processStat = readFileSync("/proc/self/stat", "utf8");
const processStartTicks = processStat.slice(processStat.lastIndexOf(")") + 2).split(" ")[19];
if (!/^\d+$/.test(processStartTicks)) throw new Error("Missing process start identity");

function record(event, detail = {}) {
  appendFileSync(marker, `${JSON.stringify({ event, pid: process.pid, parentPid: process.ppid,
    uid: process.getuid(), processStartTicks, mode, ...detail })}\n`, { encoding: "utf8", mode: 0o600 });
}

// This fallback is independent of systemd. A broken supervisor test must not
// leave a fixture running indefinitely; the test must observe cleanup earlier.
setTimeout(() => { record("fallback_exit"); process.exit(99); }, 12_000);
if (mode === "wait" || mode === "tree" || mode === "child") {
  process.on("SIGTERM", () => record("ignored_sigterm"));
}
record("started", { literal, cgroup: readFileSync("/proc/self/cgroup", "utf8") });

if (mode === "success" || mode === "failure") {
  setTimeout(() => { const code = mode === "success" ? 0 : 23; record("exit", { code }); process.exit(code); }, 350);
} else if (mode === "tree") {
  // A distinct process group ensures a parent-only process-group kill would
  // leave the child alive; control-group termination must reach both processes.
  const child = spawn(process.execPath, [__filename, "child", marker], { detached: true, stdio: "ignore" });
  child.once("error", error => { record("spawn_error", { message: error.message }); process.exit(24); });
  child.unref();
}
