import type { AiConfig } from '../core/config.ts';
import type { AiTierName } from '../providers/types.ts';

export const TIERS: AiTierName[] = ['MASS', 'DEEP', 'PREMIUM'];
export const isTier = (v: unknown): v is AiTierName => v === 'MASS' || v === 'DEEP' || v === 'PREMIUM';

/** Modell, Token-Limit und Preise einer Stufe. Modell-ID: Umgebungsvariable (ANTHROPIC_MODEL_<STUFE>) vor config/ai.json – nichts ist im Code festgelegt. */
export function resolveTier(cfg: AiConfig, tier: AiTierName, env: Record<string, string | undefined> = process.env) {
  const t = cfg.tiers[tier];
  const model = (t.modelEnv && env[t.modelEnv]) || t.model;
  return { tier, label: t.label, model, maxTokens: t.maxTokens, inputUsdPerMTok: t.inputUsdPerMTok, outputUsdPerMTok: t.outputUsdPerMTok };
}

/** Geschätzte Kosten in Cent (EUR) aus den gemeldeten Token. Ohne Token-Angabe: 0 (unbekannt). Mock-Aufrufe kosten nichts. */
export function estimateCostCents(cfg: AiConfig, tier: AiTierName, inputTokens = 0, outputTokens = 0, isMock = false, env: Record<string, string | undefined> = process.env): number {
  if (isMock) return 0;
  const t = resolveTier(cfg, tier, env);
  const usd = (inputTokens * t.inputUsdPerMTok + outputTokens * t.outputUsdPerMTok) / 1_000_000;
  return Math.round(usd * cfg.eurPerUsd * 100 * 10000) / 10000;
}
