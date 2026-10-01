import { createHash } from 'node:crypto';
import type { Repo } from '../db/repo.ts';
import type { LeadStore } from '../db/leads.ts';
import type { PipelineStore } from '../db/pipeline.ts';
import type { AppConfig } from '../core/config.ts';
import type { CrawlerProvider, GeoPoint, PlacesProvider } from '../providers/types.ts';
import { WebSearchError, type Money, type WebSearchHit, type WebSearchProvider } from '../sources/types.ts';
import { EnrichmentBudget } from './budget.ts';
import { hostOf, norm, normPhone, socialPlatformOf } from '../core/text.ts';
import { nameTokens, parseStreet } from '../dedupe/match.ts';
import { distanceKm } from '../core/geo.ts';
import { findAddressIn, visibleText } from '../sources/site-contact.ts';
import type { Fact } from '../core/profile.ts';

export type EnrichmentStatus = 'pending' | 'not_needed' | 'provider_unavailable' | 'budget_blocked' | 'cached' | 'website_found' | 'contact_found' | 'not_found' | 'uncertain' | 'skipped_priority';
export type Verification = 'VERIFIED' | 'LIKELY' | 'UNCERTAIN' | 'REJECTED';
export const ENRICH_LABEL: Record<string, string> = { pending: 'noch nicht geprüft', not_needed: 'nicht nötig', provider_unavailable: 'Websuche nicht verfügbar (kein API-Schlüssel oder Anbieterfehler)', budget_blocked: 'Budget erreicht', cached: 'aus Zwischenspeicher', website_found: 'Website gefunden', contact_found: 'Kontaktdaten gefunden', not_found: 'nichts gefunden', uncertain: 'unsicher – manuell prüfen', skipped_priority: 'Priorität zu niedrig' };
export const VERIFY_LABEL: Record<Verification, string> = { VERIFIED: 'verifiziert', LIKELY: 'wahrscheinlich', UNCERTAIN: 'unsicher', REJECTED: 'abgelehnt' };

/** Verzeichnisse, Portale und Marktplätze sind keine eigene Unternehmenswebsite. */
export const NOT_OWN_SITE = /(^|\.)(facebook|instagram|tiktok|youtube|linkedin|xing|twitter|x|pinterest|google|bing|yelp|tripadvisor|gelbeseiten|dasoertliche|11880|golocal|meinestadt|branchenbuch|cylex|werkenntdenbesten|wikipedia|kununu|jameda|treatwell|fresha|booksy|planity|lieferando|opentable|thefork|restaurantguru|speisekarte|ihk|handwerkskammer|kleinanzeigen|ebay|amazon|firmenwissen|northdata|dnb|hotfrog|infobel|openstreetmap|branchen-info|firmenfinder|stadtbranchenbuch|das-telefonbuch|telefonbuch|yellowmap|wlw|trustpilot|holidaycheck|kontaktbuch|friseur-vergleich|salonkee|shore|timify|etermin|wikidata|pagesjaunes|mapquest|waze|apple|sellwerk|oeffnungszeitenbuch|provenexpert|bridebook|stepstone|indeed|herold|datanyze|moneyhouse|firmenabc|kompass|doctolib|calendly|simplybook|setmore|tupalo|ecosia|duckduckgo|startpage|yahoo)\./i;
/** Websites, die unter dem Hostnamen einen Pfad je Kunde haben (dann gehört der erste Pfadteil zur Adresse der Firma). */
const PATH_SITES = /(wixsite\.com|business\.site|weebly\.com|sites\.google\.com|jimdosite\.com|webnode\.[a-z.]+|squarespace\.com|godaddysites\.com)$/i;

export type EnrichTrace = {
  /** Ortsangabe für die Suche: echte OSM-Stadt oder (nur Hinweis) die Region des Suchlaufs. */
  place?: { value: string; source: 'osm-city' | 'search-region' };
  queries: { query: string; requests: number; cost: Money; rateLimit?: string; hits: { rank: number; url: string; title: string; note?: string }[] }[];
  candidates: { url: string; host: string; verification: Verification; confidence: number; why: string[]; warnings: string[]; pages: number; siteAddress?: string; distanceKm?: number | null; crawlError?: string }[];
  social: { platform: string; url: string; title: string }[];
  decision?: string; providerError?: string;
};
type Cand = EnrichTrace['candidates'][number];
export type EnrichOutcome = {
  leadId: string; status: EnrichmentStatus; requests: number; costCents: number; providerCost: Money; verification?: Verification; confidence?: number; candidate?: string; note: string; found: string[]; trace?: EnrichTrace; fatal?: boolean;
};
export type LeadInfo = { name: string; city?: string; cityHint?: string; postalCode?: string; address?: string; phone?: string; subKeywords: string[]; point?: GeoPoint | null };

type VerifyCfg = AppConfig['pipeline']['enrichment']['verify'];
export type Evidence = { pages: { url: string; html: string }[]; hit?: { title: string; snippet: string }; crawlFailed?: boolean; host: string; siteCity?: string; distanceKm?: number | null };

const cityMain = (c?: string) => (c ? norm(c.replace(/^\d{5}\s*/, '').split(/[\/,(]/)[0]) : '');
const sameCity = (a: string, b: string) => !!a && !!b && (a === b || a.startsWith(b + ' ') || b.startsWith(a + ' ') || a.includes(b) || b.includes(a));
const firstMatch = (html: string, re: RegExp) => { const m = re.exec(html); return m ? visibleText(m[1]) : ''; };

/**
 * Bewertet, ob eine Seite zur Firma passt (0–100). Ein Suchtreffer allein gilt nie als offizielle Website:
 * Name (im Seitentitel/in der Domain), Ort, PLZ, Adresse, Telefon, Branche, Impressum, Kontakt – und der Standort der Website-Adresse im Vergleich zum OSM-Eintrag.
 * Ohne Namensbezug, bei nicht abrufbarer Seite, zu kurzem Namen, fehlender Prominenz des Namens oder weit entfernter Adresse bleibt es höchstens „unsicher“.
 */
export function scoreCandidate(ev: Evidence, l: LeadInfo, generic: string[], cfg: VerifyCfg): { confidence: number; verification: Verification; why: string[]; warnings: string[] } {
  const W = cfg.weights as Record<string, number>; const why: string[] = [], warnings: string[] = []; let score = 0;
  const first = ev.pages[0]?.html ?? '';
  const titleText = ev.crawlFailed ? ev.hit?.title ?? '' : [firstMatch(first, /<title[^>]*>([\s\S]*?)<\/title>/i), ...[...first.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => visibleText(m[1])), firstMatch(first, /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)].join(' ');
  const text = norm(ev.crawlFailed ? `${ev.hit?.title ?? ''} ${ev.hit?.snippet ?? ''}` : ev.pages.map((p) => visibleText(p.html)).join(' | '));
  const digits = ev.pages.map((p) => visibleText(p.html).replace(/\D/g, '')).join(' ');
  const cMain = cityMain(l.city); const hintMain = cityMain(l.cityHint);
  const core = nameTokens(l.name, [...generic, ...(cMain ? cMain.split(/\s+/) : []), ...(hintMain ? hintMain.split(/\s+/) : [])]).core;
  const tokens = core.length ? core : nameTokens(l.name, []).all;
  const hit = tokens.filter((t) => text.includes(t)).length;
  const nameHit = tokens.length > 0 && hit === tokens.length;
  if (nameHit) { score += W.name; why.push('Firmenname steht auf der Seite'); } else if (tokens.length > 1 && hit >= tokens.length / 2) { score += Math.round(W.name / 2); why.push('Firmenname teilweise auf der Seite'); }
  const promText = norm(titleText), domain = norm(ev.host).replace(/\s+/g, '');
  const inTitle = tokens.length > 0 && tokens.every((t) => promText.includes(t)), inDomain = tokens.length > 0 && tokens.every((t) => domain.includes(t));
  if (inTitle) { score += W.title; why.push('Firmenname im Seitentitel/in der Überschrift'); } else if (inDomain) { score += W.domain; why.push('Firmenname in der Domain'); } else if (nameHit) warnings.push('Firmenname nicht im Seitentitel oder in der Domain');
  if (cMain && text.includes(cMain)) { score += W.city; why.push('Ort stimmt'); }
  if (ev.siteCity && cMain && !sameCity(norm(ev.siteCity.split(/[\/,(]/)[0]), cMain)) { score += W.cityMismatch; warnings.push(`Adresse der Website liegt in anderer Stadt (${ev.siteCity})`); }
  if (l.postalCode && text.includes(l.postalCode)) { score += W.postalCode; why.push('PLZ stimmt'); }
  const st = parseStreet(l.address); if (st && st.street.length >= 4 && text.includes(st.street) && text.includes(st.no)) { score += W.address; why.push('Straße und Hausnummer stimmen'); }
  const phoneHit = !!l.phone && normPhone(l.phone).length >= 6 && digits.includes(normPhone(l.phone).replace(/^0/, '')); if (phoneHit) { score += W.phone; why.push('Telefonnummer stimmt überein'); }
  // Branche: nur wenn das Branchenwort auch außerhalb des Firmennamens vorkommt (der Name „Nagelstudio X“ belegt die Branche nicht)
  const textNoName = norm(l.name).length >= 4 ? text.split(norm(l.name)).join(' ') : text;
  if (l.subKeywords.some((k) => k.length >= 4 && textNoName.includes(norm(k)))) { score += W.industry; why.push('Branche passt'); }
  if (!ev.crawlFailed && nameHit && (ev.pages.some((p) => /impressum|imprint/i.test(p.url)) || /impressum/.test(text))) { score += W.impressum; why.push('Impressum nennt die Firma'); }
  if (!ev.crawlFailed && ev.pages.some((p) => /href=["'](?:tel|mailto):/i.test(p.html))) { score += W.contact; why.push('Kontaktangaben vorhanden'); }
  let far = false;
  if (ev.distanceKm !== undefined && ev.distanceKm !== null) {
    const km = Math.round(ev.distanceKm * 10) / 10;
    if (ev.distanceKm <= cfg.locationMatchKm) { score += W.locationMatch; why.push(`Adresse der Website liegt am OSM-Standort (${km} km)`); }
    else if (ev.distanceKm <= cfg.locationNearKm) { score += W.locationNear; why.push(`Adresse der Website liegt in der Nähe des OSM-Standorts (${km} km)`); }
    else if (ev.distanceKm > cfg.locationFarKm) { score += W.locationFar; far = true; warnings.push(`Adresse der Website liegt ${km} km vom OSM-Standort entfernt`); }
  }
  // Obergrenzen: ohne klare Belege nie „wahrscheinlich/verifiziert“
  const caps: number[] = [];
  if (!nameHit && !(phoneHit && hit > 0)) caps.push(cfg.uncertainAt + 5);
  if (!inTitle && !inDomain) caps.push(cfg.likelyAt - 1);
  if (ev.crawlFailed) { caps.push(cfg.likelyAt - 1); warnings.push('Seite nicht abrufbar – nur der Suchtreffer wurde ausgewertet'); }
  if (far) caps.push(cfg.likelyAt - 1);
  if (tokens.join('').length < 5 && !phoneHit) { caps.push(cfg.likelyAt - 1); warnings.push('Firmenname sehr kurz – Zuordnung unsicher'); }
  let confidence = Math.max(0, Math.min(100, Math.min(score, ...caps)));
  // Weit entfernte Adresse (6–25 km) bei klar passendem Namen: nicht stillschweigend verwerfen (Umzug/Zentrale/Filialbetrieb?), sondern zur manuellen Prüfung vormerken.
  // Weiter als rejectFarKm (Standard 25 km) ist es ein Namensvetter in einer anderen Region (z. B. „Haarstudio Tanja“ in Gengenbach statt in Dillingen) – abgelehnt, kein Eintrag in „Manuell prüfen“.
  if (far && nameHit && (inTitle || inDomain) && (ev.distanceKm ?? 0) <= cfg.rejectFarKm) confidence = Math.max(confidence, cfg.uncertainAt);
  const verification: Verification = confidence >= cfg.verifiedAt ? 'VERIFIED' : confidence >= cfg.likelyAt ? 'LIKELY' : confidence >= cfg.uncertainAt ? 'UNCERTAIN' : 'REJECTED';
  return { confidence, verification, why, warnings };
}

/** Betrag mit Währung → EUR-Cent (für das interne EUR-Budget); auf 6 Nachkommastellen gerundet. */
export const toEurCents = (m: Money, eurPerUsd: number) => Math.round((m.currency === 'EUR' ? m.amount * 100 : m.amount * eurPerUsd * 100) * 1e6) / 1e6;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const regDomain = (host: string) => host.replace(/^www\./, '').split('.').slice(-2).join('.');
/** Schlüssel „dieselbe Website“: Domain – bei Baukasten-Hosts mit Pfad je Kunde zusätzlich der erste Pfadteil. */
const siteKey = (url: string) => { try { const u = new URL(url); const h = u.hostname.replace(/^www\./, ''); return PATH_SITES.test(h) ? `${h}/${u.pathname.split('/')[1] ?? ''}` : regDomain(h); } catch { return url; } };

export type EnrichDeps = {
  repo: Repo; leads: LeadStore; pipeline: PipelineStore; cfg: AppConfig; now: () => Date;
  sources: { webSearch: WebSearchProvider }; providers: { crawler: CrawlerProvider; places: PlacesProvider };
  /** Neu analysieren (Website abrufen, Scores, Priorität) – vom Kontext gesetzt. */
  reanalyze: (leadId: string) => Promise<void>;
};

/**
 * Web-Enrichment: offizielle Website, Telefon, E-Mail, Kontaktseite finden – nur wenn Daten fehlen, der Lead relevant ist, Budget da ist und die Suche nicht schon gelaufen ist.
 * Danach wird der Lead neu bewertet. Es wird nichts gesendet und keine Demo erstellt.
 */
export class EnrichmentService {
  d: EnrichDeps; budget: EnrichmentBudget; private geoCache = new Map<string, GeoPoint | null>();
  constructor(d: EnrichDeps) { this.d = d; this.budget = new EnrichmentBudget(d.repo, d.cfg.pipeline.enrichment); }
  private get E() { return this.d.cfg.pipeline.enrichment; }
  private get pool() { return this.d.repo.pool; }
  private get owner() { return this.d.repo.ownerId; }
  private get leads() { return this.d.leads; }
  get provider() { return this.d.sources.webSearch; }
  get available() { return this.provider.name !== 'keine-quelle'; }
  /** Wechselkurs für USD-Providerkosten (eine einzige Quelle: config/ai.json → eurPerUsd). */
  get eurPerUsd(): number { return Number(this.d.cfg.ai.eurPerUsd); }
  /** Geschätzte Kosten einer Anfrage in EUR-Cent (für die Budgetprüfung vor jeder Anfrage). */
  estEurCents(): number {
    if (this.provider.isMock) return 0; const p = this.d.cfg.pipeline.sources.WEB_SEARCH.pricing;
    return toEurCents({ amount: p.usdPerThousandRequests / 1000, currency: p.currency }, this.eurPerUsd);
  }

  private async setStatus(leadId: string, status: EnrichmentStatus, extra: { candidate?: string | null; confidence?: number | null; verified?: Verification | null; touch?: boolean } = {}) {
    await this.pool.query(`update leads set enrichment_status=$3, last_enrichment_at = case when $4 then $8 else last_enrichment_at end,
        official_website_candidate = coalesce($5, official_website_candidate), official_website_confidence = coalesce($6, official_website_confidence), official_website_verified = coalesce($7, official_website_verified) where id=$1 and owner_id=$2`,
      [leadId, this.owner, status, extra.touch ?? false, extra.candidate ?? null, extra.confidence ?? null, extra.verified ?? null, this.d.now()]);
  }
  private async log(leadId: string, runId: string | undefined, hash: string, queries: string[], requests: number, eurCents: number, money: Money, outcome: string, found: object) {
    await this.pool.query('insert into enrichment_log(owner_id, lead_id, run_id, hash, queries, requests, cost_cents, outcome, found, provider, created_at, provider_cost_amount, provider_cost_currency, fx_eur_per_usd) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
      [this.owner, leadId, runId ?? null, hash, JSON.stringify(queries), requests, eurCents, outcome, JSON.stringify(found), this.provider.name, this.d.now(), money.amount, money.currency, money.currency === 'USD' ? this.eurPerUsd : null]);
  }

  /** Was fehlt? Website und/oder (Telefon UND E-Mail beide fehlen). */
  private needs(row: any, facts: Fact[]) {
    const hasEmail = !!row.email || facts.some((f) => f.key === 'email');
    return { website: !row.website_url, contact: !row.phone && !hasEmail, hasEmail };
  }

  /** Startadresse für die Prüfung: die Startseite der Domain (nicht der Unterseite aus dem Suchtreffer). */
  private startUrl(url: string): string {
    try { const u = new URL(url); if (PATH_SITES.test(u.hostname)) return `${u.origin}/${u.pathname.split('/')[1] ?? ''}`; return `${u.origin}/`; } catch { return url; }
  }
  private async geo(query: string): Promise<GeoPoint | null> {
    if (this.geoCache.has(query)) return this.geoCache.get(query)!;
    let p: GeoPoint | null = null; try { p = (await this.d.providers.places.geocode(query))?.point ?? null; } catch { p = null; }
    this.geoCache.set(query, p); return p;
  }

  /** Eine Kandidaten-Website prüfen: Seiten abrufen, Anschrift lesen, Standort mit dem OSM-Eintrag vergleichen, bewerten. */
  private async evaluate(h: WebSearchHit, info: LeadInfo, generic: string[]): Promise<Cand> {
    const host = hostOf(h.url) ?? h.url; const start = this.startUrl(h.url);
    const crawl = await this.d.providers.crawler.crawl(start, { maxPages: this.E.verifyPages });
    const pages = crawl.pages.filter((p) => p.status > 0 && p.status < 400 && p.html);
    const failed = !crawl.ok || !pages.length;
    let siteAddress: string | undefined, siteCity: string | undefined, km: number | null | undefined;
    if (!failed) {
      const order = [...pages].sort((a, b) => Number(/impressum|imprint|kontakt|contact/i.test(b.url)) - Number(/impressum|imprint|kontakt|contact/i.test(a.url)));
      const addr = order.map((p) => findAddressIn(visibleText(p.html))).find(Boolean);
      if (addr) {
        siteAddress = `${addr.street}, ${addr.postalCode} ${addr.city}`; siteCity = addr.city;
        if (this.E.geocodeSiteAddress && info.point) { const g = await this.geo(siteAddress); if (g) km = distanceKm(info.point, g); }
      }
    }
    const v = scoreCandidate({ pages, hit: { title: h.title, snippet: h.snippet }, crawlFailed: failed, host, siteCity, distanceKm: km }, info, generic, this.E.verify);
    return { url: failed ? start : crawl.finalUrl ?? start, host, ...v, pages: pages.length, siteAddress, distanceKm: km ?? null, crawlError: failed ? crawl.robotsBlocked ? 'robots.txt verbietet den Abruf' : crawl.error ?? 'keine Seiten' : undefined };
  }

  async enrichLead(leadId: string, o: { runId?: string; force?: boolean; ignoreCache?: boolean } = {}): Promise<EnrichOutcome> {
    const zero: Money = { amount: 0, currency: this.provider.isMock ? 'EUR' : this.d.cfg.pipeline.sources.WEB_SEARCH.pricing.currency };
    const out = (status: EnrichmentStatus, note: string, x: Partial<EnrichOutcome> = {}): EnrichOutcome => ({ leadId, status, requests: 0, costCents: 0, providerCost: zero, note, found: [], ...x });
    const row = await this.leads.rowToEntry(leadId); if (!row) throw new Error('Lead nicht gefunden');
    const facts = await this.d.leads.factsOf(leadId); const need = this.needs(row, facts);
    if (row.contact_blocked || row.paused || facts.some((f) => f.key === 'businessStatus' && /CLOSED_PERMANENTLY/.test(JSON.stringify(f.value)))) { await this.setStatus(leadId, 'not_needed'); return out('not_needed', 'Lead gesperrt, pausiert oder geschlossen.'); }
    if (!need.website && !need.contact) { await this.setStatus(leadId, 'not_needed'); return out('not_needed', 'Website und Kontaktdaten sind schon bekannt.'); }
    // Priorität: A, B und interessante C (D nicht kostenpflichtig) – ein ausdrücklicher Klick des Nutzers (force) umgeht nur diese Schranke
    const prio = row.effective_priority as string | null; const opp = Number((await this.pool.query('select score from opportunities where lead_id=$1 and owner_id=$2 order by created_at desc, id desc limit 1', [leadId, this.owner])).rows[0]?.score ?? 0);
    const allowed = (this.E.enrichPriorities as string[]).includes(prio ?? '') && (prio !== 'C' || opp >= this.E.cMinOpportunity);
    if (!allowed && !o.force) { await this.setStatus(leadId, 'skipped_priority'); return out('skipped_priority', `Priorität ${prio ?? '–'} wird nicht kostenpflichtig angereichert.`); }
    if (!this.available) { await this.setStatus(leadId, 'provider_unavailable', { touch: true }); return out('provider_unavailable', 'Websuche nicht verfügbar (BRAVE_SEARCH_API_KEY fehlt).', { fatal: true }); }

    // Ortsangabe: echte OSM-Stadt; fehlt sie (häufig bei OSM), dient die Region des Suchlaufs nur als Hinweis für die Suche – nie als Beleg
    const realCity = (row.city as string | null)?.replace(/^\d{5}\s*/, '') || undefined;
    const run = row.run_id ? (await this.pool.query('select region from lead_runs where id=$1 and owner_id=$2', [row.run_id, this.owner])).rows[0] : null;
    const cityHint = !realCity ? (run?.region as string | undefined) || undefined : undefined;
    const sub = this.d.cfg.taxonomy.sub(row.sub_industry); const subLabel = sub?.label ?? '';
    const info: LeadInfo = { name: row.company_name, city: realCity, cityHint, postalCode: row.postal_code ?? undefined, address: row.address ?? undefined, phone: row.phone ?? undefined,
      subKeywords: [...(sub?.keywords ?? []), subLabel].filter(Boolean), point: row.lat !== null && row.lng !== null ? { lat: Number(row.lat), lng: Number(row.lng) } : null };
    const hash = createHash('sha1').update(JSON.stringify([info.name, info.city, info.cityHint, info.postalCode, info.address, info.phone, need, this.E.maxQueriesPerLead, 'v2'])).digest('hex').slice(0, 24);
    if (!o.ignoreCache) {
      const last = (await this.pool.query("select outcome, created_at from enrichment_log where lead_id=$1 and owner_id=$2 and hash=$3 and outcome not in ('budget_blocked','provider_error') order by created_at desc limit 1", [leadId, this.owner, hash])).rows[0];
      if (last) { const ok = ['website_found', 'contact_found'].includes(last.outcome); const days = (this.d.now().getTime() - new Date(last.created_at).getTime()) / 86400_000;
        if (days < (ok ? this.E.cacheDays : this.E.failedCacheDays)) { await this.setStatus(leadId, 'cached'); return out('cached', `Gleiche Suche bereits am ${new Date(last.created_at).toLocaleDateString('de-DE')} (${last.outcome}) – nicht wiederholt.`); } }
    }

    // Website bekannt, aber weder Telefon noch E-Mail: dort wurde bereits gelesen – eine Websuche würde nichts Neues bringen
    if (!need.website) { await this.setStatus(leadId, 'not_found', { touch: true }); await this.d.pipeline.recomputePriority(leadId); return out('not_found', 'Website bekannt, aber auf der Website wurden keine Telefonnummer/E-Mail gefunden (keine Websuche nötig).'); }
    const place = realCity ?? cityHint ?? '';
    const nm = info.name.replace(/["„“”]/g, '').trim();
    const queries = [`"${nm}" ${place} ${subLabel}`.replace(/\s+/g, ' ').trim(), `${nm} ${place} Impressum Kontakt`.replace(/\s+/g, ' ').trim(), `${nm} ${place} ${subLabel} Telefon Öffnungszeiten`.replace(/\s+/g, ' ').trim()].slice(0, Math.max(1, this.E.maxQueriesPerLead));
    const trace: EnrichTrace = { queries: [], candidates: [], social: [], place: place ? { value: place, source: realCity ? 'osm-city' : 'search-region' } : undefined };
    let requests = 0, eurCents = 0, usd = 0, eur = 0; let blocked = false; let providerError: WebSearchError | Error | null = null; const used: string[] = [];
    const cands: Cand[] = []; const tried = new Set<string>(); const socialFacts: Fact[] = []; const generic = this.d.cfg.pipeline.dedupe.genericWords as string[];
    let accepted: Cand | null = null, ambiguous: Cand[] = [];
    for (const q of queries) {
      if (!need.website) break;                                   // nur nach der Website suchen; Kontaktdaten kommen aus ihrer Seite
      if (!(await this.budget.canSpend(this.d.now(), this.estEurCents(), eurCents))) { blocked = true; break; }
      let res; try { res = await this.provider.search({ query: q, count: this.d.cfg.pipeline.sources.WEB_SEARCH.resultsPerQuery }); }
      catch (e) { providerError = e instanceof Error ? e : new Error(String(e)); trace.providerError = providerError.message; break; }
      requests += res.requests; const c = toEurCents(res.cost, this.eurPerUsd); eurCents = r6(eurCents + c); if (res.cost.currency === 'USD') usd = r6(usd + res.cost.amount); else eur = r6(eur + res.cost.amount); used.push(q);
      const tq: EnrichTrace['queries'][number] = { query: q, requests: res.requests, cost: res.cost, rateLimit: res.rateLimit, hits: [] }; trace.queries.push(tq);
      const toCheck: WebSearchHit[] = [];
      for (const h of res.hits) {
        const host = hostOf(h.url); const t: EnrichTrace['queries'][number]['hits'][number] = { rank: h.rank, url: h.url, title: h.title }; tq.hits.push(t);
        this.collectSocial(h, info, subLabel, generic, res.retrievedAt, socialFacts, trace);
        if (!host) { t.note = 'ungültige Adresse'; continue; }
        if (socialPlatformOf(h.url)) { t.note = 'Social-Media-Profil (kein Website-Kandidat)'; continue; }
        if (NOT_OWN_SITE.test(host + '.')) { t.note = 'Verzeichnis/Portal (keine eigene Website)'; continue; }
        if (tried.has(siteKey(h.url))) { t.note = 'Domain bereits geprüft'; continue; }
        if (toCheck.length >= this.E.maxCandidatesPerQuery) { t.note = 'nicht geprüft (Obergrenze je Suche)'; continue; }
        tried.add(siteKey(h.url)); toCheck.push(h); t.note = 'wird geprüft';
      }
      const round: Cand[] = [];
      for (const h of toCheck) { try { const cand = await this.evaluate(h, info, generic); round.push(cand); cands.push(cand); trace.candidates.push(cand); } catch (e) { trace.candidates.push({ url: h.url, host: hostOf(h.url) ?? h.url, verification: 'UNCERTAIN', confidence: 0, why: [], warnings: [`Prüfung fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`], pages: 0 }); } }
      const good = round.filter((x) => x.verification === 'VERIFIED' || x.verification === 'LIKELY').sort((a, b) => b.confidence - a.confidence);
      if (good.length) {
        const [top, second] = good;
        if (second && siteKey(`https://${second.host}/`) !== siteKey(`https://${top.host}/`) && top.confidence - second.confidence < this.E.verify.ambiguityPoints) ambiguous = [top, second]; else accepted = top;
        break;
      }
    }
    const at = this.d.now().toISOString(); const found: string[] = [];
    const money: Money = usd > 0 ? { amount: usd, currency: 'USD' } : { amount: eur, currency: eur > 0 ? 'EUR' : zero.currency };
    if (blocked && !requests && !providerError) { await this.setStatus(leadId, 'budget_blocked', { touch: true }); await this.d.pipeline.recomputePriority(leadId); return out('budget_blocked', 'Budget (Monat/Tag) erreicht – nicht abgefragt.', { trace }); }
    // Ergebnisse speichern (Quelle je Angabe); die Neubewertung liest diese Fakten
    const add = async (f: Fact) => { await this.pool.query('insert into lead_facts(owner_id, lead_id, key, value, source, source_url, note, quality, captured_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [this.owner, leadId, f.key, JSON.stringify(f.value), f.source, f.url ?? null, f.note ?? null, f.quality, f.capturedAt]); };
    await this.pool.query("delete from lead_facts where lead_id=$1 and owner_id=$2 and source='web-search'", [leadId, this.owner]);
    for (const f of socialFacts) await add(f);
    let best: Cand | null = accepted ?? ambiguous[0] ?? [...cands].sort((a, b) => b.confidence - a.confidence)[0] ?? null;
    let status: EnrichmentStatus = 'not_found'; let note = 'Keine passende Website gefunden.';
    const detail = (c: Cand) => `${VERIFY_LABEL[c.verification]}, ${c.confidence}/100: ${c.why.join('; ') || 'kaum Übereinstimmungen'}${c.warnings.length ? ` (Vorbehalte: ${c.warnings.join('; ')})` : ''}`;
    if (accepted) {
      trace.decision = `Website übernommen: ${accepted.url} (${detail(accepted)})`;
      await add({ key: 'website', value: accepted.url, source: 'web-search', capturedAt: at, quality: 'medium', url: accepted.url, note: `Per Websuche gefunden – ${detail(accepted)}${accepted.verification === 'LIKELY' ? ' – bitte prüfen' : ''}` });
      await this.setStatus(leadId, 'website_found', { candidate: accepted.url, confidence: accepted.confidence, verified: accepted.verification, touch: true });
      let reanalyzed = true; try { await this.d.reanalyze(leadId); } catch (e) { reanalyzed = false; note = `Website gefunden, Neubewertung fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`; }
      found.push('Website'); status = 'website_found'; if (reanalyzed) note = `Website gefunden: ${accepted.host} (${VERIFY_LABEL[accepted.verification]}, ${accepted.confidence}/100).`;
      const after = await this.leads.rowToEntry(leadId); const nf = await this.d.leads.factsOf(leadId);
      if (after?.phone && !row.phone) found.push('Telefon'); if ((after?.email || nf.some((f) => f.key === 'email')) && !need.hasEmail) found.push('E-Mail');
      if (nf.some((f) => f.key === 'contactForm')) found.push('Kontaktformular'); if (nf.some((f) => f.key === 'whatsapp')) found.push('WhatsApp'); if (nf.some((f) => f.key === 'social' && f.source === 'website-crawl')) found.push('Social');
    } else if (ambiguous.length) {
      const top = ambiguous[0]; best = { ...top, verification: 'UNCERTAIN', warnings: [...top.warnings, `zwei ähnlich passende Websites: ${ambiguous.map((x) => x.host).join(' und ')}`] };
      trace.decision = `Nicht übernommen: zwei ähnlich passende Websites (${ambiguous.map((x) => `${x.host} ${x.confidence}/100`).join(', ')}) – manuell prüfen`;
      await add({ key: 'websiteCandidate', value: top.url, source: 'web-search', capturedAt: at, quality: 'low', url: top.url, note: `Nicht eindeutig (${trace.decision}). Wird nicht als Website übernommen.` });
      await this.setStatus(leadId, 'uncertain', { candidate: top.url, confidence: top.confidence, verified: 'UNCERTAIN', touch: true }); status = 'uncertain'; note = trace.decision;
    } else if (best && best.verification === 'UNCERTAIN') {
      trace.decision = `Nicht übernommen: ${best.host} unsicher (${detail(best)}) – manuell prüfen`;
      await add({ key: 'websiteCandidate', value: best.url, source: 'web-search', capturedAt: at, quality: 'low', url: best.url, note: `Nicht eindeutig zugeordnet (${detail(best)}) – bitte manuell prüfen. Wird nicht als Website übernommen.` });
      await this.setStatus(leadId, 'uncertain', { candidate: best.url, confidence: best.confidence, verified: 'UNCERTAIN', touch: true }); status = 'uncertain'; note = `Mögliche Website ${best.host} unsicher (${best.confidence}/100) – manuell prüfen.`;
    } else {
      trace.decision = best ? `Kein passender Treffer (bester Kandidat ${best.host}: ${detail(best)})` : 'Keine Website-Kandidaten in den Suchergebnissen';
      if (best) await this.setStatus(leadId, providerError ? 'provider_unavailable' : 'not_found', { candidate: best.url, confidence: best.confidence, verified: 'REJECTED', touch: true }); else await this.setStatus(leadId, providerError ? 'provider_unavailable' : 'not_found', { touch: true });
      if (providerError) { status = 'provider_unavailable'; note = `Websuche fehlgeschlagen: ${providerError.message}`; }
      else if (socialFacts.length) { found.push('Social (ungeprüft)'); note = 'Keine Website, aber mögliche Social-Profile gefunden (ungeprüft).'; }
    }
    if (providerError && status !== 'provider_unavailable') note += ` Danach Websuche-Fehler: ${providerError.message}`;
    if (blocked) note += ' Budget während der Suche erreicht.';
    const outcome = providerError && !accepted ? 'provider_error' : status === 'website_found' ? (found.some((x) => x === 'Telefon' || x === 'E-Mail') ? 'contact_found' : 'website_found') : status;
    if (requests > 0 || outcome === 'provider_error') await this.log(leadId, o.runId, hash, used, requests, eurCents, money, outcome, { found, candidate: best?.url, confidence: best?.confidence, verification: accepted?.verification ?? best?.verification, trace });
    await this.d.pipeline.recomputePriority(leadId);
    return out(status, note, { requests, costCents: eurCents, providerCost: money, verification: accepted?.verification ?? best?.verification, confidence: accepted?.confidence ?? best?.confidence, candidate: accepted?.url ?? best?.url, found, trace, fatal: providerError instanceof WebSearchError ? providerError.fatal : false });
  }

  /** Soziale Profile aus den Suchtreffern: nur mit Firmenname im Titel/in der Adresse UND Ort bzw. Branche im Treffer – immer ungeprüft (niedrige Qualität). */
  private collectSocial(h: WebSearchHit, l: LeadInfo, subLabel: string, generic: string[], at: string, into: Fact[], trace: EnrichTrace) {
    const pf = socialPlatformOf(h.url); if (!pf || !['instagram', 'facebook'].includes(pf)) return;
    const cm = cityMain(l.city) || cityMain(l.cityHint);
    const core = nameTokens(l.name, [...generic, ...(cm ? cm.split(/\s+/) : [])]).core; const nameHay = norm(`${h.title} ${h.url}`); const ctxHay = norm(`${h.title} ${h.snippet}`);
    if (!core.length || !core.every((t) => nameHay.includes(t))) return;
    const ctxOk = (!!cityMain(l.city) && ctxHay.includes(cityMain(l.city))) || (!!subLabel && ctxHay.includes(norm(subLabel))) || /friseur|haar|hair|salon|coiffeur|barber/.test(ctxHay);
    if (!ctxOk) return;
    if (into.some((f) => (f.value as { url: string }).url === h.url)) return;
    into.push({ key: 'social', value: { platform: pf, url: h.url }, source: 'web-search', capturedAt: at, quality: 'low', url: h.url, note: 'Per Websuche gefunden (Name und Ort/Branche im Treffer) – ungeprüft' });
    trace.social.push({ platform: pf, url: h.url, title: h.title });
  }

  /** Mehrere Leads in Prioritätsreihenfolge (A, B, C) anreichern – solange das Budget reicht. Bei fatalem Anbieterfehler (Schlüssel/Kontingent) bricht der Stapel ab. */
  async enrichBatch(ids: string[], o: { runId?: string; force?: boolean; limit?: number } = {}): Promise<{ attempted: number; counts: Record<string, number>; requests: number; costCents: number; providerCost: Money; outcomes: EnrichOutcome[]; stoppedBy?: string }> {
    const rows = (await this.pool.query("select id, effective_priority p, (select score from opportunities o where o.lead_id=l.id order by created_at desc limit 1) opp from leads l where owner_id=$1 and id = any($2)", [this.owner, ids])).rows;
    const rank = (p: string | null) => ({ A: 0, B: 1, C: 2 } as Record<string, number>)[p ?? ''] ?? 3;
    rows.sort((a, b) => rank(a.p) - rank(b.p) || Number(b.opp ?? 0) - Number(a.opp ?? 0));
    const counts: Record<string, number> = {}; const outcomes: EnrichOutcome[] = []; let requests = 0, cost = 0, usd = 0, eur = 0, attempted = 0, errors = 0; let stoppedBy: string | undefined; const limit = o.limit ?? this.E.maxLeadsPerBatch;
    for (const r of rows) {
      if (attempted >= limit) break;
      const res = await this.enrichLead(r.id, o).catch((e) => ({ leadId: r.id, status: 'not_found' as EnrichmentStatus, requests: 0, costCents: 0, providerCost: { amount: 0, currency: 'EUR' as const }, note: `Fehler: ${e instanceof Error ? e.message : String(e)}`, found: [] as string[] } as EnrichOutcome));
      counts[res.status] = (counts[res.status] ?? 0) + 1; outcomes.push(res); requests += res.requests; cost = r6(cost + res.costCents); if (res.providerCost.currency === 'USD') usd = r6(usd + res.providerCost.amount); else eur = r6(eur + res.providerCost.amount);
      if (res.requests > 0 || res.status === 'budget_blocked') attempted++;
      if (res.status === 'provider_unavailable') { errors++; if (res.fatal || !this.available || errors >= 3) { stoppedBy = res.note; break; } } else errors = 0;
    }
    return { attempted, counts, requests, costCents: cost, providerCost: usd > 0 ? { amount: usd, currency: 'USD' } : { amount: eur, currency: 'EUR' }, outcomes, stoppedBy };
  }
}
