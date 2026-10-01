import type { Context } from '../context.ts';
import { WebSearchError, type Money, type WebSearchProvider, type WebSearchResult } from '../sources/types.ts';
import { ENRICH_LABEL, NOT_OWN_SITE, VERIFY_LABEL, toEurCents, type EnrichOutcome, type EnrichTrace } from './service.ts';
import { hostOf } from '../core/text.ts';
import type { BudgetStatus } from './budget.ts';
import { normalizeCriteria } from '../search/criteria.ts';
import { CONTACTABILITY_LABEL } from '../contact/contactability.ts';

/**
 * Kontrollierter Echttest der Datenanreicherung (Prüfskript): höchstens 5 bestehende DATA_NEEDED-Leads, harte Obergrenze für Websuche-Anfragen,
 * Zustand VORHER → NACHHER je Lead, Kosten mit Währung, Sicherheitsprüfung („keine Demo, keine Nachricht, keine Freigabe“). Nichts wird gesendet oder erstellt.
 */
export const CHECK_HARD_MAX_LEADS = 5;
/**
 * Testsatz: die drei vom Nutzer genannten Leads (mit Adresse) plus zwei ohne Adresse – dem häufigen Fall bei OSM (nur Name + Koordinaten):
 * „HAARgenau“ (seltener Name) und „Tamer“ (kurzer, häufiger Vorname – Gegenprobe gegen Namensvettern). Für beide lässt sich das Ergebnis an
 * öffentlichen Verzeichnisangaben (Adresse, Telefon) gegenprüfen.
 */
export const CHECK_LEADS = ['Saar Schere', 'Hair Loft', 'Haarstudio Tanja', 'HAARgenau', 'Tamer'];
/** Der Suchlauf, aus dem die Testleads stammen (Saarlouis, 6 km, Friseure, SMALL). */
export const CHECK_RUN_CRITERIA = { location: 'Saarlouis', radiusKm: 6, industry: 'beauty', subIndustries: ['friseur'], size: 'SMALL' };

/** Harte Obergrenze: nach `cap` Anfragen wird nichts mehr gesendet (fataler Fehler → der Ablauf bricht ab). Gezählt werden Versuche, nicht nur Erfolge. */
export class CappedWebSearch implements WebSearchProvider {
  readonly name: string; readonly isMock: boolean; attempts = 0; requests = 0; readonly cap: number; private inner: WebSearchProvider;
  constructor(inner: WebSearchProvider, cap: number) { this.inner = inner; this.cap = cap; this.name = inner.name; this.isMock = inner.isMock; }
  async search(q: { query: string; count?: number }): Promise<WebSearchResult> {
    if (this.attempts >= this.cap) throw new WebSearchError(`Testobergrenze von ${this.cap} Anfragen erreicht – es wurde keine weitere Anfrage gesendet.`, { fatal: true });
    this.attempts++; const r = await this.inner.search(q); this.requests += r.requests; return r;
  }
}

export type FactRow = { key: string; value: string; source: string; sourceUrl?: string; quality: string; note?: string };
export type LeadSnap = {
  name: string; city: string | null; postalCode: string | null; address: string | null; hasCoordinates: boolean; stage: string;
  website: string | null; websiteState: string; websiteStatus: string | null; websiteScore: number | null; salesOpportunity: number | null; opportunityScore: number | null;
  priority: string | null; manualPriority: string | null; priorityReason: string | null; workStatus: string; contactability: string | null; preferredChannel: string | null;
  phone: string | null; email: string | null; demoRecommendation: string | null; demoReason: string | null; demoApproval: string; demoCount: number;
  enrichmentStatus: string | null; candidate: string | null; candidateConfidence: number | null; candidateVerdict: string | null; facts: FactRow[];
};
export type Safety = { demos: number; outbox: number; contacts: number; approvalsOther: number; approvalsAdvanced: number; stages: Record<string, string>; emailStates: Record<string, string> };
/** Stufen, die eine Handlung bedeuten (Demo, Kontakt, Angebot …) – die Anreicherung darf keinen Lead dorthin bewegen. NEW/ANALYZING/QUALIFIED/IGNORED/RECHECK sind reine Systemzustände der Analyse. */
const SYSTEM_STAGES = ['NEW', 'ANALYZING', 'QUALIFIED', 'IGNORED', 'RECHECK'];
export type LeadReport = {
  leadId: string; name: string; picked: string; skipped?: string; before: LeadSnap; after: LeadSnap | null; newFacts: FactRow[];
  outcome: { status: string; label: string; note: string; requests: number; providerCost: Money; costEurCents: number; verification?: string; confidence?: number; candidate?: string; found: string[] } | null; trace?: EnrichTrace;
};
export type Check = { id: 'namesake' | 'directory' | 'demo' | 'sent' | 'limit' | 'cost'; title: string; ok: boolean; summary: string; details: string[] };
export type Decision = { total: number; verified: number; likely: number; uncertain: number; rejected: number; notFound: number; usable: string[]; threshold: number; met: boolean; avgRequests: number | null };
/** Mindestzahl „brauchbarer“ Leads (von 5), ab der die Pipeline für die übrigen Leads empfohlen werden kann. */
export const CHECK_USABLE_MIN = 3;
export type CheckReport = {
  startedAt: string; runId: string; dryRun: boolean; provider: string; pricing: string; eurPerUsd: number; capRequests: number; attempts: number; requests: number;
  providerCost: Money; costEurCents: number; budgetBefore: BudgetStatus; budgetAfter: BudgetStatus; leads: LeadReport[]; warnings: string[]; stoppedBy?: string;
  safety: { ok: boolean; before: Safety; after: Safety; violations: string[] };
  /** Prüfliste (maschinell) und Entscheidungshilfe – nur beim echten Lauf. */
  checks?: Check[]; decision?: Decision;
  extrapolation: { remaining: number; avgRequestsPerLead: number | null; expectedRequests: number | null; expectedUsd: number | null; expectedEurCents: number | null; worstRequests: number; worstUsd: number; worstEurCents: number; dailyRequestsFit: number };
};

const str = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
const RELEVANT = ['website', 'websiteCandidate', 'phone', 'email', 'contactForm', 'whatsapp', 'social', 'contactPerson', 'address', 'postalCode', 'city', 'businessStatus'];

/** Zustand eines Leads (alles, was sich durch die Anreicherung ändern kann). */
export async function snapshotLead(ctx: Context, leadId: string): Promise<LeadSnap> {
  const pool = ctx.repo.pool, owner = ctx.repo.ownerId;
  const l = (await pool.query('select * from leads where id=$1 and owner_id=$2', [leadId, owner])).rows[0]; if (!l) throw new Error('Lead nicht gefunden');
  const facts = await ctx.leads.factsOf(leadId); const an = await ctx.analysis.store.best(leadId);
  const opp = (await pool.query('select score from opportunities where lead_id=$1 and owner_id=$2 order by created_at desc, id desc limit 1', [leadId, owner])).rows[0];
  const demoCount = Number((await pool.query('select count(*)::int n from demos where lead_id=$1 and owner_id=$2', [leadId, owner])).rows[0].n);
  const first = (k: string) => facts.filter((f) => f.key === k).sort((a, b) => ({ high: 0, medium: 1, low: 2 } as Record<string, number>)[a.quality] - ({ high: 0, medium: 1, low: 2 } as Record<string, number>)[b.quality])[0];
  return {
    name: l.company_name, city: l.city, postalCode: l.postal_code, address: l.address, hasCoordinates: l.lat !== null && l.lng !== null, stage: l.status,
    website: l.website_url, websiteState: l.website_state, websiteStatus: an?.website_status ?? null, websiteScore: an?.website_score ?? null, salesOpportunity: an?.sales_opportunity ?? null, opportunityScore: opp?.score ?? null,
    priority: l.effective_priority, manualPriority: l.manual_priority, priorityReason: l.priority_reason, workStatus: l.work_status, contactability: l.contactability, preferredChannel: l.preferred_contact_channel,
    phone: l.phone ?? (first('phone') ? str(first('phone')!.value) : null), email: l.email ?? (first('email') ? str(first('email')!.value) : null),
    demoRecommendation: l.demo_recommendation, demoReason: l.demo_recommendation_reason, demoApproval: await ctx.pipeline.approvals.stateOf(leadId, 'DEMO_CREATE'), demoCount,
    enrichmentStatus: l.enrichment_status, candidate: l.official_website_candidate, candidateConfidence: l.official_website_confidence, candidateVerdict: l.official_website_verified,
    facts: facts.filter((f) => RELEVANT.includes(f.key)).map((f) => ({ key: f.key, value: str(f.value), source: f.source, sourceUrl: f.url, quality: f.quality, note: f.note })),
  };
}
const factKey = (f: FactRow) => `${f.key}|${f.value}|${f.source}|${f.sourceUrl ?? ''}`;

async function safety(ctx: Context, ids: string[]): Promise<Safety> {
  const pool = ctx.repo.pool, owner = ctx.repo.ownerId;
  const n = async (sql: string, a: unknown[] = []) => Number((await pool.query(sql, [owner, ...a])).rows[0].n);
  return {
    demos: await n('select count(*)::int n from demos where owner_id=$1'), outbox: await n('select count(*)::int n from outbox where owner_id=$1'), contacts: await n('select count(*)::int n from contact_history where owner_id=$1'),
    approvalsOther: await n("select count(*)::int n from approvals where owner_id=$1 and action <> 'DEMO_CREATE'"), approvalsAdvanced: await n("select count(*)::int n from approvals where owner_id=$1 and state in ('AWAITING_APPROVAL','APPROVED','COMPLETED')"),
    stages: Object.fromEntries((await pool.query('select id, status from leads where owner_id=$1 and id = any($2)', [owner, ids])).rows.map((r) => [r.id, r.status as string])),
    emailStates: Object.fromEntries((await pool.query('select id, email_send_status s from leads where owner_id=$1 and id = any($2)', [owner, ids])).rows.map((r) => [r.id, r.s as string])),
  };
}

/** Testleads wählen: zuerst die ausdrücklich genannten (nur DATA_NEEDED), dann – falls Platz ist – die nächsten DATA_NEEDED-Leads nach Priorität. */
export async function pickLeads(ctx: Context, runId: string, names: string[], max: number): Promise<{ picks: { id: string; name: string; why: string; explicit: boolean }[]; warnings: string[] }> {
  const E = ctx.cfg.pipeline.enrichment;
  const rows = (await ctx.repo.pool.query(`select id, company_name, work_status, effective_priority p, enrichment_status es, (select score from opportunities o where o.lead_id=l.id order by created_at desc, id desc limit 1) opp
      from leads l where owner_id=$1 and run_id=$2`, [ctx.repo.ownerId, runId])).rows as any[];
  const picks: { id: string; name: string; why: string; explicit: boolean }[] = [], warnings: string[] = [], used = new Set<string>();
  if (names.length > max) warnings.push(`Es wurden ${names.length} Leads genannt – höchstens ${max} werden geprüft (die übrigen bleiben unberührt).`);
  for (const n of names.slice(0, max)) {
    const r = rows.find((x) => x.company_name.toLowerCase() === n.toLowerCase() && !used.has(x.id));
    if (!r) { warnings.push(`„${n}“ wurde im Suchlauf nicht gefunden.`); continue; }
    if (r.work_status !== 'DATA_NEEDED') { warnings.push(`„${n}“ ist nicht DATA_NEEDED (${r.work_status}) – ausgelassen.`); continue; }
    picks.push({ id: r.id, name: r.company_name, why: 'ausdrücklich ausgewählt', explicit: true }); used.add(r.id);
  }
  const rank = (p: string | null) => ({ A: 0, B: 1, C: 2 } as Record<string, number>)[p ?? ''] ?? 3;
  const fill = rows.filter((r) => !used.has(r.id) && r.work_status === 'DATA_NEEDED' && (!r.es || ['pending', 'provider_unavailable'].includes(r.es)) && (E.enrichPriorities as string[]).includes(r.p ?? '') && (r.p !== 'C' || Number(r.opp ?? 0) >= E.cMinOpportunity))
    .sort((a, b) => rank(a.p) - rank(b.p) || Number(b.opp ?? 0) - Number(a.opp ?? 0) || a.company_name.localeCompare(b.company_name));
  for (const r of fill) { if (picks.length >= max) break; picks.push({ id: r.id, name: r.company_name, why: 'aufgefüllt: nächster DATA_NEEDED-Lead nach Priorität', explicit: false }); used.add(r.id); }
  return { picks: picks.slice(0, max), warnings };
}

/** Den Testlauf (Saarlouis, SMALL, Friseure) finden – oder (nur mit start) kostenlos neu anlegen, ausdrücklich OHNE Websuche. */
export async function ensureRun(ctx: Context, o: { start: boolean }): Promise<{ runId: string; created: boolean; leads: number }> {
  const pool = ctx.repo.pool, owner = ctx.repo.ownerId; const C = CHECK_RUN_CRITERIA;
  const q = async () => (await pool.query(`select r.id, (select count(*)::int from leads l where l.run_id=r.id) n from lead_runs r where r.owner_id=$1 and r.status='DONE' and r.criteria->>'location'=$2 and r.criteria->>'size'=$3 and r.criteria->'subIndustries' ? $4::text
      order by (select count(*) from leads l where l.run_id=r.id) desc, r.created_at desc limit 1`, [owner, C.location, C.size, C.subIndustries[0]])).rows[0] as { id: string; n: number } | undefined;
  const have = await q(); if (have && have.n > 0) return { runId: have.id, created: false, leads: have.n };
  if (!o.start) throw new Error(`Es gibt noch keinen Suchlauf „${C.location} · ${C.radiusKm} km · Friseur · ${C.size}“. Mit --ensure-run wird er angelegt (kostenlos, ohne Websuche).`);
  const c = normalizeCriteria({ ...C }, ctx.cfg.taxonomy, ctx.cfg.pipeline.sizes);
  const id = await ctx.runner.start(c, { enrich: false }); await ctx.runner.idle();
  const run = await ctx.runs.get(id); const n = Number((await pool.query('select count(*)::int n from leads where run_id=$1', [id])).rows[0].n);
  if (!run || run.status !== 'DONE' || !n) throw new Error(`Der Suchlauf lieferte keine Leads (Status ${run?.status ?? '–'}${run?.error ? `: ${run.error}` : ''}). Meist ist der öffentliche OSM-Server (Overpass) gerade nicht erreichbar – später erneut versuchen.`);
  return { runId: id, created: true, leads: n };
}

const LOCATION_EVIDENCE = /Ort stimmt|PLZ stimmt|Straße und Hausnummer stimmen|am OSM-Standort|in der Nähe des OSM-Standorts|Telefonnummer stimmt überein/;
const LOCATION_WARNING = /anderer Stadt|entfernt/;
/** Angaben, die nur direkt von der geprüften Firmenwebsite stammen dürfen (nie aus Suchtreffern oder Verzeichnissen). */
const SITE_ONLY_KEYS = ['phone', 'email', 'contactForm', 'whatsapp', 'contactPerson', 'address', 'postalCode', 'city', 'openingHours'];

/**
 * Die Prüfpunkte des Echttests, maschinell: Namensvetter, Verzeichnisdaten, Demo, Versand, Anfragen-Obergrenze, Kosten in USD – plus die Entscheidungshilfe
 * („brauchbar“ = plausibel verifizierte Website UND mindestens ein neuer Kontaktweg – Telefon, E-Mail oder Kontaktformular – direkt von dieser Website).
 * Rein (ohne Datenbank), damit sie getestet werden kann. Ob eine Seite wirklich zur Firma gehört, bleibt eine Gegenprobe an den URLs.
 */
export function buildChecks(i: { leads: LeadReport[]; requests: number; attempts: number; cap: number; usdPerRequest: number; log: { requests: number; amount: number; currencies: string[] }; safety: CheckReport['safety'] }): { checks: Check[]; decision: Decision } {
  const accepted = (r: LeadReport) => (r.after?.website && r.newFacts.some((f) => f.key === 'website' && f.source === 'web-search') ? hostOf(r.after.website) : null);
  // 1) Namensvetter
  const nd: string[] = []; let nOk = true;
  for (const r of i.leads) {
    const host = accepted(r); const c = host ? r.trace?.candidates.find((x) => hostOf(x.url) === host) : undefined;
    if (host) {
      const ev = c?.why.filter((w) => LOCATION_EVIDENCE.test(w)) ?? [], bad = c?.warnings.filter((w) => LOCATION_WARNING.test(w)) ?? [];
      if (!c || !ev.length || bad.length) { nOk = false; nd.push(`✘ ${r.name}: ${host} ohne ausreichenden Orts-/Standortbeleg${bad.length ? ` (${bad.join('; ')})` : ''}`); }
      else nd.push(`✔ ${r.name}: ${host} (${VERIFY_LABEL[c.verification]}, ${c.confidence}/100) – ${ev.join('; ')}`);
    }
    for (const c of r.trace?.candidates ?? []) if (c.verification !== 'VERIFIED' && c.verification !== 'LIKELY' && c.warnings.some((w) => LOCATION_WARNING.test(w))) nd.push(`✔ ${r.name}: Namensvetter abgewiesen – ${c.host} (${c.warnings.filter((w) => LOCATION_WARNING.test(w)).join('; ')})`);
  }
  if (!nd.length) nd.push('Keine Website übernommen und kein Namensvetter aufgetaucht – es gab nichts falsch zuzuordnen.');
  nd.push('Maschinell geprüft ist der Orts-/Standortbeleg jeder übernommenen Website; ob sie wirklich zur Firma gehört, bitte an den URLs gegenlesen.');
  // 2) keine Verzeichnisdaten
  const dd: string[] = []; let dOk = true; const bad = (m: string) => { dOk = false; dd.push(`✘ ${m}`); };
  for (const r of i.leads) {
    const host = accepted(r);
    for (const f of r.newFacts) {
      const h = f.sourceUrl ? hostOf(f.sourceUrl) : null;
      if (SITE_ONLY_KEYS.includes(f.key) && f.source !== 'website-crawl') bad(`${r.name}: ${f.key} stammt aus „${f.source}“ statt direkt von der Website`);
      else if (SITE_ONLY_KEYS.includes(f.key) && (!host || h !== host)) bad(`${r.name}: ${f.key} stammt von ${h ?? 'unbekannter Seite'}, nicht von der übernommenen Website`);
      if ((f.key === 'website' || f.key === 'websiteCandidate') && h && NOT_OWN_SITE.test(`${h}.`)) bad(`${r.name}: ${f.key} zeigt auf Verzeichnis/Portal ${h}`);
      if (f.key === 'social' && f.source === 'web-search' && f.quality !== 'low') bad(`${r.name}: Social-Profil aus der Suche nicht als „ungeprüft“ (low) gespeichert`);
    }
  }
  const dirHosts = new Set<string>(); let dirHits = 0;
  for (const r of i.leads) for (const q of r.trace?.queries ?? []) for (const h of q.hits) if (/Verzeichnis\/Portal/.test(h.note ?? '')) { dirHits++; dirHosts.add(hostOf(h.url) ?? h.url); }
  if (dOk) dd.push(`Alle neuen Telefon-/E-Mail-/Kontaktformular-Angaben stammen direkt von der übernommenen Website (website-crawl); aus Suchtreffern wurden nur Website-Adresse und ungeprüfte Social-Profile gespeichert.`);
  dd.push(`${dirHits} Verzeichnis-/Portal-Treffer in den Suchergebnissen${dirHosts.size ? ` (${[...dirHosts].slice(0, 6).join(', ')}${dirHosts.size > 6 ? ' …' : ''})` : ''} wurden nur gezählt – keine Daten daraus übernommen.`);
  // 3) Demo / 4) Versand
  const s = i.safety; const dv = s.violations;
  const demoOk = s.after.demos === s.before.demos && s.after.approvalsAdvanced === s.before.approvalsAdvanced;
  const sentOk = s.after.outbox === s.before.outbox && s.after.contacts === s.before.contacts && s.after.approvalsOther === s.before.approvalsOther && !dv.some((v) => /E-Mail-Status|Vertriebsstatus/.test(v));
  // 5) Anfragen-Obergrenze / 6) Kosten in USD
  const limitOk = i.requests <= i.cap && i.attempts <= i.cap; const expect = Math.round(i.requests * i.usdPerRequest * 1e6) / 1e6;
  const costOk = i.log.requests === i.requests && Math.abs(i.log.amount - expect) < 1e-6 && i.log.currencies.every((c) => c === 'USD');
  const checks: Check[] = [
    { id: 'namesake', title: 'Wurde kein Namensvetter falsch zugeordnet?', ok: nOk, summary: nOk ? 'ja – jede übernommene Website hat einen Orts-/Standortbeleg, Namensvettern in anderer Stadt/Region wurden abgewiesen' : 'NEIN – siehe Details', details: nd },
    { id: 'directory', title: 'Wurden keine Verzeichnisdaten ungeprüft übernommen?', ok: dOk, summary: dOk ? 'ja – nichts aus Verzeichnissen/Portalen übernommen' : 'NEIN – siehe Details', details: dd },
    { id: 'demo', title: 'Wurde keine Demo erstellt?', ok: demoOk, summary: demoOk ? `ja – Demos ${s.before.demos} → ${s.after.demos}, keine Freigabe über „empfohlen“ hinaus` : `NEIN – Demos ${s.before.demos} → ${s.after.demos}`, details: [] },
    { id: 'sent', title: 'Wurde nichts gesendet?', ok: sentOk, summary: sentOk ? `ja – Postausgang ${s.before.outbox} → ${s.after.outbox}, Kontaktprotokoll ${s.before.contacts} → ${s.after.contacts}, kein E-Mail-/Vertriebsstatus geändert` : 'NEIN – siehe Sicherheitsprüfung', details: sentOk ? [] : dv },
    { id: 'limit', title: 'Wurde das Anfragen-Limit eingehalten?', ok: limitOk, summary: `${limitOk ? 'ja' : 'NEIN'} – ${i.requests} Anfragen verbraucht, ${i.attempts} Versuche, Obergrenze ${i.cap}`, details: [] },
    { id: 'cost', title: 'Sind die Kosten korrekt in USD protokolliert?', ok: costOk, summary: costOk ? `ja – ${i.requests} × ${String(i.usdPerRequest).replace('.', ',')} USD = ${String(expect).replace('.', ',')} USD; Protokoll: ${i.log.requests} Anfragen, ${String(Math.round(i.log.amount * 1e6) / 1e6).replace('.', ',')} USD, Währung ${i.log.currencies.join('/') || '–'}` : `NEIN – erwartet ${expect} USD für ${i.requests} Anfragen, Protokoll: ${i.log.requests} Anfragen, ${i.log.amount} (${i.log.currencies.join('/') || '–'})`, details: [] },
  ];
  // Entscheidungshilfe
  let verified = 0, likely = 0, uncertain = 0, rejected = 0, notFound = 0; const usable: string[] = [];
  for (const r of i.leads) {
    if (!r.outcome || !r.after) continue; const host = accepted(r);
    if (host) { if (r.outcome.verification === 'VERIFIED') verified++; else likely++; if (r.newFacts.some((f) => ['phone', 'email', 'contactForm'].includes(f.key) && f.source === 'website-crawl')) usable.push(r.name); }
    else if (r.after.candidateVerdict === 'UNCERTAIN') uncertain++; else if (r.after.candidateVerdict === 'REJECTED') rejected++; else notFound++;
  }
  const done = i.leads.filter((r) => r.outcome && r.outcome.requests > 0);
  return { checks, decision: { total: i.leads.length, verified, likely, uncertain, rejected, notFound, usable, threshold: CHECK_USABLE_MIN, met: usable.length >= CHECK_USABLE_MIN, avgRequests: done.length ? i.requests / done.length : null } };
}

export type CheckOptions = { runId: string; names?: string[]; maxLeads?: number; maxRequests?: number; dryRun?: boolean; /** gleiche Suche trotz Zwischenspeicher wiederholen (kostet erneut Anfragen) */ ignoreCache?: boolean; /** Fortschrittsmeldungen (die Prüfung kann einige Minuten dauern) */ onProgress?: (msg: string) => void };
const whole = (n: number | undefined, dflt: number) => (n !== undefined && Number.isFinite(n) ? Math.max(1, Math.floor(n)) : dflt);

export async function runEnrichmentCheck(ctx: Context, o: CheckOptions): Promise<CheckReport> {
  const svc = ctx.enrichment, E = ctx.cfg.pipeline.enrichment, P = ctx.cfg.pipeline.sources.WEB_SEARCH.pricing;
  const max = Math.min(whole(o.maxLeads, CHECK_HARD_MAX_LEADS), CHECK_HARD_MAX_LEADS), cap = whole(o.maxRequests, max * E.maxQueriesPerLead);   // ungültige Eingaben (NaN, 0, negativ) ergeben nie „unbegrenzt“
  const dryRun = !!o.dryRun; const startedAt = ctx.now().toISOString();
  if (!dryRun && !svc.available) throw new Error('Websuche nicht verfügbar (BRAVE_SEARCH_API_KEY fehlt) – es wurde nichts abgefragt.');
  const { picks, warnings } = await pickLeads(ctx, o.runId, o.names ?? CHECK_LEADS, max);
  if (!picks.length) throw new Error(`Keine geeigneten DATA_NEEDED-Leads im Lauf gefunden.${warnings.length ? ` ${warnings.join(' ')}` : ''}`);
  const ids = picks.map((p) => p.id); const budgetBefore = await svc.budget.status(ctx.now()); const sBefore = await safety(ctx, ids);
  const reports: LeadReport[] = []; for (const p of picks) reports.push({ leadId: p.id, name: p.name, picked: p.why, before: await snapshotLead(ctx, p.id), after: null, newFacts: [], outcome: null });
  let stoppedBy: string | undefined; let attempts = 0, requests = 0, usd = 0, eur = 0, eurCents = 0;
  const say = (m: string) => o.onProgress?.(m);
  if (!dryRun) {
    say(`Prüfe ${picks.length} Lead(s) mit höchstens ${cap} Websuche-Anfragen (Anbieter ${svc.provider.name}) …`);
    const inner = ctx.sources.webSearch; const capped = new CappedWebSearch(inner, cap); ctx.sources.webSearch = capped;
    try {
      for (let i = 0; i < picks.length; i++) {
        const r = reports[i];
        if (stoppedBy) { r.skipped = `nicht geprüft – Ablauf vorher beendet: ${stoppedBy}`; continue; }
        let out: EnrichOutcome; say(`▶ ${i + 1}/${picks.length} ${picks[i].name} …`);
        try { out = await svc.enrichLead(picks[i].id, { runId: o.runId, force: picks[i].explicit, ignoreCache: !!o.ignoreCache }); }
        catch (e) { r.skipped = `Fehler: ${e instanceof Error ? e.message : String(e)}`; stoppedBy = r.skipped; continue; }
        const cost = toEurCents(out.providerCost, svc.eurPerUsd); requests += out.requests; eurCents = Math.round((eurCents + cost) * 1e6) / 1e6;
        if (out.providerCost.currency === 'USD') usd = Math.round((usd + out.providerCost.amount) * 1e6) / 1e6; else eur = Math.round((eur + out.providerCost.amount) * 1e6) / 1e6;
        r.outcome = { status: out.status, label: ENRICH_LABEL[out.status] ?? out.status, note: out.note, requests: out.requests, providerCost: out.providerCost, costEurCents: cost, verification: out.verification, confidence: out.confidence, candidate: out.candidate, found: out.found };
        r.trace = out.trace; r.after = await snapshotLead(ctx, picks[i].id);
        const had = new Set(r.before.facts.map(factKey)); r.newFacts = r.after.facts.filter((f) => !had.has(factKey(f)));
        say(`  ✔ ${picks[i].name}: ${r.outcome.label}${out.verification ? ` (${VERIFY_LABEL[out.verification as keyof typeof VERIFY_LABEL] ?? out.verification}${out.confidence !== undefined ? `, ${out.confidence}/100` : ''})` : ''} · ${out.requests} Anfrage(n) · ${money(out.providerCost)}`);
        if (out.status === 'provider_unavailable' && (out.fatal || !svc.available)) stoppedBy = out.note;
      }
      attempts = capped.attempts;
    } finally { ctx.sources.webSearch = inner; }
  }
  const sAfter = await safety(ctx, ids); const violations: string[] = [];
  if (sAfter.demos !== sBefore.demos) violations.push(`Anzahl Demos geändert (${sBefore.demos} → ${sAfter.demos})`);
  if (sAfter.outbox !== sBefore.outbox) violations.push(`Postausgang geändert (${sBefore.outbox} → ${sAfter.outbox})`);
  if (sAfter.contacts !== sBefore.contacts) violations.push(`Kontaktprotokoll geändert (${sBefore.contacts} → ${sAfter.contacts})`);
  for (const id of ids) if (sAfter.emailStates[id] !== sBefore.emailStates[id]) violations.push(`E-Mail-Status von „${reports.find((r) => r.leadId === id)?.name}“ geändert (${sBefore.emailStates[id]} → ${sAfter.emailStates[id]})`);
  if (sAfter.approvalsOther !== sBefore.approvalsOther) violations.push(`Freigaben für E-Mail/Follow-up/Veröffentlichung/Premium entstanden (${sBefore.approvalsOther} → ${sAfter.approvalsOther})`);
  if (sAfter.approvalsAdvanced !== sBefore.approvalsAdvanced) violations.push(`Freigaben über „empfohlen“ hinaus (${sBefore.approvalsAdvanced} → ${sAfter.approvalsAdvanced})`);
  for (const id of ids) { const x = sBefore.stages[id], y = sAfter.stages[id]; if (x !== y && (!SYSTEM_STAGES.includes(x) || !SYSTEM_STAGES.includes(y))) violations.push(`Vertriebsstatus von „${reports.find((r) => r.leadId === id)?.name}“ geändert (${x} → ${y})`); }
  const budgetAfter = await svc.budget.status(ctx.now());
  let checks: Check[] | undefined, decision: Decision | undefined;
  if (!dryRun) {
    const row = (await ctx.repo.pool.query('select coalesce(sum(requests),0)::int r, coalesce(sum(provider_cost_amount),0)::float a, coalesce(array_agg(distinct provider_cost_currency) filter (where requests > 0), \'{}\') c from enrichment_log where owner_id=$1 and lead_id = any($2) and created_at >= $3', [ctx.repo.ownerId, ids, startedAt])).rows[0];
    ({ checks, decision } = buildChecks({ leads: reports, requests, attempts, cap, usdPerRequest: P.usdPerThousandRequests / 1000, log: { requests: row.r, amount: row.a, currencies: row.c }, safety: { ok: !violations.length, before: sBefore, after: sAfter, violations } }));
  }
  const remaining = Number((await ctx.repo.pool.query("select count(*)::int n from leads where owner_id=$1 and run_id=$2 and work_status='DATA_NEEDED' and not (id = any($3))", [ctx.repo.ownerId, o.runId, ids])).rows[0].n);
  const done = reports.filter((r) => r.outcome && r.outcome.requests > 0); const avg = done.length ? requests / done.length : null; const usdPer = P.usdPerThousandRequests / 1000; const eurPer = toEurCents({ amount: usdPer, currency: P.currency }, svc.eurPerUsd);
  const worst = remaining * E.maxQueriesPerLead;
  return {
    startedAt, runId: o.runId, dryRun, provider: svc.provider.name, pricing: `${P.usdPerThousandRequests} ${P.currency} je 1.000 Anfragen = ${String(usdPer).replace('.', ',')} ${P.currency} je Anfrage`, eurPerUsd: svc.eurPerUsd, capRequests: cap, attempts, requests,
    providerCost: usd > 0 || !eur ? { amount: usd, currency: 'USD' } : { amount: eur, currency: 'EUR' }, costEurCents: eurCents, budgetBefore, budgetAfter, leads: reports, warnings, stoppedBy,
    safety: { ok: !violations.length, before: sBefore, after: sAfter, violations }, checks, decision,
    extrapolation: { remaining, avgRequestsPerLead: avg, expectedRequests: avg === null ? null : Math.round(avg * remaining), expectedUsd: avg === null ? null : Math.round(avg * remaining * usdPer * 1e4) / 1e4, expectedEurCents: avg === null ? null : Math.round(avg * remaining * eurPer * 100) / 100,
      worstRequests: worst, worstUsd: Math.round(worst * usdPer * 1e4) / 1e4, worstEurCents: Math.round(worst * eurPer * 100) / 100, dailyRequestsFit: eurPer > 0 ? Math.floor(budgetAfter.todayLeftCents / eurPer) : 0 },
  };
}

// ---------- Darstellung (Markdown) ----------
const NUM = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 4 });
export const fmtUsd = (n: number) => `${NUM.format(n)} USD`;
export const fmtCents = (c: number) => `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 3 }).format(c)} EUR-Cent`;
const eur = (c: number) => `${(c / 100).toFixed(2).replace('.', ',')} €`;
const cell = (s: unknown) => String(s ?? '–').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ') || '–';
const host = (u: string) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, '') + (x.pathname.length > 1 ? x.pathname : ''); } catch { return u; } };
const money = (m: Money) => (m.currency === 'USD' ? fmtUsd(m.amount) : `${NUM.format(m.amount)} EUR`);

const channelOf = (facts: FactRow[], key: string, platform?: string) => facts.filter((f) => f.key === key && (!platform || (() => { try { return JSON.parse(f.value).platform === platform; } catch { return false; } })()));
const showChannel = (facts: FactRow[], key: string, platform?: string): string => {
  const rows = channelOf(facts, key, platform); if (!rows.length) return '–';
  return rows.map((f) => { let v = f.value; if (platform) { try { v = JSON.parse(f.value).url; } catch { /* roh anzeigen */ } } if (key === 'contactForm') v = 'ja';
    const direct = f.source === 'website-crawl'; return `${v} (${direct ? `direkt von der Website${f.sourceUrl ? `: ${host(f.sourceUrl)}` : ''}` : `Quelle ${f.source}${f.sourceUrl ? `: ${host(f.sourceUrl)}` : ''}`}, ${f.quality}${direct ? '' : ', ungeprüft'})`; }).join('; ');
};
const ct = (c: string | null) => (c ? `${c} (${CONTACTABILITY_LABEL[c as keyof typeof CONTACTABILITY_LABEL] ?? c})` : '–');
const prio = (s: LeadSnap) => `${s.priority ?? '–'}${s.manualPriority ? ' (manuell gesetzt)' : ''} (${s.priorityReason ?? '–'})`;
const demo = (s: LeadSnap) => `${s.demoRecommendation ?? '–'}${s.demoReason ? ` – ${s.demoReason}` : ''}`;
const verdict = (s: LeadSnap) => (s.candidateVerdict ? `${VERIFY_LABEL[s.candidateVerdict as keyof typeof VERIFY_LABEL] ?? s.candidateVerdict} (${s.candidateConfidence}/100)` : '–');

const chan = (f: FactRow[], fallback: string | null, key: string, platform?: string) => (showChannel(f, key, platform) !== '–' ? showChannel(f, key, platform) : fallback);
/** Zeilen der Vorher/Nachher-Tabelle (ohne `a`: nur der Zustand vorher). */
function compareRows(b: LeadSnap, a: LeadSnap | null): [string, unknown, unknown][] {
  const A = <T,>(f: (s: LeadSnap) => T) => (a ? f(a) : undefined);
  return [
    ['Website (offiziell)', b.website ?? (b.candidate ? `keine übernommen; Kandidat ${b.candidate} – ${verdict(b)}` : null), A((s) => (s.website ? `${s.website} – ${verdict(s)}` : s.candidate ? `keine übernommen; Kandidat ${s.candidate} – ${verdict(s)}` : null))],
    ['Website-Status (Lead / Analyse)', `${b.websiteState} / ${b.websiteStatus ?? '–'}`, A((s) => `${s.websiteState} / ${s.websiteStatus ?? '–'}`)],
    ['website_score', b.websiteScore ?? (b.website ? null : 'nicht anwendbar (keine Website)'), A((s) => (s.website ? s.websiteScore : 'nicht anwendbar (keine Website)'))],
    ['sales_opportunity', b.salesOpportunity, A((s) => s.salesOpportunity)],
    ['Priorität A–D (Grund)', prio(b), A(prio)],
    ['Kontaktierbarkeit', ct(b.contactability), A((s) => ct(s.contactability))], ['work_status', b.workStatus, A((s) => s.workStatus)],
    ['Telefon', chan(b.facts, b.phone, 'phone'), A((s) => chan(s.facts, s.phone, 'phone'))], ['Geschäftliche E-Mail', chan(b.facts, b.email, 'email'), A((s) => chan(s.facts, s.email, 'email'))],
    ['Kontaktformular', showChannel(b.facts, 'contactForm'), A((s) => showChannel(s.facts, 'contactForm'))], ['WhatsApp', showChannel(b.facts, 'whatsapp'), A((s) => showChannel(s.facts, 'whatsapp'))],
    ['Instagram', showChannel(b.facts, 'social', 'instagram'), A((s) => showChannel(s.facts, 'social', 'instagram'))], ['Facebook', showChannel(b.facts, 'social', 'facebook'), A((s) => showChannel(s.facts, 'social', 'facebook'))],
    ['Lead-Status (Systemstufe)', b.stage, A((s) => s.stage)],
    ['Websuche-Status', b.enrichmentStatus ? ENRICH_LABEL[b.enrichmentStatus] ?? b.enrichmentStatus : 'noch nicht geprüft', A((s) => (s.enrichmentStatus ? ENRICH_LABEL[s.enrichmentStatus] ?? s.enrichmentStatus : '–'))],
    ['Demo-Empfehlung (Grund)', demo(b), A(demo)], ['Demo-Freigabe', `${b.demoApproval} (${b.demoCount} Demo(s))`, A((s) => `${s.demoApproval} (${s.demoCount} Demo(s)) – nur Empfehlung, nichts erstellt`)],
  ];
}

function leadSection(r: LeadReport, i: number): string[] {
  const b = r.before, a = r.after; const L: string[] = [];
  L.push(`### ${i + 1}. ${r.name}`, '', `${[b.address, [b.postalCode, b.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || 'keine Adresse in den Quelldaten (nur Name und Koordinaten)'} · ausgewählt: ${r.picked}`, '');
  if (!r.outcome || !a) {
    L.push(r.skipped ? `**Nicht geprüft:** ${r.skipped}` : '**Trockenlauf:** es wurde keine Anfrage gesendet.', '', '**Zustand VORHER**', '', '| Feld | VORHER |', '|---|---|');
    for (const [k, x] of compareRows(b, null)) L.push(`| ${k} | ${cell(x)} |`);
    L.push(''); return L;
  }
  const o = r.outcome, t = r.trace;
  L.push(`**Brave-Websuche:** ${o.requests} Anfrage(n), ${t?.queries.reduce((n, q) => n + q.hits.length, 0) ?? 0} Treffer gesamt · Kosten ${money(o.providerCost)} (≈ ${fmtCents(o.costEurCents)})${t?.place ? ` · Ortsangabe in der Suche: ${t.place.value} (${t.place.source === 'osm-city' ? 'Stadt aus den Quelldaten' : 'nur Suchregion als Hinweis'})` : ''}`, '');
  if (t?.queries.length) for (const [qi, q] of t.queries.entries()) {
    L.push(`${qi + 1}. Anfrage: \`${q.query}\` → ${q.hits.length} Treffer${q.rateLimit ? ` (${q.rateLimit})` : ''}`);
    for (const h of q.hits) L.push(`   - ${h.rank}. ${host(h.url)} – ${cell(h.title).slice(0, 90)}${h.note ? ` _[${h.note}]_` : ''}`);
  } else L.push(`Keine Anfrage gesendet: ${o.note}`);
  L.push('', `**Ergebnis:** ${o.label} – ${o.note}`);
  if (t?.decision) L.push(`**Entscheidung:** ${t.decision}`);
  if (t?.providerError) L.push(`**Anbieterfehler:** ${t.providerError}`);
  if (t?.candidates.length) { L.push('', '**Geprüfte Website-Kandidaten** (ein Suchtreffer allein reicht nie – Name, Ort, Adresse, Impressum, Telefon, Standort werden abgeglichen):', '');
    L.push('| Kandidat | Einstufung | Grund (dafür) | Vorbehalte | Anschrift laut Website | Abstand zum OSM-Standort |', '|---|---|---|---|---|---|');
    for (const c of t.candidates) L.push(`| ${cell(host(c.url))} | **${VERIFY_LABEL[c.verification]}** ${c.confidence}/100 | ${cell(c.why.join('; '))} | ${cell(c.warnings.join('; '))} | ${cell(c.siteAddress)} | ${c.distanceKm === null || c.distanceKm === undefined ? '–' : `${(Math.round(c.distanceKm * 10) / 10).toString().replace('.', ',')} km`} |`); }
  if (t?.social.length) L.push('', `**Social-Profile aus den Suchtreffern (ungeprüft):** ${t.social.map((s) => `${s.platform}: ${s.url}`).join('; ')}`);
  L.push('', '**Neu gespeicherte Angaben (je Angabe mit Quelle):**', '');
  if (r.newFacts.length) { L.push('| Angabe | Wert | Quelle | Seite | Qualität |', '|---|---|---|---|---|'); for (const f of r.newFacts) L.push(`| ${f.key} | ${cell(f.value).slice(0, 110)} | ${f.source === 'website-crawl' ? 'direkt von der Website (website-crawl)' : f.source} | ${cell(f.sourceUrl ? host(f.sourceUrl) : null)} | ${f.quality} |`); } else L.push('_keine_');
  L.push('', '**VORHER → NACHHER**', '', '| Feld | VORHER | NACHHER |', '|---|---|---|');
  for (const [k, x, y] of compareRows(b, a)) L.push(`| ${k} | ${cell(x)} | ${cell(y)} |`);
  L.push('');
  return L;
}

export function renderReport(r: CheckReport): string {
  const L: string[] = [];
  L.push(`# Anreicherungs-Check${r.dryRun ? ' (Trockenlauf – keine Anfrage gesendet)' : ''}`, '', `Zeitpunkt: ${r.startedAt} · Suchlauf: ${r.runId} · Websuche: ${r.provider} · Preis: ${r.pricing} (1 USD = ${NUM.format(r.eurPerUsd)} EUR im internen Budget)`, '');
  if (r.warnings.length) L.push(...r.warnings.map((w) => `> Hinweis: ${w}`), '');
  if (r.stoppedBy) L.push(`> **Ablauf vorzeitig beendet:** ${r.stoppedBy}`, '');
  L.push('## Gesamtübersicht', '', '| # | Lead | Anfragen | Kosten | Website-Entscheidung | Priorität | Kontaktierbarkeit | work_status |', '|---|---|---|---|---|---|---|---|');
  r.leads.forEach((x, i) => { const o = x.outcome, a = x.after, b = x.before; L.push(`| ${i + 1} | ${cell(x.name)} | ${o ? o.requests : '–'} | ${o ? `${money(o.providerCost)} (≈ ${fmtCents(o.costEurCents)})` : '–'} | ${a ? cell(a.website ? `${host(a.website)} – ${verdict(a)}` : a.candidate ? `${verdict(a)}: ${host(a.candidate)} (nicht übernommen)` : `keine (${o?.label ?? '–'})`) : '–'} | ${b.priority ?? '–'} → ${a ? a.priority ?? '–' : '–'} | ${b.contactability ?? '–'} → ${a ? a.contactability ?? '–' : '–'} | ${b.workStatus} → ${a ? a.workStatus : '–'} |`); });
  L.push('', `**Anfragen:** ${r.requests} verbraucht (Obergrenze ${r.capRequests}, gesendete Versuche ${r.attempts}) · **Gesamtkosten:** ${money(r.providerCost)} ≈ ${fmtCents(r.costEurCents)} ≈ ${eur(r.costEurCents)}`, '',
    `**Budget (intern, EUR):** Monat ${eur(r.budgetBefore.monthSpentCents)} → ${eur(r.budgetAfter.monthSpentCents)} von ${eur(r.budgetAfter.monthlyLimitCents)} · heute ${eur(r.budgetBefore.todaySpentCents)} → ${eur(r.budgetAfter.todaySpentCents)} von ${eur(r.budgetAfter.dailyLimitCents)}`, '');
  const s = r.safety; L.push('## Sicherheitsprüfung', '', s.ok ? `Keine Demo erstellt (${s.before.demos} → ${s.after.demos}), keine Nachricht im Postausgang (${s.before.outbox} → ${s.after.outbox}), keine Freigabe für E-Mail/Follow-up/Veröffentlichung/Premium, keine Freigabe über „empfohlen“ hinaus, kein Lead in eine Handlungsstufe (Kontakt, Demo, Angebot …) bewegt. ✔` : `**ABWEICHUNG:** ${s.violations.join('; ')}`, '');
  if (r.checks) {
    L.push('## Prüfliste (automatisch)', '', '| # | Prüfung | Ergebnis |', '|---|---|---|');
    r.checks.forEach((c, i) => L.push(`| ${i + 1} | ${c.title} | ${c.ok ? '✔' : '✘'} ${cell(c.summary)} |`));
    L.push('');
    for (const c of r.checks) if (c.details.length) L.push(`**${c.title}**`, '', ...c.details.map((d) => `- ${d}`), '');
  }
  L.push('## Je Lead', ''); r.leads.forEach((x, i) => L.push(...leadSection(x, i)));
  if (r.decision) {
    const d = r.decision, all = !!r.checks?.every((c) => c.ok); const bad = (r.checks ?? []).filter((c) => !c.ok).map((c) => c.title);
    L.push('## Entscheidungshilfe (maschinell – die Gegenprobe der gefundenen URLs bleibt nötig)', '',
      `- Ergebnis je Lead: verifiziert ${d.verified} · wahrscheinlich ${d.likely} · unsicher ${d.uncertain} · abgelehnt ${d.rejected} · nichts gefunden ${d.notFound} (von ${d.total}).`,
      `- **Brauchbar** (plausibel verifizierte Website + mindestens ein neuer Kontaktweg – Telefon, E-Mail oder Kontaktformular – direkt von dieser Website): **${d.usable.length} von ${d.total}**${d.usable.length ? ` (${d.usable.join(', ')})` : ''} → Kriterium „mindestens ${d.threshold}“: **${d.met ? 'erfüllt' : 'nicht erfüllt'}**.`,
      `- Prüfliste: ${all ? 'alle sechs Punkte in Ordnung' : `Abweichung bei: ${bad.join('; ')}`}.`,
      d.met && all ? '- Maschinelle Empfehlung: Die Datenqualität reicht für die **kontrollierte** Anreicherung der übrigen Leads – aber erst nach ausdrücklicher Bestätigung; vorher die gefundenen Websites kurz gegenlesen.'
        : !all ? '- Maschinelle Empfehlung: **Erst die Abweichung der Prüfliste klären** – die übrigen Leads nicht anreichern.'
        : '- Maschinelle Empfehlung: Brave liefert hier zu wenig brauchbare Kontaktdaten. Nicht dieselben Suchanfragen für die übrigen Leads wiederholen (verbrennt Geld), stattdessen zusätzliche Enrichment-Quellen einbauen.',
      '- **Danach STOPP:** Die übrigen Leads werden nicht ohne ausdrückliche Bestätigung angereichert.', '');
  }
  const x = r.extrapolation; const ok = r.leads.filter((l) => l.outcome && l.outcome.requests > 0);
  L.push('## Hochrechnung für die übrigen Leads (nur Zahlen – es wird nichts gestartet)', '',
    `- Übrige DATA_NEEDED-Leads im Lauf: **${x.remaining}** (werden NICHT ohne ausdrückliche Bestätigung angereichert).`,
    x.avgRequestsPerLead === null ? '- Keine Messwerte (kein Lead wurde abgefragt).' : `- Gemessen: Ø ${NUM.format(x.avgRequestsPerLead)} Anfragen je abgefragtem Lead (${ok.length} Leads) → erwartet ca. **${x.expectedRequests} Anfragen ≈ ${fmtUsd(x.expectedUsd!)} ≈ ${fmtCents(x.expectedEurCents!)}**.`,
    `- Höchstfall (alle ${x.remaining} Leads mit der Höchstzahl an Anfragen): ${x.worstRequests} Anfragen ≈ ${fmtUsd(x.worstUsd)} ≈ ${fmtCents(x.worstEurCents)} – deutlich unter dem Monatsbudget von ${eur(r.budgetAfter.monthlyLimitCents)}; das Tageslimit reicht noch für ca. ${x.dailyRequestsFit} Anfragen.`, '');
  return L.join('\n');
}
