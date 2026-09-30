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
    const r = (await this.pool.query(`
      with cohort as (select id, contact_readiness from leads where owner_id = $1 and created_at >= $2),
      ev as (select distinct e.lead_id, e.payload->>'to' as stage from events e join cohort c on c.id = e.lead_id where e.owner_id = $1 and e.type = 'status_change'),
      calls as (select h.lead_id, h.result from contact_history h join cohort c on c.id = h.lead_id where h.owner_id = $1 and h.channel = 'PHONE')
      select
        (select count(*) from cohort)::int as found,
        (select count(distinct a.lead_id) from audits a join cohort c on c.id = a.lead_id)::int as analyzed,
        (select count(distinct lead_id) from ev where stage = 'QUALIFIED')::int as qualified,
        (select count(*) from cohort where contact_readiness = 'READY_FOR_MANUAL_CALL')::int as "contactReady",
        (select count(distinct lead_id) from calls)::int as called,
        (select count(distinct lead_id) from calls where result <> 'NO_ANSWER')::int as reached,
        (select count(*) from calls)::int as "callCount",
        (select count(distinct lead_id) from ev where stage = 'INTERESTED')::int as interested,
        (select count(distinct d.lead_id) from demos d join cohort c on c.id = d.lead_id)::int as demo,
        (select count(distinct o.lead_id) from offers o join cohort c on c.id = o.lead_id where o.status in ('SENT','ACCEPTED'))::int as offer,
        (select count(distinct o.lead_id) from payments p join orders o on o.id = p.order_id join cohort c on c.id = o.lead_id where p.kind = 'deposit' and p.status = 'paid')::int as deposit,
        (select count(distinct lead_id) from lead_outcomes lo where lo.kind = 'final' and lo.value = 'WON' and lo.lead_id in (select id from cohort))::int as customer`, [this.owner, since])).rows[0];
    const money = (await this.pool.query(`
      select
        coalesce((select sum(p.amount_cents) from payments p where p.owner_id=$1 and p.status='paid' and p.kind in ('deposit','final') and p.paid_at >= $2),0)::bigint as revenue,
        coalesce((select sum(p.amount_cents) from payments p where p.owner_id=$1 and p.status='paid' and p.kind = 'maintenance' and p.paid_at >= $2),0)::bigint as maint_paid,
        coalesce((select sum(monthly_cents) from maintenance_plans where owner_id=$1 and status='ACTIVE'),0)::bigint as mrr,
        (select count(*) from maintenance_plans where owner_id=$1 and status='ACTIVE')::int as active_plans,
        (select avg(f.price_cents)::float from offers f join orders o on o.offer_id = f.id where f.owner_id=$1 and exists (select 1 from payments p where p.order_id = o.id and p.kind='deposit' and p.status='paid' and p.paid_at >= $2)) as aov`, [this.owner, since])).rows[0];
    const funnel = STAGES.map((k) => ({ key: k, label: STAGE_TEXT[k], count: (r as any)[k] as number }));
    const steps = funnel.slice(1).map((s, i) => ({ from: funnel[i].label, to: s.label, rate: funnel[i].count ? Math.round((s.count / funnel[i].count) * 1000) / 10 : null, fromCount: funnel[i].count, toCount: s.count }));
    // contactReady ist kein „Nachfolger“ von qualified im engeren Sinn, bleibt aber als Stufe sichtbar
    return { range, funnel, steps, calls: r.callCount as number, revenueCents: Number(money.revenue), maintenancePaidCents: Number(money.maint_paid), mrrCents: Number(money.mrr), arrCents: Number(money.mrr) * 12, activePlans: money.active_plans as number, avgOrderCents: money.aov === null ? null : Math.round(money.aov as number) };
  }

  /** Pipeline: Anzahl pro Status. */
  async stageCounts() { return new Map<string, number>((await this.pool.query('select status, count(*)::int n from leads where owner_id=$1 group by 1', [this.owner])).rows.map((r) => [r.status, r.n])); }

  async recentRuns(limit = 5) { return (await this.pool.query('select id, created_at, status, description, counters from lead_runs where owner_id=$1 order by created_at desc limit $2', [this.owner, limit])).rows; }
}
