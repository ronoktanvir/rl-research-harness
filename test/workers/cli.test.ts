import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { test } from "node:test";
import { hasSubscriptionAuthentication, parseCliResult, reviewArguments, runCliReview, subscriptionEnvironment } from "../../src/workers/cli.ts";
import type { ProcessRequest, ProcessResult } from "../../src/workers/process.ts";

const result = (stdout: string, overrides: Partial<ProcessResult> = {}): ProcessResult => ({
  stdout, stderr: "", exitCode: 0, stopped: null, ...overrides,
});
const codexSuccess = [
  { type: "thread.started", thread_id: "task-1" },
  { type: "item.completed", item: { type: "agent_message", text: '{"verdict":"revise"}' } },
  { type: "turn.completed", usage: { input_tokens: 20, output_tokens: 7 } },
].map((event) => JSON.stringify(event)).join("\n");

test("successful clients preserve final answer and token usage without inventing a dollar bill", () => {
  const codex = parseCliResult("codex", result(codexSuccess));
  assert.equal(codex.status, "succeeded");
  assert.equal(codex.text, '{"verdict":"revise"}');
  assert.deepEqual(codex.usage, { input_tokens: 20, output_tokens: 7 });
  const claude = parseCliResult("claude", result(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "check the evaluator", total_cost_usd: 0.1 })));
  assert.equal(claude.status, "succeeded");
  assert.equal("cost" in claude, false);
});

test("partial output, nonzero exit and failed turns cannot become completed reviews", () => {
  assert.equal(parseCliResult("codex", result(codexSuccess.split("\n").slice(0, 2).join("\n"))).status, "failed");
  assert.equal(parseCliResult("codex", result(codexSuccess, { exitCode: 1 })).status, "failed");
  assert.equal(parseCliResult("codex", result(`${codexSuccess}\n${JSON.stringify({ type: "turn.failed", error: { message: "failure" } })}`)).status, "failed");
});

test("quota and auth failures return explicit outcomes without falling back to paid APIs", () => {
  assert.equal(parseCliResult("codex", result(JSON.stringify({ type: "turn.failed", error: { message: "Usage limit exceeded" } }), { exitCode: 1 })).status, "rate_limited");
  assert.equal(parseCliResult("claude", result(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "not logged in" }))).status, "auth_required");
  assert.equal(parseCliResult("claude", result("garbage")).diagnostic, "invalid_client_output");
  assert.equal(parseCliResult("codex", result('{"type":"error","message":"429 too many requests"}', { exitCode: 1 })).status, "rate_limited");
});

test("timeouts and cancellation discard even a seemingly complete partial response", () => {
  assert.equal(parseCliResult("codex", result(codexSuccess, { stopped: "timeout" })).status, "timed_out");
  assert.equal(parseCliResult("codex", result(codexSuccess, { stopped: "cancelled" })).status, "cancelled");
});

test("subscription process environment excludes API credentials, gateways and nested agent overrides", () => {
  const env = subscriptionEnvironment({ HOME: "/home/research", PATH: "/bin", OPENAI_API_KEY: "secret", ANTHROPIC_API_KEY: "secret", CODEX_API_KEY: "secret", ANTHROPIC_BASE_URL: "https://proxy.invalid", CLAUDECODE: "1", AWS_SECRET_ACCESS_KEY: "secret" });
  assert.equal(env.HOME, "/home/research");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.CLAUDECODE, undefined);
  const oauth = { CLAUDE_CODE_OAUTH_TOKEN: "test-client-token" };
  assert.equal(subscriptionEnvironment(oauth, "claude").CLAUDE_CODE_OAUTH_TOKEN, "test-client-token");
  assert.equal(subscriptionEnvironment(oauth, "codex").CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test("API-authenticated or unrecognized clients do not pass subscription preflight", () => {
  assert.equal(hasSubscriptionAuthentication("codex", result("", { stderr: "Logged in using ChatGPT\n" })), true);
  assert.equal(hasSubscriptionAuthentication("codex", result("Logged in using an API key")), false);
  assert.equal(hasSubscriptionAuthentication("claude", result('{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}')), false);
  assert.equal(hasSubscriptionAuthentication("claude", result('{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}')), true);
});

test("reviews use empty temporary workspaces, stdin prompts and constrained client options", async () => {
  const requests: ProcessRequest[] = [];
  const response = await runCliReview({ backend: "codex", prompt: "Private evidence", model: "model-id" }, {
    execute: async (request) => {
      requests.push(request);
      return requests.length === 1 ? result("Logged in using ChatGPT") : result(codexSuccess);
    },
  });
  assert.equal(response.status, "succeeded");
  assert.equal(requests.length, 2);
  const request = requests[1]!;
  assert.equal(request.input, "Private evidence");
  assert.equal(request.args.includes("Private evidence"), false);
  assert.equal(request.args.includes("read-only"), true);
  assert.equal(request.args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  await assert.rejects(access(request.cwd));
  const args = reviewArguments("claude");
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args.includes("--safe-mode"), true);
  assert.equal(args.includes("--bare"), false); // --bare deliberately disables subscription auth.
});

test("failed subscription preflight prevents any model invocation", async () => {
  let calls = 0;
  const response = await runCliReview({ backend: "claude", prompt: "hello" }, {
    execute: async () => { calls++; return result('{"loggedIn":false}'); },
  });
  assert.equal(response.status, "auth_required");
  assert.equal(calls, 1);
});

test("preflight operational failures are not misreported as a need to log in", async () => {
  for (const [stopped, status] of [["timeout", "timed_out"], ["cancelled", "cancelled"], ["spawn_error", "failed"], ["output_limit", "failed"]] as const) {
    const response = await runCliReview({ backend: "codex", prompt: "hello" }, { execute: async () => result("", { stopped }) });
    assert.equal(response.status, status);
    assert.equal(response.diagnostic, `auth_check_${stopped}`);
  }
});
