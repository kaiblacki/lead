import type { WebSearchProvider, WebSearchResult } from '../../sources/types.ts';
import { getWorld, websiteUrlOf } from '../../fixtures/world.ts';
import { norm } from '../../core/text.ts';

/** Deterministische Websuche über die Testwelt: findet die Website, wenn der Betrieb in der Testwelt eine hat. Dazu je Treffer Verzeichnis-Einträge (Verzeichnisse sind keine Unternehmenswebsite). */
export class MockWebSearchProvider implements WebSearchProvider {
  readonly name = 'mock-websearch'; readonly isMock = true;
  private now: () => Date; calls = 0;
  constructor(opts: { now?: () => Date } = {}) { this.now = opts.now ?? (() => new Date()); }
  async search(q: { query: string; count?: number }): Promise<WebSearchResult> {
    this.calls++;
    const nq = norm(q.query);
    const b = getWorld().find((x) => nq.includes(norm(x.name)) && (!x.city || nq.includes(norm(x.city.split('/')[0]))));
    const hits: WebSearchResult['hits'] = [];
    if (b) {
      hits.push({ url: `https://www.gelbeseiten.example/firma/${b.id}`, title: `${b.name} – Gelbe Seiten`, snippet: `${b.name}, ${b.city}`, rank: 1 });
      const site = websiteUrlOf(b); if (site && !/instagram|facebook/.test(site)) hits.push({ url: site, title: `${b.name} – ${b.city}`, snippet: `${b.name} in ${b.city}. Kontakt und Öffnungszeiten.`, rank: 2 });
    }
    return { hits: hits.slice(0, q.count ?? 5), requests: 1, source: this.name, retrievedAt: this.now().toISOString(), costCents: 0 };
  }
}
