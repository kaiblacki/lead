import type { DirectoryRecord, PlaceCandidate, Providers } from '../providers/types.ts';
import type { AppConfig } from '../core/config.ts';
import type { Repo } from '../db/repo.ts';
import type { LeadStore } from '../db/leads.ts';
import type { RunStore } from '../db/runs.ts';
import { Budget, BudgetExceeded, KillSwitchActive } from '../guardrails/budget.ts';
import { AiGateway } from '../ai/gateway.ts';
import { AiUsageStore } from '../db/ai-usage.ts';
import { analyzeCandidate } from './analyze-candidate.ts';
import { describeCriteria, postfilter, prefilter, sortKey, type SearchCriteria } from './criteria.ts';
import { assessContact, suppressionKeys } from '../contact/strategy.ts';
import { buildBrief, polishOpener } from '../sales/brief.ts';
import { distanceKm } from '../core/geo.ts';
import { socialPlatformOf } from '../core/text.ts';
import { dedupeCandidates, type Merged } from '../dedupe/merge.ts';
import { compareRecords, type MatchRecord } from '../dedupe/match.ts';
import { PipelineStore } from '../db/pipeline.ts';
import type { EnrichmentService } from '../enrich/service.ts';
import type { ScoringConfig } from '../scoring/intelligence.ts';
import type { Lead } from '../core/types.ts';

/** Absendername für den Gesprächseinstieg: eigene Einstellung, sonst Agentur-Konfiguration – aber nie ein offener Platzhalter wie „[Dein Name]“. */
const callerOf = (own: string | null | undefined, cfg: string | undefined) => [own, cfg].find((n) => n && !/[\[\]]/.test(n)) || undefined;

export type { Merged };

export type RunSummary = { found: number; prefiltered: number; analyzed: number; matched: number; errors: number; warnings: string[]; skipped: Record<string, number>; usage: Record<string, number>; stoppedReason?: string; errorSamples?: string[] };

export type RunnerDeps = { repo: Repo; leads: LeadStore; runs: RunStore; providers: Providers; cfg: AppConfig; now: () => Date; pipeline?: PipelineStore; enrichment?: EnrichmentService };

export class SearchRunner {
  d: RunnerDeps;
  private inflight = new Set<Promise<void>>();
  /** Nachbearbeitung je gespeichertem Lead (strukturierte Analyse, Auto-Demo). Wird vom Kontext gesetzt. */
  afterSave?: (leadId: string, info: { matched: boolean; noWebsite: boolean; opportunity: number | null; blocked: boolean }) => Promise<void>;
  pipeline: PipelineStore;
  /** Nach dem Lauf: Auto-Demos für die besten Leads ohne Website, Empfehlung für den Rest. Wird vom Kontext gesetzt. */
  afterRun?: (runId: string, leadIds: string[]) => Promise<{ recommended: number }>;
  constructor(d: RunnerDeps) { this.d = d; this.pipeline = d.pipeline ?? new PipelineStore({ repo: d.repo, cfg: d.cfg, now: d.now }); }

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
          const brief = res.analysis.salesOpportunity.category === 'UNRATED' ? null : buildBrief({ company: res.lead.companyName, facts: res.facts, audit: res.audit, analysis: res.analysis, contact, now, pricing: cfg.pricing, sales: cfg.sales, callerName: callerOf(settings.callerName, cfg.agency.callerName) });
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
    const startedAt = new Date();
    const PC = cfg.pipeline ?? {}; const S = PC.sources ?? {};
    const { limits } = await repo.getLimits();
    const budget = new Budget({ ...limits, maxLeadsPerRun: Math.min(limits.maxLeadsPerRun, Math.max(c.maxLeads * 4, 20)) });
    const settings = await repo.getSettings();
    const scoring = scoringOverride ?? await repo.getScoringConfig<ScoringConfig>(cfg.scoring);
    const aiStore = new AiUsageStore(repo);
    const spent = await aiStore.spent(now);
    budget.dailyCents = spent.dailyCents; budget.monthlyCents = spent.monthlyCents;       // bereits verbrauchte KI-Kosten zählen mit
    const gateway = new AiGateway(P.ai, budget, { cfg: cfg.ai, store: aiStore });
    const sum: RunSummary = { found: 0, prefiltered: 0, analyzed: 0, matched: 0, errors: 0, warnings: [], skipped: {}, usage: { places: 0, directory: 0, crawl: 0, social: 0, render: 0, websearch: 0 }, errorSamples: [] };
    const save = () => runs.progress(runId, { found: sum.found, prefiltered: sum.prefiltered, analyzed: sum.analyzed, matched: sum.matched, errors: sum.errors });
    const matchedLeads: { leadId: string; sales: number | null; dn: number | null; dist?: number; reviews?: number }[] = [];
    const savedIds: string[] = []; const refToLead = new Map<string, string>();
    const errorsList: string[] = []; let webCents = 0; let rawCount = 0; let dedupeStats = { raw: 0, unique: 0, merged: 0, possible: 0 };
    let aiOpenerLeft = Number(PC.costControl?.aiOpenerPerRun ?? 10);
    let status: 'DONE' | 'STOPPED' = 'DONE';
    const sourcesUsed: { id: string; provider: string; requests: number; costCents: number }[] = [];
    const placesProv = P.places as typeof P.places & { mode?: string };

    try {
      await runs.phase(runId, 'discovering');
      const geo = await P.places.geocode(c.location);
      if (!geo) { await runs.finish(runId, 'FAILED', sum, `Ort „${c.location}“ wurde nicht gefunden.`, { errors: [`Ort „${c.location}“ nicht gefunden`] }); return; }
      const subs = c.subIndustries.length ? c.subIndustries : c.industry ? cfg.taxonomy.subsOf(c.industry).map((s) => s.key) : [];
      const keywords = [...new Set([...cfg.taxonomy.keywordsFor(subs), ...c.keywords])].slice(0, 6);
      const searchSub = c.subIndustries.length === 1 ? c.subIndustries[0] : undefined;
      const limit = Math.min(Math.max(c.maxLeads * 3, 50), 1500);

      const remaining = () => limits.maxPlacesRequestsPerRun - budget.placesRequests;
      budget.takePlaces(1);
      const places = await P.places.search({ center: geo.point, radiusKm: c.radiusKm, keywords, limit, maxRequests: remaining() });
      budget.placesRequests += Math.max(0, places.requests - 1); sum.usage.places += places.requests;
      let dirs = { items: [] as DirectoryRecord[], requests: 0 };
      if (remaining() > 0) { budget.takePlaces(1); dirs = await P.directory.search({ center: geo.point, radiusKm: c.radiusKm, keywords, limit, maxRequests: remaining() }); budget.placesRequests += Math.max(0, dirs.requests - 1); sum.usage.directory += dirs.requests; }
      await repo.usage(runId, P.places.name, 'search', places.requests); await repo.usage(runId, P.directory.name, 'search', dirs.requests);
      sourcesUsed.push({ id: P.places.name === 'google-places' ? 'GOOGLE_PLACES' : 'OSM', provider: `${P.places.name}${placesProv.mode ? ` (${placesProv.mode})` : ''}`, requests: places.requests, costCents: places.requests * Number(S.OSM?.centsPerRequest ?? 0) });
      if (dirs.requests) sourcesUsed.push({ id: 'DIRECTORY', provider: P.directory.name, requests: dirs.requests, costCents: 0 });

      // Dedupe: dieselbe Firma aus mehreren Quellen/Objekten wird zu einem Lead (MATCH); unsichere Paare werden nur zur Prüfung vorgemerkt (POSSIBLE_MATCH)
      rawCount = places.items.length + dirs.items.length;
      const dd = dedupeCandidates(places.items, dirs.items, PC.dedupe);
      dedupeStats = dd.stats;
      const merged = dd.items;
      sum.found = merged.length;
      const distOf = (m: Merged) => { const pt = m.place?.point ?? m.directory?.point; return pt ? distanceKm(geo.point, pt) : undefined; };
      const primary = (m: Merged) => ({ id: (m.place ?? m.directory)!.externalId, source: (m.place ?? m.directory)!.source });
      const hasSite = (m: Merged) => !!((m.place?.website && !socialPlatformOf(m.place.website)) || (m.directory?.website && !socialPlatformOf(m.directory.website)));
      // Reihenfolge: nach Entfernung; bei sehr großen Läufen zuerst die aussichtsreichsten Kandidaten (günstige Vorbewertung ohne Netzzugriff)
      merged.sort((a, b) => (distOf(a) ?? 1e9) - (distOf(b) ?? 1e9));
      if (merged.length > Number(PC.costControl?.prefilterAbove ?? 100) && merged.length > c.maxLeads) {
        const pre = (m: Merged) => (hasSite(m) ? 0 : 3) + ((m.place?.phone ?? m.directory?.phone) ? 2 : 0) + (m.place?.address ? 1 : 0) + (m.place?.openingHours?.length ? 1 : 0) + (m.place?.businessStatus === 'CLOSED_PERMANENTLY' ? -9 : 0);
        merged.sort((a, b) => pre(b) - pre(a) || (distOf(a) ?? 1e9) - (distOf(b) ?? 1e9));
        sum.warnings.push(`Vorfilterung: ${merged.length} Kandidaten, es werden zuerst die aussichtsreichsten ${c.maxLeads} analysiert (kein Website-Abruf für den Rest).`);
      }
      const existingRefs = c.excludeExisting ? await leads.existingRefs([...new Set(merged.map((m) => primary(m).source))], merged.map((m) => primary(m).id)) : new Set<string>();
      const aliasHit = c.excludeExisting ? new Set((await repo.pool.query('select source_ref from lead_aliases where owner_id=$1 and source_ref = any($2)', [repo.ownerId, merged.map((m) => primary(m).id)])).rows.map((r) => r.source_ref as string)) : new Set<string>();
      const existingLeads = await this.pipeline.nearby(geo.point, c.radiusKm);
      await save();
      await runs.phase(runId, 'analyzing');

      for (const m of merged) {
        if (sum.matched >= c.maxLeads) break;
        const pr = primary(m);
        const mrec: MatchRecord = { name: (m.place ?? m.directory)!.name, phone: m.place?.phone ?? m.directory?.phone, website: m.place?.website ?? m.directory?.website, email: m.directory?.email, address: m.place?.address ?? m.directory?.address, postalCode: m.place?.postalCode ?? m.directory?.postalCode, city: m.place?.city ?? m.directory?.city, point: m.place?.point ?? m.directory?.point, subIndustry: m.directory?.subIndustry };
        // Abgleich mit bereits gespeicherten Leads (andere Quelle/anderes Objekt derselben Firma)
        let identity: { source: string; ref: string } | undefined; let existingMatch: string | null = null; const possibleExisting: { id: string; score: number; reasons: string[] }[] = [];
        let bestScore = -1;
        for (const e of existingLeads) {
          const r = compareRecords(mrec, e, PC.dedupe);
          if (r.verdict === 'MATCH' && r.score > bestScore) { bestScore = r.score; existingMatch = e.id; identity = { source: e.source, ref: e.ref }; }
          else if (r.verdict === 'POSSIBLE_MATCH') possibleExisting.push({ id: e.id, score: r.score, reasons: r.reasons });
        }
        const view = {
          distanceKm: distOf(m), employeeBucket: m.directory?.employeeBucket, rating: m.place?.rating, reviewCount: m.place?.reviewCount, isChain: m.directory?.isChain,
          closed: m.place?.businessStatus === 'CLOSED_PERMANENTLY', hasWebsite: hasSite(m), existing: existingRefs.has(pr.id) || aliasHit.has(pr.id) || existingMatch !== null,
        };
        const skip = prefilter(c, view);
        if (skip) { sum.prefiltered++; const k = skip.replace(/[0-9.,]+/g, '#').slice(0, 40); sum.skipped[k] = (sum.skipped[k] ?? 0) + 1; continue; }
        if ((await repo.getLimits()).killSwitch) throw new KillSwitchActive('Kill Switch ist aktiv');
        try {
          budget.takeLead();
          if (view.hasWebsite) budget.takeAudit();
          const base = { place: m.place, directory: m.directory, center: geo.point, searchIndustry: c.industry, searchSub, now, identity } as const;
          const res = await analyzeCandidate(P, cfg, base);
          budget.takeCrawl(res.usage.crawlRequests);
          for (const [k, v] of [['crawl', res.usage.crawlRequests], ['directory', res.usage.directoryRequests], ['social', res.usage.socialRequests], ['render', res.usage.renderRuns]] as const) sum.usage[k] += v;
          sum.analyzed++;

          const hits = await repo.findSuppression(suppressionKeys(res.facts, res.lead.companyName));
          const contact = assessContact({ facts: res.facts, audit: res.audit, suppressionHits: hits, phoneEnabled: settings.phoneEnabled });
          let brief = res.analysis.salesOpportunity.category === 'UNRATED' ? null : buildBrief({ company: res.lead.companyName, facts: res.facts, audit: res.audit, analysis: res.analysis, contact, now, pricing: cfg.pricing, sales: cfg.sales, callerName: callerOf(settings.callerName, cfg.agency.callerName) });
          const fail = postfilter(c, { analysis: res.analysis, audit: res.audit, profiles: (res.lead.socials ?? []).map((s) => ({ platform: s.platform, lastPostAt: s.lastActivityAt })), socialComplete: !!res.social?.complete,
            readiness: contact.readiness, hasPhone: !!res.lead.phone, hasEmail: !!res.lead.email, bookingRelevant: cfg.taxonomy.sub(res.lead.subIndustry)?.booking !== false, now, cfg: scoring });
          const matched = fail.length === 0 && contact.readiness !== 'DO_NOT_CONTACT';
          if (matched && brief && (brief.priority === 'A' || brief.priority === 'B') && aiOpenerLeft > 0) { aiOpenerLeft--; brief = await polishOpener(brief, { company: res.lead.companyName, callerName: callerOf(settings.callerName, cfg.agency.callerName) }, gateway, res.externalId); }
          const saved = await leads.saveAnalysis({ res, contact, brief, runId, scoring, runResult: { matched, failReasons: contact.readiness === 'DO_NOT_CONTACT' && !fail.length ? ['Auf der Sperrliste'] : fail } });
          await gateway.flush(saved.leadId);
          savedIds.push(saved.leadId); refToLead.set(`${pr.source}|${pr.id}`, saved.leadId);
          for (const a of [...m.aliases, ...(identity ? [{ source: pr.source, ref: pr.id }] : [])]) await this.pipeline.addAlias(saved.leadId, a.source, a.ref);
          for (const pe of possibleExisting.filter((x) => x.id !== saved.leadId).sort((a, b) => b.score - a.score).slice(0, 3)) await this.pipeline.addCandidate(saved.leadId, pe.id, pe.score, pe.reasons);
          try { await this.afterSave?.(saved.leadId, { matched, noWebsite: res.audit.status === 'NO_WEBSITE', opportunity: res.analysis.salesOpportunity.value, blocked: contact.readiness === 'DO_NOT_CONTACT' }); }
          catch (e) { if (sum.warnings.length < 5) sum.warnings.push(`Nachbearbeitung ${res.lead.companyName}: ${e instanceof Error ? e.message : String(e)}`); }
          if (matched) { sum.matched++; matchedLeads.push({ leadId: saved.leadId, sales: res.analysis.salesOpportunity.value, dn: res.analysis.digitalNeed.value, dist: res.lead.distanceKm, reviews: res.lead.reviewCount }); }
        } catch (e) {
          if (e instanceof BudgetExceeded || e instanceof KillSwitchActive) throw e;
          sum.errors++; const msg = `${m.place?.name ?? m.directory?.name}: ${e instanceof Error ? e.message : String(e)}`; if (sum.errorSamples!.length < 5) sum.errorSamples!.push(msg); if (errorsList.length < 20) errorsList.push(msg);
        }
        await save();
      }
      // unsichere Dubletten innerhalb des Laufs zur manuellen Prüfung vormerken
      for (const m of merged) for (const pp of m.possible) {
        const a = refToLead.get(`${pp.source}|${pp.ref}`), b = refToLead.get(`${pp.otherSource}|${pp.otherRef}`);
        if (a && b) await this.pipeline.addCandidate(a, b, pp.score, pp.reasons);
      }
    } catch (e) {
      if (e instanceof BudgetExceeded || e instanceof KillSwitchActive) { status = 'STOPPED'; sum.stoppedReason = e.message; errorsList.push(e.message); }
      else throw e;
    }

    // Rangfolge nach gewählter Sortierung
    matchedLeads.sort((a, b) => sortKey(c, { salesOpportunity: a.sales, digitalNeed: a.dn, distanceKm: a.dist, reviewCount: a.reviews }) - sortKey(c, { salesOpportunity: b.sales, digitalNeed: b.dn, distanceKm: b.dist, reviewCount: b.reviews }));
    await runs.setRanks(runId, matchedLeads.map((x) => x.leadId));
    if (sum.matched < c.minLeads) sum.warnings.push(`Nur ${sum.matched} von mindestens ${c.minLeads} Leads gefunden. Radius erweitern oder Filter lockern${sum.stoppedReason ? ` (Lauf gestoppt: ${sum.stoppedReason})` : ''}.`);
    if (!sum.found) sum.warnings.push('Die Datenquellen haben für diese Suche keine Treffer geliefert.');
    if (sum.stoppedReason && /MAX LEADS/.test(sum.stoppedReason) && c.maxLeads > limits.maxLeadsPerRun) sum.warnings.push(`Die Suchgröße (${c.maxLeads}) übersteigt das Limit „Max. Leads pro Lauf“ (${limits.maxLeadsPerRun}) – in den Einstellungen erhöhen.`);
    // Web-Enrichment (nur wenn Daten fehlen, in Prioritätsreihenfolge, im Budget) – danach wird neu bewertet
    let enr: Record<string, unknown> = { attempted: 0 };
    if (this.d.enrichment && savedIds.length && status === 'DONE') {
      await runs.phase(runId, 'enriching');
      try {
        const r = await this.d.enrichment.enrichBatch(savedIds, { runId });
        enr = { attempted: r.attempted, counts: r.counts, requests: r.requests, costCents: r.costCents }; sum.usage.websearch += r.requests; webCents += r.costCents;
        errorsList.push(...r.outcomes.filter((o) => /^Fehler/.test(o.note)).slice(0, 5).map((o) => o.note));
        if (r.counts.provider_unavailable) sum.warnings.push('Web-Enrichment übersprungen: Websuche nicht verfügbar (BRAVE_SEARCH_API_KEY fehlt).');
        if (r.counts.budget_blocked) sum.warnings.push(`Enrichment-Budget erreicht – ${r.counts.budget_blocked} Lead(s) bleiben ohne Anreicherung (budget_blocked).`);
      } catch (e) { sum.warnings.push(`Enrichment: ${e instanceof Error ? e.message : String(e)}`); }
      await runs.phase(runId, 'analyzing');
    }
    await repo.usage(runId, P.crawler.name, 'crawl', sum.usage.crawl); await repo.usage(runId, P.social.name, 'lookup', sum.usage.social);
    if (this.d.enrichment) { await repo.usage(runId, this.d.enrichment.provider.name, 'search', sum.usage.websearch); if (sum.usage.websearch) sourcesUsed.push({ id: 'WEB_SEARCH', provider: this.d.enrichment.provider.name, requests: sum.usage.websearch, costCents: webCents }); }
    if (sum.usage.crawl) sourcesUsed.push({ id: 'DIRECT_WEBSITE', provider: P.crawler.name, requests: sum.usage.crawl, costCents: sum.usage.crawl * Number(S.DIRECT_WEBSITE?.centsPerRequest ?? 0) });
    // Demo-Empfehlungen entstehen bei der Bewertung jedes Leads; hier nur die Zählung (es wird nie automatisch eine Demo erstellt)
    let demoInfo = { recommended: 0 };
    try { if (this.afterRun) demoInfo = await this.afterRun(runId, savedIds); }
    catch (e) { sum.warnings.push(`Empfehlungen: ${e instanceof Error ? e.message : String(e)}`); }
    (sum as RunSummary & Record<string, unknown>).pipeline = { dedupe: dedupeStats, demoRecommended: demoInfo.recommended, enrichment: enr, webSearchCalls: sum.usage.websearch };
    const ai = await new AiUsageStore(repo).forRun(runId, startedAt);
    const osmCents = sourcesUsed.filter((s) => s.id === 'OSM' || s.id === 'GOOGLE_PLACES').reduce((n, s) => n + s.costCents, 0);
    const costs = { osm: osmCents, web_search: webCents, ai: ai.analysisCents + ai.otherCents, demo: ai.demoCents, total: osmCents + webCents + ai.totalCents };
    await save();
    await runs.finish(runId, status, sum, undefined, { sources: sourcesUsed, costs, errors: errorsList, rawCount, foundCount: sum.analyzed });
  }
}
