import type { Repo } from '../db/repo.ts';
import type { SalesDocs } from '../sales/docs.ts';
import type { AppConfig } from '../core/config.ts';
import type { AnalysisService } from '../analysis/service.ts';
import type { PipelineStore } from '../db/pipeline.ts';
import { familyFor, recommendModules } from '../site/modules.ts';

const RANK: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };

/** Was nach einer Analyse bzw. nach einem Suchlauf automatisch passiert. Mit Website: nie automatisch eine Demo. Nichts wird gesendet. */
export class Automation {
  repo: Repo; docs: SalesDocs; cfg: AppConfig; analysis: AnalysisService; pipeline: PipelineStore;
  constructor(d: { repo: Repo; docs: SalesDocs; cfg: AppConfig; analysis: AnalysisService; pipeline: PipelineStore }) { this.repo = d.repo; this.docs = d.docs; this.cfg = d.cfg; this.analysis = d.analysis; this.pipeline = d.pipeline; }

  /** Pro Lead: strukturierte Analyse (MASS, kostenlos) speichern und Layout-Familie samt empfohlenen Modulen festlegen (nur wenn Kai noch nichts gewählt hat). */
  async afterAnalysis(leadId: string, _info: { matched: boolean; noWebsite: boolean; opportunity: number | null; blocked: boolean }) {
    await this.analysis.saveBase(leadId);
    await this.recommend(leadId);
  }

  async recommend(leadId: string) {
    const l = (await this.repo.pool.query('select sub_industry, industry, demo_family from leads where id=$1 and owner_id=$2', [leadId, this.repo.ownerId])).rows[0]; if (!l) return;
    const family = familyFor(this.cfg, { subIndustry: l.sub_industry, industry: l.industry });
    // eine manuell gewählte Familie bleibt; die Empfehlung wird immer aktuell gehalten (getrennt von „selected“)
    await this.pipeline.setModuleState(leadId, { family: l.demo_family ?? family, recommended: recommendModules(this.cfg, { family: l.demo_family ?? family, subIndustry: l.sub_industry }) });
  }

  /**
   * Nach dem Lauf: Firmen OHNE Website mit genug Daten bekommen – nach Priorität und Verkaufschance sortiert – höchstens `maxAutoDemos` automatische Demos;
   * die übrigen geeigneten Leads erhalten demo_decision = recommended („Demo empfohlen“). Firmen mit Website: nie automatisch.
   */
  async afterRun(_runId: string, leadIds: string[], opts: { maxAutoDemos: number }): Promise<{ autoDemos: number; recommended: number }> {
    if (!leadIds.length) return { autoDemos: 0, recommended: 0 };
    const c = this.cfg.sales?.autoDemo ?? {};
    const any: string[] = c.requireAnyOf ?? ['phone', 'address'];
    const rows = (await this.repo.pool.query(
      `select l.id, l.phone, l.address, l.paused, l.contact_blocked, l.demo_decision, l.effective_priority, o.score,
         exists (select 1 from demos d where d.lead_id = l.id and d.owner_id = l.owner_id) has_demo
       from leads l left join lateral (select score from opportunities where lead_id = l.id order by created_at desc, id desc limit 1) o on true
       where l.owner_id=$1 and l.id = any($2) and l.website_state = 'none'`, [this.repo.ownerId, leadIds])).rows as any[];
    const eligible = rows.filter((l) => !l.paused && !l.contact_blocked && l.demo_decision !== 'skipped' && !l.has_demo && l.score !== null && l.score >= (c.minOpportunity ?? 45)
      && any.some((k) => (k === 'phone' ? l.phone : k === 'address' ? l.address : null)));
    eligible.sort((a, b) => (RANK[a.effective_priority ?? 'D'] - RANK[b.effective_priority ?? 'D']) || (b.score - a.score) || (Number(!!b.phone) - Number(!!a.phone)));
    let autoDemos = 0, recommended = 0;
    for (const l of eligible) {
      if (c.enabled && autoDemos < opts.maxAutoDemos) { await this.docs.demoFor(l.id, 'auto', 'system'); autoDemos++; }
      else { await this.pipeline.setDemoRecommended(l.id); recommended++; }
    }
    return { autoDemos, recommended };
  }
}
