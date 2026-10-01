import type { GeocodeResult, PlaceCandidate, PlaceQuery, PlacesProvider } from '../types.ts';

/** Schlagwort → OpenStreetMap-Filter. Was nicht passt, wird über den Namen gesucht. */
const TAGS: [RegExp, string[]][] = [
  [/friseur|barber|haarschnitt|hair/i, ['["shop"="hairdresser"]']],
  [/nagel|nail|maniküre|manikure/i, ['["shop"="beauty"]', '["beauty"~"nails"]']],
  [/kosmetik|beauty|wellness|spa/i, ['["shop"="beauty"]', '["leisure"="spa"]']],
  [/restaurant|gastro|café|cafe|bistro|imbiss/i, ['["amenity"~"^(restaurant|cafe|fast_food)$"]']],
  [/zahnarzt|dental|zahn/i, ['["amenity"="dentist"]', '["healthcare"="dentist"]']],
  [/auto|kfz|werkstatt|reifen/i, ['["shop"="car_repair"]', '["shop"="tyres"]']],
  [/handwerk|elektr|sanitär|maler|tischler|dachdecker|schreiner/i, ['["craft"]']],
  [/immobil|makler/i, ['["office"="estate_agent"]']],
  [/fitness|sport|gym|yoga/i, ['["leisure"="fitness_centre"]', '["sport"="fitness"]']],
  [/versicher|berat/i, ['["office"~"insurance|financial|consulting"]']],
];
const esc = (s: string) => s.replace(/[\\"]/g, '').replace(/[^\p{L}\p{N} .&'-]/gu, '').slice(0, 40);

export function overpassQuery(q: PlaceQuery): string {
  const r = Math.round(Math.min(50, Math.max(1, q.radiusKm)) * 1000), at = `(around:${r},${q.center.lat},${q.center.lng})`;
  const filters = new Set<string>();
  for (const kw of q.keywords) { const hit = TAGS.find(([re]) => re.test(kw)); if (hit) hit[1].forEach((f) => filters.add(f)); else if (esc(kw).length >= 3) filters.add(`["shop"]["name"~"${esc(kw)}",i]`);   }   // Namenssuche nur innerhalb von Läden (sonst zu teuer für Overpass)
  if (!filters.size) filters.add('["shop"]');
  const body = [...filters].map((f) => `nwr${f}["name"]${at};`).join('');
  return `[out:json][timeout:60];(${body});out center tags ${Math.min(300, Math.max(10, q.limit * 3))};`;
}

type El = { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> };

/**
 * Keyfreie Lead-Quelle auf Basis von OpenStreetMap (Nominatim für Orte, Overpass für Firmen). Daten: © OpenStreetMap-Mitwirkende, ODbL – bei Nutzung Quelle nennen.
 * Höflichkeitsregeln: eindeutiger User-Agent, höchstens eine Anfrage pro Sekunde, kein Massenabruf (Limit pro Lauf).
 * Qualität „mittel“: Telefon/Website sind in OSM häufig nicht eingetragen – Lücken werden als „nicht verfügbar“ behandelt, nicht geraten.
 * Nicht gegen die echten Server getestet.
 */
export class OsmPlacesProvider implements PlacesProvider {
  readonly name = 'osm'; readonly isMock = false;
  private ua: string; private now: () => Date; private last = 0;
  constructor(contact = process.env.OSM_CONTACT, now: () => Date = () => new Date()) { this.ua = `AI-Agency-OS/1.0${contact ? ` (${contact})` : ''}`; this.now = now; }
  /** Eine Anfrage mit Höflichkeitsregeln: 1/s, bei 429/5xx bis zu zweimal mit Wartezeit (Retry-After) wiederholen. */
  private async call(url: string, init: RequestInit, name: string): Promise<Response> {
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      await this.throttle(); res = await fetch(url, init);
      if (![429, 502, 503, 504].includes(res.status) || attempt >= 2) return res;
      const ra = Number(res.headers.get('retry-after')); await new Promise((r) => setTimeout(r, Math.min(60_000, (Number.isFinite(ra) && ra > 0 ? ra : 5 * 3 ** attempt) * 1000)));
    }
    void name;
  }
  private async throttle() { const wait = this.last + 1100 - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); this.last = Date.now(); }

  async geocode(query: string): Promise<GeocodeResult | null> {
    const res = await this.call(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=1&countrycodes=de&accept-language=de`, { headers: { 'user-agent': this.ua } }, 'Nominatim');
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    const d = (await res.json()) as { lat: string; lon: string; display_name: string }[];
    return d[0] ? { query, name: d[0].display_name, point: { lat: Number(d[0].lat), lng: Number(d[0].lon) }, source: this.name } : null;
  }

  private map(e: El): PlaceCandidate | null {
    const t = e.tags ?? {}; const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if (!t.name) return null;
    const street = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
    const status = t['disused:shop'] || t['disused:amenity'] ? 'CLOSED_PERMANENTLY' : undefined;
    return { externalId: `osm-${e.type}-${e.id}`, source: this.name, capturedAt: this.now().toISOString(), quality: 'medium', name: t.name,
      categories: [t.shop, t.amenity, t.craft, t.office, t.leisure, t.beauty ? `beauty:${t.beauty}` : undefined].filter(Boolean) as string[], address: street || undefined, postalCode: t['addr:postcode'], city: t['addr:city'],
      point: lat !== undefined && lon !== undefined ? { lat, lng: lon } : undefined, phone: t.phone ?? t['contact:phone'], website: t.website ?? t['contact:website'] ?? t.url,
      mapsUrl: `https://www.openstreetmap.org/${e.type}/${e.id}`, openingHours: t.opening_hours ? [t.opening_hours] : undefined, businessStatus: status };
  }

  /** Overpass-Server (öffentlich, geteilt): bei Überlastung/Zeitüberschreitung der Reihe nach probieren. Ein Fehler wird gemeldet – nie als „0 Treffer“ ausgegeben. */
  static ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
  private async overpass(data: string): Promise<El[]> {
    const errors: string[] = [];
    for (const url of OsmPlacesProvider.ENDPOINTS) {
      try {
        const res = await this.call(url, { method: 'POST', headers: { 'user-agent': this.ua, 'content-type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(data), signal: AbortSignal.timeout(60_000) }, 'Overpass');
        if (!res.ok) { errors.push(`${new URL(url).host}: HTTP ${res.status}`); continue; }
        const text = await res.text(); let j: { elements?: El[]; remark?: string };
        try { j = JSON.parse(text); } catch { errors.push(`${new URL(url).host}: keine JSON-Antwort (überlastet?)`); continue; }
        if (j.remark && /error|timeout|out of memory/i.test(j.remark)) { errors.push(`${new URL(url).host}: ${j.remark.slice(0, 80)}`); continue; }
        return j.elements ?? [];
      } catch (e) { errors.push(`${new URL(url).host}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    throw new Error(`Overpass nicht erreichbar/überlastet (${errors.join('; ')})`);
  }

  async search(q: PlaceQuery) {
    const items = (await this.overpass(overpassQuery(q))).map((e) => this.map(e)).filter((x): x is PlaceCandidate => !!x);
    const seen = new Set<string>(); const out = items.filter((i) => (seen.has(i.externalId) ? false : (seen.add(i.externalId), true))).slice(0, q.limit);
    return { items: out, requests: 1 };
  }

  async details(externalId: string): Promise<PlaceCandidate | null> {
    const m = /^osm-(node|way|relation)-(\d+)$/.exec(externalId); if (!m) return null;
    const els = await this.overpass(`[out:json][timeout:25];${m[1]}(${m[2]});out center tags;`);
    return els[0] ? this.map(els[0]) : null;
  }
}
