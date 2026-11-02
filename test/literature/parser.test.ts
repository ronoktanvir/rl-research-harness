import assert from "node:assert/strict";
import test from "node:test";
import { parseArxivAtom } from "../../src/literature/index.ts";
import { bytes, entry, feed } from "./fixtures.ts";

test("Atom metadata preserves explicit version, dates and reported venue without upgrading abstract evidence", () => {
  const paper = parseArxivAtom(bytes(feed()), 2).papers[0]!;
  assert.equal(paper.arxivId, "2601.12345"); assert.equal(paper.version, 2);
  assert.equal(paper.versionedId, "2601.12345v2"); assert.equal(paper.venueVerification, "unverified");
  assert.equal(paper.contentScope, "metadata_and_abstract_only"); assert.match(paper.abstract, /reward & propose/u);
  assert.equal(paper.publishedAt, "2026-01-02T12:00:00Z"); assert.equal(paper.updatedAt, "2026-02-02T12:00:00Z");
  assert.match(paper.journalReference!, /author supplied/u);
});

test("legacy and unversioned identifiers remain explicit and do not invent v1", () => {
  const paper = parseArxivAtom(bytes(feed(entry("hep-ex/0307015"))), 1).papers[0]!;
  assert.equal(paper.version, null); assert.equal(paper.versionedId, null);
  assert.equal(paper.abstractUrl, "https://arxiv.org/abs/hep-ex/0307015");
});

test("equivalent namespace prefixes work while wrong namespace identities fail", () => {
  const alternate = feed().replaceAll("opensearch:", "search:").replace("xmlns:opensearch", "xmlns:search")
    .replaceAll("arxiv:", "paper:").replace("xmlns:arxiv", "xmlns:paper");
  assert.equal(parseArxivAtom(bytes(alternate), 1).papers[0]!.version, 2);
  assert.throws(() => parseArxivAtom(bytes(feed().replace("http://www.w3.org/2005/Atom", "https://wrong.example/Atom")), 1));
  assert.throws(() => parseArxivAtom(bytes(feed().replace("http://a9.com/-/spec/opensearch/1.1/", "https://wrong.example/search")), 1));
  assert.throws(() => parseArxivAtom(bytes(feed().replace("<entry>", '<entry xmlns="https://wrong.example/entry">')), 1));
});

test("HTTP-success Atom error entries cannot become papers", () => {
  const error = `<entry><id>http://arxiv.org/api/errors#bad_query</id><title>Error</title><summary>Bad query</summary></entry>`;
  assert.throws(() => parseArxivAtom(bytes(feed(error)), 1), { code: "arxiv_api_error" });
});

test("DTD, external entities, malformed UTF8 and trailing garbage fail closed", () => {
  for (const xml of [feed().replace("<feed ", '<!DOCTYPE feed [<!ENTITY external SYSTEM "file:///etc/passwd">]><feed '),
    feed().replace("A measured reward study", "&undefinedEntity;"), feed() + "trailing garbage", feed().replace("</entry>", "</wrong>"),
    feed().replace("</feed>", "<?fetch href='https://example.invalid'?></feed>")]) assert.throws(() => parseArxivAtom(bytes(xml), 1));
  assert.throws(() => parseArxivAtom(Uint8Array.from([0xff, 0xfe, 0]), 1));
});

test("nested or duplicate scalar fields, duplicate papers and oversized structures cannot be silently reinterpreted", () => {
  for (const xml of [feed(entry(undefined, "<title>Second title</title>")), feed(entry(undefined, "", "<nested>Claim</nested>")),
    feed(entry() + entry(), 2), feed(entry(undefined, "<x>".repeat(14) + "</x>".repeat(14))),
    feed(entry(undefined, "<x/>".repeat(12_001)))]) assert.throws(() => parseArxivAtom(bytes(xml), 2));
  assert.throws(() => parseArxivAtom(bytes(feed()), 1, 100));
  assert.throws(() => parseArxivAtom(bytes(feed()), 1, NaN));
  assert.throws(() => parseArxivAtom(bytes(feed().replace("2026-02-02T12:00:00Z", "2026-02-30T12:00:00Z")), 1));
  assert.throws(() => parseArxivAtom(bytes(feed(entry() + entry("2601.12346v1"), 2)), 1));
});

test("empty results remain empty and arbitrary links are retained neither as requests nor verified evidence", () => {
  assert.deepEqual(parseArxivAtom(bytes(feed("", 0)), 1).papers, []);
  const paper = parseArxivAtom(bytes(feed(entry(undefined, '<link href="http://127.0.0.1/private" rel="related" title="pdf"/>'))), 1).papers[0]!;
  assert.equal(Object.hasOwn(paper, "pdf"), false);
  assert.ok(paper.abstractUrl.startsWith("https://arxiv.org/abs/"));
});
