import type { Repo } from '../db/repo.ts';
import type { PipelineStore } from '../db/pipeline.ts';

export const DEMO_STAGES = ['NO_DEMO', 'DEMO_RECOMMENDED', 'DEMO_SELECTED', 'DEMO_CREATED', 'DEMO_SHOWN'] as const;
export type DemoStage = (typeof DEMO_STAGES)[number];
export const DEMO_STAGE_LABEL: Record<DemoStage, string> = { NO_DEMO: 'Keine Demo', DEMO_RECOMMENDED: 'Demo empfohlen', DEMO_SELECTED: 'Demo ausgewählt', DEMO_CREATED: 'Demo erstellt', DEMO_SHOWN: 'Demo gezeigt' };
export const DEMO_STAGE_HELP: Record<DemoStage, string> = { NO_DEMO: 'Für diesen Lead keine Demo vorschlagen.', DEMO_RECOMMENDED: 'Das System empfiehlt eine Demo – du hast noch nicht entschieden.', DEMO_SELECTED: 'Du hast die Demo gewählt – sie wird erst nach deiner Bestätigung erstellt.', DEMO_CREATED: 'Es existiert eine Demo (wird automatisch gesetzt).', DEMO_SHOWN: 'Du hast die Demo dem Unternehmen gezeigt.' };

/** Wirksame Demo-Stufe: eine vorhandene Demo gilt immer (CREATED bzw. SHOWN); sonst Kais Auswahl; sonst die Empfehlung des Systems. */
export function effectiveDemoStage(l: { demo_stage?: string | null; demo_recommendation?: string | null; demo_decision?: string | null }, hasDemo: boolean): DemoStage {
  if (hasDemo) return l.demo_stage === 'DEMO_SHOWN' ? 'DEMO_SHOWN' : 'DEMO_CREATED';
  if (l.demo_stage === 'NO_DEMO' || l.demo_stage === 'DEMO_SELECTED') return l.demo_stage;
  if (l.demo_decision === 'skipped') return 'NO_DEMO';
  return l.demo_recommendation === 'DEMO_RECOMMENDED' || l.demo_stage === 'DEMO_RECOMMENDED' ? 'DEMO_RECOMMENDED' : 'NO_DEMO';
}

/** Manuelle Demo-Kategorisierung. Erstellt nie eine Demo – „ausgewählt“ legt nur die Bestätigungsanfrage an (die Demo entsteht erst auf der Bestätigungsseite). */
export class DemoStageService {
  repo: Repo; pipeline: PipelineStore;
  constructor(d: { repo: Repo; pipeline: PipelineStore }) { this.repo = d.repo; this.pipeline = d.pipeline; }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }
  async hasDemo(leadId: string) { return (await this.pool.query('select 1 from demos where lead_id=$1 and owner_id=$2 and not revoked limit 1', [leadId, this.owner])).rowCount! > 0; }
  async effective(leadId: string): Promise<DemoStage> {
    const l = (await this.pool.query('select demo_stage, demo_recommendation, demo_decision from leads where id=$1 and owner_id=$2', [leadId, this.owner])).rows[0];
    return l ? effectiveDemoStage(l, await this.hasDemo(leadId)) : 'NO_DEMO';
  }
  async set(leadId: string, stage: DemoStage | null): Promise<DemoStage> {
    if (stage !== null && !(DEMO_STAGES as readonly string[]).includes(stage)) throw new Error('Unbekannte Demo-Stufe.');
    const lead = (await this.pool.query('select 1 from leads where id=$1 and owner_id=$2', [leadId, this.owner])).rowCount; if (!lead) throw new Error('Lead nicht gefunden');
    const has = await this.hasDemo(leadId); const ap = this.pipeline.approvals; const state = await ap.stateOf(leadId, 'DEMO_CREATE');
    if (stage === 'DEMO_CREATED') throw new Error('„Demo erstellt“ wird automatisch gesetzt, sobald eine Demo existiert.');
    if (stage === 'DEMO_SHOWN' && !has) throw new Error('„Demo gezeigt“ geht erst, wenn eine Demo erstellt wurde.');
    if (!has) {
      if (stage === 'NO_DEMO' && state !== 'COMPLETED') await ap.reject(leadId, 'DEMO_CREATE', 'user', 'Stufe „Keine Demo“ gewählt');
      else if (stage === 'DEMO_SELECTED') { if (state === 'REJECTED') await ap.reopen(leadId, 'DEMO_CREATE'); await ap.request(leadId, 'DEMO_CREATE', 'Demo vom Nutzer ausgewählt'); }
      else if (stage === 'DEMO_RECOMMENDED' || stage === null) { if (state === 'REJECTED') await ap.reopen(leadId, 'DEMO_CREATE'); }
    }
    await this.pool.query("update leads set demo_stage=$3, demo_shown_at = case when $3 = 'DEMO_SHOWN' then now() else demo_shown_at end, demo_decision = case when $3 = 'NO_DEMO' then 'skipped' when demo_decision = 'skipped' and $3 is distinct from 'NO_DEMO' then null else demo_decision end where id=$1 and owner_id=$2", [leadId, this.owner, stage]);
    await this.repo.event(this.pool, leadId, 'demo_stage_set', { stage, actor: 'user' });
    await this.pipeline.recomputePriority(leadId);
    return this.effective(leadId);
  }
}
