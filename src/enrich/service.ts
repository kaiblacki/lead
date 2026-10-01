import { createHash } from 'node:crypto';
import type { Repo } from '../db/repo.ts';
import type { LeadStore } from '../db/leads.ts';
import type { PipelineStore } from '../db/pipeline.ts';
import type { AppConfig } from '../core/config.ts';
import type { CrawlerProvider } from '../providers/types.ts';
import type { WebSearchProvider, WebSearchHit } from '../sources/types.ts';
import { EnrichmentBudget } from './budget.ts';
import { hostOf, norm, normPhone, socialPlatformOf } from '../core/text.ts';
import { nameTokens, parseStreet } from '../dedupe/match.ts';
import type { Fact } from '../core/profile.ts';

export type EnrichmentStatus = 'pending' | 'not_needed' | 'provider_unavailable' | 'budget_blocked' | 'cached' | 'website_found' | 'contact_found' | 'not_found' | 'uncertain' | 'skipped_priority';
export type Verification = 'VERIFIED' | 'LIKELY' | 'UNCERTAIN' | 'REJECTED';
export const ENRICH_LABEL: Record<string, string> = { pending: 'noch nicht geprüft', not_needed: 'nicht nötig', provider_unavailable: 'Websuche nicht verfügbar (kein API-Schlüssel)', budget_blocked: 'Budget erreicht', cached: 'aus Zwischenspeicher', website_found: 'Website gefunden', contact_found: 'Kontaktdaten gefunden', not_found: 'nichts gefunden', uncertain: 'unsicher – manuell prüfen', skipped_priority: 'Priorität zu niedrig' };
export const VERIFY_LABEL: Record<Verification, string> = { VERIFIED: 'verifiziert', LIKELY: 'wahrscheinlich', UNCERTAIN: 'unsicher', REJECTED: 'abgelehnt' };

/** Verzeichnisse, Portale und Marktplätze sind keine eigene Unternehmenswebsite. */
export const NOT_OWN_SITE = /(^|\.)(facebook|instagram|tiktok|youtube|linkedin|xing|twitter|x|pinterest|google|bing|yelp|tripadvisor|gelbeseiten|dasoertliche|11880|golocal|meinestadt|branchenbuch|cylex|werkenntdenbesten|wikipedia|kununu|jameda|treatwell|fresha|booksy|planity|lieferando|opentable|thefork|restaurantguru|speisekarte|ihk|handwerkskammer|kleinanzeigen|ebay|amazon|firmenwissen|northdata|dnb|hotfrog|infobel|openstreetmap|gelbeseiten\.example)\b/i;

type Cand = { url: string; confidence: number; verification: Verification; why: string[] };
export type EnrichOutcome = { leadId: string; status: EnrichmentStatus; requests: number; costCents: number; verification?: Verification; confidence?: number; candidate?: string; note: string; found: string[] };
type LeadInfo = { name: string; city?: string; postalCode?: string; address?: string; phone?: string; subKeywords: string[] };

/** Bewertet, ob eine Seite zur Firma passt (0–100). Ein Suchtreffer allein gilt nie als offizielle Website. */
export function scoreCandidate(pages: { url: string; html: string }[], l: LeadInfo, generic: string[], cfg: AppConfig['pipeline']['enrichment']['verify']): { confidence: number; verification: Verification; why: string[] } {
  const W = cfg.weights; const why: string[] = []; let score = 0;
  const text = norm(pages.map((p) => p.html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).join(' '));
  const digits = pages.map((p) => p.html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/\D/g, '')).join(' ');
  const city = l.city ? norm(l.city.replace(/^\d{5}\s*/, '')) : '';
  const core = nameTokens(l.name, [...generic, ...(city ? city.split(/\s+/) : [])]).core;
  const tokens = core.length ? core : nameTokens(l.name, []).all;
  const hit = tokens.filter((t) => text.includes(t)).length;
  const nameHit = tokens.length > 0 && hit === tokens.length;
  if (nameHit) { score += W.name; why.push('Firmenname steht auf der Seite'); } else if (tokens.length > 1 && hit >= tokens.length / 2) { score += Math.round(W.name / 2); why.push('Firmenname teilweise auf der Seite'); }
  if (city && text.includes(city)) { score += W.city; why.push('Ort stimmt'); }
  if (l.postalCode && text.includes(l.postalCode)) { score += W.postalCode; why.push('PLZ stimmt'); }
  const st = parseStreet(l.address); if (st && st.street.length >= 4 && text.includes(st.street) && text.includes(st.no)) { score += W.address; why.push('Straße und Hausnummer stimmen'); }
  const phoneHit = !!l.phone && normPhone(l.phone).length >= 6 && digits.includes(normPhone(l.phone).replace(/^0/, '')); if (phoneHit) { score += W.phone; why.push('Telefonnummer stimmt überein'); }
  if (l.subKeywords.some((k) => k.length >= 4 && text.includes(norm(k)))) { score += W.industry; why.push('Branche passt'); }
  if (pages.some((p) => /impressum|imprint/i.test(p.url)) || /impressum/.test(text)) { if (nameHit) { score += W.impressum; why.push('Impressum nennt die Firma'); } }
  if (pages.some((p) => /href=["'](?:tel|mailto):/i.test(p.html))) { score += W.contact; why.push('Kontaktangaben vorhanden'); }
  // ohne Namensbezug gibt es keine Verifikation – auch nicht über Ort/Telefon allein
  const capped = !nameHit && !(phoneHit && hit > 0) ? Math.min(score, cfg.uncertainAt + 5) : score;
  const confidence = Math.max(0, Math.min(100, capped));
  const verification: Verification = confidence >= cfg.verifiedAt ? 'VERIFIED' : confidence >= cfg.likelyAt ? 'LIKELY' : confidence >= cfg.uncertainAt ? 'UNCERTAIN' : 'REJECTED';
  return { confidence, verification, why };
}

export type EnrichDeps = {
  repo: Repo; leads: LeadStore; pipeline: PipelineStore; cfg: AppConfig; now: () => Date;
  sources: { webSearch: WebSearchProvider }; providers: { crawler: CrawlerProvider };
  /** Neu analysieren (Website abrufen, Scores, Priorität) – vom Kontext gesetzt. */
  reanalyze: (leadId: string) => Promise<void>;
};

/**
 * Web-Enrichment: offizielle Website, Telefon, E-Mail, Kontaktseite finden – nur wenn Daten fehlen, der Lead relevant ist, Budget da ist und die Suche nicht schon gelaufen ist.
 * Danach wird der Lead neu bewertet. Es wird nichts gesendet und keine Demo erstellt.
 */
export class EnrichmentService {
  d: EnrichDeps; budget: EnrichmentBudget;
  constructor(d: EnrichDeps) { this.d = d; this.budget = new EnrichmentBudget(d.repo, d.cfg.pipeline.enrichment); }
  private get E() { return this.d.cfg.pipeline.enrichment; }
  private get pool() { return this.d.repo.pool; }
  private get owner() { return this.d.repo.ownerId; }
  get provider() { return this.d.sources.webSearch; }
  get available() { return this.provider.name !== 'keine-quelle'; }
  private estCents() { return this.provider.isMock ? 0 : Number(this.d.cfg.pipeline.sources.WEB_SEARCH.centsPerRequest ?? 0); }

  private async setStatus(leadId: string, status: EnrichmentStatus, extra: { candidate?: string | null; confidence?: number | null; verified?: Verification | null; touch?: boolean } = {}) {
    await this.pool.query(`update leads set enrichment_status=$3, last_enrichment_at = case when $4 then now() else last_enrichment_at end,
        official_website_candidate = coalesce($5, official_website_candidate), official_website_confidence = coalesce($6, official_website_confidence), official_website_verified = coalesce($7, official_website_verified) where id=$1 and owner_id=$2`,
      [leadId, this.owner, status, extra.touch ?? false, extra.candidate ?? null, extra.confidence ?? null, extra.verified ?? null]);
  }
  private async log(leadId: string, runId: string | undefined, hash: string, queries: string[], requests: number, cost: number, outcome: string, found: object) {
    await this.pool.query('insert into enrichment_log(owner_id, lead_id, run_id, hash, queries, requests, cost_cents, outcome, found, provider, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [this.owner, leadId, runId ?? null, hash, JSON.stringify(queries), requests, cost, outcome, JSON.stringify(found), this.provider.name, this.d.now()]);
  }

  /** Was fehlt? Website und/oder (Telefon UND E-Mail beide fehlen). */
  private needs(row: any, facts: Fact[]) {
    const hasEmail = !!row.email || facts.some((f) => f.key === 'email');
    return { website: !row.website_url, contact: !row.phone && !hasEmail, hasEmail };
  }

  async enrichLead(leadId: string, o: { runId?: string; force?: boolean; ignoreCache?: boolean } = {}): Promise<EnrichOutcome> {
    const out = (status: EnrichmentStatus, note: string, x: Partial<EnrichOutcome> = {}): EnrichOutcome => ({ leadId, status, requests: 0, costCents: 0, note, found: [], ...x });
    const row = await this.leads.rowToEntry(leadId); if (!row) throw new Error('Lead nicht gefunden');
    const facts = await this.d.leads.factsOf(leadId); const need = this.needs(row, facts);
    if (row.contact_blocked || row.paused || facts.some((f) => f.key === 'businessStatus' && /CLOSED_PERMANENTLY/.test(JSON.stringify(f.value)))) { await this.setStatus(leadId, 'not_needed'); return out('not_needed', 'Lead gesperrt, pausiert oder geschlossen.'); }
    if (!need.website && !need.contact) { await this.setStatus(leadId, 'not_needed'); return out('not_needed', 'Website und Kontaktdaten sind schon bekannt.'); }
    // Priorität: A, B und interessante C (D nicht kostenpflichtig) – ein ausdrücklicher Klick des Nutzers (force) umgeht nur diese Schranke
    const prio = row.effective_priority as string | null; const opp = Number((await this.pool.query('select score from opportunities where lead_id=$1 and owner_id=$2 order by created_at desc, id desc limit 1', [leadId, this.owner])).rows[0]?.score ?? 0);
    const allowed = (this.E.enrichPriorities as string[]).includes(prio ?? '') && (prio !== 'C' || opp >= this.E.cMinOpportunity);
    if (!allowed && !o.force) { await this.setStatus(leadId, 'skipped_priority'); return out('skipped_priority', `Priorität ${prio ?? '–'} wird nicht kostenpflichtig angereichert.`); }
    if (!this.available) { await this.setStatus(leadId, 'provider_unavailable', { touch: true }); return out('provider_unavailable', 'Websuche nicht verfügbar (BRAVE_SEARCH_API_KEY fehlt).'); }

    const info: LeadInfo = { name: row.company_name, city: row.city ?? undefined, postalCode: row.postal_code ?? undefined, address: row.address ?? undefined, phone: row.phone ?? undefined,
      subKeywords: [...(this.d.cfg.taxonomy.sub(row.sub_industry)?.keywords ?? []), this.d.cfg.taxonomy.sub(row.sub_industry)?.label ?? ''].filter(Boolean) };
    const hash = createHash('sha1').update(JSON.stringify([info.name, info.city, info.postalCode, info.address, info.phone, need, this.E.maxQueriesPerLead, 'v1'])).digest('hex').slice(0, 24);
    if (!o.ignoreCache) {
      const last = (await this.pool.query("select outcome, created_at from enrichment_log where lead_id=$1 and owner_id=$2 and hash=$3 and outcome <> 'budget_blocked' order by created_at desc limit 1", [leadId, this.owner, hash])).rows[0];
      if (last) { const ok = ['website_found', 'contact_found'].includes(last.outcome); const days = (this.d.now().getTime() - new Date(last.created_at).getTime()) / 86400_000;
        if (days < (ok ? this.E.cacheDays : this.E.failedCacheDays)) { await this.setStatus(leadId, 'cached'); return out('cached', `Gleiche Suche bereits am ${new Date(last.created_at).toLocaleDateString('de-DE')} (${last.outcome}) – nicht wiederholt.`); } }
    }

    const city = (info.city ?? '').replace(/^\d{5}\s*/, ''); const sub = this.d.cfg.taxonomy.sub(row.sub_industry)?.label ?? '';
    const queries = [`${info.name} ${city}`.trim(), `${info.name} ${city} Kontakt Impressum`.trim(), `${info.name} ${city} ${sub} Telefon`.trim()].slice(0, Math.max(1, this.E.maxQueriesPerLead));
    let requests = 0, cost = 0; let best = null as Cand | null, accepted = null as Cand | null; let blocked = false; const used: string[] = []; const socialFacts: Fact[] = []; const triedUrls = new Set<string>();
    const generic = this.d.cfg.pipeline.dedupe.genericWords as string[];
    for (const q of queries) {
      if (!need.website) break;                                   // nur nach der Website suchen; Kontaktdaten kommen aus ihrer Seite
      if (!(await this.budget.canSpend(this.d.now(), this.estCents(), cost))) { blocked = true; break; }
      let res; try { res = await this.provider.search({ query: q, count: this.d.cfg.pipeline.sources.WEB_SEARCH.resultsPerQuery }); } catch (e) { await this.log(leadId, o.runId, hash, used, requests, cost, 'not_found', { error: e instanceof Error ? e.message : String(e) }); throw e; }
      requests += res.requests; cost += res.costCents; used.push(q);
      for (const h of res.hits.slice(0, 5)) this.collectSocial(h, info, generic, res.retrievedAt, socialFacts);
      for (const h of res.hits.slice(0, 4)) {
        const host = hostOf(h.url); if (!host || socialPlatformOf(h.url) || NOT_OWN_SITE.test(host) || triedUrls.has(host)) continue; triedUrls.add(host);
        const crawl = await this.d.providers.crawler.crawl(h.url, { maxPages: 2 });
        const pages = crawl.pages.filter((p) => p.status > 0 && p.status < 400 && p.html); if (!crawl.ok || !pages.length) continue;
        const v = scoreCandidate(pages, info, generic, this.E.verify); const url = crawl.finalUrl ?? h.url;
        if (!best || v.confidence > best.confidence) best = { url, ...v };
        if (v.verification === 'VERIFIED' || v.verification === 'LIKELY') { accepted = { url, ...v }; break; }
      }
      if (accepted) break;
    }
    const at = this.d.now().toISOString(); const found: string[] = [];
    if (blocked && !requests) { await this.setStatus(leadId, 'budget_blocked', { touch: true }); await this.d.pipeline.recomputePriority(leadId); return out('budget_blocked', 'Budget (Monat/Tag) erreicht – nicht abgefragt.', { found }); }
    // Ergebnisse speichern (Quelle je Angabe); die Neubewertung liest diese Fakten
    const add = async (f: Fact) => { await this.pool.query('insert into lead_facts(owner_id, lead_id, key, value, source, source_url, note, quality, captured_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [this.owner, leadId, f.key, JSON.stringify(f.value), f.source, f.url ?? null, f.note ?? null, f.quality, f.capturedAt]); };
    await this.pool.query("delete from lead_facts where lead_id=$1 and owner_id=$2 and source='web-search'", [leadId, this.owner]);
    for (const f of socialFacts) await add(f);
    let status: EnrichmentStatus = 'not_found'; let note = 'Keine passende Website gefunden.';
    if (accepted) {
      await add({ key: 'website', value: accepted.url, source: 'web-search', capturedAt: at, quality: 'medium', url: accepted.url, note: `Per Websuche gefunden (${VERIFY_LABEL[accepted.verification]}, ${accepted.confidence}/100): ${accepted.why.join('; ')}${accepted.verification === 'LIKELY' ? ' – bitte prüfen' : ''}` });
      await this.setStatus(leadId, 'website_found', { candidate: accepted.url, confidence: accepted.confidence, verified: accepted.verification, touch: true });
      try { await this.d.reanalyze(leadId); } catch (e) { note = `Website gefunden, Neubewertung fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`; }
      found.push('Website'); status = 'website_found'; note = `Website gefunden: ${hostOf(accepted.url)} (${VERIFY_LABEL[accepted.verification]}, ${accepted.confidence}/100).`;
      const after = await this.leads.rowToEntry(leadId); const nf = await this.d.leads.factsOf(leadId);
      if (after?.phone && !row.phone) found.push('Telefon'); if ((after?.email || nf.some((f) => f.key === 'email')) && !need.hasEmail) found.push('E-Mail');
      if (nf.some((f) => f.key === 'contactForm')) found.push('Kontaktformular'); if (nf.some((f) => f.key === 'whatsapp')) found.push('WhatsApp'); if (nf.some((f) => f.key === 'social' && f.source === 'website-crawl')) found.push('Social');
      if (found.some((x) => x === 'Telefon' || x === 'E-Mail')) status = 'website_found';
    } else if (best && best.verification === 'UNCERTAIN') {
      await add({ key: 'websiteCandidate', value: best.url, source: 'web-search', capturedAt: at, quality: 'low', url: best.url, note: `Nicht eindeutig zugeordnet (${best.confidence}/100: ${best.why.join('; ') || 'kaum Übereinstimmungen'}) – bitte manuell prüfen. Wird nicht als Website übernommen.` });
      await this.setStatus(leadId, 'uncertain', { candidate: best.url, confidence: best.confidence, verified: 'UNCERTAIN', touch: true }); status = 'uncertain'; note = `Mögliche Website ${hostOf(best.url)} unsicher (${best.confidence}/100) – manuell prüfen.`;
    } else {
      if (best) await this.setStatus(leadId, 'not_found', { candidate: best.url, confidence: best.confidence, verified: 'REJECTED', touch: true }); else await this.setStatus(leadId, 'not_found', { touch: true });
      if (socialFacts.length) { found.push('Social (ungeprüft)'); note = 'Keine Website, aber mögliche Social-Profile gefunden (ungeprüft).'; }
    }
    if (blocked) note += ' Budget während der Suche erreicht.';
    await this.log(leadId, o.runId, hash, used, requests, cost, status === 'website_found' ? (found.some((x) => x === 'Telefon' || x === 'E-Mail') ? 'contact_found' : 'website_found') : status, { found, candidate: best?.url, confidence: best?.confidence, verification: accepted?.verification ?? best?.verification });
    await this.d.pipeline.recomputePriority(leadId);
    return out(status, note, { requests, costCents: cost, verification: accepted?.verification ?? best?.verification, confidence: accepted?.confidence ?? best?.confidence, candidate: accepted?.url ?? best?.url, found });
  }
  private get leads() { return this.d.leads; }

  private collectSocial(h: WebSearchHit, l: LeadInfo, generic: string[], at: string, into: Fact[]) {
    const pf = socialPlatformOf(h.url); if (!pf || !['instagram', 'facebook'].includes(pf)) return;
    const core = nameTokens(l.name, [...generic, ...(l.city ? norm(l.city).split(/\s+/) : [])]).core; const hay = norm(`${h.title} ${h.url}`);
    if (!core.length || !core.every((t) => hay.includes(t))) return;
    if (into.some((f) => (f.value as { url: string }).url === h.url)) return;
    into.push({ key: 'social', value: { platform: pf, url: h.url }, source: 'web-search', capturedAt: at, quality: 'low', url: h.url, note: 'Per Websuche gefunden (Name im Treffer) – ungeprüft' });
  }

  /** Mehrere Leads in Prioritätsreihenfolge (A, B, C) anreichern – solange das Budget reicht. */
  async enrichBatch(ids: string[], o: { runId?: string; force?: boolean; limit?: number } = {}): Promise<{ attempted: number; counts: Record<string, number>; requests: number; costCents: number; outcomes: EnrichOutcome[] }> {
    const rows = (await this.pool.query("select id, effective_priority p, (select score from opportunities o where o.lead_id=l.id order by created_at desc limit 1) opp from leads l where owner_id=$1 and id = any($2)", [this.owner, ids])).rows;
    const rank = (p: string | null) => ({ A: 0, B: 1, C: 2 } as Record<string, number>)[p ?? ''] ?? 3;
    rows.sort((a, b) => rank(a.p) - rank(b.p) || Number(b.opp ?? 0) - Number(a.opp ?? 0));
    const counts: Record<string, number> = {}; const outcomes: EnrichOutcome[] = []; let requests = 0, cost = 0, attempted = 0; const limit = o.limit ?? this.E.maxLeadsPerBatch;
    for (const r of rows) {
      if (attempted >= limit) break;
      const res = await this.enrichLead(r.id, o).catch((e) => ({ leadId: r.id, status: 'not_found' as EnrichmentStatus, requests: 0, costCents: 0, note: `Fehler: ${e instanceof Error ? e.message : String(e)}`, found: [] as string[] }));
      counts[res.status] = (counts[res.status] ?? 0) + 1; outcomes.push(res); requests += res.requests; cost += res.costCents;
      if (res.requests > 0 || res.status === 'budget_blocked') attempted++;
      if (res.status === 'provider_unavailable') break;
    }
    return { attempted, counts, requests, costCents: cost, outcomes };
  }
}
