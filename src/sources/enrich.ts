import type { CrawlerProvider } from '../providers/types.ts';
import type { Fact } from '../core/profile.ts';
import type { WebSearchProvider } from './types.ts';
import { hostOf, norm, normPhone, socialPlatformOf } from '../core/text.ts';
import { nameTokens } from '../dedupe/match.ts';

/** Verzeichnisse, Portale und Marktplätze sind keine eigene Unternehmenswebsite. */
const NOT_OWN_SITE = /(^|\.)(facebook|instagram|tiktok|youtube|linkedin|xing|twitter|x|pinterest|google|bing|yelp|tripadvisor|gelbeseiten|dasoertliche|11880|golocal|meinestadt|branchenbuch|cylex|werkenntdenbesten|wikipedia|kununu|jameda|treatwell|fresha|booksy|planity|lieferando|opentable|thefork|restaurantguru|speisekarte|ihk|handwerkskammer|kleinanzeigen|ebay|amazon|firmenwissen|northdata|dnb|hotfrog|infobel|openstreetmap|gelbeseiten\.example)\b/i;

export type EnrichNeed = { website: boolean; contact: boolean };
export type FindResult = { url?: string; verified: string[]; candidate?: string; requests: number; costCents: number; facts: Fact[]; note: string };

export class Enricher {
  private src: { webSearch: WebSearchProvider }; private prov: { crawler: CrawlerProvider }; generic: string[]; cfg: { minOpportunity: number; maxPerRun: number; resultsPerQuery: number };
  /** Anbieter werden bei jedem Aufruf neu gelesen (Registry/Quellen können im Betrieb getauscht werden). */
  constructor(d: { sources: { webSearch: WebSearchProvider }; providers: { crawler: CrawlerProvider }; genericWords: string[]; cfg: { minOpportunity: number; maxPerRun: number; resultsPerQuery: number } }) { this.src = d.sources; this.prov = d.providers; this.generic = d.genericWords; this.cfg = d.cfg; }
  get ws() { return this.src.webSearch; }
  get crawler() { return this.prov.crawler; }

  /** Websuche nur, wenn Daten fehlen UND der Lead interessant genug ist (spart Kosten). */
  wants(l: { hasWebsite: boolean; hasPhone: boolean; hasEmail: boolean; closed?: boolean; opportunity: number | null; callsUsed: number }): EnrichNeed | null {
    if (l.closed || l.callsUsed >= this.cfg.maxPerRun) return null;
    const needsWebsite = !l.hasWebsite, needsContact = !l.hasPhone && !l.hasEmail;
    if (!needsWebsite && !needsContact) return null;
    if ((l.opportunity ?? 0) < this.cfg.minOpportunity) return null;
    return { website: needsWebsite, contact: needsContact };
  }

  /** Sucht die offizielle Website. Ein Treffer gilt nur, wenn die Seite selbst zur Firma passt (Telefonnummer, oder Ort/PLZ plus Firmenname) – sonst bleibt es ein Hinweis zur manuellen Prüfung. */
  async findWebsite(l: { name: string; city?: string; phone?: string; postalCode?: string }, at: string): Promise<FindResult> {
    const query = [l.name, l.city?.replace(/^\d{5}\s*/, '')].filter(Boolean).join(' ');
    const r = await this.ws.search({ query, count: this.cfg.resultsPerQuery });
    const res: FindResult = { verified: [], requests: r.requests, costCents: r.costCents, facts: [], note: r.hits.length ? '' : 'Websuche ohne Treffer' };
    const core = nameTokens(l.name, [...this.generic, ...(l.city ? norm(l.city).split(/\s+/) : [])]).core;
    for (const h of r.hits.slice(0, 3)) {
      const host = hostOf(h.url); if (!host || socialPlatformOf(h.url) || NOT_OWN_SITE.test(host)) continue;
      const crawl = await this.crawler.crawl(h.url, { maxPages: 2 }); res.requests += 0;
      const pages = crawl.pages.filter((p) => p.status > 0 && p.status < 400 && p.html);
      if (!crawl.ok || !pages.length) { res.note = `Treffer ${host} nicht abrufbar`; continue; }
      const text = norm(pages.map((p) => p.html.replace(/<[^>]+>/g, ' ')).join(' ')); const digits = pages.map((p) => p.html.replace(/\D/g, '')).join(' ');
      const nameHit = core.length ? core.every((t) => text.includes(t)) : text.includes(norm(l.name));
      const phoneHit = !!l.phone && normPhone(l.phone).length >= 6 && digits.includes(normPhone(l.phone).replace(/^0/, ''));
      const placeHit = (!!l.postalCode && text.includes(l.postalCode)) || (!!l.city && text.includes(norm(l.city.replace(/^\d{5}\s*/, ''))));
      const why: string[] = []; if (phoneHit) why.push('Telefonnummer stimmt überein'); if (nameHit && placeHit) why.push('Firmenname und Ort/PLZ stehen auf der Seite');
      if (phoneHit || (nameHit && placeHit)) {
        const final = crawl.finalUrl ?? h.url; res.url = final; res.verified = why;
        res.facts.push({ key: 'website', value: final, source: 'web-search', capturedAt: r.retrievedAt || at, quality: 'medium', url: h.url, note: `Per Websuche gefunden und geprüft: ${why.join('; ')}` });
        res.note = `Website gefunden: ${host}`; return res;
      }
      res.candidate ??= h.url; res.note = `Mögliche Website ${host} – nicht eindeutig zuzuordnen (manuell prüfen)`;
    }
    if (res.candidate && !res.url) res.facts.push({ key: 'websiteCandidate', value: res.candidate, source: 'web-search', capturedAt: r.retrievedAt || at, quality: 'low', url: res.candidate, note: 'Nicht eindeutig zugeordnet – bitte manuell prüfen. Wird nicht als Website übernommen.' });
    return res;
  }
}
