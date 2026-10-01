import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Taxonomy, type IndustryConfig } from './industries.ts';

export type AppConfig = {
  dir: string;
  scoring: any; pricing: any; agency: any; industries: IndustryConfig; taxonomy: Taxonomy; sales: any; retention: any; ai: AiConfig; analysis: AnalysisConfig; pipeline: PipelineConfig;
};
export type AiTierCfg = { label: string; model: string; modelEnv: string; maxTokens: number; inputUsdPerMTok: number; outputUsdPerMTok: number; purpose: string };
export type AiConfig = { eurPerUsd: number; tiers: Record<'MASS' | 'DEEP' | 'PREMIUM', AiTierCfg> };
export type PipelineConfig = any;
export type AnalysisConfig = { featureLabels: Record<string, string>; improvements: Record<string, string>; noWebsiteImprovements: string[] };

const cache = new Map<string, AppConfig>();
const ROOT = new URL('../../', import.meta.url).pathname;

/** Liest die JSON-Konfiguration. CONFIG_DIR (oder der Parameter) wählt ein anderes Verzeichnis, z. B. config.mock für den Demo-Modus. */
export function loadConfig(dir = process.env.CONFIG_DIR || 'config'): AppConfig {
  const abs = resolve(ROOT, dir);
  const hit = cache.get(abs);
  if (hit) return hit;
  // Fehlende Dateien kommen aus config/ (Überlagerung, z. B. config.mock mit nur agency.json und pricing.json)
  const read = (n: string) => { const f = resolve(abs, n); return JSON.parse(readFileSync(existsSync(f) ? f : resolve(ROOT, 'config', n), 'utf8')); };
  const industries = read('industries.json') as IndustryConfig;
  const cfg: AppConfig = { dir: abs, scoring: read('scoring.json'), pricing: read('pricing.json'), agency: read('agency.json'), industries, taxonomy: new Taxonomy(industries), sales: read('sales.json'), retention: read('retention.json'), ai: read('ai.json'), analysis: read('analysis.json'), pipeline: read('pipeline.json') };
  cache.set(abs, cfg);
  return cfg;
}
export const clearConfigCache = () => cache.clear();
