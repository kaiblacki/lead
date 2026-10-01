import type { Repo } from '../db/repo.ts';
import type { SalesDocs } from '../sales/docs.ts';
import type { AppConfig } from '../core/config.ts';
import type { AnalysisService } from '../analysis/service.ts';

/** Was nach jeder Analyse automatisch passiert: strukturierte Analyse speichern; für Firmen OHNE Website (mit genug Daten) eine Demo erzeugen. Mit Website: nie automatisch. Nichts wird gesendet. */
export class Automation {
  repo: Repo; docs: SalesDocs; cfg: AppConfig; analysis: AnalysisService;
  constructor(d: { repo: Repo; docs: SalesDocs; cfg: AppConfig; analysis: AnalysisService }) { this.repo = d.repo; this.docs = d.docs; this.cfg = d.cfg; this.analysis = d.analysis; }

  async afterAnalysis(leadId: string, info: { matched: boolean; noWebsite: boolean; opportunity: number | null; blocked: boolean; run: { left: number } }) {
    await this.analysis.saveBase(leadId);
    const c = this.cfg.sales?.autoDemo; if (!c?.enabled || !info.noWebsite || info.blocked || info.run.left <= 0) return;
    if (info.opportunity === null || info.opportunity < (c.minOpportunity ?? 45)) return;
    const l = (await this.repo.pool.query('select phone, address, demo_decision, paused from leads where id=$1 and owner_id=$2', [leadId, this.repo.ownerId])).rows[0];
    if (!l || l.paused || l.demo_decision === 'skipped') return;
    const any: string[] = c.requireAnyOf ?? ['phone', 'address'];
    if (!any.some((k) => (k === 'phone' ? l.phone : k === 'address' ? l.address : null))) return;
    if ((await this.repo.pool.query('select 1 from demos where lead_id=$1 and owner_id=$2 limit 1', [leadId, this.repo.ownerId])).rowCount) return;
    await this.docs.demoFor(leadId, 'auto', 'system'); info.run.left--;
  }
}
