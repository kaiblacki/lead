import type { DirectoryRecord, PlaceCandidate } from '../providers/types.ts';
import { compareRecords, nameTokens, type DedupeConfig, type MatchRecord, type MatchResult } from './match.ts';
import { hostOf, norm, normPhone, socialPlatformOf } from '../core/text.ts';

export type Alias = { source: string; ref: string };
export type PossiblePair = { source: string; ref: string; otherSource: string; otherRef: string; score: number; reasons: string[] };
/** Ein Unternehmen nach Dedupe: bis zu ein Orts-Datensatz und ein Verzeichnis-Datensatz; weitere Kennungen derselben Firma stehen in `aliases`. */
export type Merged = { place?: PlaceCandidate; directory?: DirectoryRecord; aliases: Alias[]; possible: PossiblePair[] };
export type DedupeStats = { raw: number; unique: number; merged: number; possible: number };

type Rec = { kind: 'P'; p: PlaceCandidate } | { kind: 'D'; d: DirectoryRecord };
const asMatch = (r: Rec): MatchRecord => {
  const x = r.kind === 'P' ? r.p : r.d; const sub = r.kind === 'D' ? r.d.subIndustry : undefined;
  return { name: x.name, phone: x.phone, website: x.website, email: r.kind === 'D' ? r.d.email : undefined, address: x.address, postalCode: x.postalCode, city: x.city, point: x.point, subIndustry: sub };
};
const refOf = (r: Rec): Alias => (r.kind === 'P' ? { source: r.p.source, ref: r.p.externalId } : { source: r.d.source, ref: r.d.externalId });
const Q = { high: 3, medium: 2, low: 1 } as const;
const completeness = (x: PlaceCandidate) => [x.phone, x.website, x.address, x.postalCode, x.openingHours?.length, x.point].filter(Boolean).length;

/** Suchschlüssel, damit nicht jeder Datensatz mit jedem verglichen werden muss (Blocking). */
function blocks(m: MatchRecord, generic: string[]): string[] {
  const k: string[] = [];
  if (m.phone && normPhone(m.phone).length >= 6) k.push(`p:${normPhone(m.phone)}`);
  const h = m.website && !socialPlatformOf(m.website) ? hostOf(m.website) : null; if (h) k.push(`d:${h}`);
  if (m.email) k.push(`e:${m.email.toLowerCase()}`);
  if (m.point) k.push(`g:${Math.round(m.point.lat * 100)},${Math.round(m.point.lng * 100)}`);
  const t = nameTokens(m.name, generic); const first = (t.core[0] ?? t.all[0]); if (first) k.push(`n:${first}`);
  return k;
}

/** Fehlende Angaben des Hauptdatensatzes aus den Duplikaten ergänzen (nichts wird überschrieben oder erfunden). */
function fillGaps(primary: PlaceCandidate, others: PlaceCandidate[]): PlaceCandidate {
  const out = { ...primary };
  for (const o of others) {
    out.phone ??= o.phone; out.website ??= o.website; out.address ??= o.address; out.postalCode ??= o.postalCode; out.city ??= o.city; out.point ??= o.point;
    if (!out.openingHours?.length && o.openingHours?.length) out.openingHours = o.openingHours;
    if (!out.categories.length) out.categories = o.categories;
  }
  return out;
}

/**
 * Führt Treffer mehrerer Quellen und Dubletten innerhalb einer Quelle zusammen.
 * MATCH → ein Unternehmen (Quelleninformationen bleiben als Alias erhalten). POSSIBLE_MATCH → getrennt lassen, aber zur manuellen Prüfung melden.
 */
export function dedupeCandidates(places: PlaceCandidate[], dirs: DirectoryRecord[], cfg: DedupeConfig): { items: Merged[]; stats: DedupeStats } {
  const recs: Rec[] = [...places.map((p) => ({ kind: 'P', p }) as Rec), ...dirs.map((d) => ({ kind: 'D', d }) as Rec)];
  const clusters: { members: Rec[]; mrecs: MatchRecord[] }[] = [];
  const index = new Map<string, Set<number>>();
  const possible: { rec: Rec; cluster: number; res: MatchResult }[] = [];
  for (const rec of recs) {
    const m = asMatch(rec); const cand = new Set<number>();
    for (const k of blocks(m, cfg.genericWords)) for (const c of index.get(k) ?? []) cand.add(c);
    let best: { c: number; res: MatchResult } | null = null; let poss: { c: number; res: MatchResult } | null = null;
    for (const c of cand) {
      for (const other of clusters[c].mrecs) {
        const res = compareRecords(m, other, cfg);
        if (res.verdict === 'MATCH' && (!best || res.score > best.res.score)) best = { c, res };
        else if (res.verdict === 'POSSIBLE_MATCH' && (!poss || res.score > poss.res.score)) poss = { c, res };
      }
    }
    let ci: number;
    if (best) { ci = best.c; clusters[ci].members.push(rec); clusters[ci].mrecs.push(m); }
    else { ci = clusters.length; clusters.push({ members: [rec], mrecs: [m] }); if (poss) possible.push({ rec, cluster: poss.c, res: poss.res }); }
    for (const k of blocks(m, cfg.genericWords)) { if (!index.has(k)) index.set(k, new Set()); index.get(k)!.add(ci); }
  }
  const items: Merged[] = clusters.map((cl) => {
    const ps = cl.members.filter((r): r is Extract<Rec, { kind: 'P' }> => r.kind === 'P').map((r) => r.p).sort((a, b) => Q[b.quality] - Q[a.quality] || completeness(b) - completeness(a));
    const ds = cl.members.filter((r): r is Extract<Rec, { kind: 'D' }> => r.kind === 'D').map((r) => r.d);
    const place = ps.length ? fillGaps(ps[0], ps.slice(1)) : undefined;
    const primaryRef = place ? { source: place.source, ref: place.externalId } : { source: ds[0].source, ref: ds[0].externalId };
    const aliases = cl.members.map(refOf).filter((a) => !(a.source === primaryRef.source && a.ref === primaryRef.ref));
    return { place, directory: ds[0], aliases, possible: [] };
  });
  const ofCluster = (c: number) => items[c];
  const primaryOf = (m: Merged): Alias => (m.place ? { source: m.place.source, ref: m.place.externalId } : { source: m.directory!.source, ref: m.directory!.externalId });
  for (const p of possible) {
    const mine = items.find((it) => it.aliases.some((a) => a.ref === refOf(p.rec).ref && a.source === refOf(p.rec).source) || (primaryOf(it).ref === refOf(p.rec).ref && primaryOf(it).source === refOf(p.rec).source));
    const other = ofCluster(p.cluster);
    if (mine && other && mine !== other) mine.possible.push({ ...primaryOf(mine), otherSource: primaryOf(other).source, otherRef: primaryOf(other).ref, score: p.res.score, reasons: p.res.reasons });
  }
  void norm;
  return { items, stats: { raw: recs.length, unique: items.length, merged: recs.length - items.length, possible: items.reduce((n, i) => n + i.possible.length, 0) } };
}
