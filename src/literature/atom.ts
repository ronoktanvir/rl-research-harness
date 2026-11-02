import { SaxesParser } from "saxes";
import type { ArxivFeed, ArxivPaper } from "./types.ts";

const ATOM = "http://www.w3.org/2005/Atom";
const OPEN = "http://a9.com/-/spec/opensearch/1.1/";
const ARXIV = "http://arxiv.org/schemas/atom";
interface Element { uri: string; local: string; attributes: Map<string, string>; text: string; children: Element[] }
export class LiteratureError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "LiteratureError"; }
}
function fail(message: string): never { throw new LiteratureError("invalid_atom", message); }
function children(node: Element, local: string, uri = ATOM): Element[] { return node.children.filter(child => child.local === local && child.uri === uri); }
function scalar(node: Element, local: string, uri = ATOM, required = true, maximum = 40_000): string | null {
  const found = children(node, local, uri);
  if (found.length > 1 || (required && found.length !== 1)) fail(`Expected one ${local} field`);
  if (!found[0]) return null;
  if (found[0].children.length) fail(`Nested markup is not supported in ${local}`);
  const value = found[0].text.replace(/\s+/gu, " ").trim();
  if (!value || value.length > maximum) fail(`Invalid or oversized ${local}`);
  return value;
}
function count(node: Element, name: string): number {
  const value = scalar(node, name, OPEN)!;
  if (!/^(0|[1-9]\d*)$/u.test(value) || !Number.isSafeInteger(Number(value))) fail(`Invalid ${name}`);
  return Number(value);
}
function date(node: Element, name: string): string {
  const value = scalar(node, name)!;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u.test(value) || !Number.isFinite(Date.parse(value))) fail(`Invalid ${name} timestamp`);
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! || Number(value.slice(11, 13)) > 23) fail(`Invalid ${name} calendar date`);
  return value;
}
function paper(entry: Element): ArxivPaper {
  const sourceEntryId = scalar(entry, "id", ATOM, true, 1024)!;
  let link: URL;
  try { link = new URL(sourceEntryId); } catch { return fail("Invalid arXiv entry identifier"); }
  if (!["http:", "https:"].includes(link.protocol) || link.hostname !== "arxiv.org" || link.username || link.password || link.port || link.search || link.hash) {
    if (link.hostname === "arxiv.org" && link.pathname.startsWith("/api/errors")) throw new LiteratureError("arxiv_api_error", "arXiv returned an error entry rather than paper metadata");
    fail("Unexpected arXiv entry identifier origin");
  }
  if (link.pathname.startsWith("/api/errors")) throw new LiteratureError("arxiv_api_error", "arXiv returned an error entry rather than paper metadata");
  const match = /^\/abs\/((?:\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7}))(?:v([1-9]\d*))?$/iu.exec(link.pathname);
  if (!match) fail("Unsupported arXiv identifier");
  const arxivId = match[1]!, version = match[2] ? Number(match[2]) : null;
  if (version !== null && !Number.isSafeInteger(version)) fail("Invalid arXiv version");
  const authors = children(entry, "author").map(author => scalar(author, "name", ATOM, true, 1024)!);
  if (authors.length < 1 || authors.length > 1000) fail("Invalid author count");
  const categories = children(entry, "category").map(category => {
    const term = category.attributes.get("{}term"); if (!term || term.length > 128) return fail("Invalid category"); return term;
  });
  if (categories.length > 128) fail("Too many categories");
  const publishedAt = date(entry, "published"), updatedAt = date(entry, "updated");
  if (Date.parse(updatedAt) < Date.parse(publishedAt)) fail("Updated date precedes first publication date");
  return { arxivId, version, versionedId: version === null ? null : `${arxivId}v${version}`, sourceEntryId,
    abstractUrl: `https://arxiv.org/abs/${arxivId}${version === null ? "" : `v${version}`}`,
    title: scalar(entry, "title", ATOM, true, 4096)!, abstract: scalar(entry, "summary")!, authors,
    categories: [...new Set(categories)], publishedAt, updatedAt,
    journalReference: scalar(entry, "journal_ref", ARXIV, false, 4096), doi: scalar(entry, "doi", ARXIV, false, 1024),
    venueVerification: "unverified", contentScope: "metadata_and_abstract_only" };
}

/** Strict XML/namespace parsing only. No entity, stylesheet, DOI or PDF URL is fetched. */
export function parseArxivAtom(raw: Uint8Array, maxResults: number, maxBytes = 524_288): ArxivFeed {
  if (!(raw instanceof Uint8Array) || !Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 20 || !Number.isSafeInteger(maxBytes)
    || maxBytes < 1 || raw.byteLength > maxBytes || maxBytes > 524_288) fail("Response exceeds configured parser bounds");
  let xml: string;
  try { xml = new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { return fail("Response is not valid UTF-8"); }
  const stack: Element[] = []; let root: Element | null = null; let nodes = 0, textLength = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("error", () => fail("Malformed XML response"));
  parser.on("doctype", () => fail("Document type declarations are prohibited"));
  parser.on("processinginstruction", () => fail("Processing instructions are prohibited"));
  parser.on("xmldecl", declaration => {
    if (declaration.version !== "1.0" || (declaration.encoding && !/^utf-8$/iu.test(declaration.encoding))) fail("Only UTF-8 XML 1.0 is supported");
  });
  parser.on("opentag", tag => {
    if (++nodes > 12_000 || stack.length >= 12 || Object.keys(tag.attributes).length > 32) fail("XML structural limits exceeded");
    const element: Element = { uri: tag.uri, local: tag.local, attributes: new Map(Object.values(tag.attributes).map(value => [`{${value.uri}}${value.local}`, value.value])), text: "", children: [] };
    if (stack.length) stack.at(-1)!.children.push(element); else { if (root) fail("Multiple XML roots"); root = element; }
    stack.push(element);
  });
  const collect = (value: string) => {
    textLength += value.length;
    if (textLength > maxBytes) fail("XML text limit exceeded");
    if (stack.length) stack.at(-1)!.text += value;
    else if (value.trim()) fail("Text outside the feed");
  };
  parser.on("text", collect); parser.on("cdata", collect); parser.on("closetag", () => { stack.pop(); });
  parser.write(xml).close();
  const feed = root as Element | null;
  if (!feed || feed.local !== "feed" || feed.uri !== ATOM || stack.length) fail("Expected an Atom feed");
  const entries = children(feed, "entry");
  if (feed.children.some(node => node.local === "entry" && node.uri !== ATOM)) fail("Entry has an unexpected namespace");
  if (entries.length > maxResults) fail("Server returned more than the requested result bound");
  // Detect error feeds before demanding ordinary search counters.
  const papers = entries.map(paper);
  if (new Set(papers.map(item => item.arxivId)).size !== papers.length) fail("Duplicate paper identity in one result page");
  const totalResults = count(feed, "totalResults"), startIndex = count(feed, "startIndex"), itemsPerPage = count(feed, "itemsPerPage");
  if (itemsPerPage > maxResults || papers.length > itemsPerPage || papers.length > Math.max(0, totalResults - startIndex)) fail("Feed pagination counters contradict returned entries");
  return { totalResults, startIndex, itemsPerPage, papers };
}
