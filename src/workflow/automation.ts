import type { Repo } from '../db/repo.ts';
import type { SalesDocs } from '../sales/docs.ts';
import type { AppConfig } from '../core/config.ts';
import type { AnalysisService } from '../analysis/service.ts';
import type { PipelineStore } from '../db/pipeline.ts';
import { familyFor, recommendModules } from '../site/modules.ts';


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

  /** Nach dem Lauf: nur zählen. Demos werden nie automatisch erstellt – das System empfiehlt (siehe PipelineStore/Freigaben), der Nutzer bestätigt. */
  async afterRun(_runId: string, leadIds: string[]): Promise<{ recommended: number }> {
    if (!leadIds.length) return { recommended: 0 };
    const n = (await this.repo.pool.query("select count(*)::int n from approvals where owner_id=$1 and lead_id = any($2) and action='DEMO_CREATE' and state in ('RECOMMENDED','AWAITING_APPROVAL')", [this.repo.ownerId, leadIds])).rows[0].n as number;
    return { recommended: n };
  }
}
