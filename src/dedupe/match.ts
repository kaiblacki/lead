import type { GeoPoint } from '../providers/types.ts';
import { distanceKm } from '../core/geo.ts';
import { hostOf, norm, normPhone, socialPlatformOf } from '../core/text.ts';

/** Ein Datensatz, wie ihn jede Quelle liefern kann. Die Match-Logik kennt keine Quelle – nur diese Felder. */
export type MatchRecord = { name: string; phone?: string | null; website?: string | null; email?: string | null; address?: string | null; postalCode?: string | null; city?: string | null; point?: GeoPoint | null; subIndustry?: string | null };
export type MatchVerdict = 'MATCH' | 'POSSIBLE_MATCH' | 'NO_MATCH';
export type MatchResult = { verdict: MatchVerdict; score: number; reasons: string[] };
export type DedupeConfig = {
  matchAt: number; possibleAt: number; nearMeters: number; genericWords: string[];
  weights: { phone: number; domain: number; email: number; nameExact: number; nameSimilar: number; address: number; postalCode: number; near: number; industry: number };
  conflicts: { differentPhone: number; differentDomain: number; differentStreetNumber: number };
};

const lev = (a: string, b: string): number => {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
};

/** Namensbestandteile ohne Rechtsform und Branchenwörter („Nagelstudio Anna GmbH“ → „anna“). */
const tokCache = new Map<string, { all: string[]; core: string[] }>();
export function nameTokens(name: string, generic: string[]): { all: string[]; core: string[] } {
  const key = `${name}\u0000${generic.length}\u0000${generic[generic.length - 1] ?? ''}`; const hit = tokCache.get(key); if (hit) return hit;
  if (tokCache.size > 50_000) tokCache.clear();
  const g = new Set(generic);
  const all = norm(name.replace(/&/g, ' ')).split(/\s+/).filter(Boolean);
  const core = all.filter((t) => !g.has(t) && t.length > 1);
  const res = { all, core }; tokCache.set(key, res); return res;
}
const tokEq = (a: string, b: string) => a === b || (a.length >= 7 && b.length >= 7 && lev(a, b) <= 1);

/** 0…1: wie ähnlich sind zwei Firmennamen (Tokenvergleich; kurze Namen wie „Anna“/„Anja“ gelten als verschieden). */
export function nameSimilarity(a: string, b: string, generic: string[]): { exact: boolean; sim: number } {
  const A = nameTokens(a, generic), B = nameTokens(b, generic);
  if (norm(a) === norm(b)) return { exact: true, sim: 1 };
  const ca = A.core.length ? A.core : A.all, cb = B.core.length ? B.core : B.all;
  if (!ca.length || !cb.length) return { exact: false, sim: 0 };
  const hits = ca.filter((t) => cb.some((u) => tokEq(t, u))).length;
  let sim = hits / (ca.length + cb.length - hits);
  // Ein Name steckt vollständig im anderen („Haarwerk“ ↔ „Haarwerk Saarbrücken“), sofern das gemeinsame Wort unterscheidungskräftig ist
  if (hits >= 1 && hits === Math.min(ca.length, cb.length) && ca.some((t) => t.length >= 5 && cb.some((u) => tokEq(t, u)))) sim = Math.max(sim, 0.8);
  return { exact: A.core.join(' ') === B.core.join(' ') && A.core.length > 0, sim };
}

const streetCache = new Map<string, { street: string; no: string } | null>();
export function parseStreet(address?: string | null): { street: string; no: string } | null {
  if (!address) return null;
  const c = streetCache.get(address); if (c !== undefined) return c;
  if (streetCache.size > 50_000) streetCache.clear();
  const r = parseStreetRaw(address); streetCache.set(address, r); return r;
}
function parseStreetRaw(address: string): { street: string; no: string } | null {
  const first = address.split(',')[0].trim();
  const m = /^(.*?[A-Za-zÄÖÜäöüß.])\s*(\d+\s*[a-zA-Z]?)(?:\s*[-–/]\s*\d+\s*[a-zA-Z]?)?$/.exec(first);
  if (!m) return null;
  const street = norm(m[1].replace(/stra(ß|ss)e|str\./gi, 'str')).replace(/str$/, '') ;
  return { street, no: norm(m[2]) };
}

const GENERIC_DOMAINS = /^(gmail|gmx|web|t-online|outlook|yahoo|mail|freenet|icloud|hotmail)\./;
const domainOf = (w?: string | null) => { if (!w || socialPlatformOf(w)) return null; return hostOf(w); };

/** Vergleicht zwei Datensätze mit mehreren Merkmalen. Kein Merkmal allein gilt als Beweis. */
export function compareRecords(a: MatchRecord, b: MatchRecord, cfg: DedupeConfig): MatchResult {
  const W = cfg.weights, C = cfg.conflicts; const reasons: string[] = []; let score = 0; const ids: string[] = [];
  const add = (n: number, why: string) => { score += n; reasons.push(`${why} (${n > 0 ? '+' : ''}${n})`); };
  const pa = a.phone && normPhone(a.phone).length >= 6 ? normPhone(a.phone) : null, pb = b.phone && normPhone(b.phone).length >= 6 ? normPhone(b.phone) : null;
  if (pa && pb) { if (pa === pb) { add(W.phone, 'gleiche Telefonnummer'); ids.push('phone'); } else add(C.differentPhone, 'unterschiedliche Telefonnummern'); }
  const da = domainOf(a.website), db = domainOf(b.website);
  if (da && db) { if (da === db) { add(W.domain, 'gleiche Domain'); ids.push('domain'); } else add(C.differentDomain, 'unterschiedliche Domains'); }
  const ea = a.email?.toLowerCase(), eb = b.email?.toLowerCase();
  if (ea && eb && ea === eb && !GENERIC_DOMAINS.test(ea.split('@')[1] ?? '') ) { add(W.email, 'gleiche E-Mail'); ids.push('email'); }
  else if (ea && eb && ea === eb) { add(Math.round(W.email * 0.6), 'gleiche E-Mail (allgemeiner Anbieter)'); ids.push('email'); }
  const places = [a.city, b.city].filter(Boolean).flatMap((c) => norm(c!).split(/\s+/));
  const ns = nameSimilarity(a.name, b.name, [...cfg.genericWords, ...places]);
  if (ns.exact) add(W.nameExact, 'gleicher Name'); else if (ns.sim >= 0.6) add(W.nameSimilar, `ähnlicher Name (${Math.round(ns.sim * 100)} %)`);
  const sa = parseStreet(a.address), sb = parseStreet(b.address);
  const plzA = a.postalCode || /\b(\d{5})\b/.exec(a.address ?? '')?.[1], plzB = b.postalCode || /\b(\d{5})\b/.exec(b.address ?? '')?.[1];
  if (sa && sb) {
    if (sa.street === sb.street && sa.no === sb.no) { add(W.address, 'gleiche Adresse'); ids.push('address'); if (plzA && plzA === plzB) add(W.postalCode, 'gleiche PLZ'); }
    else if (sa.street === sb.street) add(C.differentStreetNumber, 'gleiche Straße, andere Hausnummer');
  } else if (plzA && plzA === plzB) add(W.postalCode, 'gleiche PLZ');
  if (a.point && b.point && distanceKm(a.point, b.point) * 1000 <= cfg.nearMeters) add(W.near, `Standort < ${cfg.nearMeters} m`);
  if (a.subIndustry && b.subIndustry && a.subIndustry === b.subIndustry) add(W.industry, 'gleiche Branche');
  const nameOk = ns.exact || ns.sim >= 0.6;
  let verdict: MatchVerdict = 'NO_MATCH';
  // Ohne Kennung (Telefon/Domain/E-Mail/Adresse) und ohne Namensähnlichkeit gibt es nichts, worauf sich ein Verdacht stützen könnte.
  if (ids.length || nameOk) {
    if (score >= cfg.matchAt && (nameOk || ids.length >= 2)) verdict = 'MATCH';
    else if (score >= cfg.possibleAt) verdict = 'POSSIBLE_MATCH';
  }
  return { verdict, score, reasons };
}
