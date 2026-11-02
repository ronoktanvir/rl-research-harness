import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import {
  configure, createRegistry, defineExtension, defineTask, defineTool,
  type Extension, type Registry, type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { openPiRuntime, type AgentRuntime } from "../../src/runtime/index.ts";
import { deferred } from "./helpers.ts";

const agent = { model: { provider: "faux", modelId: "faux-1" } };
const settings = { compaction: { enabled: false }, retry: { enabled: false }, stream: { maxRetries: 0 } };

function setup(faux: FauxProviderHandle = fauxProvider()) {
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, faux };
}

function untilAborted(context: Context): Promise<never> {
  return new Promise((_resolve, reject) => {
    const signal = context.abortSignal;
    if (signal?.aborted) { reject(new Error("cancelled")); return; }
    signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  });
}

test("tool results, request identity and conversation survive close/reopen", { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-runtime-"));
  const { models, faux } = setup();
  let invocations = 0;
  const registry = createRegistry();
  registry.install(defineExtension({ name: "evidence", tools: [defineTool({
    name: "lookup", description: "Read fixed qualification evidence", parameters: Type.Object({}), replay: "safe",
    execute: async () => {
      invocations += 1;
      return { output: [{ type: "text", text: "baseline reward is 12" }] };
    },
  })] }));
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("lookup", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("The recorded baseline reward is 12."),
  ]);
  const options = { storagePath: join(dir, "agent.sqlite"), models, registry, initialAgent: agent, settings };
  let runtime: AgentRuntime | undefined;
  try {
    runtime = await openPiRuntime(options);
    await assert.rejects(openPiRuntime(options), /already open/);
    const request = { requestId: "baseline-1", message: "Inspect the baseline" };
    const receipt = await runtime.submit(request);
    const result = await runtime.wait(receipt.id, { signal: AbortSignal.timeout(5_000) });
    assert.equal(result.status, "done");
    if (result.status === "done") assert.match(result.text, /12/);
    assert.equal(invocations, 1);
    assert.ok((await runtime.history()).some((item) => item.kind === "pi.tool-result" && item.text.includes("12")));
    assert.ok(Object.hasOwn((await runtime.usage()).models, "faux/faux-1"));
    const root = runtime.rootConversationId;
    await runtime.close();
    runtime = await openPiRuntime(options);
    assert.equal(runtime.rootConversationId, root);
    assert.deepEqual(await runtime.submit(request), receipt);
    assert.deepEqual(await runtime.wait(receipt.id), result);
    await assert.rejects(runtime.submit({ ...request, message: "Different payload" }), /different message/);
    assert.equal(faux.state.callCount, 2);
    assert.equal(invocations, 1);
  } finally {
    await runtime?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("admission snapshots request fields once, including getters and later mutation", { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-snapshot-"));
  const { models, faux } = setup();
  faux.setResponses([fauxAssistantMessage("First answer"), fauxAssistantMessage("Second answer")]);
  const runtime = await openPiRuntime({ storagePath: join(dir, "agent.sqlite"), models, initialAgent: agent, settings });
  try {
    const reads = { requestId: 0, message: 0, conversationId: 0 };
    const getterRequest = {
      get requestId() { return ++reads.requestId === 1 ? "getter-request" : "changed-id"; },
      get message() { return ++reads.message === 1 ? "Original getter message" : "Changed getter message"; },
      get conversationId() { return ++reads.conversationId === 1 ? runtime.rootConversationId : "invalid"; },
    };
    const first = await runtime.submit(getterRequest);
    assert.equal(first.requestId, "getter-request");
    assert.deepEqual(reads, { requestId: 1, message: 1, conversationId: 1 });
    await runtime.wait(first.id, { signal: AbortSignal.timeout(5_000) });
    assert.deepEqual(await runtime.submit({ requestId: "getter-request", message: "Original getter message" }), first);

    const mutableRequest = { requestId: "mutable-request", message: "Original mutable message", conversationId: runtime.rootConversationId };
    const pending = runtime.submit(mutableRequest);
    mutableRequest.requestId = "changed-id";
    mutableRequest.message = "Changed mutable message";
    mutableRequest.conversationId = "invalid";
    const second = await pending;
    assert.equal(second.requestId, "mutable-request");
    await runtime.wait(second.id, { signal: AbortSignal.timeout(5_000) });
    assert.deepEqual(await runtime.submit({ requestId: "mutable-request", message: "Original mutable message" }), second);
    await assert.rejects(runtime.submit({ requestId: "mutable-request", message: "Changed mutable message" }), /different message/);

    const userMessages = (await runtime.history()).filter((item) => item.kind === "pi.user").map((item) => item.text);
    assert.deepEqual(userMessages, ["Original getter message", "Original mutable message"]);
    assert.equal(faux.state.callCount, 2);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function crashDuringTool(storagePath: string, policy: "safe" | "unsafe"): Promise<string> {
  const fixture = fileURLToPath(new URL("./fixtures/crash-worker.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", fixture, storagePath, policy], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const closed = once(child, "close");
  try {
    const ready = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Worker startup timed out: ${stderr}`)), 8_000);
      let buffer = "";
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`Worker exited before ready: ${code}/${signal} ${stderr}`)); });
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        try {
          const value: unknown = JSON.parse(buffer.slice(0, newline));
          if (typeof value !== "object" || value === null || !("submissionId" in value) || typeof value.submissionId !== "string") {
            throw new Error("Invalid worker ready record");
          }
          resolve(value.submissionId);
        } catch (error) { reject(error); }
      });
    });
    child.kill("SIGKILL");
    const [code, signal] = await closed;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
    return ready;
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
  }
}

for (const policy of ["safe", "unsafe"] as const) {
  test(`SIGKILL recovery respects ${policy} tool replay policy`, { timeout: 15_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), `pi-${policy}-`));
    let runtime: AgentRuntime | undefined;
    try {
      const storagePath = join(dir, "agent.sqlite");
      const submissionId = await crashDuringTool(storagePath, policy);
      const { models, faux } = setup();
      faux.setResponses([fauxAssistantMessage("Recovery inspected.")]);
      let recoveredInvocations = 0;
      const registry = createRegistry();
      registry.install(defineExtension({ name: "qualification", tools: [defineTool({
        name: "hold", description: "Controlled test tool", parameters: Type.Object({}), replay: policy,
        execute: async () => {
          recoveredInvocations += 1;
          return { output: [{ type: "text", text: "recovered safe work" }] };
        },
      })] }));
      runtime = await openPiRuntime({ storagePath, models, registry, initialAgent: agent, settings });
      assert.equal((await runtime.wait(submissionId, { signal: AbortSignal.timeout(5_000) })).status, "done");
      assert.equal(recoveredInvocations, policy === "safe" ? 1 : 0);
      const toolResults = (await runtime.history()).filter((item) => item.kind === "pi.tool-result");
      assert.equal(toolResults.length, 1);
      assert.match(toolResults[0]!.text, policy === "safe" ? /recovered safe work/ : /interrupted/);
      assert.equal((await runtime.inspect()).tasks.length, 0);
    } finally {
      await runtime?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("cancelling a waiter preserves work; cancelling its conversation stops it", { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cancel-"));
  const { models, faux } = setup();
  const started = deferred<void>();
  let aborted = false;
  const registry = createRegistry();
  registry.install(defineExtension({ name: "blocking", tools: [defineTool({
    name: "block", description: "Wait for cancellation", parameters: Type.Object({}),
    execute: async (_args, _api, context) => {
      started.resolve();
      try { return await untilAborted(context); }
      finally { aborted = true; }
    },
  })] }));
  faux.setResponses([fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" })]);
  const runtime = await openPiRuntime({ storagePath: join(dir, "agent.sqlite"), models, registry, initialAgent: agent, settings });
  try {
    const receipt = await runtime.submit({ requestId: "wait-test", message: "Wait" });
    await started.promise;
    await assert.rejects(runtime.wait(receipt.id, { signal: AbortSignal.timeout(20) }));
    assert.equal(aborted, false);
    assert.ok((await runtime.inspect()).tasks.length > 0);
    await runtime.cancel();
    assert.equal(aborted, true);
    assert.equal((await runtime.wait(receipt.id)).status, "unanswered");
    assert.equal((await runtime.inspect()).tasks.length, 0);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function registerChildTool(registry: Registry, started: { resolve: (id: string) => void }, aborted: () => void): void {
  const block = defineTool({
    name: "child_work", description: "Controlled child work", parameters: Type.Object({}),
    execute: async (_args, api, context) => {
      started.resolve(String(api.conversationId));
      try { return await untilAborted(context); }
      finally { aborted(); }
    },
  });
  const delegate: Extension = defineExtension({ name: "owned_child", tools: [defineTool({
    name: "delegate", description: "Delegate a controlled qualification task", parameters: Type.Object({}), replay: "safe",
    execute: async (_args, api: ToolExecutionApi, context: Context) => {
      const id = await api.commit(async (tx) => {
        const prior = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (prior !== undefined) return prior.id;
        const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
        await configure(tx, child.id, { tools: [block] });
        return child.id;
      }, context);
      const child = await api.conversation(id, context);
      assert.ok(child);
      const result = await (await child.submit({ type: "input", content: "Perform child work", requestId: `child:${api.taskId}` }, context)).wait(context);
      return { output: [{ type: "text", text: result.status }] };
    },
  })] });
  registry.install(defineExtension({ name: "child_tools", tools: [block] }));
  registry.install(delegate);
}

test("parent cancellation reaches an owned child conversation", { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-child-"));
  const { models, faux } = setup();
  const started = deferred<string>();
  let childAborted = false;
  const registry = createRegistry();
  registerChildTool(registry, started, () => { childAborted = true; });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("child_work", {}), { stopReason: "toolUse" }),
  ]);
  const runtime = await openPiRuntime({ storagePath: join(dir, "agent.sqlite"), models, registry, initialAgent: agent, settings });
  try {
    const receipt = await runtime.submit({ requestId: "parent", message: "Delegate work" });
    const child = await started.promise;
    assert.notEqual(child, runtime.rootConversationId);
    assert.ok((await runtime.inspect()).tasks.some((task) => task.conversationId === child));
    await runtime.cancel();
    assert.equal(childAborted, true);
    assert.equal((await runtime.wait(receipt.id)).status, "unanswered");
    assert.equal((await runtime.inspect()).tasks.length, 0);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ordinary cancellation preserves background children; explicit scope cancellation reaches them", { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-background-"));
  const { models, faux } = setup();
  const started = deferred<string>();
  let childAborted = false;
  const registry = createRegistry();
  const block = defineTool({
    name: "background_work", description: "Controlled background work", parameters: Type.Object({}),
    execute: async (_args, api, context) => {
      started.resolve(String(api.conversationId));
      try { return await untilAborted(context); }
      finally { childAborted = true; }
    },
  });
  const anchor = defineTask<null, { phase: "complete" }, null>({
    name: "qualification.anchor", version: 1, initial: () => ({ phase: "complete" }),
    phases: {
      complete: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
    },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
  registry.install(defineExtension({ name: "background", tasks: [anchor], tools: [block, defineTool({
    name: "spawn_background", description: "Start controlled background child", parameters: Type.Object({}),
    execute: async (_args, api, context) => {
      const id = await api.commit(async (tx) => {
        const owner = await tx.createTask(anchor, null, { ownership: { kind: "conversation" }, background: true });
        const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
        await configure(tx, child.id, { tools: [block] });
        return child.id;
      }, context);
      const child = await api.conversation(id, context);
      assert.ok(child);
      await child.submit({ type: "input", content: "Background work", requestId: `background:${api.taskId}` }, context);
      await started.promise;
      return { output: [{ type: "text", text: "Background work started" }] };
    },
  })] }));
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("spawn_background", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("background_work", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("The background task is running."),
  ]);
  const runtime = await openPiRuntime({ storagePath: join(dir, "agent.sqlite"), models, registry, initialAgent: agent, settings });
  try {
    const receipt = await runtime.submit({ requestId: "background-parent", message: "Start background work" });
    assert.equal((await runtime.wait(receipt.id, { signal: AbortSignal.timeout(5_000) })).status, "done");
    const child = await started.promise;
    await runtime.cancel();
    assert.equal(childAborted, false);
    assert.ok((await runtime.inspect()).tasks.some((task) => task.conversationId === child));
    await runtime.cancel(undefined, { includeBackground: true });
    assert.equal(childAborted, true);
    assert.equal((await runtime.inspect()).tasks.length, 0);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
