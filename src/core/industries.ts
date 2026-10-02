import { norm } from './text.ts';

export type SubIndustry = { key: string; label: string; keywords: string[]; template: string; booking: boolean; features?: string[]; industryKey: string; industryLabel: string };
export type Industry = { key: string; label: string; subIndustries: Omit<SubIndustry, 'industryKey' | 'industryLabel'>[] };
export type IndustryConfig = { industries: Industry[] };

export class Taxonomy {
  readonly subs: SubIndustry[];
  readonly industries: Industry[];
  constructor(cfg: IndustryConfig) {
    this.industries = cfg.industries;
    this.subs = cfg.industries.flatMap((i) => i.subIndustries.map((s) => ({ ...s, industryKey: i.key, industryLabel: i.label })));
  }
  sub(key: string | undefined | null): SubIndustry | undefined { return this.subs.find((s) => s.key === key); }
  industry(key: string | undefined | null): Industry | undefined { return this.industries.find((i) => i.key === key); }
  subsOf(industryKey: string): SubIndustry[] { return this.subs.filter((s) => s.industryKey === industryKey); }

  /** Sucht eine Unterbranche zu einem Freitext (Einzahl/Mehrzahl, Umlaute egal). */
  match(text: string): SubIndustry | undefined {
    const t = norm(text);
    if (!t) return undefined;
    const words = t.split(' ');
    let best: { s: SubIndustry; len: number } | undefined;
    for (const s of this.subs) {
      for (const k of [s.key, s.label, ...s.keywords]) {
        const nk = norm(k);
        if (!nk) continue;
        const hit = words.some((w) => w === nk || (nk.length >= 5 && w.startsWith(nk)) || (w.length >= 5 && nk.startsWith(w) && nk.length - w.length <= 2));
        if (hit && (!best || nk.length > best.len)) best = { s, len: nk.length };
      }
    }
    return best?.s;
  }
  /** Alle Suchbegriffe einer Unterbranche (für Datenquellen). */
  keywordsFor(subKeys: string[]): string[] {
    const per = subKeys.length > 3 ? 1 : 3;
    return [...new Set(subKeys.flatMap((k) => this.sub(k)?.keywords.slice(0, per) ?? []))];
  }
}
