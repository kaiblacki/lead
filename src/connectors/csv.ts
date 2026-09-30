import type { Lead } from '../core/types.ts';

export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  const delim = (input.split('\n')[0] ?? '').includes(';') ? ';' : ',';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (q) {
      if (ch === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

const ALIASES: Record<string, string[]> = {
  companyName: ['firmenname', 'firma', 'name', 'company', 'companyname'],
  industry: ['branche', 'industry'],
  address: ['adresse', 'strasse', 'straße', 'address'],
  city: ['stadt', 'ort', 'city'],
  region: ['region', 'bundesland'],
  phone: ['telefon', 'tel', 'phone', 'telefonnummer'],
  websiteUrl: ['website', 'webseite', 'url', 'homepage', 'websiteurl'],
  instagram: ['instagram'],
  facebook: ['facebook'],
  description: ['beschreibung', 'description'],
};

export function leadsFromCsv(input: string, source = 'csv-import'): { leads: Lead[]; skipped: string[] } {
  const [header, ...rows] = parseCsv(input);
  if (!header) return { leads: [], skipped: [] };
  const idx: Record<string, number> = {};
  header.forEach((h, i) => {
    const key = h.trim().toLowerCase();
    for (const [field, names] of Object.entries(ALIASES)) if (names.includes(key)) idx[field] = i;
  });
  if (idx.companyName === undefined) throw new Error('CSV braucht eine Spalte "Firmenname" (oder Name/Firma/Company)');
  const get = (r: string[], f: string) => (idx[f] === undefined ? undefined : r[idx[f]]?.trim() || undefined);
  const leads: Lead[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  rows.forEach((r, n) => {
    const name = get(r, 'companyName');
    if (!name) { skipped.push(`Zeile ${n + 2}: kein Firmenname`); return; }
    const city = get(r, 'city');
    const key = `${name.toLowerCase()}|${(city ?? '').toLowerCase()}`;
    if (seen.has(key)) { skipped.push(`Zeile ${n + 2}: Duplikat von ${name}`); return; }
    seen.add(key);
    const socials = (['instagram', 'facebook'] as const).flatMap((p) => { const u = get(r, p); return u ? [{ platform: p, url: u }] : []; });
    leads.push({
      id: `csv-${leads.length + 1}`, companyName: name, industry: get(r, 'industry'), address: get(r, 'address'), city,
      region: get(r, 'region'), phone: get(r, 'phone'), websiteUrl: get(r, 'websiteUrl'), socials, description: get(r, 'description'), source,
    });
  });
  return { leads, skipped };
}
