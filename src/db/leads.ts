import type pg from 'pg';
import type { Repo } from './repo.ts';
import type { CandidateResult } from '../search/analyze-candidate.ts';
import type { ContactAssessment } from '../contact/strategy.ts';
import { assessContact, suppressionKeys } from '../contact/strategy.ts';
import type { SalesBrief } from '../sales/brief.ts';
import { analysisPath, type Status } from '../core/status.ts';
import { moveLead, recordOutcome } from './lead-status.ts';
import { snapshotFeatures, hashConfig, type ScoringConfig } from '../scoring/intelligence.ts';
import type { Fact, FactKey } from '../core/profile.ts';

export type SaveAnalysisInput = {
  res: CandidateResult; contact: ContactAssessment; brief: SalesBrief | null; runId?: string | null; scoring: ScoringConfig;
  runResult?: { matched: boolean; failReasons: string[] };
};

export type LeadFilter = { quick?: string; tier?: string; q?: string; category?: string; status?: string; readiness?: string; websiteState?: string; minScore?: number; runId?: string; matchedOnly?: boolean; priority?: string; sort?: string; limit?: number; offset?: number };

export class LeadStore {
  repo: Repo;
  /** Nach dem Speichern einer Analyse (innerhalb derselben Transaktion), z. B. um die Priorität A–D neu zu berechnen. */
  afterSave?: (leadId: string, c: pg.PoolClient) => Promise<void>;
  constructor(repo: Repo) { this.repo = repo; }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }

  /** Welche externen Referenzen gibt es schon? (für „bereits vorhandene ausschließen“) */
  async existingRefs(source: string[], refs: string[]): Promise<Set<string>> {
    if (!refs.length) return new Set();
    const r = await this.pool.query('select source_ref from leads where owner_id=$1 and source = any($2) and source_ref = any($3) union select source_ref from lead_aliases where owner_id=$1 and source = any($2) and source_ref = any($3)', [this.owner, source, refs]);
    return new Set(r.rows.map((x) => x.source_ref));
  }

  /** Speichert eine komplette Analyse atomar: Lead, Fakten, Audit, Scores, Verkaufsbrief, Snapshot, Status, Audit-Log. */
  async saveAnalysis(i: SaveAnalysisInput): Promise<{ leadId: string; created: boolean; status: Status; snapshotId: string }> {
    const { res, contact, brief, runId } = i;
    const l = res.lead, a = res.analysis, au = res.audit;
    return this.repo.tx(async (c) => {
      const up = await c.query(
        `insert into leads(owner_id, run_id, company_name, industry, sub_industry, address, postal_code, city, phone, email, website_url, google_maps_url, opening_hours, description, socials,
           source, source_ref, employee_bucket, distance_km, lat, lng, rating, review_count, website_state, contact_readiness, contact_channel, contact_reason, is_mock, last_analyzed_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28, now())
         on conflict (owner_id, source, source_ref) do update set company_name=excluded.company_name, industry=excluded.industry, sub_industry=excluded.sub_industry, address=excluded.address,
           postal_code=excluded.postal_code, city=excluded.city, phone=excluded.phone, email=excluded.email, website_url=excluded.website_url, google_maps_url=excluded.google_maps_url,
           opening_hours=excluded.opening_hours, description=excluded.description, socials=excluded.socials, employee_bucket=excluded.employee_bucket, distance_km=excluded.distance_km,
           lat=excluded.lat, lng=excluded.lng, rating=excluded.rating, review_count=excluded.review_count, website_state=excluded.website_state, contact_readiness=excluded.contact_readiness,
           contact_channel=excluded.contact_channel, contact_reason=excluded.contact_reason, last_analyzed_at=now(), run_id=coalesce(excluded.run_id, leads.run_id)
         returning id, status, (xmax = 0) as created`,
        [this.owner, runId ?? null, l.companyName, l.industry ?? null, l.subIndustry ?? null, l.address ?? null, l.postalCode ?? null, l.city ?? null, l.phone ?? null, l.email ?? null, l.websiteUrl ?? null,
          l.mapsUrl ?? null, l.openingHours ?? null, l.description ?? null, JSON.stringify(l.socials ?? []), res.source, res.externalId, l.employeeBucket ?? null, l.distanceKm ?? null,
          l.point?.lat ?? null, l.point?.lng ?? null, l.rating ?? null, l.reviewCount ?? null, a.websiteState, contact.readiness, contact.recommended, contact.reasons[0] ?? null, !!l.isMock]);
      const leadId: string = up.rows[0].id;
      const current: Status = up.rows[0].status;

      await c.query('delete from lead_facts where lead_id=$1 and owner_id=$2', [leadId, this.owner]);
      for (const f of res.facts) await c.query('insert into lead_facts(owner_id, lead_id, key, value, source, source_url, note, quality, captured_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [this.owner, leadId, f.key, JSON.stringify(f.value), f.source, f.url ?? null, f.note ?? null, f.quality, f.capturedAt]);

      const aud = await c.query(
        `insert into audits(owner_id, lead_id, status, scores, final_url, pages_analyzed, coverage, render_dependent, notes, quality, overall_quality, source, captured_at, render_source)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
        [this.owner, leadId, au.status, JSON.stringify(au.quality), au.finalUrl ?? null, au.pagesAnalyzed, au.coverage, au.renderDependent, JSON.stringify(au.notes), JSON.stringify(au.quality), au.overallQuality, au.source, au.capturedAt, au.renderSource ? JSON.stringify(au.renderSource) : null]);
      for (const ck of au.checks) await c.query('insert into findings(owner_id, audit_id, category, code, severity, summary, evidence, status) values ($1,$2,$3,$4,$5,$6,$7,$8)',
        [this.owner, aud.rows[0].id, ck.category, ck.code, ck.severity, ck.summary, ck.evidence, ck.status]);

      const so = a.salesOpportunity;
      await c.query(
        `insert into opportunities(owner_id, lead_id, audit_id, score, category, factors, why, digital_need, dimensions, contributions, data_quality_factor, config_version, upsells, missing, note)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [this.owner, leadId, aud.rows[0].id, so.value, so.category, JSON.stringify(a.why), a.why.map((w) => w.text).join('\n'), a.digitalNeed.value, JSON.stringify(a.dimensions),
          JSON.stringify({ digitalNeed: a.digitalNeed, sales: so.contributions }), so.dataQualityFactor, a.configVersion, JSON.stringify(a.upsells), JSON.stringify(a.missing), so.note]);

      if (brief) {
        const latest = (await c.query('select opener_source, approved_at from sales_packages where lead_id=$1 and owner_id=$2 order by created_at desc, id desc limit 1', [leadId, this.owner])).rows[0];
        if (!latest || (latest.opener_source !== 'manual' && !latest.approved_at)) {
          await c.query(`insert into sales_packages(owner_id, lead_id, problems, chance, offer_name, price_cents, opener, opener_source, brief) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [this.owner, leadId, JSON.stringify(brief.reasons), brief.valueRange.label, brief.service.name, brief.service.priceCents, brief.opener, brief.openerSource === 'ai' ? 'ai' : 'template', JSON.stringify(brief)]);
        }
      }

      const snap = await c.query('insert into score_snapshots(owner_id, lead_id, config_version, features, scores) values ($1,$2,$3,$4,$5) returning id',
        [this.owner, leadId, a.configVersion, JSON.stringify(snapshotFeatures(res.facts, au, a)), JSON.stringify({ digitalNeed: a.digitalNeed.value, salesOpportunity: so.value, category: so.category, configHash: hashConfig(i.scoring), contactReadiness: contact.readiness })]);

      const target: Status = contact.readiness === 'DO_NOT_CONTACT' ? 'IGNORED' : so.category === 'UNRATED' ? 'RECHECK' : (so.category === 'LOW' || so.category === 'IGNORE') ? 'IGNORED' : 'QUALIFIED';
      let from = current;
      for (const to of analysisPath(current, target)) {
        await c.query('update leads set status=$1 where id=$2 and owner_id=$3', [to, leadId, this.owner]);
        await this.repo.event(c, leadId, 'status_change', { from, to, reason: `Analyse: ${so.category === 'UNRATED' ? 'nicht bewertbar' : `${so.category} (${so.value})`}`, actor: 'system' });
        from = to;
      }
      await this.repo.event(c, leadId, 'audit_done', { audit_id: aud.rows[0].id, status: au.status, checks: au.checks.length, sales_opportunity: so.value, digital_need: a.digitalNeed.value, actor: 'system' });
      if (runId && i.runResult) await c.query('insert into run_results(run_id, lead_id, owner_id, matched, fail_reasons, sales_opportunity, digital_need) values ($1,$2,$3,$4,$5,$6,$7) on conflict (run_id, lead_id) do update set matched=$4, fail_reasons=$5, sales_opportunity=$6, digital_need=$7',
        [runId, leadId, this.owner, i.runResult.matched, JSON.stringify(i.runResult.failReasons), so.value, a.digitalNeed.value]);
      await this.afterSave?.(leadId, c);
      return { leadId, created: up.rows[0].created as boolean, status: from, snapshotId: snap.rows[0].id as string };
    });
  }

  async list(f: LeadFilter = {}) {
    const p: unknown[] = [this.owner]; let where = 'l.owner_id = $1';
    const add = (sql: string, v: unknown) => { p.push(v); where += ` and ${sql.replaceAll('?', `$${p.length}`)}`; };
    if (f.status) add('l.status = ?', f.status);
    if (f.category) add('o.category = ?', f.category);
    if (f.readiness) add('l.contact_readiness = ?', f.readiness);
    if (f.websiteState) add('l.website_state = ?', f.websiteState);
    if (f.minScore) add('o.score >= ?', f.minScore);
    if (f.priority) add("coalesce(l.effective_priority, sp.brief->>'priority') = ?", f.priority);
    if (f.tier) add('l.ai_tier = ?', f.tier);
    if (f.q) add('(l.company_name ilike ? or l.city ilike ? or l.sub_industry ilike ?)', `%${f.q}%`);
    const hasDemo = 'exists (select 1 from demos d where d.lead_id = l.id and not d.revoked)';
    const openCall = "exists (select 1 from lead_tasks t where t.lead_id = l.id and t.status = 'OPEN' and t.kind = 'CALL_DEMO_READY')";
    const hasEmail = "(l.email is not null or exists (select 1 from lead_facts lf where lf.lead_id = l.id and lf.key = 'email'))";
    // Schnellfilter (je einer): die Fragen, die man im Vertrieb am häufigsten stellt
    const QUICK: Record<string, string> = {
      no_website: "l.website_state = 'none'",
      worst_websites: 'au.overall_quality is not null',
      demo_ready: hasDemo,
      demo_open: `l.website_url is not null and not ${hasDemo} and l.demo_decision is null`,
      not_contacted: "l.call_count = 0 and l.last_contact_at is null and l.status in ('QUALIFIED','DEMO_CREATED')",
      call_today: `(${openCall} or (l.callback_at is not null and l.callback_at < now() + interval '1 day')) and l.contact_readiness = 'READY_FOR_MANUAL_CALL' and not l.paused`,
      // Arbeitsstatus-Filter: angerufen / interessiert / später (Rückruf) / kein Interesse
      called: 'l.call_count > 0', interested: "l.status in ('INTERESTED','OFFER_SENT','OFFER_ACCEPTED')", later: 'l.callback_at is not null',
      no_interest: "exists (select 1 from contact_history ch where ch.lead_id = l.id and ch.result = 'NO_INTEREST')",
      // „Jetzt bearbeiten“: kontaktierbare A/B-Leads, die noch nicht abgeschlossen sind
      now_work: "l.work_status = 'CONTACTABLE' and l.effective_priority in ('A','B') and not l.paused and l.contact_readiness <> 'DO_NOT_CONTACT' and l.status in ('QUALIFIED','DEMO_CREATED','CONTACTED','REPLIED')",
      has_email: hasEmail, has_phone: 'l.phone is not null',
      has_website: 'l.website_url is not null',
      demo_recommended: `l.demo_decision = 'recommended' and not ${hasDemo}`,
      manual_check: "(l.review_flag is not null or l.contact_readiness = 'MANUAL_REVIEW' or l.official_website_verified = 'UNCERTAIN')",
      data_needed: "l.work_status = 'DATA_NEEDED' and l.contact_readiness <> 'DO_NOT_CONTACT' and l.status <> 'IGNORED'",
      ready_contact: "l.work_status = 'CONTACTABLE' and l.effective_priority in ('A','B') and not l.paused and l.contact_readiness <> 'DO_NOT_CONTACT' and l.status in ('QUALIFIED','DEMO_CREATED')",
      new_a: "l.effective_priority = 'A' and l.call_count = 0 and l.created_at > now() - interval '14 days' and l.status in ('QUALIFIED','DEMO_CREATED')",
      // „Heute bearbeiten“: alle A-Leads, die noch nicht kontaktiert sind, fällige Rückrufe und Leads mit fertiger Demo
      today_work: `(l.contact_readiness <> 'DO_NOT_CONTACT' and not l.paused and l.status in ('QUALIFIED','DEMO_CREATED') and ((l.effective_priority = 'A' and l.call_count = 0) or ${openCall} or (l.callback_at is not null and l.callback_at < now() + interval '1 day')))`,
    };
    if (f.quick && QUICK[f.quick]) where += ` and ${QUICK[f.quick]}`;
    let join = '';
    if (f.runId) { p.push(f.runId); join = `join run_results rr on rr.lead_id = l.id and rr.run_id = $${p.length}`; if (f.matchedOnly) where += ' and rr.matched'; }
    // Standard: vertriebsorientiert – kontaktierbare Leads zuerst (DATA_NEEDED getrennt am Ende), dann Priorität, höchste Verkaufschance; bei Gleichstand Firmen ohne Website, dann schlechteste Website, dann mit Telefonnummer
    const sort = f.sort || (f.quick === 'worst_websites' ? 'website_asc' : '');
    const prioRank = "case l.effective_priority when 'A' then 0 when 'B' then 1 when 'C' then 2 when 'D' then 3 else 4 end";
    const order = sort === 'score' ? 'o.score desc nulls last, (l.website_state = \'none\') desc, au.overall_quality asc nulls last, l.created_at desc' : sort === 'website_asc' ? 'au.overall_quality asc nulls last, o.score desc nulls last' : sort === 'distance' ? 'l.distance_km asc nulls last' : sort === 'digital_need' ? 'o.digital_need desc nulls last' : sort === 'recent' ? 'l.created_at desc'
      : `(l.work_status = 'DATA_NEEDED') asc, (l.phone is not null) desc, ${prioRank}, o.score desc nulls last, (l.website_state = 'none') desc, au.overall_quality asc nulls last, (l.phone is not null) desc, l.created_at desc`;
    const limit = Math.min(f.limit ?? 100, 500), offset = Math.max(f.offset ?? 0, 0);
    const base = `from leads l ${join}
      left join lateral (select score, category, digital_need, data_quality_factor, dimensions from opportunities where lead_id = l.id order by created_at desc, id desc limit 1) o on true
      left join lateral (select overall_quality, status as audit_status from audits where lead_id = l.id order by created_at desc, id desc limit 1) au on true
      left join lateral (select brief, approved_at from sales_packages where lead_id = l.id order by created_at desc, id desc limit 1) sp on true where ${where}`;
    const total = (await this.pool.query(`select count(*)::int n ${base}`, p)).rows[0].n;
    p.push(limit, offset);
    const rows = (await this.pool.query(
      `select l.id, l.company_name, l.city, l.sub_industry, l.status, l.paused, l.contact_readiness, l.contact_channel, l.phone, l.website_url, l.website_state, l.distance_km, l.is_mock, l.last_analyzed_at,
         l.call_count, l.callback_at, l.address, l.email, l.source, l.industry, l.ai_tier, l.email_send_status, l.email_sent_at, l.demo_decision, l.last_contact_at, o.score, o.category, o.digital_need, o.data_quality_factor,
         (o.dimensions->'dataQuality'->>'value')::float as dq, (o.dimensions->'contactability'->>'value')::float as contactability,
         case when l.website_state = 'none' then null else au.overall_quality end as website_score, au.audit_status,
         ${hasDemo} as has_demo, ${openCall} as demo_ready_call, ${hasEmail} as has_email,
         coalesce(l.effective_priority, sp.brief->>'priority') as priority, l.effective_priority, l.auto_priority, l.manual_priority, l.priority_reason, l.review_flag, l.work_status, l.contactability, l.preferred_contact_channel, l.demo_recommendation, l.demo_recommendation_reason, l.enrichment_status, l.last_enrichment_at, l.official_website_candidate, l.official_website_confidence, l.official_website_verified, sp.approved_at ${base} order by ${order} limit $${p.length - 1} offset $${p.length}`, p)).rows;
    return { total, rows };
  }

  async setDemoDecision(leadId: string, decision: 'skipped' | null) {
    const r = await this.pool.query('update leads set demo_decision=$3 where id=$1 and owner_id=$2', [leadId, this.owner, decision]);
    if (!r.rowCount) throw new Error('Lead nicht gefunden');
    await this.repo.event(this.pool, leadId, 'demo_decision', { decision, actor: 'user' });
  }

  /** Pipeline: pro Status die besten Leads (nach Score). */
  async byStage(perStage = 12) {
    return (await this.pool.query(`select * from (
        select l.id, l.company_name, l.city, l.status, l.paused, l.contact_readiness, l.is_mock, o.score, o.category, row_number() over (partition by l.status order by o.score desc nulls last, l.created_at desc) as rn
        from leads l left join lateral (select score, category from opportunities where lead_id = l.id order by created_at desc, id desc limit 1) o on true where l.owner_id = $1) x where rn <= $2`, [this.owner, perStage])).rows;
  }

  async get(id: string) {
    const l = await this.pool.query('select * from leads where id=$1 and owner_id=$2', [id, this.owner]);
    if (!l.rows[0]) return null;
    const [facts, opp, audit, sales, events, history, snaps] = await Promise.all([
      this.pool.query('select key, value, source, source_url, note, quality, captured_at from lead_facts where lead_id=$1 and owner_id=$2 order by key, captured_at desc', [id, this.owner]),
      this.pool.query('select * from opportunities where lead_id=$1 and owner_id=$2 order by created_at desc, id desc limit 1', [id, this.owner]),
      this.pool.query('select * from audits where lead_id=$1 and owner_id=$2 order by created_at desc, id desc limit 1', [id, this.owner]),
      this.pool.query('select * from sales_packages where lead_id=$1 and owner_id=$2 order by created_at desc, id desc limit 1', [id, this.owner]),
      this.pool.query('select type, payload, created_at from events where lead_id=$1 and owner_id=$2 order by id desc limit 60', [id, this.owner]),
      this.pool.query('select * from contact_history where lead_id=$1 and owner_id=$2 order by at desc limit 50', [id, this.owner]),
      this.pool.query('select scores, created_at from score_snapshots where lead_id=$1 and owner_id=$2 order by created_at desc limit 10', [id, this.owner]),
    ]);
    const checks = audit.rows[0] ? (await this.pool.query('select * from findings where audit_id=$1 and owner_id=$2', [audit.rows[0].id, this.owner])).rows : [];
    return { lead: l.rows[0], facts: facts.rows, opportunity: opp.rows[0] ?? null, audit: audit.rows[0] ?? null, checks, sales: sales.rows[0] ?? null, events: events.rows, history: history.rows, snapshots: snaps.rows };
  }

  async factsOf(leadId: string): Promise<Fact[]> {
    const r = await this.pool.query('select key, value, source, source_url, note, quality, captured_at from lead_facts where lead_id=$1 and owner_id=$2', [leadId, this.owner]);
    return r.rows.map((x) => ({ key: x.key as FactKey, value: x.value, source: x.source, url: x.source_url ?? undefined, note: x.note ?? undefined, quality: x.quality, capturedAt: x.captured_at.toISOString() }));
  }

  async setPaused(id: string, paused: boolean) {
    await this.repo.tx(async (c) => {
      const r = await c.query('update leads set paused=$1 where id=$2 and owner_id=$3', [paused, id, this.owner]);
      if (!r.rowCount) throw new Error('Lead nicht gefunden');
      await this.repo.event(c, id, paused ? 'paused' : 'resumed', { actor: 'user' });
    });
  }
  async isPaused(source: string, ref: string) { return (await this.pool.query('select paused from leads where owner_id=$1 and source=$2 and source_ref=$3', [this.owner, source, ref])).rows[0]?.paused === true; }

  /** Manueller Statuswechsel (nur direkte, erlaubte Übergänge) mit Pflicht-Grund. */
  async setStatus(id: string, to: Status, reason: string) {
    if (!reason.trim()) throw new Error('Ein Grund ist Pflicht');
    await this.repo.tx((c) => moveLead(this.repo, c, id, to, reason.slice(0, 300), 'user'));
  }

  async approveBrief(id: string) {
    await this.repo.tx(async (c) => {
      const r = await c.query(`update sales_packages set approved_at = now() where id = (select id from sales_packages where lead_id=$1 and owner_id=$2 order by created_at desc, id desc limit 1) and owner_id=$2`, [id, this.owner]);
      if (!r.rowCount) throw new Error('Kein Verkaufspaket vorhanden');
      await this.repo.event(c, id, 'sales_approved', { actor: 'user' });
    });
  }
  /** EDIT: Ein geänderter Einstieg muss erneut freigegeben werden. */
  async editOpener(id: string, opener: string) {
    const text = opener.trim();
    if (text.length < 10 || text.length > 1500) throw new Error('Gesprächseinstieg: 10 bis 1500 Zeichen');
    await this.repo.tx(async (c) => {
      const r = await c.query(`update sales_packages set opener=$3, opener_source='manual', approved_at=null, brief = jsonb_set(coalesce(brief,'{}'::jsonb), '{opener}', to_jsonb($3::text)) where id = (select id from sales_packages where lead_id=$1 and owner_id=$2 order by created_at desc, id desc limit 1) and owner_id=$2`, [id, this.owner, text]);
      if (!r.rowCount) throw new Error('Kein Verkaufspaket vorhanden');
      await this.repo.event(c, id, 'opener_edited', { actor: 'user' });
    });
  }

  // ---------- Kontaktstrategie neu berechnen (nach Sperrliste/Einstellungen) ----------
  /** Kontaktstrategie berechnen, ohne zu speichern (für die Anzeige). */
  async assess(leadId: string, c: pg.Pool | pg.PoolClient = this.pool): Promise<ContactAssessment | null> {
    const lead = (await c.query('select id, company_name, contact_blocked from leads where id=$1 and owner_id=$2', [leadId, this.owner])).rows[0];
    if (!lead) return null;
    const facts = await this.factsOf(leadId);
    const settings = await this.repo.getSettings();
    const hits = await this.repo.findSuppression(suppressionKeys(facts, lead.company_name));
    const wa = (await c.query(`select 1 from findings f join audits a on a.id=f.audit_id where a.lead_id=$1 and f.owner_id=$2 and f.code='WHATSAPP' and f.status='pass' order by a.created_at desc limit 1`, [leadId, this.owner])).rowCount! > 0;
    const audit = { checks: wa ? [{ code: 'WHATSAPP', status: 'pass' }] : [] } as never;
    return assessContact({ facts, audit, blocked: lead.contact_blocked, suppressionHits: hits, phoneEnabled: settings.phoneEnabled });
  }
  async recomputeContact(leadId: string, c: pg.Pool | pg.PoolClient = this.pool): Promise<ContactAssessment | null> {
    const a = await this.assess(leadId, c);
    if (!a) return null;
    await c.query('update leads set contact_readiness=$1, contact_channel=$2, contact_reason=$3 where id=$4 and owner_id=$5', [a.readiness, a.recommended, a.reasons[0] ?? null, leadId, this.owner]);
    return a;
  }
  async recomputeAllContact(): Promise<number> {
    const ids = (await this.pool.query("select id from leads where owner_id=$1 and status not in ('DEPLOYED','MAINTENANCE')", [this.owner])).rows.map((r) => r.id as string);
    for (const id of ids) await this.recomputeContact(id);
    return ids.length;
  }

  /** Kontakt sperren: Sperrliste + Lead blockieren + Status „zurückgestellt“ + Verlauf. */
  async markDoNotContact(leadId: string, reason: string, actor = 'user') {
    const facts = await this.factsOf(leadId);
    const lead = (await this.pool.query('select company_name from leads where id=$1 and owner_id=$2', [leadId, this.owner])).rows[0];
    if (!lead) throw new Error('Lead nicht gefunden');
    const keys = suppressionKeys(facts, lead.company_name).filter((k) => k.kind !== 'domain' || !/^(gmail|gmx|web|t-online|outlook|yahoo|mail)\./.test(k.value));
    await this.repo.tx(async (c) => {
      for (const k of keys) await this.repo.addSuppression(k.kind, k.value, reason || 'Do not contact', leadId, c);
      await c.query("update leads set contact_blocked=true, email_send_status='do_not_contact', contact_readiness=$3, contact_channel=$4, contact_reason=$5 where id=$1 and owner_id=$2", [leadId, this.owner, 'DO_NOT_CONTACT', 'DO_NOT_CONTACT', `Do not contact: ${reason || 'Wunsch des Unternehmens'}`]);
      try { await moveLead(this.repo, c, leadId, 'IGNORED', `Do not contact: ${reason || '—'}`, actor, { path: true }); } catch { /* Status passt nicht (z. B. Kunde) – Sperre bleibt */ }
      await this.repo.event(c, leadId, 'do_not_contact', { actor, reason });
      await this.afterSave?.(leadId, c);
    });
  }

  async recordContact(c: pg.PoolClient, leadId: string, e: { channel: string; direction?: string; result?: string | null; note?: string | null; callbackAt?: Date | null; actor?: string }) {
    await c.query('insert into contact_history(owner_id, lead_id, channel, direction, result, note, callback_at, actor) values ($1,$2,$3,$4,$5,$6,$7,$8)',
      [this.owner, leadId, e.channel, e.direction ?? 'outbound', e.result ?? null, e.note ? e.note.slice(0, 4000) : null, e.callbackAt ?? null, e.actor ?? 'user']);
  }

  async rowToEntry(id: string) { return (await this.pool.query('select * from leads where id=$1 and owner_id=$2', [id, this.owner])).rows[0] ?? null; }
  async snapshotOutcome(c: pg.PoolClient, leadId: string, kind: 'call' | 'stage' | 'final', value: string, payload: object) { await recordOutcome(this.repo, c, leadId, kind, value, payload); }
}

export const LEAD_DEMO_DECISIONS = ['skipped'] as const;
