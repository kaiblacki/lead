import type { Repo } from './repo.ts';
import { computeGrowthScores, type GrowthInput, type GrowthScores, type GrowthWeights } from '../scoring/growth.ts';

/** Berechnet und speichert Scoring-Dimensionen + Handlungspriorität je Lead (abgeleitet, jederzeit neu berechenbar). */
export class GrowthService {
  repo: Repo; cfg: GrowthWeights; now: () => Date;
  constructor(o: { repo: Repo; growth: GrowthWeights; now?: () => Date }) { this.repo = o.repo; this.cfg = o.growth; this.now = o.now ?? (() => new Date()); }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }

  private async inputs(leadId?: string): Promise<(GrowthInput & { id: string })[]> {
    const rows = (await this.pool.query(`
      select l.id, l.status, l.work_status, l.contactability, l.website_state, l.paused, l.call_count, l.demo_stage, l.website_potential, l.partnership_potential, l.needs_analysis_potential,
        l.official_website_verified = 'VERIFIED' as verified, (l.phone is not null) as has_phone,
        (l.email is not null or exists (select 1 from lead_facts lf where lf.lead_id = l.id and lf.key = 'email')) as has_email,
        la.website_score, la.sales_opportunity, o.digital_need, o.data_quality_factor,
        (select p.status from partners p where p.lead_id = l.id and p.owner_id = l.owner_id limit 1) as partner_status,
        (l.status in ('INTERESTED','OFFER_SENT','OFFER_ACCEPTED') or exists (select 1 from contact_history h where h.lead_id = l.id and h.result = 'INTERESTED')) as interest,
        exists (select 1 from offers f where f.lead_id = l.id and f.status in ('READY_FOR_REVIEW','APPROVED','SENT')) as offer_open,
        (l.callback_at is not null and l.callback_at <= $3) as callback_due,
        (select count(*)::int from tasks t where t.lead_id = l.id and t.status = 'OPEN' and t.due_at <= $3) as due_tasks
      from leads l
      left join lateral (select website_score, sales_opportunity from lead_analysis where lead_id = l.id order by created_at desc, id desc limit 1) la on true
      left join lateral (select digital_need, data_quality_factor from opportunities where lead_id = l.id order by created_at desc, id desc limit 1) o on true
      where l.owner_id = $1 and ($2::uuid is null or l.id = $2)`, [this.owner, leadId ?? null, this.now()])).rows;
    return rows.map((r) => ({
      id: r.id, status: r.status, work_status: r.work_status, contactability: r.contactability, website_state: r.website_state, website_quality: r.website_score, sales_opportunity: r.sales_opportunity,
      digital_need: r.digital_need, data_quality: r.data_quality_factor === null ? null : Math.round(Number(r.data_quality_factor) * 100), official_website_verified: r.verified, has_phone: r.has_phone, has_email: r.has_email,
      website_potential: r.website_potential, partnership_potential: r.partnership_potential, needs_analysis_potential: r.needs_analysis_potential, partner_status: r.partner_status,
      call_count: r.call_count, interest: r.interest, demo_stage: r.demo_stage, offer_open: r.offer_open, callback_due: r.callback_due, due_tasks: r.due_tasks, paused: r.paused,
    }));
  }

  async refresh(leadId?: string): Promise<number> {
    const list = await this.inputs(leadId);
    for (const i of list) {
      const s = computeGrowthScores(i, this.cfg);
      await this.pool.query('update leads set growth_scores = $3, action_priority = $4, growth_updated_at = $5 where id = $1 and owner_id = $2', [i.id, this.owner, JSON.stringify(s), s.actionPriority, this.now()]);
    }
    return list.length;
  }

  async forLead(leadId: string): Promise<GrowthScores | null> {
    await this.refresh(leadId);
    return ((await this.pool.query('select growth_scores from leads where id = $1 and owner_id = $2', [leadId, this.owner])).rows[0]?.growth_scores ?? null) as GrowthScores | null;
  }
}
