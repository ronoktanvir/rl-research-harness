import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Usage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  createRegistry,
  defineDocFamily,
  Harness,
  type AgentChange,
  type Conversation,
  type ConversationId as PiConversationId,
  type HarnessOptions,
  type SubmissionId as PiSubmissionId,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import type {
  AgentOutcome, AgentRequest, AgentRuntime, RuntimeSnapshot, RuntimeUsage,
  SubmissionReceipt, TranscriptItem, UsageSnapshot,
} from "./types.ts";

/** Guards accidental double-open in this process; the host must enforce one process owner. */
const openPaths = new Set<string>();

const RequestBinding = defineDocFamily<{ digest: string | null }, null>({
  kind: "research.request_binding",
  version: 1,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ digest: null }),
  checkpointWhen: () => true,
});

export interface PiRuntimeOptions {
  storagePath: string;
  /** Inject providers explicitly. This adapter does not discover credentials. */
  models: HarnessOptions["models"];
  /** Trusted application tools only. Omitted means no application tools. */
  registry?: HarnessOptions["registry"];
  /** Applied only when the root conversation is first created. */
  initialAgent: AgentChange;
  settings?: HarnessOptions["settings"];
  onReport?: HarnessOptions["onReport"];
}

function parseId(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new TypeError("Invalid runtime record ID");
  }
  return Number(value);
}

function usageView(value: Usage): RuntimeUsage {
  return {
    inputTokens: value.input,
    outputTokens: value.output,
    cacheReadTokens: value.cacheRead,
    cacheWriteTokens: value.cacheWrite,
    totalTokens: value.totalTokens,
    costUsd: value.cost.total,
  };
}

/** Pinned Pi Durable 1.4.0 integration. No shell, remote executor or budget gateway is installed. */
export async function openPiRuntime(options: PiRuntimeOptions): Promise<AgentRuntime> {
  const path = resolve(options.storagePath);
  if (openPaths.has(path)) throw new Error(`Runtime store is already open in this process: ${path}`);
  openPaths.add(path);
  let harness: Harness | undefined;
  let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>> | undefined;
  try {
    database = await openNodeSqliteDatabase(path);
    // Strengthen the upstream NORMAL default. This is not a host-failure certification.
    await database.exec("PRAGMA synchronous = FULL");
    const storage = await SqliteStorage.open(database);
    harness = await Harness.open(storage, {
      models: options.models,
      registry: options.registry ?? createRegistry(),
      ...(options.settings === undefined ? {} : { settings: options.settings }),
      ...(options.onReport === undefined ? {} : { onReport: options.onReport }),
    }, BACKGROUND_CONTEXT);
    const root = await harness.root(BACKGROUND_CONTEXT, { agent: options.initialAgent });
    harness.resume();
    return new PiRuntime(harness, root, () => openPaths.delete(path));
  } catch (error) {
    if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT).catch(() => {});
    else await database?.close().catch(() => {});
    openPaths.delete(path);
    throw error;
  }
}

class PiRuntime implements AgentRuntime {
  readonly rootConversationId: string;
  #closing: Promise<void> | undefined;

  constructor(private readonly harness: Harness, root: Conversation, private readonly release: () => void) {
    this.rootConversationId = String(root.id);
  }

  #assertOpen(): void {
    if (this.#closing !== undefined) throw new Error("Runtime is closing or closed");
  }

  async #conversation(id: string = this.rootConversationId): Promise<Conversation> {
    this.#assertOpen();
    const conversation = await this.harness.conversation(parseId(id) as PiConversationId, BACKGROUND_CONTEXT);
    if (conversation === undefined) throw new Error(`Unknown conversation: ${id}`);
    return conversation;
  }

  async submit(request: AgentRequest): Promise<SubmissionReceipt> {
    // The caller can mutate the object while admission awaits storage, and fields
    // can be getters. Bind and admit the same values by reading each only once.
    const { requestId, message, conversationId } = request;
    if (!requestId.trim() || requestId.length > 200) {
      throw new TypeError("requestId must contain 1–200 characters");
    }
    if (!message.trim()) throw new TypeError("message must not be empty");
    const conversation = await this.#conversation(conversationId);
    const digest = createHash("sha256").update(message).digest("hex");
    // Persist the payload binding first. A crash between this commit and submit is safe:
    // retry finds the same binding, and Pi deduplicates admission by requestId.
    await conversation.commit(async (tx) => {
      const binding = await tx.doc(RequestBinding, conversation.id, requestId, null);
      if (binding.digest !== null && binding.digest !== digest) {
        throw new Error("requestId was already bound to a different message");
      }
      binding.digest = digest;
    }, BACKGROUND_CONTEXT);
    const submission = await conversation.submit({
      type: "input", requestId, content: message, whenBusy: "followUp",
    }, BACKGROUND_CONTEXT);
    return { id: String(submission.id), conversationId: String(conversation.id), requestId };
  }

  async wait(submissionId: string, options: { signal?: AbortSignal } = {}): Promise<AgentOutcome> {
    this.#assertOpen();
    const context = options.signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(options.signal, BACKGROUND_CONTEXT);
    const submission = await this.harness.submission(parseId(submissionId) as PiSubmissionId, context);
    if (submission === undefined) throw new Error(`Unknown submission: ${submissionId}`);
    const settled = await submission.wait(context);
    const common = { submissionId, conversationId: String(settled.conversationId) };
    if (settled.status === "unanswered") return { status: "unanswered", ...common, reason: settled.reason };
    if (settled.type !== "input") throw new Error("This runtime only exposes input submissions");
    const conversation = await this.#conversation(String(settled.conversationId));
    const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
    const text = entry?.model?.flatMap((message) => {
      if (message.role !== "assistant") return [];
      return message.content.flatMap((block) => block.type === "text" ? [block.text] : []);
    }).join("\n") ?? "";
    return { status: "done", ...common, text };
  }

  async cancel(conversationId: string = this.rootConversationId, options: { includeBackground?: boolean } = {}): Promise<void> {
    const conversation = await this.#conversation(conversationId);
    await conversation.abort(BACKGROUND_CONTEXT, { background: options.includeBackground ?? false });
  }

  async inspect(): Promise<RuntimeSnapshot> {
    this.#assertOpen();
    const snapshot = await this.harness.inspect(BACKGROUND_CONTEXT);
    return {
      scheduling: snapshot.scheduling,
      tasks: snapshot.tasks.map(({ record, state }) => ({
        id: String(record.id), conversationId: String(record.conversationId), kind: record.kind,
        status: record.state.status,
        ...(state.kind === "blocked" ? { blockedReason: state.reason } : {}),
      })),
      pendingSubmissions: snapshot.submissions.map((item) => ({
        id: String(item.id), conversationId: String(item.conversationId), status: item.status,
      })),
    };
  }

  async history(conversationId: string = this.rootConversationId, limit = 100): Promise<TranscriptItem[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("history limit must be 1–1000");
    const conversation = await this.#conversation(conversationId);
    const page = await conversation.entries({}, limit, undefined, BACKGROUND_CONTEXT);
    return [...page.items].reverse().map((entry) => ({
      id: String(entry.id), kind: entry.kind,
      text: (entry.model ?? []).flatMap((message) => {
        if (typeof message.content === "string") return [message.content];
        return message.content.flatMap((block) => block.type === "text" ? [block.text] : []);
      }).join("\n"),
    }));
  }

  async usage(): Promise<UsageSnapshot> {
    this.#assertOpen();
    const usage = await this.harness.usage(BACKGROUND_CONTEXT);
    return {
      models: Object.fromEntries(Object.entries(usage.models).map(([key, value]) => [key, usageView(value)])),
      tools: Object.fromEntries(Object.entries(usage.tools).map(([key, value]) => [key, usageView(value)])),
    };
  }

  close(): Promise<void> {
    this.#closing ??= this.harness.close(BACKGROUND_CONTEXT).finally(this.release);
    return this.#closing;
  }
}
