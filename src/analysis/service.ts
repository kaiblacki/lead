import type { Repo } from '../db/repo.ts';
import type { LeadStore } from '../db/leads.ts';
import { AnalysisStore } from '../db/analysis.ts';
import type { AiUsageStore } from '../db/ai-usage.ts';
import type { AppConfig } from '../core/config.ts';
import type { AiTierName } from '../providers/types.ts';
import { resolveTier } from '../ai/tiers.ts';
import { baseConcept, buildStructured, contentHash, type StructInput, type StructuredAnalysis } from './structured.ts';
import { DEEP_SYSTEM, deepPrompt, parseJson, premiumPrompt, validateConcept, validateDeep } from './ai.ts';

const RANK: Record<AiTierName, number> = { MASS: 0, DEEP: 1, PREMIUM: 2 };
type Complete = (leadId: string | null, req: { task: any; prompt: string; system?: string; tier?: AiTierName; purpose?: any; maxTokens?: number }) => Promise<{ text: string; model: string }>;

/** Strukturierte Lead-Analyse: MASS (regelbasiert, ohne Kosten) bei jedem Suchlauf; DEEP/PREMIUM auf Wunsch je Lead mit KI, validiert, mit Cache und Kostenprotokoll. */
export class AnalysisService {
  repo: Repo; leads: LeadStore; store: AnalysisStore; usage: AiUsageStore; cfg: AppConfig; complete: Complete; now: () => Date; aiIsMock: () => boolean;
  constructor(d: { repo: Repo; leads: LeadStore; usage: AiUsageStore; cfg: AppConfig; complete: Complete; now?: () => Date; aiIsMock: () => boolean }) {
    this.repo = d.repo; this.leads = d.leads; this.store = new AnalysisStore(d.repo); this.usage = d.usage; this.cfg = d.cfg; this.complete = d.complete; this.now = d.now ?? (() => new Date()); this.aiIsMock = d.aiIsMock;
  }
  private get pool() { return this.repo.pool; }

  /** Eingabe für die Analyse aus den gespeicherten Daten (Fakten, Audit, Bewertung, Verkaufsgrundlage). */
  async inputFor(leadId: string): Promise<StructInput> {
    const d = await this.leads.get(leadId); if (!d) throw new Error('Lead nicht gefunden');
    const facts = await this.leads.factsOf(leadId);
    const sub = this.cfg.taxonomy.sub(d.lead.sub_industry);
    const checks = d.checks.map((c: any) => ({ code: c.code, category: c.category, status: c.status, severity: c.severity, summary: c.summary, evidence: c.evidence }));
    return {
      companyName: d.lead.company_name, subLabel: sub?.label, features: sub?.features?.length ? sub.features : ['services', 'maps', 'opening_hours'], websiteUrl: d.lead.website_url, auditStatus: d.audit?.status ?? (d.lead.website_url ? null : 'NO_WEBSITE'), auditNotes: d.audit?.notes ?? [], renderDependent: !!d.audit?.render_dependent,
      websiteScore: d.audit?.overall_quality ?? null, salesOpportunity: d.opportunity?.score ?? null, coverage: Number(d.audit?.coverage ?? 0), dataQualityFactor: Number(d.opportunity?.data_quality_factor ?? 0.5), checks, facts,
      reasons: d.sales?.brief?.reasons ?? [], source: d.lead.source, phone: d.lead.phone, email: d.lead.email, address: d.lead.address,
    };
  }

  /** MASS-Analyse speichern (regelbasiert). Unveränderte Grundlage → keine neue Zeile. */
  async saveBase(leadId: string): Promise<{ row: Awaited<ReturnType<AnalysisStore['insert']>>; cached: boolean }> {
    const i = await this.inputFor(leadId);
    const hash = contentHash(i, 'MASS:rules:' + JSON.stringify(this.cfg.analysis).length);
    const last = await this.store.latestOf(leadId, 'MASS');
    if (last && last.content_hash === hash) return { row: last, cached: true };
    const a = buildStructured(i, this.cfg.analysis);
    return { row: await this.store.insert(leadId, 'MASS', a, { hash, model: 'rules', costCents: 0, at: this.now() }), cached: false };
  }

  /** DEEP bzw. PREMIUM für einen Lead. Gleiche Grundlage + gleiches Modell → vorhandene Analyse, kein KI-Aufruf. */
  async run(leadId: string, tier: AiTierName, o: { force?: boolean } = {}) {
    if (tier === 'MASS') { const r = await this.saveBase(leadId); return { ...r, aiCalls: 0, costCents: 0, note: r.cached ? 'Unveränderte Grundlage – vorhandene Analyse verwendet.' : 'Regelbasierte Analyse aktualisiert.' }; }
    const i = await this.inputFor(leadId);
    const model = resolveTier(this.cfg.ai, tier).model;
    const hash = contentHash(i, `${tier}:${this.aiIsMock() ? 'mock' : model}`);
    const last = await this.store.latestOf(leadId, tier);
    if (last && last.content_hash === hash && !o.force) return { row: last, cached: true, aiCalls: 0, costCents: 0, note: 'Unveränderte Grundlage – vorhandene Analyse verwendet (keine KI-Kosten).' };
    const base = buildStructured(i, this.cfg.analysis);
    const allowed = [...new Set([...i.checks.map((c) => c.code), ...i.reasons.map((r) => r.code), 'NO_WEBSITE'])];
    const facts = { company: i.companyName, branche: i.subLabel ?? null, website_status: base.website_status, website_score: base.website_score, sales_opportunity: base.sales_opportunity, base, befunde: i.checks.filter((c) => c.status !== 'pass').map((c) => ({ code: c.code, status: c.status, text: c.summary, evidence: c.evidence })),
      features_der_branche: base.recommended_demo_features, bekannte_angaben: { telefon: !!i.phone, email: !!i.email, adresse: !!i.address } };
    const before = await this.usage.forLead(leadId);
    let merged: StructuredAnalysis = { ...base }; let note = ''; let modelUsed = this.aiIsMock() ? 'mock-ai' : model;
    try {
      const res = await this.complete(leadId, { task: 'analyze_lead', system: DEEP_SYSTEM, prompt: deepPrompt(facts), tier: tier === 'PREMIUM' ? 'DEEP' : tier, purpose: 'analysis' });
      modelUsed = res.model;
      const v = validateDeep(parseJson(res.text), allowed);
      if (v) { merged = { ...base, ...v.fields }; note = v.dropped ? `${v.dropped} KI-Aussage(n) ohne Beleg verworfen.` : ''; } else note = 'KI-Antwort nicht verwertbar – regelbasierte Analyse bleibt.';
      if (tier === 'PREMIUM') {
        const r2 = await this.complete(leadId, { task: 'premium_concept', system: DEEP_SYSTEM, prompt: premiumPrompt({ ...facts, base: merged }), tier: 'PREMIUM', purpose: 'demo' });
        modelUsed = r2.model;
        merged.concept = validateConcept(parseJson(r2.text)) ?? baseConcept(i, this.cfg.analysis, merged);
        if (!validateConcept(parseJson(r2.text))) note = (note ? note + ' ' : '') + 'Konzept: KI-Antwort nicht verwertbar – regelbasierter Entwurf.';
      }
    } catch (e) { note = `KI nicht verfügbar (${e instanceof Error ? e.message : String(e)}) – regelbasierte Analyse bleibt.`; modelUsed = 'rules'; if (tier === 'PREMIUM') merged.concept = baseConcept(i, this.cfg.analysis, merged); }
    const after = await this.usage.forLead(leadId);
    const cost = after.totalCents - before.totalCents;
    const row = await this.store.insert(leadId, tier, merged, { hash, model: modelUsed, costCents: cost, at: this.now() });
    await this.pool.query('update leads set ai_tier = case when $3 = \'PREMIUM\' or ai_tier = \'MASS\' then $3 else ai_tier end where id=$1 and owner_id=$2', [leadId, this.repo.ownerId, tier]);
    await this.repo.event(this.pool, leadId, 'analysis_run', { tier, model: modelUsed, cost_cents: cost, actor: 'user' });
    return { row, cached: false, aiCalls: after.calls - before.calls, costCents: cost, note };
  }
  best(leadId: string) { return this.store.best(leadId); }
  rank = RANK;
}
