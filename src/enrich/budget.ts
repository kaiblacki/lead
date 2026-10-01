import type { Repo } from '../db/repo.ts';
import { startOfBerlinDay } from '../core/time.ts';

export type BudgetStatus = {
  monthlyLimitCents: number; dailyLimitCents: number; monthSpentCents: number; monthLeftCents: number; todaySpentCents: number; todayLeftCents: number;
  monthRequests: number; todayRequests: number; monthEnrichedLeads: number; costPerEnrichedLeadCents: number | null;
};

/** Enrichment-Budget (monatlich + Tages-Sicherheitslimit), berechnet aus dem Protokoll `enrichment_log`. Kostenlose Anbieter (Kosten 0) verbrauchen nichts. */
export class EnrichmentBudget {
  repo: Repo; cfg: { monthly_enrichment_budget_eur: number; daily_enrichment_budget_eur: number };
  /** Die Limits werden bei jeder Prüfung aus der Konfiguration gelesen (änderbar ohne Neustart der Logik). */
  constructor(repo: Repo, cfg: { monthly_enrichment_budget_eur: number; daily_enrichment_budget_eur: number }) { this.repo = repo; this.cfg = cfg; }
  get monthlyEur() { return this.cfg.monthly_enrichment_budget_eur; }
  get dailyEur() { return this.cfg.daily_enrichment_budget_eur; }
  static monthStart(now: Date): Date {
    const day = startOfBerlinDay(now); const dom = Number(new Intl.DateTimeFormat('de-DE', { day: 'numeric', timeZone: 'Europe/Berlin' }).format(now));
    return startOfBerlinDay(new Date(day.getTime() - (dom - 1) * 86400_000 + 12 * 3600_000));
  }
  async status(now: Date): Promise<BudgetStatus> {
    const day = startOfBerlinDay(now), month = EnrichmentBudget.monthStart(now);
    const r = (await this.repo.pool.query(`select coalesce(sum(cost_cents) filter (where created_at >= $2),0)::float m, coalesce(sum(cost_cents) filter (where created_at >= $3),0)::float d,
        coalesce(sum(requests) filter (where created_at >= $2),0)::int mr, coalesce(sum(requests) filter (where created_at >= $3),0)::int dr, count(distinct lead_id) filter (where created_at >= $2 and requests > 0)::int ml
        from enrichment_log where owner_id=$1`, [this.repo.ownerId, month, day])).rows[0];
    const monthlyLimitCents = this.monthlyEur * 100, dailyLimitCents = this.dailyEur * 100;
    return { monthlyLimitCents, dailyLimitCents, monthSpentCents: r.m, monthLeftCents: Math.max(0, monthlyLimitCents - r.m), todaySpentCents: r.d, todayLeftCents: Math.max(0, dailyLimitCents - r.d),
      monthRequests: r.mr, todayRequests: r.dr, monthEnrichedLeads: r.ml, costPerEnrichedLeadCents: r.ml ? r.m / r.ml : null };
  }
  /** Darf eine weitere Anfrage mit geschätzten Kosten `cents` gestartet werden? Kostenlose (0) immer. */
  async canSpend(now: Date, cents: number, pending = 0): Promise<boolean> {
    if (cents <= 0) return true;
    const s = await this.status(now);
    return s.monthSpentCents + pending + cents <= s.monthlyLimitCents + 1e-9 && s.todaySpentCents + pending + cents <= s.dailyLimitCents + 1e-9;
  }
}
