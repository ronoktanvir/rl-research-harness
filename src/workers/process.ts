import { spawn } from "node:child_process";

export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stopped: "timeout" | "cancelled" | "output_limit" | "spawn_error" | null;
}

/** A bounded child process, without a shell or retries. Private prompts travel on stdin. */
export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 3_600_000) {
    throw new Error("timeoutMs must be between 1 and 3,600,000");
  }
  if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1) {
    throw new Error("maxOutputBytes must be a positive safe integer");
  }
  if (request.signal?.aborted) {
    return { exitCode: null, stdout: "", stderr: "", stopped: "cancelled" };
  }
  return new Promise((resolve) => {
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let stopped: ProcessResult["stopped"] = null;
    let finished = false;
    let closed = false;
    let exitCode: number | null = null;
    let escalated = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      // A direct child can exit before its descendants. Keep the process-group
      // escalation alive, and do not report cancellation complete before it runs.
      if (finished || !closed || (escalation && !escalated)) return;
      finished = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, stdout: Buffer.concat(output).toString("utf8"), stderr: Buffer.concat(errors).toString("utf8"), stopped });
    };
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // An already-exited group is normal during cancellation races.
      }
    };
    const stop = (reason: NonNullable<ProcessResult["stopped"]>) => {
      if (finished || stopped) return;
      stopped = reason;
      kill("SIGTERM");
      escalation = setTimeout(() => { kill("SIGKILL"); escalated = true; finish(); }, 250);
    };
    const onAbort = () => stop("cancelled");
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => stop("timeout"), request.timeoutMs);
    const collect = (buffer: Buffer, destination: Buffer[]) => {
      const remaining = Math.max(0, request.maxOutputBytes - bytes);
      if (remaining > 0) destination.push(buffer.subarray(0, remaining));
      bytes += buffer.length;
      if (bytes > request.maxOutputBytes) stop("output_limit");
    };
    child.stdout.on("data", (buffer: Buffer) => collect(buffer, output));
    child.stderr.on("data", (buffer: Buffer) => collect(buffer, errors));
    child.stdin.on("error", () => { /* A process may exit before consuming stdin. */ });
    child.on("error", () => { stopped ??= "spawn_error"; });
    child.on("close", (code) => {
      closed = true;
      exitCode = code;
      finish();
    });
    // Recheck after registering the listener, covering abort between the first check and spawn.
    if (request.signal?.aborted) onAbort();
    child.stdin.end(request.input);
  });
}
