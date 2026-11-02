import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./process.ts";
import type { ProcessRequest, ProcessResult } from "./process.ts";

export type CliBackend = "codex" | "claude";
export type CliStatus = "succeeded" | "rate_limited" | "auth_required" | "failed" | "cancelled" | "timed_out";

export interface CliTask {
  backend: CliBackend;
  prompt: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CliTaskResult {
  backend: CliBackend;
  status: CliStatus;
  text: string;
  sessionId?: string;
  usage?: Record<string, number>;
  billing: "client_managed_account";
  diagnostic?: string;
}

export interface CliWorkerOptions {
  executables?: Partial<Record<CliBackend, string>>;
  environment?: NodeJS.ProcessEnv;
  execute?: (request: ProcessRequest) => Promise<ProcessResult>;
}

export function hasSubscriptionAuthentication(backend: CliBackend, result: ProcessResult): boolean {
  if (result.stopped || result.exitCode !== 0) return false;
  if (backend === "codex") return /^Logged in using ChatGPT\s*$/m.test(`${result.stdout}\n${result.stderr}`);
  try {
    const status: unknown = JSON.parse(result.stdout);
    return object(status) && status.loggedIn === true && status.authMethod === "oauth_token" && status.apiProvider === "firstParty";
  } catch { return false; }
}

/** Keep ordinary OS/login context; never pass API billing overrides to a subscription worker. */
export function subscriptionEnvironment(source: NodeJS.ProcessEnv, backend?: CliBackend): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  // Forward an already configured official-client OAuth token only to that client.
  // Never inspect, log, persist, refresh, or send it to our own provider/API code.
  if (backend === "claude" && source.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = source.CLAUDE_CODE_OAUTH_TOKEN;
  // Authentication remains inside the official clients; this code never reads their token files.
  env.CI = "1";
  env.NO_COLOR = "1";
  return env;
}

const CODEX_DISABLED_FEATURES = [
  "shell_tool", "unified_exec", "apps", "plugins", "multi_agent", "hooks",
  "browser_use", "computer_use", "code_mode", "code_mode_host", "image_generation",
  "in_app_browser", "view_image", "sleep_tool",
];

export function reviewArguments(backend: CliBackend, model?: string): string[] {
  if (model !== undefined && (!model.trim() || model.length > 200 || /[\r\n\0]/.test(model))) {
    throw new Error("model must be a nonempty single-line identifier");
  }
  const args = backend === "codex"
    ? ["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
      "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never",
      "-c", 'approval_policy="never"', "-c", 'model_provider="openai"',
      "-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0",
      ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature])]
    : ["--print", "--output-format", "json", "--safe-mode", "--restricted",
      "--tools", "", "--strict-mcp-config", "--setting-sources", "",
      "--permission-prompts", "none", "--no-session-persistence"];
  if (model !== undefined) args.push("--model", model);
  if (backend === "codex") args.push("-");
  return args;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function usage(value: unknown): Record<string, number> | undefined {
  if (!object(value)) return undefined;
  const selected: Record<string, number> = {};
  for (const key of ["input_tokens", "output_tokens", "cached_input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
    const item = value[key];
    if (typeof item === "number" && Number.isSafeInteger(item) && item >= 0) selected[key] = item;
  }
  return Object.keys(selected).length ? selected : undefined;
}

function failureStatus(message: string): CliStatus {
  if (/rate.?limit|usage.?limit|quota.?exceed|too many requests|\b429\b/i.test(message)) return "rate_limited";
  if (/not logged in|authentication|unauthorized|please log.?in|\b401\b/i.test(message)) return "auth_required";
  return "failed";
}

/** Parse only final client protocol results. A partial answer cannot count as a completed review. */
export function parseCliResult(backend: CliBackend, result: ProcessResult): CliTaskResult {
  const base = { backend, text: "", billing: "client_managed_account" as const };
  if (result.stopped) {
    const status = result.stopped === "timeout" ? "timed_out" : result.stopped === "cancelled" ? "cancelled" : "failed";
    return { ...base, status, diagnostic: result.stopped };
  }
  let text = "";
  let sessionId: string | undefined;
  let tokenUsage: Record<string, number> | undefined;
  let completed = false;
  const failures: string[] = [];
  const errors: string[] = [];
  try {
    if (backend === "claude") {
      const event: unknown = JSON.parse(result.stdout);
      if (!object(event) || event.type !== "result") throw new Error("No Claude result record");
      completed = event.subtype === "success" && event.is_error === false;
      if (typeof event.result === "string") text = event.result;
      if (typeof event.session_id === "string") sessionId = event.session_id;
      tokenUsage = usage(event.usage);
      if (!completed) failures.push(JSON.stringify(event));
    } else {
      for (const line of result.stdout.split("\n")) {
        if (!line.trim()) continue;
        const event: unknown = JSON.parse(line);
        if (!object(event)) throw new Error("Invalid Codex event");
        if (event.type === "thread.started" && typeof event.thread_id === "string") sessionId = event.thread_id;
        if (event.type === "item.completed" && object(event.item) && event.item.type === "agent_message" && typeof event.item.text === "string") text = event.item.text;
        if (event.type === "turn.completed") { completed = true; tokenUsage = usage(event.usage); }
        if (event.type === "turn.failed") { completed = false; failures.push(JSON.stringify(event.error)); }
        if (event.type === "error") errors.push(JSON.stringify(event));
      }
    }
  } catch {
    return { ...base, status: failureStatus(result.stderr), diagnostic: "invalid_client_output" };
  }
  if (result.exitCode !== 0 || !completed || failures.length || !text.trim()) {
    return { ...base, status: failureStatus([...failures, ...errors, result.stderr].join("\n")), diagnostic: "client_did_not_complete" };
  }
  return {
    ...base, status: "succeeded", text,
    ...(sessionId ? { sessionId } : {}),
    ...(tokenUsage ? { usage: tokenUsage } : {}),
  };
}

/** A bounded evidence-only reviewer. It never switches to an API key or another account. */
export async function runCliReview(task: CliTask, options: CliWorkerOptions = {}): Promise<CliTaskResult> {
  if (task.backend !== "codex" && task.backend !== "claude") throw new Error("Unsupported CLI backend");
  if (!task.prompt.trim() || Buffer.byteLength(task.prompt) > 512_000) throw new Error("Prompt must contain 1–512,000 bytes");
  const args = reviewArguments(task.backend, task.model);
  const cwd = await mkdtemp(join(tmpdir(), "rl-harness-review-"));
  try {
    const execute = options.execute ?? runProcess;
    const executable = options.executables?.[task.backend] ?? task.backend;
    const env = subscriptionEnvironment(options.environment ?? process.env, task.backend);
    const auth = await execute({
      executable,
      args: task.backend === "codex" ? ["login", "status"] : ["auth", "status"],
      cwd, env, input: "", timeoutMs: 10_000, maxOutputBytes: 32_000,
      ...(task.signal ? { signal: task.signal } : {}),
    });
    if (!hasSubscriptionAuthentication(task.backend, auth)) {
      const status: CliStatus = auth.stopped === "cancelled" ? "cancelled" : auth.stopped === "timeout" ? "timed_out" : auth.stopped ? "failed" : "auth_required";
      return {
        backend: task.backend,
        status,
        text: "", billing: "client_managed_account",
        diagnostic: auth.stopped ? `auth_check_${auth.stopped}` : "subscription_authentication_not_verified",
      };
    }
    const result = await execute({
      executable, args, cwd, env,
      input: task.prompt,
      timeoutMs: task.timeoutMs ?? 120_000,
      maxOutputBytes: 2_000_000,
      ...(task.signal ? { signal: task.signal } : {}),
    });
    return parseCliResult(task.backend, result);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
