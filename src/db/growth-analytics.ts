import type { Repo } from './repo.ts';

export type Slice = { key: string; leads: number; analyzed: number; called: number; interested: number; demos: number; offers: number; won: number; avgAction: number | null };

/** Auswertungen nach Branche, Region, Strategie und Partner sowie Kosten je Lead/Kunde. Nur Lesezugriffe auf gespeicherte Daten. */
export class GrowthAnalytics {
  repo: Repo;
  constructor(repo: Repo) { this.repo = repo; }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }

  /** Gruppiert die Leads nach einer festen Spalte (kein freier Eingabewert im SQL). */
  async slices(by: 'industry' | 'region' | 'strategy' | 'contact'): Promise<Slice[]> {
    const col = { industry: "coalesce(l.sub_industry, l.industry, 'nicht verfügbar')", region: "coalesce(l.city, l.region, 'nicht verfügbar')", strategy: "coalesce(l.conversation_strategy, 'nicht verfügbar')", contact: "coalesce(l.contact_strategy, l.recommended_contact_strategy, 'nicht verfügbar')" }[by];
    const rows = (await this.pool.query(`
      select ${col} as key, count(*)::int leads,
        count(*) filter (where exists (select 1 from audits a where a.lead_id = l.id) or exists (select 1 from score_snapshots s where s.lead_id = l.id))::int analyzed,
        count(*) filter (where l.call_count > 0)::int called,
        count(*) filter (where l.status in ('INTERESTED','OFFER_SENT','OFFER_ACCEPTED') or exists (select 1 from events e where e.lead_id = l.id and e.type = 'status_change' and e.payload->>'to' = 'INTERESTED'))::int interested,
        count(*) filter (where exists (select 1 from demos d where d.lead_id = l.id))::int demos,
        count(*) filter (where exists (select 1 from offers o where o.lead_id = l.id and o.status in ('SENT','ACCEPTED')))::int offers,
        count(*) filter (where exists (select 1 from lead_outcomes lo where lo.lead_id = l.id and lo.kind = 'final' and lo.value = 'WON'))::int won,
        avg(l.action_priority)::float avg_action
      from leads l where l.owner_id = $1 group by 1 order by leads desc, key limit 50`, [this.owner])).rows;
    return rows.map((r) => ({ key: r.key, leads: r.leads, analyzed: r.analyzed, called: r.called, interested: r.interested, demos: r.demos, offers: r.offers, won: r.won, avgAction: r.avg_action === null ? null : Math.round(r.avg_action) }));
  }

  /** Partner: Status, Leads/Weiterleitungen, Umwandlungen, geschätzter Wert. */
  async partners() {
    const rows = (await this.pool.query(`
      select p.id, p.company_name, p.status,
        count(r.id) filter (where r.direction = 'OUTGOING')::int outgoing,
        count(r.id) filter (where r.direction = 'INCOMING')::int incoming,
        count(r.id) filter (where r.accepted)::int accepted,
        count(r.id) filter (where r.converted)::int converted,
        coalesce(sum(r.estimated_value_cents) filter (where r.converted), 0)::bigint value_cents
      from partners p left join referrals r on p.id in (r.source_partner_id, r.destination_partner_id) and r.status <> 'CANCELLED'
      where p.owner_id = $1 group by p.id order by p.company_name`, [this.owner])).rows;
    const byStatus = (await this.pool.query('select status, count(*)::int n from partners where owner_id = $1 group by 1 order by 2 desc', [this.owner])).rows;
    return { partners: rows.map((r) => ({ ...r, value_cents: Number(r.value_cents) })), byStatus };
  }

  /** Kosten je Lead und je Kunde: KI-Schätzung (ai_usage) + Web-Anreicherung (enrichment_log, EUR). Nicht erfasste Kosten werden nicht geschätzt. */
  async costs() {
    const one = async (sql: string) => (await this.pool.query(sql, [this.owner])).rows[0];
    const leads = (await one('select count(*)::int n from leads where owner_id = $1')).n as number;
    const customers = (await one("select count(distinct lead_id)::int n from lead_outcomes where owner_id = $1 and kind = 'final' and value = 'WON'")).n as number;
    const ai = Number((await one('select coalesce(sum(est_cents),0)::float c from ai_usage where owner_id = $1')).c);
    const enrich = Number((await one('select coalesce(sum(cost_cents),0)::float c from enrichment_log where owner_id = $1')).c);
    const total = ai + enrich;
    return { leads, customers, aiCents: ai, enrichCents: enrich, totalCents: total, perLeadCents: leads ? total / leads : null, perCustomerCents: customers ? total / customers : null };
  }

  /** Umsatz je Monat (bezahlte Zahlungen), letzte 12 Monate. */
  async revenueByMonth() {
    return (await this.pool.query(`select to_char(date_trunc('month', paid_at), 'YYYY-MM') as month, sum(amount_cents)::bigint cents, count(*)::int n from payments where owner_id = $1 and status = 'paid' and paid_at >= now() - interval '12 months' group by 1 order by 1 desc`, [this.owner])).rows.map((r) => ({ month: r.month as string, cents: Number(r.cents), n: r.n as number }));
  }
}
