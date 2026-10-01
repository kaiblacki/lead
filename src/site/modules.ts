import type { AppConfig } from '../core/config.ts';

export type Family = 'SERVICE' | 'APPOINTMENT' | 'GASTRO_RETAIL';
export const FAMILIES: Family[] = ['SERVICE', 'APPOINTMENT', 'GASTRO_RETAIL'];
export type ModuleDef = { label: string; demo: string };

export const moduleDefs = (cfg: AppConfig): Record<string, ModuleDef> => cfg.pipeline.demo.modules;
export const moduleKeys = (cfg: AppConfig): string[] => Object.keys(cfg.pipeline.demo.modules);

/** Layout-Familie: Unterbranche → Branche → vorhandene Branchen-Funktionen. Reine Konfiguration (config/pipeline.json), kein Branchenwissen im Code. */
export function familyFor(cfg: AppConfig, o: { subIndustry?: string | null; industry?: string | null }): Family {
  const fams = cfg.pipeline.demo.families as Record<Family, { subIndustries: string[]; industries: string[] }>;
  const sub = cfg.taxonomy.sub(o.subIndustry ?? undefined);
  for (const f of FAMILIES) if (sub && fams[f].subIndustries.includes(sub.key)) return f;
  const ind = sub?.industryKey ?? o.industry ?? undefined;
  for (const f of FAMILIES) if (ind && fams[f].industries.includes(ind)) return f;
  const feats = sub?.features ?? [];
  if (feats.includes('menu') || feats.includes('reservation')) return 'GASTRO_RETAIL';
  if (feats.includes('booking')) return 'APPOINTMENT';
  return 'SERVICE';
}

/** Empfohlene Module: zuerst die Funktionen der Unterbranche, dann die Standardauswahl der Familie – begrenzt (maxRecommended). Nur Empfehlung; Kai wählt. */
export function recommendModules(cfg: AppConfig, o: { family: Family; subIndustry?: string | null }): string[] {
  const D = cfg.pipeline.demo; const known = new Set(Object.keys(D.modules));
  const sub = cfg.taxonomy.sub(o.subIndustry ?? undefined);
  const fromFeatures = (sub?.features ?? []).map((f: string) => D.featureToModule[f]).filter((m: string | undefined): m is string => !!m && known.has(m));
  const out: string[] = [];
  // Passt die Familie zur Branche, führen deren Funktionen; wählt Kai eine andere Familie, führt deren Standardauswahl
  const own = familyFor(cfg, { subIndustry: o.subIndustry }) === o.family;
  const famDefaults: string[] = D.recommendedByFamily[o.family] ?? [];
  for (const m of own ? [...fromFeatures, ...famDefaults] : [...famDefaults, ...fromFeatures]) if (known.has(m) && !out.includes(m)) out.push(m);
  return out.slice(0, D.maxRecommended ?? 6);
}
/** Aktive Auswahl: Kais Auswahl, sonst die Empfehlung. Unbekannte Schlüssel fallen heraus. */
export function effectiveModules(cfg: AppConfig, o: { recommended?: string[] | null; selected?: string[] | null }): string[] {
  const known = new Set(Object.keys(cfg.pipeline.demo.modules));
  return (o.selected ?? o.recommended ?? []).filter((m) => known.has(m));
}
