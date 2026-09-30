import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Taxonomy, type IndustryConfig } from './industries.ts';

export type AppConfig = {
  dir: string;
  scoring: any; pricing: any; agency: any; industries: IndustryConfig; taxonomy: Taxonomy; sales: any; retention: any;
};

const cache = new Map<string, AppConfig>();
const ROOT = new URL('../../', import.meta.url).pathname;

/** Liest die JSON-Konfiguration. CONFIG_DIR (oder der Parameter) wählt ein anderes Verzeichnis, z. B. config.mock für den Demo-Modus. */
export function loadConfig(dir = process.env.CONFIG_DIR || 'config'): AppConfig {
  const abs = resolve(ROOT, dir);
  const hit = cache.get(abs);
  if (hit) return hit;
  const read = (n: string) => JSON.parse(readFileSync(resolve(abs, n), 'utf8'));
  const industries = read('industries.json') as IndustryConfig;
  const cfg: AppConfig = { dir: abs, scoring: read('scoring.json'), pricing: read('pricing.json'), agency: read('agency.json'), industries, taxonomy: new Taxonomy(industries), sales: read('sales.json'), retention: read('retention.json') };
  cache.set(abs, cfg);
  return cfg;
}
export const clearConfigCache = () => cache.clear();
