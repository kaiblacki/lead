import type { AIProvider, AiRequest, AiResponse, AiTierName } from '../providers/types.ts';
import type { Budget } from '../guardrails/budget.ts';
import type { AiConfig } from '../core/config.ts';
import type { AiUsageStore, UsageRow } from '../db/ai-usage.ts';
import { estimateCostCents, resolveTier } from './tiers.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const roughTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * Alle KI-Aufrufe laufen hier durch: Stufe → Modell (config/ai.json), Budget vorher, Kosten-Protokoll nachher – egal ob Mock oder echter Anbieter.
 * Ohne `store` werden Einträge gesammelt und mit `flush(leadId)` gespeichert (der Lauf kennt die Lead-ID erst nach dem Speichern).
 */
export class AiGateway {
  log: UsageRow[] = [];
  private provider: AIProvider; private budget: Budget; private cfg?: AiConfig; private store?: AiUsageStore; private env: Record<string, string | undefined>;
  constructor(provider: AIProvider, budget: Budget, o: { cfg?: AiConfig; store?: AiUsageStore; env?: Record<string, string | undefined> } = {}) { this.provider = provider; this.budget = budget; this.cfg = o.cfg; this.store = o.store; this.env = o.env ?? process.env; }

  /** Geschätzte Kosten vor dem Aufruf (für das Budget): Obergrenze aus max. Token der Stufe. */
  private preEstimate(tier: AiTierName, promptLen: number, maxTokens: number) { return this.cfg ? estimateCostCents(this.cfg, tier, Math.ceil(promptLen / 4), maxTokens, this.provider.isMock, this.env) : 0; }

  async complete(leadId: string | null, r: AiRequest): Promise<AiResponse> {
    const tier: AiTierName = r.tier ?? 'MASS';
    const t = this.cfg ? resolveTier(this.cfg, tier, this.env) : null;
    const maxTokens = r.maxTokens ?? t?.maxTokens ?? 600;
    this.budget.takeAi(leadId ?? 'run', this.preEstimate(tier, r.prompt.length, maxTokens));
    const req: AiRequest = { ...r, tier, maxTokens, model: r.model ?? (this.provider.isMock ? undefined : t?.model) };
    const res = await this.provider.complete(req);
    const tin = res.inputTokens ?? roughTokens((r.system ?? '') + r.prompt), tout = res.outputTokens ?? roughTokens(res.text);
    const row: UsageRow = { leadId, model: res.model, task: r.task, tier, purpose: r.purpose ?? 'other', inputTokens: tin, outputTokens: tout,
      estCents: this.cfg ? estimateCostCents(this.cfg, tier, tin, tout, this.provider.isMock, this.env) : 0, mock: this.provider.isMock };
    if (this.store && leadId && UUID_RE.test(leadId)) await this.store.insert(row); else this.log.push(row);
    return res;
  }
  /** Gesammelte Einträge einem (jetzt bekannten) Lead zuordnen und speichern. */
  async flush(leadId: string) { if (!this.store) return; const rows = this.log.splice(0); for (const r of rows) await this.store.insert({ ...r, leadId }); }
}
