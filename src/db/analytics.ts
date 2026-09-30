import type { Repo } from './repo.ts';

export type Range = 'all' | '7' | '30' | '90';
export const STAGES = ['found', 'analyzed', 'qualified', 'contactReady', 'called', 'reached', 'interested', 'demo', 'offer', 'deposit', 'customer'] as const;
export type StageKey = (typeof STAGES)[number];
export const STAGE_TEXT: Record<StageKey, string> = {
  found: 'Leads gefunden', analyzed: 'Leads analysiert', qualified: 'Qualifizierte Leads', contactReady: 'Kontaktbereite Leads', called: 'Angerufen', reached: 'Erreicht (Antworten)',
  interested: 'Interessenten', demo: 'Demos', offer: 'Angebote', deposit: 'Anzahlungen', customer: 'Gewonnene Kunden',
};

/** Kennzahlen für das Dashboard. Funnel = Kohorte der im Zeitraum gefundenen Leads: wie viele haben jede Stufe je erreicht? */
export class AnalyticsStore {
  repo: Repo;
  constructor(repo: Repo) { this.repo = repo; }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }

  async overview(range: Range = 'all', now = new Date()) {
    const since = range === 'all' ? new Date(0) : new Date(now.getTime() - Number(range) * 86400000);
    // Pro Lead ein Satz „eigene“ Kennzeichen; daraus ein echter Trichter: eine Stufe zählt jeden Lead, der sie erreicht hat ODER darüber hinaus ist
    // (z. B. Anzahlung ⇒ auch Angebot, Interesse). So nimmt der Trichter nach unten nie zu und keine Quote übersteigt 100 %.
    const flags = (await this.pool.query(`
      with cohort as (select id, contact_readiness from leads where owner_id = $1 and created_at >= $2)
      select c.id,
        (exists (select 1 from audits a where a.lead_id = c.id) or exists (select 1 from score_snapshots s where s.lead_id = c.id)) as analyzed,
        exists (select 1 from events e where e.lead_id = c.id and e.owner_id = $1 and e.type = 'status_change' and e.payload->>'to' = 'QUALIFIED') as qualified,
        (c.contact_readiness = 'READY_FOR_MANUAL_CALL') as ready,
        exists (select 1 from contact_history h where h.lead_id = c.id and h.owner_id = $1 and h.channel = 'PHONE') as called,
        exists (select 1 from contact_history h where h.lead_id = c.id and h.owner_id = $1 and h.channel = 'PHONE' and h.result <> 'NO_ANSWER') as reached,
        exists (select 1 from events e where e.lead_id = c.id and e.owner_id = $1 and e.type = 'status_change' and e.payload->>'to' = 'INTERESTED') as interested,
        exists (select 1 from demos d where d.lead_id = c.id) as demo,
        exists (select 1 from offers o where o.lead_id = c.id and o.status in ('SENT','ACCEPTED')) as offer,
        exists (select 1 from payments p join orders o on o.id = p.order_id where o.lead_id = c.id and p.kind = 'deposit' and p.status = 'paid') as deposit,
        exists (select 1 from lead_outcomes lo where lo.lead_id = c.id and lo.kind = 'final' and lo.value = 'WON') as customer
      from cohort c`, [this.owner, since])).rows as Record<string, boolean>[];
    const callCount = (await this.pool.query("select count(*)::int n from contact_history h join leads l on l.id = h.lead_id where h.owner_id = $1 and h.channel = 'PHONE' and l.created_at >= $2", [this.owner, since])).rows[0].n as number;
    const own: Record<StageKey, (f: Record<string, boolean>) => boolean> = {
      found: () => true, analyzed: (f) => f.analyzed, qualified: (f) => f.qualified, contactReady: (f) => f.qualified && f.ready, called: (f) => f.called, reached: (f) => f.reached,
      interested: (f) => f.interested, demo: (f) => f.demo, offer: (f) => f.offer, deposit: (f) => f.deposit, customer: (f) => f.customer,
    };
    const counts = Object.fromEntries(STAGES.map((k) => [k, 0])) as Record<StageKey, number>;
    for (const f of flags) {
      let beyond = false;                                              // von unten nach oben: „weiter hinten erreicht“ schließt vorherige Stufen ein
      for (let i = STAGES.length - 1; i >= 0; i--) { beyond = beyond || own[STAGES[i]](f); if (beyond) counts[STAGES[i]]++; }
    }
    const r = { ...counts, callCount };
    const money = (await this.pool.query(`
      select
        coalesce((select sum(p.amount_cents) from payments p where p.owner_id=$1 and p.status='paid' and p.kind in ('deposit','final') and p.paid_at >= $2),0)::bigint as revenue,
        coalesce((select sum(p.amount_cents) from payments p where p.owner_id=$1 and p.status='paid' and p.kind = 'maintenance' and p.paid_at >= $2),0)::bigint as maint_paid,
        coalesce((select sum(monthly_cents) from maintenance_plans where owner_id=$1 and status='ACTIVE'),0)::bigint as mrr,
        (select count(*) from maintenance_plans where owner_id=$1 and status='ACTIVE')::int as active_plans,
        (select avg(f.price_cents)::float from offers f join orders o on o.offer_id = f.id where f.owner_id=$1 and exists (select 1 from payments p where p.order_id = o.id and p.kind='deposit' and p.status='paid' and p.paid_at >= $2)) as aov`, [this.owner, since])).rows[0];
    const funnel = STAGES.map((k) => ({ key: k, label: STAGE_TEXT[k], count: (r as any)[k] as number }));
    const steps = funnel.slice(1).map((s, i) => ({ from: funnel[i].label, to: s.label, rate: funnel[i].count ? Math.round((s.count / funnel[i].count) * 1000) / 10 : null, fromCount: funnel[i].count, toCount: s.count }));
    return { range, funnel, steps, calls: r.callCount as number, revenueCents: Number(money.revenue), maintenancePaidCents: Number(money.maint_paid), mrrCents: Number(money.mrr), arrCents: Number(money.mrr) * 12, activePlans: money.active_plans as number, avgOrderCents: money.aov === null ? null : Math.round(money.aov as number) };
  }

  /** Pipeline: Anzahl pro Status. */
  async stageCounts() { return new Map<string, number>((await this.pool.query('select status, count(*)::int n from leads where owner_id=$1 group by 1', [this.owner])).rows.map((r) => [r.status, r.n])); }

  async recentRuns(limit = 5) { return (await this.pool.query('select id, created_at, status, description, counters from lead_runs where owner_id=$1 order by created_at desc limit $2', [this.owner, limit])).rows; }
}
