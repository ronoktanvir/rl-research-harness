import type { EvidencePacket } from "../research/types.ts";
import type { ExperimentLedger, JsonObject } from "../ledger/types.ts";

export interface ArxivDiscoveryRequest {
  projectId: string;
  discoveryId: string;
  query: string;
  maxResults: number;
  start?: number;
  sortBy?: "submittedDate" | "lastUpdatedDate" | "relevance";
  timeoutMs?: number;
  maxResponseBytes?: number;
}
export interface NormalizedArxivRequest extends ArxivDiscoveryRequest {
  start: number;
  sortBy: "submittedDate" | "lastUpdatedDate" | "relevance";
  timeoutMs: number;
  maxResponseBytes: number;
}
export interface ArxivPaper {
  arxivId: string;
  version: number | null;
  versionedId: string | null;
  sourceEntryId: string;
  abstractUrl: string;
  title: string;
  abstract: string;
  authors: string[];
  categories: string[];
  publishedAt: string;
  updatedAt: string;
  journalReference: string | null;
  doi: string | null;
  venueVerification: "unverified";
  contentScope: "metadata_and_abstract_only";
}
export interface ArxivFeed { totalResults: number; startIndex: number; itemsPerPage: number; papers: ArxivPaper[] }
export interface DiscoveryFailure { code: string; detail: string; retryAfter: string | null }
export interface ArxivDiscovery {
  schemaVersion: 1;
  status: "complete" | "failed" | "uncertain";
  request: NormalizedArxivRequest;
  queryObservationId: string;
  responseObservationId: string | null;
  resultObservationId: string | null;
  paperObservationIds: string[];
  retrievedAt: string | null;
  rawSha256: string | null;
  feed: ArxivFeed | null;
  failure: DiscoveryFailure | null;
  limitations: string[];
}
export interface ArxivDiscoveryOptions {
  signal?: AbortSignal;
  /** Test injection only; the implementation always constructs the fixed public endpoint. */
  fetch?: typeof globalThis.fetch;
  /** Trusted clock injection for deterministic tests. */
  now?: () => Date;
}
export type LiteratureArchive = Pick<ExperimentLedger, "getObservation" | "appendObservation" | "listObservations">;
export interface LiteraturePacketRequest { packetId: string; question: string; proposal: string; requiredCriteria: string[] }
export type LiteratureEvidencePacket = EvidencePacket;

export interface ArxivAvailabilityOptions { now?: () => Date }
export interface ArxivHold {
  schemaVersion: 1;
  holdObservationId: string;
  queryObservationId: string;
  responseObservationId: string;
  responseDigest: string;
  projectId: string;
  receivedAt: string;
  retryAfter: string | null;
  retryAt: string | null;
  retryBasis: "delay_seconds" | "http_date" | "unknown";
  /** Omitted on legacy complete-response holds. No complete body is claimed here. */
  responseEvidenceScope?: "headers_only";
}
export interface ArxivHoldState extends ArxivHold {
  released: boolean;
  releaseObservationIds: string[];
  blocked: boolean;
}
export interface ArxivAvailability { available: boolean; checkedAt: string; holds: ArxivHoldState[] }
export interface ReleaseArxivHoldRequest { holdObservationId: string; releaseId: string; evidence: JsonObject }
