import type { Taxonomy } from '../core/industries.ts';
import type { Analysis, ScoringConfig } from '../scoring/intelligence.ts';
import type { AuditReport } from '../audit/types.ts';
import type { Readiness } from '../contact/strategy.ts';
import type { EmployeeBucket } from '../providers/types.ts';

export type WebsiteFilter = 'none' | 'exists' | 'needs_improvement' | 'fine';
export const WEBSITE_FILTERS: WebsiteFilter[] = ['none', 'exists', 'needs_improvement', 'fine'];
export const WEBSITE_LABEL: Record<WebsiteFilter, string> = { none: 'Website fehlt', exists: 'Website vorhanden', needs_improvement: 'Website verbesserungswürdig', fine: 'Website in Ordnung' };
export const EMPLOYEE_BUCKETS: EmployeeBucket[] = ['1-4', '5-9', '10-49', '50+'];
export const READINESS: Readiness[] = ['READY_FOR_MANUAL_CALL', 'EMAIL_PERMISSION_REQUIRED', 'WHATSAPP_OPT_IN_REQUIRED', 'MANUAL_REVIEW', 'DO_NOT_CONTACT'];
export const SORTS = ['sales_opportunity', 'digital_need', 'distance', 'reviews'] as const;

export type SearchCriteria = {
  location: string; radiusKm: number;
  industry?: string; subIndustries: string[]; keywords: string[];
  employeeBuckets: EmployeeBucket[]; includeUnknownSize: boolean;
  minLeads: number; maxLeads: number;
  website: WebsiteFilter[];
  mobileProblems: boolean; noBooking: boolean;
  socialPresent: 'any' | 'yes' | 'no'; socialActive: 'any' | 'yes' | 'no';
  minOpportunity: number; minDigitalNeed: number;
  minRating?: number; maxRating?: number; minReviews?: number;
  requirePhone: boolean; requireEmail: boolean;
  readiness: Readiness[];
  excludeExisting: boolean; excludeChains: boolean;
  sort: (typeof SORTS)[number];
};

export class CriteriaError extends Error { errors: string[]; constructor(errors: string[]) { super(errors.join(' · ')); this.errors = errors; } }

const toArr = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]).map(String);
const toBool = (v: unknown, d: boolean) => (v === undefined || v === null || v === '' ? d : v === true || v === '1' || v === 'true' || v === 'on');
const toNum = (v: unknown): number | undefined => (v === undefined || v === null || String(v).trim() === '' ? undefined : Number(String(v).replace(',', '.')));

/** Prüft und normalisiert Suchkriterien. Wirft CriteriaError mit allen Fehlern. */
export function normalizeCriteria(raw: Record<string, unknown>, tax: Taxonomy): SearchCriteria {
  const errors: string[] = [];
  const location = String(raw.location ?? '').trim();
  if (!location) errors.push('Ort fehlt.'); else if (location.length > 80) errors.push('Ort ist zu lang (max. 80 Zeichen).');
  const radius = toNum(raw.radiusKm ?? 30);
  if (radius === undefined || !Number.isInteger(radius) || radius < 1 || radius > 200) errors.push('Radius muss eine ganze Zahl zwischen 1 und 200 km sein.');
  const industry = String(raw.industry ?? '').trim() || undefined;
  if (industry && !tax.industry(industry)) errors.push(`Unbekannte Branche: ${industry.slice(0, 40)}`);
  const subs = toArr(raw.subIndustries).filter(Boolean);
  for (const s of subs) if (!tax.sub(s)) errors.push(`Unbekannte Unterbranche: ${s.slice(0, 40)}`);
  const keywords = toArr(typeof raw.keywords === 'string' ? raw.keywords.split(',') : raw.keywords).map((k) => k.trim()).filter(Boolean);
  if (keywords.length > 5 || keywords.some((k) => k.length > 40)) errors.push('Maximal 5 Stichwörter mit je höchstens 40 Zeichen.');
  if (!industry && !subs.length && !keywords.length) errors.push('Bitte eine Branche, Unterbranche oder ein Stichwort angeben.');
  const buckets = toArr(raw.employeeBuckets);
  for (const b of buckets) if (!EMPLOYEE_BUCKETS.includes(b as EmployeeBucket)) errors.push(`Ungültige Mitarbeitergröße: ${b.slice(0, 10)}`);
  const maxLeads = toNum(raw.maxLeads ?? 50), minLeads = toNum(raw.minLeads ?? 0);
  if (maxLeads === undefined || !Number.isInteger(maxLeads) || maxLeads < 1 || maxLeads > 500) errors.push('Höchstzahl Leads muss zwischen 1 und 500 liegen.');
  if (minLeads === undefined || !Number.isInteger(minLeads) || minLeads < 0) errors.push('Mindestzahl Leads muss eine ganze Zahl ≥ 0 sein.');
  else if (maxLeads !== undefined && minLeads > maxLeads) errors.push('Mindestzahl darf nicht größer als die Höchstzahl sein.');
  const website = toArr(raw.website);
  for (const w of website) if (!WEBSITE_FILTERS.includes(w as WebsiteFilter)) errors.push(`Ungültiger Website-Filter: ${w.slice(0, 20)}`);
  const tri = (v: unknown, name: string): 'any' | 'yes' | 'no' => { const s = String(v ?? 'any'); if (s !== 'any' && s !== 'yes' && s !== 'no') { errors.push(`${name}: ungültiger Wert`); return 'any'; } return s; };
  const socialPresent = tri(raw.socialPresent, 'Social Media vorhanden'), socialActive = tri(raw.socialActive, 'Social Media aktiv');
  const minOpp = toNum(raw.minOpportunity ?? 0) ?? 0, minDN = toNum(raw.minDigitalNeed ?? 0) ?? 0;
  if (Number.isNaN(minOpp) || minOpp < 0 || minOpp > 100) errors.push('Mindest-Opportunity-Score muss zwischen 0 und 100 liegen.');
  if (Number.isNaN(minDN) || minDN < 0 || minDN > 100) errors.push('Mindest-Digital-Need muss zwischen 0 und 100 liegen.');
  const minRating = toNum(raw.minRating), maxRating = toNum(raw.maxRating), minReviews = toNum(raw.minReviews);
  for (const [n, v] of [['Mindestbewertung', minRating], ['Höchstbewertung', maxRating]] as const) if (v !== undefined && (Number.isNaN(v) || v < 0 || v > 5)) errors.push(`${n} muss zwischen 0 und 5 liegen.`);
  if (minRating !== undefined && maxRating !== undefined && minRating > maxRating) errors.push('Mindestbewertung darf nicht größer als die Höchstbewertung sein.');
  if (minReviews !== undefined && (Number.isNaN(minReviews) || minReviews < 0 || minReviews > 100000)) errors.push('Mindestanzahl Bewertungen ist ungültig.');
  const readiness = toArr(raw.readiness);
  for (const r of readiness) if (!READINESS.includes(r as Readiness)) errors.push(`Ungültiger Kontaktstatus: ${r.slice(0, 30)}`);
  const sort = String(raw.sort ?? 'sales_opportunity');
  if (!SORTS.includes(sort as (typeof SORTS)[number])) errors.push('Ungültige Sortierung.');
  if (errors.length) throw new CriteriaError(errors);
  return {
    location, radiusKm: radius!, industry, subIndustries: subs, keywords, employeeBuckets: buckets as EmployeeBucket[], includeUnknownSize: toBool(raw.includeUnknownSize, true),
    minLeads: minLeads!, maxLeads: maxLeads!, website: website as WebsiteFilter[], mobileProblems: toBool(raw.mobileProblems, false), noBooking: toBool(raw.noBooking, false),
    socialPresent, socialActive, minOpportunity: minOpp, minDigitalNeed: minDN, minRating, maxRating, minReviews, requirePhone: toBool(raw.requirePhone, false), requireEmail: toBool(raw.requireEmail, false),
    readiness: readiness as Readiness[], excludeExisting: toBool(raw.excludeExisting, true), excludeChains: toBool(raw.excludeChains, false), sort: sort as SearchCriteria['sort'],
  };
}

/** Formular-Felder → rohe Kriterien (Mehrfachauswahl, Checkboxen mit Formular-Marker). */
export function criteriaFromForm(f: URLSearchParams): Record<string, unknown> {
  const marker = f.has('_form');
  const cb = (n: string, d: boolean) => (marker ? f.get(n) === '1' : d);
  return {
    location: f.get('location'), radiusKm: f.get('radiusKm'), industry: f.get('industry'), subIndustries: f.getAll('sub'), keywords: f.get('keywords') ?? '',
    employeeBuckets: f.getAll('emp'), includeUnknownSize: cb('includeUnknownSize', true), minLeads: f.get('minLeads'), maxLeads: f.get('maxLeads'), website: f.getAll('website'),
    mobileProblems: cb('mobileProblems', false), noBooking: cb('noBooking', false), socialPresent: f.get('socialPresent') ?? 'any', socialActive: f.get('socialActive') ?? 'any',
    minOpportunity: f.get('minOpportunity'), minDigitalNeed: f.get('minDigitalNeed'), minRating: f.get('minRating'), maxRating: f.get('maxRating'), minReviews: f.get('minReviews'),
    requirePhone: cb('requirePhone', false), requireEmail: cb('requireEmail', false), readiness: f.getAll('readiness'), excludeExisting: cb('excludeExisting', true),
    excludeChains: cb('excludeChains', false), sort: f.get('sort') ?? 'sales_opportunity',
  };
}

export function describeCriteria(c: SearchCriteria, tax: Taxonomy): string {
  const parts = [`${c.location}`, `${c.radiusKm} km`];
  const subs = c.subIndustries.map((s) => tax.sub(s)?.label ?? s);
  if (subs.length) parts.push(subs.join(', ')); else if (c.industry) parts.push(tax.industry(c.industry)?.label ?? c.industry);
  if (c.keywords.length) parts.push(`„${c.keywords.join(', ')}“`);
  if (c.website.length) parts.push(c.website.map((w) => WEBSITE_LABEL[w]).join(' oder '));
  if (c.mobileProblems) parts.push('mobile Probleme');
  if (c.noBooking) parts.push('keine Terminbuchung');
  if (c.socialPresent !== 'any') parts.push(c.socialPresent === 'yes' ? 'Social Media vorhanden' : 'ohne Social Media');
  if (c.socialActive !== 'any') parts.push(c.socialActive === 'yes' ? 'Social Media aktiv' : 'Social Media inaktiv');
  if (c.minOpportunity > 0) parts.push(`Opportunity ≥ ${c.minOpportunity}`);
  if (c.employeeBuckets.length) parts.push(`Größe ${c.employeeBuckets.join('/')}`);
  parts.push(`max. ${c.maxLeads} Leads`);
  return parts.join(' · ');
}

// ---------- Filter ----------
export type PreView = { distanceKm?: number; employeeBucket?: string; rating?: number; reviewCount?: number; isChain?: boolean; closed?: boolean; hasWebsite?: boolean; existing?: boolean };

/** Günstige Vorprüfung vor dem (teuren) Website-Audit. Gibt den Ausschlussgrund zurück oder null. */
export function prefilter(c: SearchCriteria, v: PreView): string | null {
  if (v.closed) return 'Betrieb dauerhaft geschlossen';
  if (v.distanceKm !== undefined && v.distanceKm > c.radiusKm) return `Außerhalb des Radius (${v.distanceKm.toFixed(1)} km)`;
  if (c.excludeExisting && v.existing) return 'Bereits als Lead vorhanden';
  if (c.excludeChains && v.isChain) return 'Filialbetrieb/Kette';
  if (c.employeeBuckets.length) {
    if (!v.employeeBucket) { if (!c.includeUnknownSize) return 'Mitarbeitergröße unbekannt'; }
    else if (!c.employeeBuckets.includes(v.employeeBucket as EmployeeBucket)) return `Mitarbeitergröße ${v.employeeBucket} nicht gewünscht`;
  }
  if (c.minReviews !== undefined && (v.reviewCount ?? -1) < c.minReviews) return v.reviewCount === undefined ? 'Bewertungsanzahl unbekannt' : `Nur ${v.reviewCount} Bewertungen`;
  if (c.minRating !== undefined && (v.rating === undefined || v.rating < c.minRating)) return v.rating === undefined ? 'Bewertung unbekannt' : `Bewertung ${v.rating} unter ${c.minRating}`;
  if (c.maxRating !== undefined && v.rating !== undefined && v.rating > c.maxRating) return `Bewertung ${v.rating} über ${c.maxRating}`;
  const onlyNone = c.website.length > 0 && c.website.every((w) => w === 'none');
  if (onlyNone && v.hasWebsite) return 'Hat eine Website';
  if (c.website.length && !c.website.includes('none') && v.hasWebsite === false) return 'Hat keine Website';
  return null;
}

export type PostView = {
  analysis: Analysis; audit: AuditReport; profiles: { platform: string; lastPostAt?: string }[]; socialComplete: boolean;
  readiness?: Readiness; hasPhone: boolean; hasEmail: boolean; bookingRelevant: boolean; now: Date; cfg: ScoringConfig;
};

/** Prüft die nach der Analyse bekannten Kriterien. Leere Liste = Treffer. */
export function postfilter(c: SearchCriteria, v: PostView): string[] {
  const why: string[] = [];
  const a = v.analysis;
  if (c.website.length) {
    const s = a.websiteState;
    const ok = c.website.some((w) => w === 'none' ? s === 'none' : w === 'exists' ? (s === 'exists' || s === 'needs_improvement' || s === 'fine' || s === 'unknown') : w === 'needs_improvement' ? s === 'needs_improvement' : s === 'fine');
    if (!ok) why.push(s === 'unknown' ? 'Website nicht erreichbar – nicht bewertbar' : `Website-Status „${s}“ passt nicht`);
  }
  if (c.mobileProblems) { const m = a.dimensions.mobileNeed; if (!(m.state === 'measured' && m.value !== null && m.value >= v.cfg.mobileProblemAt)) why.push('Keine mobilen Probleme festgestellt'); }
  if (c.noBooking) {
    const booking = v.audit.checks.find((k) => k.code === 'ONLINE_BOOKING');
    if (!v.bookingRelevant) why.push('Terminbuchung für diese Branche nicht relevant');
    else if (!(a.websiteState === 'none' || booking?.status === 'fail')) why.push(booking?.status === 'unknown' ? 'Terminbuchung nicht zuverlässig prüfbar' : 'Online-Terminbuchung vorhanden');
  }
  const present = v.profiles.length > 0;
  if (c.socialPresent === 'yes' && !present) why.push('Kein Social-Media-Profil');
  if (c.socialPresent === 'no' && (present || !v.socialComplete)) why.push(present ? 'Social-Media-Profil vorhanden' : 'Social Media nicht zuverlässig prüfbar');
  const cutoff = v.now.getTime() - v.cfg.socialActiveDays * 86400000;
  const active = v.profiles.some((p) => p.lastPostAt && Date.parse(p.lastPostAt) >= cutoff);
  if (c.socialActive === 'yes' && !active) why.push('Social Media nicht aktiv');
  if (c.socialActive === 'no' && (!present || active)) why.push(!present ? 'Kein Profil, daher nicht „inaktiv“' : 'Social Media aktiv');
  if (c.minOpportunity > 0 && (a.salesOpportunity.value === null || a.salesOpportunity.value < c.minOpportunity)) why.push(a.salesOpportunity.value === null ? 'Opportunity nicht bewertbar' : `Opportunity ${a.salesOpportunity.value} unter ${c.minOpportunity}`);
  if (c.minDigitalNeed > 0 && (a.digitalNeed.value === null || a.digitalNeed.value < c.minDigitalNeed)) why.push(a.digitalNeed.value === null ? 'Digital Need nicht bewertbar' : `Digital Need ${a.digitalNeed.value} unter ${c.minDigitalNeed}`);
  if (c.requirePhone && !v.hasPhone) why.push('Keine Telefonnummer');
  if (c.requireEmail && !v.hasEmail) why.push('Keine E-Mail-Adresse');
  if (c.readiness.length && (!v.readiness || !c.readiness.includes(v.readiness))) why.push(`Kontaktstatus ${v.readiness ?? 'unbekannt'} nicht gewünscht`);
  return why;
}

export function sortKey(c: SearchCriteria, r: { salesOpportunity: number | null; digitalNeed: number | null; distanceKm?: number; reviewCount?: number }): number {
  switch (c.sort) {
    case 'digital_need': return -(r.digitalNeed ?? -1);
    case 'distance': return r.distanceKm ?? Infinity;
    case 'reviews': return -(r.reviewCount ?? -1);
    default: return -(r.salesOpportunity ?? -1);
  }
}

// ---------- Schnellsuche ----------
export type QuickSearch = { criteria: Record<string, unknown>; unmatched: string[]; understood: string[] };

/** „Völklingen + 30 km + Nagelstudios + Website fehlt oder verbesserungswürdig“ → Kriterien. Unverstandenes wird gemeldet, nichts geraten. */
export function parseQuickSearch(text: string, tax: Taxonomy): QuickSearch {
  const c: Record<string, any> = { subIndustries: [] as string[], website: [] as string[], employeeBuckets: [] as string[] };
  const understood: string[] = [], unmatched: string[] = [];
  const tokens = text.split(/\s*\+\s*|\s*;\s*|\s*,\s+/).map((t) => t.trim()).filter(Boolean);
  for (const t of tokens) {
    const low = t.toLowerCase();
    let m: RegExpExecArray | null, hit = false;
    if ((m = /(\d{1,3})\s*km/.exec(low))) { c.radiusKm = Number(m[1]); understood.push(`Radius ${m[1]} km`); hit = true; }
    if (/website\s+(?:fehlt|fehlend)|keine\s+website|ohne\s+website|keine\s+webseite/.test(low)) { c.website.push('none'); understood.push('Website fehlt'); hit = true; }
    if (/verbesserungsw|veraltet|modernisier|schlechte?\s+website|website\s+schlecht/.test(low)) { c.website.push('needs_improvement'); understood.push('Website verbesserungswürdig'); hit = true; }
    if (/mobile?\s+probleme|mobil\s+schlecht|nicht\s+mobil/.test(low)) { c.mobileProblems = true; understood.push('mobile Probleme'); hit = true; }
    if (/keine\s+termin(?:buchung)?|ohne\s+termin/.test(low)) { c.noBooking = true; understood.push('keine Terminbuchung'); hit = true; }
    if (/social\s*media\s+aktiv|instagram\s+aktiv|aktiv\s+auf\s+social/.test(low)) { c.socialActive = 'yes'; understood.push('Social Media aktiv'); hit = true; }
    else if (/social\s*media\s+vorhanden|hat\s+instagram|instagram\s+vorhanden/.test(low)) { c.socialPresent = 'yes'; understood.push('Social Media vorhanden'); hit = true; }
    else if (/kein(?:e)?\s+social/.test(low)) { c.socialPresent = 'no'; understood.push('ohne Social Media'); hit = true; }
    if ((m = /(?:score|opportunity)\s*(?:ab|>=|mind\.?|mindestens)?\s*(\d{1,3})|ab\s+(\d{1,3})\s*punkte/.exec(low))) { c.minOpportunity = Number(m[1] ?? m[2]); understood.push(`Opportunity ≥ ${c.minOpportunity}`); hit = true; }
    if ((m = /(\d{1,3})\s*(?:leads|treffer|ergebnisse)/.exec(low))) { c.maxLeads = Number(m[1]); understood.push(`max. ${m[1]} Leads`); hit = true; }
    if ((m = /(\d+)\s*[-–]\s*(\d+)\s*mitarbeiter/.exec(low))) { const lo = Number(m[1]), hi = Number(m[2]); const b = ([['1-4', 1, 4], ['5-9', 5, 9], ['10-49', 10, 49], ['50+', 50, 9999]] as const).filter(([, a, z]) => a <= hi && z >= lo).map(([k]) => k); c.employeeBuckets.push(...b); understood.push(`Größe ${b.join('/')}`); hit = true; }
    if (!hit) {
      const sub = tax.match(t);
      if (sub) { c.subIndustries.push(sub.key); c.industry = c.industry ?? sub.industryKey; understood.push(`Branche ${sub.label}`); }
      else if (!c.location && /^[A-Za-zÄÖÜäöüß .\-\/]{2,40}$/.test(t) && !/\b(website|social|mobile|termin)\b/i.test(t)) { c.location = t; understood.push(`Ort ${t}`); }
      else unmatched.push(t);
    }
  }
  c.website = [...new Set(c.website)]; c.employeeBuckets = [...new Set(c.employeeBuckets)]; c.subIndustries = [...new Set(c.subIndustries)];
  return { criteria: c, unmatched, understood };
}
