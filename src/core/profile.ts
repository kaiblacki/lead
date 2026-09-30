import type { DirectoryRecord, PlaceCandidate, Quality, SocialResult } from '../providers/types.ts';
import type { AuditReport } from '../audit/types.ts';
import type { Lead } from './types.ts';
import { normPhone, norm, hostOf, socialPlatformOf } from './text.ts';

export type FactKey = 'name' | 'industry' | 'subIndustry' | 'address' | 'postalCode' | 'city' | 'distanceKm' | 'phone' | 'email' | 'website' | 'social' | 'employeeBucket'
  | 'locationsCount' | 'rating' | 'reviewCount' | 'openingHours' | 'services' | 'description' | 'businessStatus' | 'legalForm' | 'foundedYear' | 'isChain' | 'mapsUrl' | 'point';

/** Ein Einzelfakt mit Herkunft. Jeder externe Wert im System ist so gespeichert: Quelle, Erfassungsdatum, Datenqualität. */
export type Fact = { key: FactKey; value: unknown; source: string; capturedAt: string; quality: Quality; url?: string; note?: string };

export const FACT_LABELS: Record<FactKey, string> = {
  name: 'Firma', industry: 'Branche', subIndustry: 'Unterbranche', address: 'Adresse', postalCode: 'PLZ', city: 'Stadt', distanceKm: 'Entfernung', phone: 'Telefon', email: 'E-Mail',
  website: 'Website', social: 'Social Media', employeeBucket: 'Mitarbeitergröße', locationsCount: 'Standorte', rating: 'Bewertung', reviewCount: 'Anzahl Bewertungen',
  openingHours: 'Öffnungszeiten', services: 'Öffentlich erkennbare Leistungen', description: 'Beschreibung', businessStatus: 'Betriebsstatus', legalForm: 'Rechtsform',
  foundedYear: 'Gründungsjahr', isChain: 'Filialbetrieb/Kette', mapsUrl: 'Karten-Link', point: 'Standort (Koordinaten)',
};
export const FACT_ORDER = Object.keys(FACT_LABELS) as FactKey[];
const QUALITY_RANK: Record<Quality, number> = { high: 3, medium: 2, low: 1 };

/** Bester Fakt je Schlüssel: höchste Qualität, bei Gleichstand der aktuellste. */
export function bestFact(facts: Fact[], key: FactKey): Fact | undefined {
  return facts.filter((f) => f.key === key && f.value !== undefined && f.value !== null && f.value !== '')
    .sort((a, b) => QUALITY_RANK[b.quality] - QUALITY_RANK[a.quality] || b.capturedAt.localeCompare(a.capturedAt))[0];
}
export const factValue = <T = unknown>(facts: Fact[], key: FactKey): T | undefined => bestFact(facts, key)?.value as T | undefined;

const canon = (key: FactKey, v: unknown): string => {
  if (key === 'phone') return normPhone(String(v));
  if (key === 'website') return hostOf(String(v)) ?? String(v).toLowerCase();
  if (key === 'email') return String(v).toLowerCase();
  if (key === 'address') return norm(String(v));
  return typeof v === 'string' ? norm(v) : JSON.stringify(v);
};

/** Schlüssel, bei denen zwei Quellen mit verschiedenen Werten einen echten Widerspruch bedeuten. */
const CONFLICT_KEYS: FactKey[] = ['phone', 'email', 'website', 'employeeBucket', 'openingHours'];
export type Conflict = { key: FactKey; values: { value: unknown; source: string }[] };
export function findConflicts(facts: Fact[]): Conflict[] {
  const out: Conflict[] = [];
  for (const key of CONFLICT_KEYS) {
    const fs = facts.filter((f) => f.key === key && f.value !== undefined && f.value !== '');
    const distinct = new Set(fs.map((f) => canon(key, f.value)));
    if (distinct.size > 1 && new Set(fs.map((f) => f.source)).size > 1) out.push({ key, values: fs.map((f) => ({ value: f.value, source: f.source })) });
  }
  return out;
}

export type ProfileInput = {
  place?: PlaceCandidate | null; directory?: DirectoryRecord | null; social?: SocialResult | null; audit?: AuditReport | null;
  distanceKm?: number; searchIndustry?: string; searchSub?: string; csv?: Lead | null; capturedAt: string; siteFacts?: { phone?: string; email?: string; services?: string[]; url?: string } | null;
};

/** Baut aus allen Quellen die Faktenliste. Nichts wird erfunden oder geschätzt; fehlende Werte fehlen. */
export function buildFacts(i: ProfileInput): Fact[] {
  const f: Fact[] = [];
  const add = (key: FactKey, value: unknown, source: string, capturedAt: string, quality: Quality, extra: Partial<Fact> = {}) => {
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) return;
    f.push({ key, value, source, capturedAt, quality, ...extra });
  };
  const p = i.place, d = i.directory, c = i.csv;
  if (p) {
    const s = p.source, at = p.capturedAt, q = p.quality;
    add('name', p.name, s, at, q); add('address', p.address, s, at, q); add('postalCode', p.postalCode, s, at, q); add('city', p.city, s, at, q);
    add('phone', p.phone, s, at, q); add('rating', p.rating, s, at, q); add('reviewCount', p.reviewCount, s, at, q);
    add('openingHours', p.openingHours, s, at, q); add('businessStatus', p.businessStatus, s, at, q); add('mapsUrl', p.mapsUrl, s, at, q, { url: p.mapsUrl }); add('point', p.point, s, at, q);
    if (p.website) {
      const platform = socialPlatformOf(p.website);
      if (platform) add('social', { platform, url: p.website }, s, at, 'low', { note: 'Im Website-Feld steht nur ein Social-Media-Profil – keine eigene Website hinterlegt.' });
      else add('website', p.website, s, at, q, { url: p.website });
    }
  }
  if (d) {
    const s = d.source, at = d.capturedAt, q = d.quality;
    add('name', d.name, s, at, q); add('address', d.address, s, at, q); add('postalCode', d.postalCode, s, at, q); add('city', d.city, s, at, q); add('phone', d.phone, s, at, q);
    add('email', d.email, s, at, q); add('subIndustry', d.subIndustry, s, at, q); add('employeeBucket', d.employeeBucket, s, at, q); add('locationsCount', d.locationsCount, s, at, q);
    add('legalForm', d.legalForm, s, at, q); add('foundedYear', d.foundedYear, s, at, q); add('description', d.description, s, at, q); add('services', d.services, s, at, q);
    add('isChain', d.isChain, s, at, q); add('point', d.point, s, at, q);
    if (d.website) { const platform = socialPlatformOf(d.website); if (platform) add('social', { platform, url: d.website }, s, at, 'low'); else add('website', d.website, s, at, q, { url: d.website }); }
  }
  if (c) {
    const s = c.source, at = i.capturedAt, q: Quality = 'medium';
    add('name', c.companyName, s, at, q); add('address', c.address, s, at, q); add('postalCode', c.postalCode, s, at, q); add('city', c.city, s, at, q); add('phone', c.phone, s, at, q);
    add('email', c.email, s, at, q); add('website', c.websiteUrl, s, at, q, { url: c.websiteUrl }); add('openingHours', c.openingHours ? c.openingHours.split('\n') : undefined, s, at, q); add('description', c.description, s, at, q);
    for (const so of c.socials ?? []) add('social', { platform: so.platform, url: so.url }, s, at, 'low');
  }
  if (i.social) for (const pr of i.social.profiles) add('social', { platform: pr.platform, url: pr.url, handle: pr.handle, followers: pr.followers, lastPostAt: pr.lastPostAt }, pr.source, pr.capturedAt, pr.quality, { url: pr.url });
  if (i.siteFacts) {
    const at = i.audit?.capturedAt ?? i.capturedAt;
    add('phone', i.siteFacts.phone, 'website-crawl', at, 'medium', { url: i.siteFacts.url }); add('email', i.siteFacts.email, 'website-crawl', at, 'medium', { url: i.siteFacts.url });
    add('services', i.siteFacts.services, 'website-crawl', at, 'medium', { url: i.siteFacts.url, note: 'Aus Überschriften/Listen der Website gelesen' });
  }
  if (i.distanceKm !== undefined) add('distanceKm', Math.round(i.distanceKm * 10) / 10, 'computed', i.capturedAt, 'high', { note: 'Luftlinie zum Suchzentrum' });
  if (i.searchIndustry) add('industry', i.searchIndustry, 'search-criteria', i.capturedAt, 'medium');
  if (i.searchSub) add('subIndustry', i.searchSub, 'search-criteria', i.capturedAt, 'medium');
  return f;
}

/** Liest Telefon/E-Mail/Leistungen aus den Seiten (nur was dort tatsächlich steht). */
export function extractSiteFacts(pages: { url: string; html: string }[]): { phone?: string; email?: string; services?: string[]; url?: string } {
  const html = pages.map((p) => p.html).join('\n');
  const tel = /href=["']tel:([+\d\s()/-]+)["']/i.exec(html)?.[1];
  const mail = /href=["']mailto:([^"'?]+)/i.exec(html)?.[1];
  const services: string[] = [];
  for (const m of html.matchAll(/<h[23][^>]*>\s*(?:Leistungen|Unser Angebot|Angebot|Preise|Speisekarte)[^<]*<\/h[23]>\s*(?:<p[^>]*>[^<]*<\/p>\s*)?<ul[^>]*>([\s\S]*?)<\/ul>/gi)) {
    for (const li of m[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) { const t = li[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); if (t && t.length < 80) services.push(t); }
  }
  return { phone: tel?.trim(), email: mail?.trim(), services: [...new Set(services)].slice(0, 8), url: pages[0]?.url };
}

/** Flache Bestwerte für Listen/Suche aus den Fakten. */
export function leadFromFacts(facts: Fact[], base: { id: string; source: string }): Lead {
  const v = <T,>(k: FactKey) => factValue<T>(facts, k);
  const socials = facts.filter((x) => x.key === 'social').map((x) => x.value as { platform: string; url: string; lastPostAt?: string });
  const seen = new Set<string>();
  const uniq = socials.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));
  return {
    id: base.id, source: base.source, companyName: v<string>('name') ?? 'Unbekannt', industry: v('industry'), subIndustry: v('subIndustry'), address: v('address'), postalCode: v('postalCode'), city: v('city'),
    phone: v('phone'), email: v('email'), websiteUrl: v('website'), socials: uniq.map((s) => ({ platform: s.platform, url: s.url, lastActivityAt: s.lastPostAt })),
    mapsUrl: v('mapsUrl'), openingHours: (v<string[]>('openingHours') ?? []).join('\n') || undefined, description: v('description'), employeeBucket: v('employeeBucket'),
    distanceKm: v('distanceKm'), rating: v('rating'), reviewCount: v('reviewCount'), point: v('point'),
  };
}
