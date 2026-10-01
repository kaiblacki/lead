import type { WebSearchProvider, WebSearchResult } from '../../sources/types.ts';

/** Brave Search API (BRAVE_SEARCH_API_KEY). Eine Anfrage je Suche; Kosten je Anfrage kommen aus config/pipeline.json. Nicht gegen den echten Dienst getestet (nur mit nachgestellten Antworten). */
export class BraveSearchProvider implements WebSearchProvider {
  readonly name = 'brave-search'; readonly isMock = false;
  private key: string | undefined; private cents: number; private now: () => Date; private base: string;
  constructor(apiKey: string | undefined = process.env.BRAVE_SEARCH_API_KEY, centsPerRequest = 0, now: () => Date = () => new Date(), base = 'https://api.search.brave.com/res/v1/web/search') {
    this.key = apiKey; this.cents = centsPerRequest; this.now = now; this.base = base;
  }
  async search(q: { query: string; count?: number }): Promise<WebSearchResult> {
    if (!this.key) throw new Error('BRAVE_SEARCH_API_KEY fehlt');
    const url = `${this.base}?q=${encodeURIComponent(q.query.slice(0, 300))}&count=${Math.min(Math.max(q.count ?? 5, 1), 10)}&country=de&search_lang=de&safesearch=moderate`;
    const res = await fetch(url, { headers: { accept: 'application/json', 'x-subscription-token': this.key }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Brave Search HTTP ${res.status}`);
    const j = (await res.json()) as { web?: { results?: { url?: string; title?: string; description?: string }[] } };
    const hits = (j.web?.results ?? []).filter((r) => r.url).map((r, i) => ({ url: r.url!, title: (r.title ?? '').replace(/<[^>]+>/g, ''), snippet: (r.description ?? '').replace(/<[^>]+>/g, ''), rank: i + 1 }));
    return { hits, requests: 1, source: this.name, retrievedAt: this.now().toISOString(), costCents: this.cents };
  }
}
