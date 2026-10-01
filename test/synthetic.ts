import type { CrawlerProvider, GeocodeResult, PlaceCandidate, PlaceQuery, PlacesProvider } from '../src/providers/types.ts';

const C = 'bdfgklmnprstvz', V = 'aeiou';
/** Deterministische, voneinander klar verschiedene Fantasienamen („Kovanu“, „Tilemo“ …) – damit Tests keine zufälligen Namensähnlichkeiten erzeugen. */
export const word = (i: number) => { let x = (i + 1) * 2654435761 % 4294967296, s = ''; for (let k = 0; k < 3; k++) { s += C[x % C.length].toUpperCase().repeat(k === 0 ? 1 : 0) + (k === 0 ? '' : C[x % C.length]); x = Math.floor(x / 14); s += V[x % 5]; x = Math.floor(x / 5); } return s + C[(i * 7) % C.length]; };
const SUB = (i: number) => word(i * 3 + 11);

export type SynOpts = { n: number; extra?: PlaceCandidate[]; idPrefix?: string; noSiteEvery?: number; dupEvery?: number; source?: string; closedEvery?: number; noPhoneEvery?: number };
/** Erzeugt n Orts-Datensätze ohne Netzzugriff. Jede dupEvery-te Firma kommt ein zweites Mal vor (gleiche Nummer, anderes Objekt). */
export class SyntheticPlaces implements PlacesProvider {
  readonly name = 'osm'; readonly isMock = false; mode = 'PUBLIC_DEMO'; searches = 0; geocodes = 0;
  o: SynOpts;
  constructor(o: SynOpts) { this.o = o; }
  async geocode(query: string): Promise<GeocodeResult | null> { this.geocodes++; return { query, name: 'Völklingen', point: { lat: 49.2515, lng: 6.8465 }, source: 'osm' }; }
  items(): PlaceCandidate[] {
    const { n } = this.o; const out: PlaceCandidate[] = [];
    for (let i = 0; i < n; i++) {
      const name = `Nagelstudio ${word(i)}`, noSite = i % (this.o.noSiteEvery ?? 3) === 0;
      const base: PlaceCandidate = { externalId: `osm-node-${1000 + i}`, source: this.o.source ?? 'osm', capturedAt: '2026-06-01T10:00:00.000Z', quality: 'medium', name, categories: ['beauty', 'beauty:nails'],
        address: `${SUB(i)}straße ${1 + (i % 90)}`, postalCode: '66333', city: 'Völklingen', point: { lat: 49.2515 + ((i % 40) - 20) / 3000, lng: 6.8465 + (Math.floor(i / 40) - 7) / 3000 },
        phone: this.o.noPhoneEvery && i % this.o.noPhoneEvery === 0 ? undefined : `06898 ${String(200000 + i * 13).slice(0, 6)}`, website: noSite ? undefined : `https://www.${word(i).toLowerCase()}-nails.example`, openingHours: i % 4 === 0 ? ['Mo-Fr 09:00-18:00'] : undefined,
        mapsUrl: `https://www.openstreetmap.org/node/${1000 + i}`, businessStatus: this.o.closedEvery && i % this.o.closedEvery === 0 ? 'CLOSED_PERMANENTLY' : undefined };
      out.push(base);
      if (this.o.dupEvery && i % this.o.dupEvery === 1) out.push({ ...base, externalId: `osm-way-${5000 + i}`, name: name.toUpperCase(), website: undefined, address: base.address, phone: base.phone });
    }
    return [...out, ...(this.o.extra ?? [])].map((x) => (this.o.idPrefix ? { ...x, externalId: this.o.idPrefix + x.externalId } : x));
  }
  async search(q: PlaceQuery) { this.searches++; return { items: this.items().slice(0, q.limit), requests: 1 }; }
  async details() { return null; }
}

/** Website-Abruf ohne Netz: liefert eine schlichte, gültige Seite; zählt die Aufrufe. */
export class StubCrawler implements CrawlerProvider {
  readonly name = 'stub-crawler'; readonly isMock = false; calls = 0; pages: Record<string, string> = {}; sites: Record<string, { path: string; html: string }[]> = {}; seen: string[] = [];
  async crawl(url: string) {
    this.calls++; this.seen.push(url);
    const multi = this.sites[url];
    if (multi) return { ok: true, startUrl: url, finalUrl: url, pages: multi.map((p) => ({ url: new URL(p.path, url).toString(), status: 200, html: p.html, loadMs: 700, bytes: p.html.length })), capturedAt: '2026-06-01T10:00:00Z', requests: multi.length, source: this.name };
    const html = this.pages[url] ?? `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Nagelstudio</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>Nagelstudio</h1><p>Wir freuen uns auf Sie.</p><a href="${url}/impressum">Impressum</a></body></html>`;
    return { ok: true, startUrl: url, finalUrl: url, pages: [{ url, status: 200, html, loadMs: 800, bytes: html.length }], capturedAt: '2026-06-01T10:00:00Z', requests: 1, source: this.name };
  }
}
