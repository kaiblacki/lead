/**
 * Datenlücken eines Leads. Ein Lead mit Lücken wird NICHT verworfen: er bleibt gespeichert und bekommt „DATA ENRICHMENT NEEDED“ mit der Liste dessen, was fehlt –
 * später können weitere zulässige Quellen (z. B. Google Places) die Lücken füllen. Nichts wird geraten.
 */
export type EnrichmentInput = { phone?: string | null; website_url?: string | null; website_state?: string | null; address?: string | null; email?: string | null; source?: string | null };
export type Enrichment = { needed: boolean; missing: string[]; optional: string[]; label: string };

export function enrichment(l: EnrichmentInput): Enrichment {
  const missing: string[] = [], optional: string[] = [];
  if (!l.phone) missing.push('Telefonnummer');
  if (!l.website_url) missing.push(l.source === 'osm' || /^osm/.test(l.source ?? '') ? 'Website (in OpenStreetMap nicht hinterlegt – bitte prüfen)' : 'Website (keine hinterlegt – bitte prüfen)');
  if (!l.address) missing.push('Adresse');
  if (!l.email) optional.push('E-Mail');
  const needed = missing.length > 0;
  return { needed, missing, optional, label: needed ? 'DATA ENRICHMENT NEEDED' : 'Daten vollständig' };
}
export const NA = 'nicht verfügbar';
/** Zeigt einen Wert oder ausdrücklich „nicht verfügbar“. */
export const orNA = (v: unknown) => (v === null || v === undefined || String(v).trim() === '' ? NA : String(v));
export const SOURCE_LABEL: Record<string, string> = { osm: 'OpenStreetMap', 'google-places': 'Google Places', 'mock-google-places': 'Mock (Google Places)', 'mock-directory': 'Mock (Verzeichnis)', 'csv-import': 'CSV-Import', csv: 'CSV-Import' };
export const sourceLabel = (s?: string | null) => (s ? SOURCE_LABEL[s] ?? s : NA);
export const OSM_ATTRIBUTION = 'Daten © OpenStreetMap-Mitwirkende (ODbL)';
