import type { Repo } from './repo.ts';
import type { StructuredAnalysis } from '../analysis/structured.ts';
import type { AiTierName } from '../providers/types.ts';

const ORDER: Record<AiTierName, number> = { MASS: 0, DEEP: 1, PREMIUM: 2 };
export type AnalysisRow = StructuredAnalysis & { id: string; lead_id: string; tier: AiTierName; analyzed_at: string; ai_model_used: string; estimated_ai_cost: number; content_hash: string };

export class AnalysisStore {
  repo: Repo;
  constructor(repo: Repo) { this.repo = repo; }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }
  private shape(r: any): AnalysisRow {
    return { id: r.id, lead_id: r.lead_id, tier: r.tier, website_status: r.website_status, website_score: r.website_score, sales_opportunity: r.sales_opportunity, analysis_summary: r.analysis_summary, positive_points: r.positive_points, weaknesses: r.weaknesses,
      sales_reasons: r.sales_reasons, recommended_improvements: r.recommended_improvements, recommended_demo_features: r.recommended_demo_features, recommended_contact_angle: r.recommended_contact_angle, telephone_talking_points: r.telephone_talking_points,
      email_talking_points: r.email_talking_points, missing_information: r.missing_information, manual_checks: r.manual_checks, evidence: r.evidence, sources: r.sources, confidence: Number(r.confidence), concept: r.concept,
      analyzed_at: r.analyzed_at, ai_model_used: r.ai_model_used, estimated_ai_cost: Number(r.estimated_ai_cost), content_hash: r.content_hash };
  }
  async insert(leadId: string, tier: AiTierName, a: StructuredAnalysis, o: { hash: string; model: string; costCents: number; at: Date }) {
    const r = await this.pool.query(`insert into lead_analysis(owner_id, lead_id, tier, website_status, website_score, sales_opportunity, analysis_summary, positive_points, weaknesses, sales_reasons, recommended_improvements, recommended_demo_features,
        recommended_contact_angle, telephone_talking_points, email_talking_points, missing_information, manual_checks, evidence, sources, concept, confidence, content_hash, analyzed_at, ai_model_used, estimated_ai_cost)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) returning *`,
      [this.owner, leadId, tier, a.website_status, a.website_score, a.sales_opportunity, a.analysis_summary, J(a.positive_points), J(a.weaknesses), J(a.sales_reasons), J(a.recommended_improvements), J(a.recommended_demo_features), a.recommended_contact_angle,
        J(a.telephone_talking_points), J(a.email_talking_points), J(a.missing_information), J(a.manual_checks), J(a.evidence), J(a.sources), a.concept ? J(a.concept) : null, a.confidence, o.hash, o.at, o.model, o.costCents]);
    return this.shape(r.rows[0]);
  }
  /** Jüngste Analyse einer Stufe (für Cache-Prüfung). */
  async latestOf(leadId: string, tier: AiTierName) {
    const r = (await this.pool.query('select * from lead_analysis where lead_id=$1 and owner_id=$2 and tier=$3 order by created_at desc, id desc limit 1', [leadId, this.owner, tier])).rows[0];
    return r ? this.shape(r) : null;
  }
  /** Die aussagekräftigste aktuelle Analyse: höchste vorhandene Stufe. */
  async best(leadId: string) {
    const rows = (await this.pool.query('select distinct on (tier) * from lead_analysis where lead_id=$1 and owner_id=$2 order by tier, created_at desc, id desc', [leadId, this.owner])).rows.map((r) => this.shape(r));
    rows.sort((a, b) => ORDER[b.tier] - ORDER[a.tier]);
    const top = rows[0]; if (!top) return null;
    // PREMIUM-Konzept bzw. DEEP-Texte, aber Kennzahlen immer vom jüngsten Stand
    return { ...top, concept: rows.find((r) => r.concept)?.concept ?? null, tiers: rows.map((r) => r.tier) };
  }
}
const J = (v: unknown) => JSON.stringify(v);
