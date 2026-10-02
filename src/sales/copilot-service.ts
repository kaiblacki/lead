import { createHash } from 'node:crypto';
import type { Repo } from '../db/repo.ts';
import type { LeadStore } from '../db/leads.ts';
import type { AppConfig } from '../core/config.ts';
import type { AiRequest, AiResponse } from '../providers/types.ts';
import { buildCopilot, copilotViolation, type Copilot, type CopilotInput } from './copilot.ts';
import { effectiveModules, moduleDefs } from '../site/modules.ts';
import { sourceLabel } from '../core/enrichment.ts';

type Complete = (leadId: string | null, req: AiRequest) => Promise<AiResponse>;
export type StoredCopilot = { mass: Copilot | null; deep: { opener?: string; summary30?: string; model?: string; costCents: number; createdAt: Date } | null; inputHash: string | null; createdAt: Date | null };

/**
 * Sales Copilot je Lead. MASS = regelbasiert und kostenlos, wird bei geänderter Datenlage neu berechnet (Cache über Hash der Eingabe).
 * DEEP (Button „Verkaufsassistent vertiefen“) formuliert nur Einstieg und Zusammenfassung mit KI neu – gleiche Fakten, geprüfte Ausgabe.
 * Nichts wird gesendet; Priorität, Module, Notizen und manuelle Entscheidungen werden hier nie verändert.
 */
export class CopilotService {
  repo: Repo; leads: LeadStore; cfg: AppConfig; now: () => Date; complete: Complete; aiIsMock: () => boolean;
  constructor(d: { repo: Repo; leads: LeadStore; cfg: AppConfig; now?: () => Date; complete: Complete; aiIsMock: () => boolean }) {
    this.repo = d.repo; this.leads = d.leads; this.cfg = d.cfg; this.now = d.now ?? (() => new Date()); this.complete = d.complete; this.aiIsMock = d.aiIsMock;
  }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }

  /** Automatisch erzeugen für Priorität A/B, hohe Verkaufschance oder empfohlene Demo (konfigurierbar in config/copilot.json). */
  isEligible(l: { effective_priority?: string | null; demo_recommendation?: string | null; opportunity?: number | null; contact_blocked?: boolean }): boolean {
    const a = this.cfg.copilot.auto;
    if (l.contact_blocked) return false;
    return (a.priorities as string[]).includes(l.effective_priority ?? '') || (l.opportunity ?? -1) >= a.minSalesOpportunity || (a.includeDemoRecommended && l.demo_recommendation === 'DEMO_RECOMMENDED');
  }

  /** Alle belegten Eingaben für einen Lead zusammenstellen. */
  async input(leadId: string): Promise<{ input: CopilotInput; row: any; opportunity: number | null } | null> {
    const l = await this.leads.rowToEntry(leadId); if (!l) return null;
    const q = (sql: string, p: unknown[] = [leadId, this.owner]) => this.pool.query(sql, p).then((r) => r.rows);
    const [facts, opp, audit, demos, note, call, ana] = await Promise.all([
      this.leads.factsOf(leadId),
      q('select score from opportunities where lead_id=$1 and owner_id=$2 order by created_at desc, id desc limit 1'),
      q('select id, status, overall_quality from audits where lead_id=$1 and owner_id=$2 order by created_at desc, id desc limit 1'),
      q('select 1 from demos where lead_id=$1 and owner_id=$2 and not revoked limit 1'),
      q('select body from lead_notes where lead_id=$1 and owner_id=$2'),
      q("select result, note, callback_at, at from contact_history where lead_id=$1 and owner_id=$2 and channel='PHONE' order by at desc limit 1"),
      q('select manual_checks from lead_analysis where lead_id=$1 and owner_id=$2 order by created_at desc, id desc limit 1'),
    ]);
    const findings = audit[0] ? await q('select code, severity, summary, evidence from findings where audit_id=$1 and owner_id=$2', [audit[0].id, this.owner]) : [];
    const sub = this.cfg.taxonomy.sub(l.sub_industry); const ind = this.cfg.taxonomy.industry(sub?.industryKey ?? l.industry);
    const fact = (k: string) => facts.find((f) => f.key === k);
    const defs = moduleDefs(this.cfg);
    const mods = effectiveModules(this.cfg, { recommended: l.modules_recommended, selected: l.modules_selected }).filter((k) => defs[k]);
    const settings = await this.repo.getSettings();
    const rec = (l.modules_recommended as string[] | null)?.length ? (l.modules_recommended as string[]) : mods;
    const phoneFact = fact('phone');
    const input: CopilotInput = {
      company: l.company_name, city: l.city, subKey: sub?.key ?? null, subLabel: sub?.label ?? null, industryKey: sub?.industryKey ?? ind?.key ?? null, industryLabel: ind?.label ?? null, bookingIndustry: !!sub?.booking,
      websiteState: l.website_state, websiteUrl: l.website_url, websiteScore: l.website_state === 'none' ? null : audit[0]?.overall_quality ?? null, auditStatus: audit[0]?.status ?? null,
      checks: findings.map((f) => ({ code: f.code, status: 'fail', severity: f.severity, summary: f.summary, evidence: f.evidence })),
      officialVerified: l.official_website_verified, enrichmentStatus: l.enrichment_status,
      salesOpportunity: opp[0]?.score ?? null, priority: l.effective_priority, workStatus: l.work_status, contactReadiness: l.contact_readiness, contactReason: l.contact_reason, contactBlocked: !!l.contact_blocked,
      hasPhone: !!l.phone, hasEmail: !!l.email || !!fact('email'), hasWhatsapp: !!fact('whatsapp'), hasContactForm: !!fact('contactForm'), hasSocial: !!fact('social') || (Array.isArray(l.socials) && l.socials.length > 0),
      phoneSource: phoneFact ? sourceLabel(phoneFact.source) : l.phone ? sourceLabel(l.source) : null,
      reviewCount: l.review_count, rating: l.rating !== null && l.rating !== undefined ? Number(l.rating) : null, employeeBucket: l.employee_bucket, isChain: fact('isChain')?.value === true || Number(fact('locationsCount')?.value ?? 0) > 3,
      closed: facts.some((f) => f.key === 'businessStatus' && /CLOSED_PERMANENTLY/.test(JSON.stringify(f.value))), address: l.address, source: sourceLabel(l.source),
      demo: { exists: demos.length > 0, modules: mods.map((k) => ({ key: k, label: defs[k].label, demoLabel: defs[k].demo })), familyLabel: l.demo_family ? this.cfg.pipeline.demo.families[l.demo_family]?.label ?? null : null },
      demoRecommended: l.demo_recommendation === 'DEMO_RECOMMENDED' && l.demo_decision !== 'skipped',
      recommendedModules: rec.filter((k) => defs[k]).map((k) => ({ key: k, label: defs[k].label })),
      manualChecks: (ana[0]?.manual_checks as string[] | undefined) ?? [], interestTopics: l.interest_topics ?? [], callCount: l.call_count ?? 0,
      lastCall: call[0] ? { result: call[0].result, note: call[0].note, callbackAt: call[0].callback_at ? new Date(call[0].callback_at).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }) : null, at: new Date(call[0].at).toISOString() } : null,
      note: note[0]?.body ?? null, callerName: settings.callerName || this.cfg.agency.callerName || this.cfg.agency.ownerName || 'Ihr Ansprechpartner',
    };
    return { input, row: l, opportunity: opp[0]?.score ?? null };
  }

  private hash(i: CopilotInput) { return createHash('sha256').update(JSON.stringify({ i: { ...i, note: undefined }, v: this.cfg.copilot.version, c: JSON.stringify(this.cfg.copilot).length })).digest('hex').slice(0, 32); }

  /** Berechnet (falls sich die Datenlage geändert hat) und speichert die regelbasierte Gesprächsvorbereitung. Gleiche Eingabe → gespeicherte Fassung, kein erneutes Rechnen. */
  async ensure(leadId: string, o: { force?: boolean; onlyIfEligible?: boolean } = {}): Promise<{ copilot: Copilot; cached: boolean } | null> {
    const g = await this.input(leadId); if (!g) return null;
    const stored = (await this.pool.query("select input_hash, content from sales_copilot where lead_id=$1 and owner_id=$2 and tier='MASS'", [leadId, this.owner])).rows[0];
    const eligible = this.isEligible({ ...g.row, opportunity: g.opportunity });
    if (o.onlyIfEligible && !eligible && !stored) return null;
    const hash = this.hash(g.input);
    if (stored && stored.input_hash === hash && !o.force) return { copilot: stored.content as Copilot, cached: true };
    const c = buildCopilot(g.input, this.cfg);
    await this.pool.query(`insert into sales_copilot(owner_id, lead_id, tier, input_hash, content, cost_cents) values ($1,$2,'MASS',$3,$4,0)
      on conflict (lead_id, tier) do update set input_hash=$3, content=$4, created_at=now()`, [this.owner, leadId, hash, JSON.stringify(c)]);
    // nur Kennzahlen/Anzeige-Spalten – Priorität, manuelle Entscheidungen, Module und Notizen bleiben unberührt
    await this.pool.query('update leads set website_potential=$3, needs_analysis_potential=$4, partnership_potential=$5, recommended_next_action=$6, call_goal=$7 where id=$1 and owner_id=$2',
      [leadId, this.owner, c.website.potential, c.needsAnalysis.potential, c.partnership.potential, c.nextAction.code, c.goal.text]);
    return { copilot: c, cached: false };
  }

  /** Nach geänderten Rahmenbedingungen (z. B. Telefonakquise freigegeben, Sperrliste): vorhandene Fassungen neu rechnen (regelbasiert, kostenlos; Cache verhindert unnötige Arbeit). */
  async refreshAll(): Promise<number> {
    const ids = (await this.pool.query("select lead_id from sales_copilot where owner_id=$1 and tier='MASS'", [this.owner])).rows.map((r) => r.lead_id as string);
    let n = 0; for (const id of ids) { const r = await this.ensure(id); if (r && !r.cached) n++; }
    return n;
  }

  async stored(leadId: string): Promise<StoredCopilot> {
    const rows = (await this.pool.query('select tier, input_hash, content, ai_model, cost_cents, created_at from sales_copilot where lead_id=$1 and owner_id=$2', [leadId, this.owner])).rows;
    const mass = rows.find((r) => r.tier === 'MASS'), deep = rows.find((r) => r.tier === 'DEEP');
    return { mass: mass?.content ?? null, inputHash: mass?.input_hash ?? null, createdAt: mass?.created_at ?? null,
      deep: deep ? { ...deep.content, model: deep.ai_model, costCents: Number(deep.cost_cents), createdAt: deep.created_at } : null };
  }

  /**
   * „Verkaufsassistent vertiefen“ (DEEP): Einstieg und Zusammenfassung werden mit KI neu formuliert – aus denselben Fakten.
   * Verworfen wird alles mit Zahlen, Preisen, Versprechen, Produkt-/Rabattaussagen oder ungültigem JSON; dann bleibt der Regeltext.
   * Gleiche Eingabe → gespeicherte Fassung (kein erneuter KI-Aufruf, keine Kosten).
   */
  async deepen(leadId: string): Promise<{ note: string; used: boolean; costCents: number }> {
    const base = await this.ensure(leadId, { force: false }); if (!base) throw new Error('Lead nicht gefunden');
    const hash = (await this.stored(leadId)).inputHash!;
    const cur = (await this.pool.query("select input_hash from sales_copilot where lead_id=$1 and owner_id=$2 and tier='DEEP'", [leadId, this.owner])).rows[0];
    if (cur && cur.input_hash === hash) return { note: 'Unveränderte Grundlage – vorhandene vertiefte Fassung bleibt, kein KI-Aufruf.', used: false, costCents: 0 };
    if (this.aiIsMock()) return { note: 'Keine KI konfiguriert (ANTHROPIC_API_KEY fehlt) – der regelbasierte Verkaufsassistent bleibt, es entstehen keine Kosten.', used: false, costCents: 0 };
    const c = base.copilot;
    const prompt = ['Formuliere für einen telefonischen Erstkontakt auf Deutsch (a) einen höflichen Gesprächseinstieg (max. 3 Sätze) und (b) eine Zusammenfassung (max. 3 Sätze).',
      'Verwende AUSSCHLIESSLICH die folgenden belegten Fakten. Erfinde nichts. Keine Preise, Zahlen zu Umsatz/Kunden/Mitarbeitern, keine Versprechen, keine Versicherungsprodukte, keine Rabatte. Keine Behauptung, es gäbe keine Website, wenn die Fakten nur „in den verfügbaren Quellen nicht gefunden“ sagen.',
      'Antworte nur als JSON: {"opener": "...", "summary": "..."}', 'FACTS_JSON:',
      JSON.stringify({ opener: c.opener.text, summary: c.summary30, facts: c.facts, arguments: c.arguments.map((a) => ({ claim: a.claim, evidence: a.evidence })) })].join('\n');
    const res = await this.complete(leadId, { task: 'sales_opener', prompt, maxTokens: 500, tier: 'DEEP', purpose: 'contact' });
    let j: { opener?: string; summary?: string } = {};
    try { j = JSON.parse(res.text.slice(res.text.indexOf('{'), res.text.lastIndexOf('}') + 1)); } catch { /* ungültig → verworfen */ }
    const bad = (t: unknown) => typeof t !== 'string' || t.length < 20 || t.length > 900 || /\d{2,}|%|€|\bEuro\b|garantier|kostenlos|gratis/i.test(t) || copilotViolation(t);
    if (bad(j.opener) || bad(j.summary)) return { note: 'Die KI-Antwort wurde verworfen (ungültig oder nicht belegt) – der Regeltext bleibt.', used: false, costCents: 0 };
    await this.pool.query(`insert into sales_copilot(owner_id, lead_id, tier, input_hash, content, ai_model, cost_cents) values ($1,$2,'DEEP',$3,$4,$5,0)
      on conflict (lead_id, tier) do update set input_hash=$3, content=$4, ai_model=$5, created_at=now()`, [this.owner, leadId, hash, JSON.stringify({ opener: j.opener, summary30: j.summary }), res.model]);
    return { note: 'Einstieg und Zusammenfassung wurden vertieft (DEEP). Kosten stehen im KI-Kostenprotokoll des Leads.', used: true, costCents: 0 };
  }
}
