import { LiteratureError } from "./atom.ts";
import type { NormalizedArxivRequest, ArxivDiscoveryOptions } from "./types.ts";

export const ARXIV_ENDPOINT = "https://export.arxiv.org/api/query";
export interface ArxivResponseHeaders { status: number; contentType: string; retryAfter: string | null }
export interface RawArxivResponse extends ArxivResponseHeaders { bytes: Uint8Array }
let active = false;
let nextStartAt = 0;

export function arxivQueryUrl(request: NormalizedArxivRequest): string {
  const url = new URL(ARXIV_ENDPOINT);
  url.searchParams.set("search_query", request.query); url.searchParams.set("start", String(request.start));
  url.searchParams.set("max_results", String(request.maxResults)); url.searchParams.set("sortBy", request.sortBy);
  url.searchParams.set("sortOrder", "descending"); return url.href;
}

/** One process-wide connection, plus a caller-supplied durable admission callback.
 * If an injected transport ignores cancellation, its connection remains quarantined
 * until that operation actually settles, rather than admitting another connection.
 */
export async function retrieveArxiv(request: NormalizedArxivRequest, options: ArxivDiscoveryOptions, admit: () => void, onHeaders?: (headers: ArxivResponseHeaders) => void): Promise<RawArxivResponse> {
  const clock = options.now ?? (() => new Date()); const started = clock().getTime();
  if (options.signal?.aborted) throw new LiteratureError("cancelled", "Retrieval was cancelled before admission");
  if (active || started < nextStartAt) throw new LiteratureError("rate_limited_locally", "arXiv permits one connection and one request per three seconds; retry explicitly later");
  admit(); active = true; nextStartAt = started + 3000;
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectBound!: (error: Error) => void;
  const bounded = new Promise<never>((_, reject) => { rejectBound = reject; });
  const abort = (code: string) => {
    const error = new LiteratureError(code, code === "timeout" ? "arXiv retrieval deadline exceeded" : "arXiv retrieval was cancelled");
    controller.abort(error); if (reader) void reader.cancel(error).catch(() => undefined); rejectBound(error);
  };
  const onAbort = () => abort("cancelled");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  timer = setTimeout(() => abort("timeout"), request.timeoutMs);
  const operation = (async (): Promise<RawArxivResponse> => {
    if (controller.signal.aborted) throw controller.signal.reason;
    const response = await (options.fetch ?? globalThis.fetch)(arxivQueryUrl(request), { method: "GET", redirect: "error", credentials: "omit",
      headers: { Accept: "application/atom+xml", "User-Agent": "rl-research-harness/0.1 (bounded arXiv metadata discovery)" }, signal: controller.signal });
    if (controller.signal.aborted) { await response.body?.cancel(); throw controller.signal.reason; }
    if (response.redirected || (response.url && response.url !== arxivQueryUrl(request))) { await response.body?.cancel(); throw new LiteratureError("redirect", "Unexpected response URL"); }
    const retryAfter = response.headers.get("retry-after");
    // Never truncate an invalid header into an apparently valid retry timestamp.
    const metadata = { status: response.status, contentType: response.headers.get("content-type") ?? "", retryAfter: retryAfter !== null && retryAfter.length <= 256 ? retryAfter : null };
    // Preserve known service denial before a slow/oversized body can fail capture.
    // Failed durable receipt writes abort this request; they never imply a full body.
    try { onHeaders?.({ ...metadata }); } catch (error) { await response.body?.cancel(); throw error; }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > request.maxResponseBytes)) { await response.body?.cancel(); throw new LiteratureError("response_too_large", "Declared response size exceeds the configured bound"); }
    if (!response.body) throw new LiteratureError("empty_response", "Response has no readable body");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const next = await reader.read(); if (controller.signal.aborted) throw controller.signal.reason;
        if (next.done) break;
        length += next.value.byteLength;
        if (length > request.maxResponseBytes) throw new LiteratureError("response_too_large", "Streamed response exceeds the configured byte bound");
        chunks.push(next.value.slice());
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); reader = undefined; }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { ...metadata, bytes };
  })();
  void operation.then(() => { active = false; }, () => { active = false; });
  try { return await Promise.race([operation, bounded]); }
  finally { if (timer) clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); }
}
