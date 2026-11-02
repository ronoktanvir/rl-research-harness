/** Public IDs are opaque strings, not Pi's numeric implementation details. */
export type ConversationId = string;
export type SubmissionId = string;

export interface AgentRequest {
  /** Stable within one conversation. Reuse only for the same message. */
  requestId: string;
  message: string;
  conversationId?: ConversationId;
}

export interface SubmissionReceipt {
  id: SubmissionId;
  conversationId: ConversationId;
  requestId: string;
}

export type AgentOutcome =
  | { status: "done"; submissionId: SubmissionId; conversationId: ConversationId; text: string }
  | { status: "unanswered"; submissionId: SubmissionId; conversationId: ConversationId; reason: string };

export interface RuntimeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Recorded accounting; not a provider invoice or enforced spending limit. */
  costUsd: number;
}

export interface UsageSnapshot {
  models: Record<string, RuntimeUsage>;
  tools: Record<string, RuntimeUsage>;
}

export interface RuntimeSnapshot {
  scheduling: "paused" | "running" | "closing";
  tasks: Array<{ id: string; conversationId: ConversationId; kind: string; status: string; blockedReason?: string }>;
  pendingSubmissions: Array<{ id: SubmissionId; conversationId: ConversationId; status: string }>;
}

export interface TranscriptItem {
  id: string;
  kind: string;
  text: string;
}

/** Agent conversations are not the authoritative experiment or cost ledger. */
export interface AgentRuntime {
  readonly rootConversationId: ConversationId;
  submit(request: AgentRequest): Promise<SubmissionReceipt>;
  /** Cancelling this wait does not cancel the underlying work. Use cancel(). */
  wait(submissionId: SubmissionId, options?: { signal?: AbortSignal }): Promise<AgentOutcome>;
  /** Includes only work already in the scope. It is not a durable project-stop barrier. */
  cancel(conversationId?: ConversationId, options?: { includeBackground?: boolean }): Promise<void>;
  inspect(): Promise<RuntimeSnapshot>;
  /** Bounded recent transcript, in chronological order. */
  history(conversationId?: ConversationId, limit?: number): Promise<TranscriptItem[]>;
  usage(): Promise<UsageSnapshot>;
  /** Stops this runtime; pending work can recover on reopen. Not a remote-job stop. */
  close(): Promise<void>;
}
