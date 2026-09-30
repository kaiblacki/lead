import type { DirectoryRecord, PlaceCandidate, Providers } from '../providers/types.ts';
import type { AppConfig } from '../core/config.ts';
import type { Repo } from '../db/repo.ts';
import type { LeadStore } from '../db/leads.ts';
import type { RunStore } from '../db/runs.ts';
import { Budget, BudgetExceeded, KillSwitchActive } from '../guardrails/budget.ts';
import { AiGateway } from '../ai/gateway.ts';
import { analyzeCandidate } from './analyze-candidate.ts';
import { describeCriteria, postfilter, prefilter, sortKey, type SearchCriteria } from './criteria.ts';
import { assessContact, suppressionKeys } from '../contact/strategy.ts';
import { buildBrief, polishOpener } from '../sales/brief.ts';
import { distanceKm } from '../core/geo.ts';
import { hostOf, norm, normPhone, socialPlatformOf } from '../core/text.ts';
import type { ScoringConfig } from '../scoring/intelligence.ts';
import type { Lead } from '../core/types.ts';

export type Merged = { place?: PlaceCandidate; directory?: DirectoryRecord };

const keysOf = (x: { name: string; phone?: string; website?: string; postalCode?: string; city?: string }) => {
  const k: string[] = [];
  if (x.phone && normPhone(x.phone).length >= 6) k.push(`p:${normPhone(x.phone)}`);
  const h = x.website && !socialPlatformOf(x.website) ? hostOf(x.website) : null;
  if (h) k.push(`d:${h}`);
  k.push(`n:${norm(x.name)}|${x.postalCode ?? norm(x.city ?? '')}`);
  return k;
};

/** Führt Treffer mehrerer Quellen zusammen (gleiche Nummer, gleiche Domain oder gleicher Name + PLZ). */
export function mergeCandidates(places: PlaceCandidate[], dirs: DirectoryRecord[]): Merged[] {
  const out: Merged[] = []; const index = new Map<string, Merged>();
  const reg = (m: Merged, x: Parameters<typeof keysOf>[0]) => { for (const k of keysOf(x)) if (!index.has(k)) index.set(k, m); };
  for (const p of places) { const m: Merged = { place: p }; out.push(m); reg(m, p); }
  for (const d of dirs) {
    const hit = keysOf(d).map((k) => index.get(k)).find(Boolean);
    if (hit && !hit.directory) { hit.directory = d; reg(hit, d); } else if (!hit) { const m: Merged = { directory: d }; out.push(m); reg(m, d); }
  }
  return out;
}

export type RunSummary = { found: number; prefiltered: number; analyzed: number; matched: number; errors: number; warnings: string[]; skipped: Record<string, number>; usage: Record<string, number>; stoppedReason?: string; errorSamples?: string[] };

export type RunnerDeps = { repo: Repo; leads: LeadStore; runs: RunStore; providers: Providers; cfg: AppConfig; now: () => Date };

export class SearchRunner {
  d: RunnerDeps;
  private inflight = new Set<Promise<void>>();
  constructor(d: RunnerDeps) { this.d = d; }

  /** Startet einen Lauf im Hintergrund und gibt sofort die Lauf-ID zurück. */
  async start(criteria: SearchCriteria, opts: { scoring?: ScoringConfig } = {}): Promise<string> {
    const { killSwitch } = await this.d.repo.getLimits();
    if (killSwitch) throw new Error('Kill Switch ist aktiv – keine neuen Suchläufe.');
    if (this.inflight.size || (await this.d.runs.running()).length) throw new Error('Es läuft bereits eine Suche. Bitte warten, bis sie fertig ist.');
    const description = describeCriteria(criteria, this.d.cfg.taxonomy);
    const runId = await this.d.runs.create(criteria, description);
    const p = this.execute(runId, criteria, opts.scoring).catch(async (e) => { await this.d.runs.finish(runId, 'FAILED', {}, e instanceof Error ? e.message : String(e)); }).finally(() => { this.inflight.delete(p); });
    this.inflight.add(p);
    return runId;
  }
  /** Eigene Liste (z. B. aus einer CSV-Datei) analysieren: gleiche Analyse, Scores und Kontaktprüfung wie bei der Suche, aber ohne Filter. */
  async startImport(leadsIn: Lead[], label: string): Promise<string> {
    const { killSwitch } = await this.d.repo.getLimits();
    if (killSwitch) throw new Error('Kill Switch ist aktiv – keine neuen Läufe.');
    if (this.inflight.size || (await this.d.runs.running()).length) throw new Error('Es läuft bereits eine Suche. Bitte warten, bis sie fertig ist.');
    if (!leadsIn.length) throw new Error('Keine gültigen Zeilen gefunden.');
    if (leadsIn.length > 500) throw new Error('Maximal 500 Zeilen pro Import.');
    const runId = await this.d.runs.createImport(label, leadsIn.length);
    const p = this.executeImport(runId, leadsIn).catch(async (e) => { await this.d.runs.finish(runId, 'FAILED', {}, e instanceof Error ? e.message : String(e)); }).finally(() => { this.inflight.delete(p); });
    this.inflight.add(p);
    return runId;
  }

  private async executeImport(runId: string, rows: Lead[]): Promise<void> {
    const { repo, leads, runs, providers: P, cfg } = this.d;
    const now = this.d.now();
    const { limits } = await repo.getLimits();
    const budget = new Budget(limits);
    const settings = await repo.getSettings();
    const scoring = await repo.getScoringConfig<ScoringConfig>(cfg.scoring);
    const sum: RunSummary = { found: rows.length, prefiltered: 0, analyzed: 0, matched: 0, errors: 0, warnings: [], skipped: {}, usage: { places: 0, directory: 0, crawl: 0, social: 0, render: 0 }, errorSamples: [] };
    let status: 'DONE' | 'STOPPED' = 'DONE';
    try {
      for (const row of rows) {
        if ((await repo.getLimits()).killSwitch) throw new KillSwitchActive('Kill Switch ist aktiv');
        try {
          budget.takeLead(); if (row.websiteUrl) budget.takeAudit();
          const res = await analyzeCandidate(P, cfg, { csv: row, now });
          budget.takeCrawl(res.usage.crawlRequests);
          for (const [k, v] of [['crawl', res.usage.crawlRequests], ['directory', res.usage.directoryRequests], ['social', res.usage.socialRequests], ['render', res.usage.renderRuns]] as const) sum.usage[k] += v;
          sum.analyzed++;
          const hits = await repo.findSuppression(suppressionKeys(res.facts, res.lead.companyName));
          const contact = assessContact({ facts: res.facts, audit: res.audit, suppressionHits: hits, phoneEnabled: settings.phoneEnabled });
          const brief = res.analysis.salesOpportunity.category === 'UNRATED' ? null : buildBrief({ company: res.lead.companyName, facts: res.facts, audit: res.audit, analysis: res.analysis, contact, now, pricing: cfg.pricing, sales: cfg.sales, callerName: settings.callerName ?? cfg.agency.callerName });
          const saved = await leads.saveAnalysis({ res, contact, brief, runId, scoring, runResult: { matched: contact.readiness !== 'DO_NOT_CONTACT', failReasons: contact.readiness === 'DO_NOT_CONTACT' ? ['Auf der Sperrliste'] : [] } });
          if (contact.readiness !== 'DO_NOT_CONTACT') sum.matched++;
          void saved;
        } catch (e) {
          if (e instanceof BudgetExceeded || e instanceof KillSwitchActive) throw e;
          sum.errors++; if (sum.errorSamples!.length < 5) sum.errorSamples!.push(`${row.companyName}: ${e instanceof Error ? e.message : String(e)}`);
        }
        await runs.progress(runId, { found: sum.found, prefiltered: 0, analyzed: sum.analyzed, matched: sum.matched, errors: sum.errors });
      }
    } catch (e) { if (e instanceof BudgetExceeded || e instanceof KillSwitchActive) { status = 'STOPPED'; sum.stoppedReason = e.message; } else throw e; }
    const ranked = (await leads.list({ runId, matchedOnly: true, limit: 500 })).rows.map((r) => r.id as string);
    await runs.setRanks(runId, ranked);
    await repo.usage(runId, P.crawler.name, 'crawl', sum.usage.crawl); await repo.usage(runId, P.social.name, 'lookup', sum.usage.social);
    await runs.finish(runId, status, sum);
  }

  /** Wartet auf laufende Läufe (für Tests und sauberes Beenden). */
  async idle() { while (this.inflight.size) await Promise.all([...this.inflight]); }

  async execute(runId: string, c: SearchCriteria, scoringOverride?: ScoringConfig): Promise<void> {
    const { repo, leads, runs, providers: P, cfg } = this.d;
    const now = this.d.now();
    const { limits } = await repo.getLimits();
    const budget = new Budget({ ...limits, maxLeadsPerRun: Math.min(limits.maxLeadsPerRun, Math.max(c.maxLeads * 4, 20)) });
    const settings = await repo.getSettings();
    const scoring = scoringOverride ?? await repo.getScoringConfig<ScoringConfig>(cfg.scoring);
    const gateway = new AiGateway(P.ai, budget);
    const sum: RunSummary = { found: 0, prefiltered: 0, analyzed: 0, matched: 0, errors: 0, warnings: [], skipped: {}, usage: { places: 0, directory: 0, crawl: 0, social: 0, render: 0 }, errorSamples: [] };
    const save = () => runs.progress(runId, { found: sum.found, prefiltered: sum.prefiltered, analyzed: sum.analyzed, matched: sum.matched, errors: sum.errors });
    const matchedLeads: { leadId: string; sales: number | null; dn: number | null; dist?: number; reviews?: number }[] = [];
    let status: 'DONE' | 'STOPPED' = 'DONE';

    try {
      const geo = await P.places.geocode(c.location);
      if (!geo) { await runs.finish(runId, 'FAILED', sum, `Ort „${c.location}“ wurde nicht gefunden.`); return; }
      const subs = c.subIndustries.length ? c.subIndustries : c.industry ? cfg.taxonomy.subsOf(c.industry).map((s) => s.key) : [];
      const keywords = [...new Set([...cfg.taxonomy.keywordsFor(subs), ...c.keywords])].slice(0, 6);
      const searchSub = c.subIndustries.length === 1 ? c.subIndustries[0] : undefined;
      const limit = Math.min(Math.max(c.maxLeads * 5, 50), 400);

      const remaining = () => limits.maxPlacesRequestsPerRun - budget.placesRequests;
      budget.takePlaces(1);
      const places = await P.places.search({ center: geo.point, radiusKm: c.radiusKm, keywords, limit, maxRequests: remaining() });
      budget.placesRequests += Math.max(0, places.requests - 1); sum.usage.places += places.requests;
      let dirs = { items: [] as DirectoryRecord[], requests: 0 };
      if (remaining() > 0) { budget.takePlaces(1); dirs = await P.directory.search({ center: geo.point, radiusKm: c.radiusKm, keywords, limit, maxRequests: remaining() }); budget.placesRequests += Math.max(0, dirs.requests - 1); sum.usage.directory += dirs.requests; }
      await repo.usage(runId, P.places.name, 'search', places.requests); await repo.usage(runId, P.directory.name, 'search', dirs.requests);

      const merged = mergeCandidates(places.items, dirs.items);
      sum.found = merged.length;
      const distOf = (m: Merged) => { const pt = m.place?.point ?? m.directory?.point; return pt ? distanceKm(geo.point, pt) : undefined; };
      merged.sort((a, b) => (distOf(a) ?? 1e9) - (distOf(b) ?? 1e9));
      const primary = (m: Merged) => ({ id: (m.place ?? m.directory)!.externalId, source: (m.place ?? m.directory)!.source });
      const existing = c.excludeExisting ? await leads.existingRefs([...new Set(merged.map((m) => primary(m).source))], merged.map((m) => primary(m).id)) : new Set<string>();
      await save();

      for (const m of merged) {
        if (sum.matched >= c.maxLeads) break;
        const pr = primary(m);
        const view = {
          distanceKm: distOf(m), employeeBucket: m.directory?.employeeBucket, rating: m.place?.rating, reviewCount: m.place?.reviewCount, isChain: m.directory?.isChain,
          closed: m.place?.businessStatus === 'CLOSED_PERMANENTLY', hasWebsite: !!((m.place?.website && !socialPlatformOf(m.place.website)) || (m.directory?.website && !socialPlatformOf(m.directory.website))), existing: existing.has(pr.id),
        };
        const skip = prefilter(c, view);
        if (skip) { sum.prefiltered++; const k = skip.replace(/[0-9.,]+/g, '#').slice(0, 40); sum.skipped[k] = (sum.skipped[k] ?? 0) + 1; continue; }
        if ((await repo.getLimits()).killSwitch) throw new KillSwitchActive('Kill Switch ist aktiv');
        try {
          budget.takeLead();
          if (view.hasWebsite) budget.takeAudit();
          const res = await analyzeCandidate(P, cfg, { place: m.place, directory: m.directory, center: geo.point, searchIndustry: c.industry, searchSub, now });
          budget.takeCrawl(res.usage.crawlRequests);
          for (const [k, v] of [['crawl', res.usage.crawlRequests], ['directory', res.usage.directoryRequests], ['social', res.usage.socialRequests], ['render', res.usage.renderRuns]] as const) sum.usage[k] += v;
          sum.analyzed++;

          const hits = await repo.findSuppression(suppressionKeys(res.facts, res.lead.companyName));
          const contact = assessContact({ facts: res.facts, audit: res.audit, suppressionHits: hits, phoneEnabled: settings.phoneEnabled });
          let brief = res.analysis.salesOpportunity.category === 'UNRATED' ? null : buildBrief({ company: res.lead.companyName, facts: res.facts, audit: res.audit, analysis: res.analysis, contact, now, pricing: cfg.pricing, sales: cfg.sales, callerName: settings.callerName ?? cfg.agency.callerName });
          const fail = postfilter(c, { analysis: res.analysis, audit: res.audit, profiles: (res.lead.socials ?? []).map((s) => ({ platform: s.platform, lastPostAt: s.lastActivityAt })), socialComplete: !!res.social?.complete,
            readiness: contact.readiness, hasPhone: !!res.lead.phone, hasEmail: !!res.lead.email, bookingRelevant: cfg.taxonomy.sub(res.lead.subIndustry)?.booking !== false, now, cfg: scoring });
          const matched = fail.length === 0 && contact.readiness !== 'DO_NOT_CONTACT';
          if (matched && brief && (brief.priority === 'A' || brief.priority === 'B')) brief = await polishOpener(brief, { company: res.lead.companyName, callerName: settings.callerName ?? cfg.agency.callerName }, gateway, res.externalId);
          const saved = await leads.saveAnalysis({ res, contact, brief, runId, scoring, runResult: { matched, failReasons: contact.readiness === 'DO_NOT_CONTACT' && !fail.length ? ['Auf der Sperrliste'] : fail } });
          if (matched) { sum.matched++; matchedLeads.push({ leadId: saved.leadId, sales: res.analysis.salesOpportunity.value, dn: res.analysis.digitalNeed.value, dist: res.lead.distanceKm, reviews: res.lead.reviewCount }); }
        } catch (e) {
          if (e instanceof BudgetExceeded || e instanceof KillSwitchActive) throw e;
          sum.errors++; if (sum.errorSamples!.length < 5) sum.errorSamples!.push(`${m.place?.name ?? m.directory?.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
        await save();
      }
    } catch (e) {
      if (e instanceof BudgetExceeded || e instanceof KillSwitchActive) { status = 'STOPPED'; sum.stoppedReason = e.message; }
      else throw e;
    }

    // Rangfolge nach gewählter Sortierung
    matchedLeads.sort((a, b) => sortKey(c, { salesOpportunity: a.sales, digitalNeed: a.dn, distanceKm: a.dist, reviewCount: a.reviews }) - sortKey(c, { salesOpportunity: b.sales, digitalNeed: b.dn, distanceKm: b.dist, reviewCount: b.reviews }));
    await runs.setRanks(runId, matchedLeads.map((x) => x.leadId));
    if (sum.matched < c.minLeads) sum.warnings.push(`Nur ${sum.matched} von mindestens ${c.minLeads} Leads gefunden. Radius erweitern oder Filter lockern${sum.stoppedReason ? ` (Lauf gestoppt: ${sum.stoppedReason})` : ''}.`);
    if (!sum.found) sum.warnings.push('Die Datenquellen haben für diese Suche keine Treffer geliefert.');
    await repo.usage(runId, P.crawler.name, 'crawl', sum.usage.crawl); await repo.usage(runId, P.social.name, 'lookup', sum.usage.social);
    await save();
    await runs.finish(runId, status, sum);
  }
}
