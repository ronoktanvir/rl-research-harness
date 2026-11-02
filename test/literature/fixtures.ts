export const bytes = (text: string) => new TextEncoder().encode(text);
export function entry(id = "2601.12345v2", extra = "", title = "A measured reward study"): string {
  return `<entry><id>http://arxiv.org/abs/${id}</id><title>${title}</title><published>2026-01-02T12:00:00Z</published><updated>2026-02-02T12:00:00Z</updated>
    <summary>Authors report improved reward &amp; propose a comparison. Full methods remain unread.</summary><author><name>Researcher One</name></author>
    <category term="cs.LG"/><arxiv:journal_ref>Example Conference 2026 (author supplied)</arxiv:journal_ref><arxiv:doi>10.1234/example</arxiv:doi>${extra}</entry>`;
}
export function feed(entries = entry(), total = 1): string {
  return `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">
    <title>ArXiv Query</title><id>http://arxiv.org/api/example</id><updated>2026-02-03T00:00:00Z</updated>
    <opensearch:totalResults>${total}</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex><opensearch:itemsPerPage>${total}</opensearch:itemsPerPage>${entries}</feed>`;
}
