import type { DirectoryRecord, GeoPoint, PlaceCandidate, Providers, RenderMetrics, SocialResult, CrawlResult } from '../providers/types.ts';
import type { AppConfig } from '../core/config.ts';
import type { Lead } from '../core/types.ts';
import { buildFacts, extractSiteFacts, leadFromFacts, bestFact, type Fact } from '../core/profile.ts';
import { distanceKm } from '../core/geo.ts';
import { runAudit } from '../audit/audit.ts';
import type { AuditReport } from '../audit/types.ts';
import { analyzeLead, type Analysis } from '../scoring/intelligence.ts';

export type CandidateInput = {
  place?: PlaceCandidate | null; directory?: DirectoryRecord | null; csv?: Lead | null;
  center?: GeoPoint; /** Bereits bekannte Entfernung (bei erneuter Analyse ohne Suchzentrum). */ distanceKm?: number; searchIndustry?: string; searchSub?: string; now: Date;
  /** Browsertest auch mit echtem Provider (teuer). Mock-Provider schätzen immer. */
  deep?: boolean;
};
export type CandidateResult = {
  externalId: string; source: string; facts: Fact[]; lead: Lead; audit: AuditReport; analysis: Analysis; social: SocialResult | null; crawl: CrawlResult | null; render: RenderMetrics | null;
  usage: { crawlRequests: number; directoryRequests: number; socialRequests: number; renderRuns: number };
};

/** Ein Kandidat durch die komplette Kette: Anreichern → Website prüfen → Social → Fakten → Audit → Scores. Keine Datenbank, keine Nebenwirkungen. */
export async function analyzeCandidate(p: Providers, cfg: AppConfig, i: CandidateInput): Promise<CandidateResult> {
  const usage = { crawlRequests: 0, directoryRequests: 0, socialRequests: 0, renderRuns: 0 };
  const place = i.place ?? null;
  let directory = i.directory ?? null;
  const name = place?.name ?? directory?.name ?? i.csv?.companyName ?? 'Unbekannt';
  const city = place?.city ?? directory?.city ?? i.csv?.city;
  if (!directory && (place || i.csv)) { directory = await p.directory.lookup(name, city, place?.phone ?? i.csv?.phone); usage.directoryRequests++; }

  const capturedAt = i.now.toISOString();
  const dist = i.center ? (place?.point ?? directory?.point ? distanceKm(i.center, (place?.point ?? directory?.point)!) : undefined) : i.distanceKm;
  let facts = buildFacts({ place, directory, csv: i.csv, distanceKm: dist, searchIndustry: i.searchIndustry, searchSub: i.searchSub, capturedAt });
  const websiteUrl = bestFact(facts, 'website')?.value as string | undefined;

  let crawl: CrawlResult | null = null;
  if (websiteUrl) { crawl = await p.crawler.crawl(websiteUrl, { maxPages: 4 }); usage.crawlRequests += crawl.requests; }

  let render: RenderMetrics | null = null;
  if (crawl?.ok && crawl.pages[0]?.html && (i.deep || p.render.isMock)) {
    render = await p.render.measure(p.render.isMock ? { html: crawl.pages[0].html } : { url: crawl.finalUrl ?? websiteUrl }); usage.renderRuns++;
  }

  const known = facts.filter((f) => f.key === 'social').map((f) => (f.value as { url: string }).url);
  const social = await p.social.lookup({ name, city, website: websiteUrl, knownUrls: known }); usage.socialRequests++;

  const okPages = (crawl?.pages ?? []).filter((x) => x.status > 0 && x.status < 400 && x.html);
  const siteFacts = okPages.length ? extractSiteFacts(okPages) : null;
  // Kontaktdaten der Website nur als zusätzliche Quelle (ändern die Qualität der Hauptquellen nicht).
  facts = buildFacts({ place, directory, csv: i.csv, social, distanceKm: dist, searchIndustry: i.searchIndustry, searchSub: i.searchSub, capturedAt, siteFacts });

  const subKey = (bestFact(facts, 'subIndustry')?.value as string | undefined) ?? i.searchSub;
  const sub = cfg.taxonomy.sub(subKey) ?? cfg.taxonomy.match(`${name} ${place?.categories?.join(' ') ?? ''}`);
  const bookingRelevant = sub ? sub.booking : undefined;
  const audit = runAudit({ websiteUrl, lead: { companyName: name, city, postalCode: bestFact(facts, 'postalCode')?.value as string | undefined, bookingRelevant, features: sub?.features }, crawl, render, now: i.now });
  const websiteSources = [...new Set(facts.filter((f) => f.key === 'name').map((f) => f.source))];
  const analysis = analyzeLead({ facts, audit, social, bookingRelevant, upsells: cfg.pricing.upsells ?? [], now: i.now, websiteSources }, cfg.scoring);

  const externalId = place?.externalId ?? directory?.externalId ?? i.csv?.id ?? `adhoc-${name}`;
  const source = place?.source ?? directory?.source ?? i.csv?.source ?? 'unknown';
  const lead = leadFromFacts(facts, { id: externalId, source });
  lead.isMock = !!(place?.fixture || directory?.fixture);
  if (sub) { lead.subIndustry = lead.subIndustry ?? sub.key; lead.industry = sub.industryKey; }
  return { externalId, source, facts, lead, audit, analysis, social, crawl, render, usage };
}
