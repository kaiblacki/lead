import type { Repo } from './repo.ts';

export type LearningRow = Record<string, string | number | boolean | null>;
const BUCKETS: [string, number, number][] = [['0–44', 0, 44], ['45–59', 45, 59], ['60–74', 60, 74], ['75–100', 75, 100]];

/**
 * Learning Loop: Welche Eigenschaften hatte der Lead, welcher Score, was war das Ergebnis?
 * Nur saubere Datenstruktur und einfache Auswertung (kein ML). Export ohne Firmennamen/Kontaktdaten.
 */
export class LearningStore {
  repo: Repo;
  constructor(repo: Repo) { this.repo = repo; }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }

  /** Eine Zeile pro Lead: Merkmale + Scores (letzter Snapshot vor dem ersten Kontakt, sonst erster) + Ergebnisse. */
  async rows(): Promise<LearningRow[]> {
    const r = await this.pool.query(`
      select l.id as lead_id, l.sub_industry, l.is_mock,
        s.features, s.scores, s.created_at as scored_at,
        (select value from lead_outcomes o where o.lead_id = l.id and o.kind = 'call' order by at limit 1) as first_call_result,
        (select count(*)::int from lead_outcomes o where o.lead_id = l.id and o.kind = 'call') as calls,
        (select array_agg(distinct value) from lead_outcomes o where o.lead_id = l.id and o.kind = 'stage') as stages,
        (select value from lead_outcomes o where o.lead_id = l.id and o.kind = 'final' order by at desc limit 1) as final_outcome
      from leads l
      left join lateral (select features, scores, created_at from score_snapshots where lead_id = l.id order by created_at limit 1) s on true
      where l.owner_id = $1 order by l.created_at`, [this.owner]);
    return r.rows.map((x) => {
      const stages: string[] = x.stages ?? [], f = x.features ?? {}, sc = x.scores ?? {};
      return {
        lead_id: x.lead_id, sub_industry: x.sub_industry, is_mock: x.is_mock, employee_bucket: f.employeeBucket ?? null, distance_km: f.distanceKm ?? null, rating: f.rating ?? null, review_count: f.reviewCount ?? null,
        website_state: f.websiteState ?? null, has_phone: f.hasPhone ?? null, has_email: f.hasEmail ?? null, problem_count: Array.isArray(f.problemCodes) ? f.problemCodes.length : null, social_profiles: f.socialProfiles ?? null,
        ...Object.fromEntries(Object.entries(f.dims ?? {}).map(([k, v]) => [`dim_${k}`, v as number | null])),
        digital_need: sc.digitalNeed ?? null, sales_opportunity: sc.salesOpportunity ?? null, category: sc.category ?? null, config_hash: sc.configHash ?? null,
        calls: x.calls, first_call_result: x.first_call_result, reached_interested: stages.includes('INTERESTED'), reached_demo: stages.includes('DEMO_CREATED'), reached_offer: stages.includes('OFFER_SENT'),
        won: x.final_outcome === 'WON', lost: x.final_outcome === 'LOST', final_outcome: x.final_outcome,
      };
    });
  }

  async csv(): Promise<string> {
    const rows = await this.rows();
    if (!rows.length) return 'lead_id\n';
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const q = (v: unknown) => (v === null || v === undefined ? '' : /[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    return [cols.join(';'), ...rows.map((r) => cols.map((c) => q(r[c])).join(';'))].join('\n');
  }

  /** Score-Klassen vs. Ergebnis: Wie oft führt welcher Score zu Interesse/Kauf? */
  async buckets() {
    const rows = await this.rows();
    return BUCKETS.map(([label, lo, hi]) => {
      const inB = rows.filter((r) => typeof r.sales_opportunity === 'number' && (r.sales_opportunity as number) >= lo && (r.sales_opportunity as number) <= hi);
      const called = inB.filter((r) => (r.calls as number) > 0), reached = called.filter((r) => r.first_call_result !== 'NO_ANSWER');
      const interested = inB.filter((r) => r.reached_interested), won = inB.filter((r) => r.won);
      const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
      return { label, leads: inB.length, called: called.length, reached: reached.length, interested: interested.length, won: won.length, interestedRate: pct(interested.length, called.length), wonRate: pct(won.length, called.length) };
    });
  }
}
