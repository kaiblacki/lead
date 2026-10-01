import type { Context } from '../context.ts';
import { analyzeCandidate } from './analyze-candidate.ts';
import { assessContact, suppressionKeys } from '../contact/strategy.ts';
import { buildBrief } from '../sales/brief.ts';
import { leadFromFacts, bestFact } from '../core/profile.ts';
import type { ScoringConfig } from '../scoring/intelligence.ts';
import type { Lead } from '../core/types.ts';

/** Einen bestehenden Lead erneut analysieren (RETRY / Tiefenprüfung). Handarbeit (bearbeiteter Einstieg, Status) bleibt erhalten. */
export async function reanalyzeLead(ctx: Context, leadId: string, opts: { deep?: boolean } = {}) {
  if ((await ctx.repo.getLimits()).killSwitch) throw new Error('Kill Switch ist aktiv – keine Analysen.');
  const row = await ctx.leads.rowToEntry(leadId);
  if (!row) throw new Error('Lead nicht gefunden');
  const P = ctx.registry.providers;
  const facts = await ctx.leads.factsOf(leadId);
  const now = ctx.now();
  let place = null, directory = null, csv: Lead | null = null;
  if (row.source === P.places.name) place = await P.places.details(row.source_ref);
  if (!place) csv = leadFromFacts(facts.filter((f) => f.source !== 'computed' && f.source !== 'website-crawl' && f.source !== 'web-search'), { id: row.source_ref, source: row.source });
  const extraFacts = facts.filter((f) => f.source === 'web-search');   // per Websuche gefundene Angaben (mit Quelle) bleiben bei jeder Neuanalyse erhalten
  const known = Number(row.distance_km);
  const res = await analyzeCandidate(P, ctx.cfg, { place, directory, csv, distanceKm: Number.isFinite(known) ? known : undefined, searchIndustry: row.industry ?? undefined, searchSub: row.sub_industry ?? undefined, now, deep: opts.deep, extraFacts });
  if (!place && csv) { res.source = row.source; res.externalId = row.source_ref; }
  const settings = await ctx.repo.getSettings();
  const hits = await ctx.repo.findSuppression(suppressionKeys(res.facts, res.lead.companyName));
  const contact = assessContact({ facts: res.facts, audit: res.audit, suppressionHits: hits, blocked: row.contact_blocked, phoneEnabled: settings.phoneEnabled });
  const brief = res.analysis.salesOpportunity.category === 'UNRATED' ? null : buildBrief({ company: res.lead.companyName, facts: res.facts, audit: res.audit, analysis: res.analysis, contact, now, pricing: ctx.cfg.pricing, sales: ctx.cfg.sales, callerName: settings.callerName ?? ctx.cfg.agency.callerName });
  const scoring = await ctx.repo.getScoringConfig<ScoringConfig>(ctx.cfg.scoring);
  void bestFact;
  return ctx.leads.saveAnalysis({ res, contact, brief, scoring });
}
