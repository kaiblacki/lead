import type { Repo } from './repo.ts';
import type { AiTierName } from '../providers/types.ts';

export type UsageRow = { leadId: string | null; model: string; task: string; tier: AiTierName | null; purpose: string; inputTokens: number; outputTokens: number; estCents: number; mock: boolean };

/** KI-Kostenprotokoll: ein Datensatz je Aufruf (Modell, Aufgabe, Token, geschätzte Kosten, Lead, Zeitpunkt). */
export class AiUsageStore {
  repo: Repo;
  constructor(repo: Repo) { this.repo = repo; }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }

  async insert(r: UsageRow) {
    await this.pool.query('insert into ai_usage(owner_id, lead_id, model, est_cents, task, tier, purpose, input_tokens, output_tokens) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [this.owner, r.leadId, r.model, r.estCents, r.task, r.tier, r.purpose, r.inputTokens, r.outputTokens]);
  }
  /** Bisher verbrauchte Cent heute / in diesem Monat (für die Budget-Limits). */
  async spent(now: Date) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()), month = new Date(now.getFullYear(), now.getMonth(), 1);
    const r = (await this.pool.query('select coalesce(sum(est_cents) filter (where created_at >= $2),0)::float d, coalesce(sum(est_cents) filter (where created_at >= $3),0)::float m from ai_usage where owner_id=$1', [this.owner, day, month])).rows[0];
    return { dailyCents: r.d as number, monthlyCents: r.m as number };
  }
  /** Kosten eines Leads nach Zweck. */
  async forLead(leadId: string) {
    const rows = (await this.pool.query("select coalesce(purpose,'other') purpose, count(*)::int calls, coalesce(sum(est_cents),0)::float cents, coalesce(sum(input_tokens),0)::int tin, coalesce(sum(output_tokens),0)::int tout from ai_usage where owner_id=$1 and lead_id=$2 group by 1", [this.owner, leadId])).rows;
    const by = Object.fromEntries(rows.map((r) => [r.purpose, r])) as Record<string, { calls: number; cents: number; tin: number; tout: number }>;
    const sum = (k: 'cents' | 'calls' | 'tin' | 'tout') => rows.reduce((s, r) => s + Number(r[k]), 0);
    return { analysisCents: by.analysis?.cents ?? 0, demoCents: by.demo?.cents ?? 0, contactCents: by.contact?.cents ?? 0, totalCents: sum('cents'), calls: sum('calls'), inputTokens: sum('tin'), outputTokens: sum('tout') };
  }
  /** Gesamtübersicht für Analytics. */
  async overview() {
    const t = (await this.pool.query("select coalesce(sum(est_cents),0)::float total, coalesce(sum(est_cents) filter (where purpose='analysis'),0)::float analysis, coalesce(sum(est_cents) filter (where purpose='demo'),0)::float demo, count(*)::int calls from ai_usage where owner_id=$1", [this.owner])).rows[0];
    const analysed = (await this.pool.query('select count(distinct lead_id)::int n from lead_analysis where owner_id=$1', [this.owner])).rows[0].n as number;
    const demos = (await this.pool.query('select count(distinct lead_id)::int n from demos where owner_id=$1', [this.owner])).rows[0].n as number;
    const byTier = (await this.pool.query("select coalesce(tier,'—') tier, count(*)::int calls, coalesce(sum(est_cents),0)::float cents from ai_usage where owner_id=$1 group by 1 order by 1", [this.owner])).rows;
    return { totalCents: t.total as number, analysisCents: t.analysis as number, demoCents: t.demo as number, calls: t.calls as number, analysedLeads: analysed, demoLeads: demos,
      avgPerAnalysedCents: analysed ? (t.total as number) / analysed : null, avgPerDemoCents: demos ? (t.demo as number) / demos : null, byTier };
  }
}
