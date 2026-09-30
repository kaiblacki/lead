import pg from 'pg';
import type { Lead } from '../core/types.ts';
import { analysisPath, transition, type Status } from '../core/status.ts';
import type { LeadReport } from '../pipeline.ts';
import type { ScoringConfig } from '../scoring/opportunity.ts';
import { DEFAULT_LIMITS, type Limits } from '../guardrails/budget.ts';
import { randomBytes } from 'node:crypto';
import type { Offer } from '../offers/generate.ts';
import { randomUUID } from 'node:crypto';
import { validateItem, type Item } from '../social/generate.ts';

type Q = pg.Pool | pg.PoolClient;

/** Zugriff auf Postgres (Supabase). Läuft nur serverseitig; jede Abfrage ist auf owner_id beschränkt. */
export class Repo {
  pool: pg.Pool;
  ownerId: string;
  constructor(pool: pg.Pool, ownerId: string) { this.pool = pool; this.ownerId = ownerId; }

  static fromEnv(env = process.env): Repo {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL fehlt');
    if (!env.OWNER_ID) throw new Error('OWNER_ID fehlt (UUID deines Supabase-Auth-Nutzers)');
    return new Repo(new pg.Pool({ connectionString: env.DATABASE_URL, max: 4 }), env.OWNER_ID);
  }
  close() { return this.pool.end(); }

  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; }
    catch (e) { await c.query('rollback'); throw e; }
    finally { c.release(); }
  }

  async event(q: Q, leadId: string | null, type: string, payload: object) {
    await q.query('insert into events(owner_id, lead_id, type, payload) values ($1,$2,$3,$4)', [this.ownerId, leadId, type, JSON.stringify(payload)]);
  }

  async createRun(industry: string, region: string, radiusKm: number | null, limit: number): Promise<string> {
    const r = await this.pool.query('insert into lead_runs(owner_id, industry, region, radius_km, run_limit, status) values ($1,$2,$3,$4,$5,$6) returning id',
      [this.ownerId, industry, region, radiusKm, limit, 'RUNNING']);
    return r.rows[0].id;
  }
  async finishRun(runId: string, status: string, counters: object) {
    await this.pool.query('update lead_runs set status=$1, counters=$2 where id=$3 and owner_id=$4', [status, JSON.stringify(counters), runId, this.ownerId]);
  }

  /** Speichert Lead, Audit, Befunde, Score und Verkaufspaket in einer Transaktion. Gibt die Lead-UUID zurück. */
  async saveReport(r: LeadReport, runId: string | null): Promise<string> {
    return this.tx(async (c) => {
      const l = r.lead;
      const up = await c.query(
        `insert into leads(owner_id, run_id, company_name, industry, address, city, region, phone, website_url, google_maps_url, opening_hours, description, socials, source, source_url, source_ref)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         on conflict (owner_id, source, source_ref) do update set company_name=excluded.company_name, industry=excluded.industry, address=excluded.address,
           city=excluded.city, phone=excluded.phone, website_url=excluded.website_url, google_maps_url=excluded.google_maps_url, socials=excluded.socials
         returning id, status`,
        [this.ownerId, runId, l.companyName, l.industry, l.address, l.city, l.region, l.phone, l.websiteUrl, l.mapsUrl, l.openingHours, l.description,
          JSON.stringify(l.socials ?? []), l.source, l.sourceUrl, l.id]);
      const leadId: string = up.rows[0].id;
      const current: Status = up.rows[0].status;

      const a = await c.query('insert into audits(owner_id, lead_id, status, scores) values ($1,$2,$3,$4) returning id',
        [this.ownerId, leadId, r.audit.status, r.audit.scores ? JSON.stringify(r.audit.scores) : null]);
      for (const f of r.audit.findings) {
        await c.query('insert into findings(owner_id, audit_id, category, code, severity, summary, evidence) values ($1,$2,$3,$4,$5,$6,$7)',
          [this.ownerId, a.rows[0].id, f.category, f.code, f.severity, f.summary, f.evidence]);
      }
      const o = r.opportunity;
      await c.query('insert into opportunities(owner_id, lead_id, audit_id, score, category, factors, why) values ($1,$2,$3,$4,$5,$6,$7)',
        [this.ownerId, leadId, a.rows[0].id, o.scored ? o.score : null, o.scored ? o.category : 'RECHECK', JSON.stringify(o.scored ? o.factors : []), o.scored ? o.why : o.reason]);
      if (r.sales) {
        const s = r.sales;
        await c.query('insert into sales_packages(owner_id, lead_id, problems, chance, offer_name, price_cents, opener, opener_source) values ($1,$2,$3,$4,$5,$6,$7,$8)',
          [this.ownerId, leadId, JSON.stringify(s.problems), s.chance, s.offerName, s.priceCents, s.opener, s.openerSource]);
      }
      const target: Status = !o.scored ? 'RECHECK' : (o.category === 'LOW' || o.category === 'IGNORE') ? 'IGNORED' : 'QUALIFIED';
      let from = current;
      for (const to of analysisPath(current, target)) {
        const ev = transition(leadId, from, to, `Analyse: ${o.scored ? `${o.category} (${o.score})` : 'nicht bewertbar'}`);
        await c.query('update leads set status=$1 where id=$2 and owner_id=$3', [to, leadId, this.ownerId]);
        await this.event(c, leadId, 'status_change', { from: ev.from, to: ev.to, reason: ev.reason, actor: 'system' });
        from = to;
      }
      await c.query('update leads set last_analyzed_at = now() where id=$1 and owner_id=$2', [leadId, this.ownerId]);
      await this.event(c, leadId, 'audit_done', { audit_id: a.rows[0].id, status: r.audit.status, findings: r.audit.findings.length, actor: 'system' });
      return leadId;
    });
  }

  async listLeads(f: { category?: string; status?: string; q?: string; limit?: number } = {}) {
    const p: unknown[] = [this.ownerId];
    let where = 'l.owner_id = $1';
    if (f.status) { p.push(f.status); where += ` and l.status = $${p.length}`; }
    if (f.category) { p.push(f.category); where += ` and o.category = $${p.length}`; }
    if (f.q) { p.push(`%${f.q}%`); where += ` and (l.company_name ilike $${p.length} or l.city ilike $${p.length})`; }
    p.push(Math.min(f.limit ?? 200, 500));
    const r = await this.pool.query(
      `select l.id, l.company_name, l.city, l.status, l.paused, l.contact_blocked, l.website_url, l.phone, l.last_analyzed_at, o.score, o.category, s.approved_at
       from leads l
       left join lateral (select score, category from opportunities where lead_id = l.id order by created_at desc, id desc limit 1) o on true
       left join lateral (select approved_at from sales_packages where lead_id = l.id order by created_at desc, id desc limit 1) s on true
       where ${where} order by o.score desc nulls last, l.created_at desc limit $${p.length}`, p);
    return r.rows;
  }

  async getLead(id: string) {
    const l = await this.pool.query('select * from leads where id=$1 and owner_id=$2', [id, this.ownerId]);
    if (!l.rows[0]) return null;
    const [opp, audit, sales, events] = await Promise.all([
      this.pool.query('select * from opportunities where lead_id=$1 and owner_id=$2 order by created_at desc, id desc limit 1', [id, this.ownerId]),
      this.pool.query('select * from audits where lead_id=$1 and owner_id=$2 order by created_at desc, id desc limit 1', [id, this.ownerId]),
      this.pool.query('select * from sales_packages where lead_id=$1 and owner_id=$2 order by created_at desc, id desc limit 1', [id, this.ownerId]),
      this.pool.query('select type, payload, created_at from events where lead_id=$1 and owner_id=$2 order by id desc limit 50', [id, this.ownerId]),
    ]);
    const findings = audit.rows[0] ? (await this.pool.query('select * from findings where audit_id=$1 and owner_id=$2', [audit.rows[0].id, this.ownerId])).rows : [];
    return { lead: l.rows[0], opportunity: opp.rows[0] ?? null, audit: audit.rows[0] ?? null, findings, sales: sales.rows[0] ?? null, events: events.rows };
  }

  /** Aufgabe aus Sicht der Pipeline: pausierte Leads werden übersprungen. */
  async isPaused(leadSource: string, sourceRef: string): Promise<boolean> {
    const r = await this.pool.query('select paused from leads where owner_id=$1 and source=$2 and source_ref=$3', [this.ownerId, leadSource, sourceRef]);
    return r.rows[0]?.paused === true;
  }

  async setPaused(id: string, paused: boolean) {
    await this.tx(async (c) => {
      const r = await c.query('update leads set paused=$1 where id=$2 and owner_id=$3', [paused, id, this.ownerId]);
      if (!r.rowCount) throw new Error('Lead nicht gefunden');
      await this.event(c, id, paused ? 'paused' : 'resumed', { actor: 'user' });
    });
  }

  async setStatus(id: string, to: Status, reason: string) {
    await this.tx(async (c) => {
      const r = await c.query('select status from leads where id=$1 and owner_id=$2 for update', [id, this.ownerId]);
      if (!r.rows[0]) throw new Error('Lead nicht gefunden');
      const ev = transition(id, r.rows[0].status, to, reason);
      await c.query('update leads set status=$1 where id=$2 and owner_id=$3', [to, id, this.ownerId]);
      await this.event(c, id, 'status_change', { from: ev.from, to: ev.to, reason: ev.reason, actor: 'user' });
    });
  }

  async approveSales(id: string) {
    await this.tx(async (c) => {
      const r = await c.query(`update sales_packages set approved_at = now() where id = (select id from sales_packages where lead_id=$1 and owner_id=$2 order by created_at desc, id desc limit 1) and owner_id=$2`, [id, this.ownerId]);
      if (!r.rowCount) throw new Error('Kein Verkaufspaket vorhanden');
      await this.event(c, id, 'sales_approved', { actor: 'user' });
    });
  }

  /** EDIT: Ein geänderter Einstieg muss erneut freigegeben werden. */
  async editOpener(id: string, opener: string) {
    const text = opener.trim();
    if (text.length < 10 || text.length > 1500) throw new Error('Gesprächseinstieg: 10 bis 1500 Zeichen');
    await this.tx(async (c) => {
      const r = await c.query(`update sales_packages set opener=$3, opener_source='manual', approved_at=null where id = (select id from sales_packages where lead_id=$1 and owner_id=$2 order by created_at desc, id desc limit 1) and owner_id=$2`, [id, this.ownerId, text]);
      if (!r.rowCount) throw new Error('Kein Verkaufspaket vorhanden');
      await this.event(c, id, 'opener_edited', { actor: 'user' });
    });
  }

  async getLimits(): Promise<{ limits: Limits; killSwitch: boolean }> {
    const r = await this.pool.query('select * from budgets where owner_id=$1', [this.ownerId]);
    const b = r.rows[0];
    if (!b) return { limits: DEFAULT_LIMITS, killSwitch: false };
    return { killSwitch: b.kill_switch, limits: {
      maxLeadsPerRun: b.max_leads_per_run, maxAuditsPerRun: b.max_audits_per_run, maxAiRequestsPerLead: b.max_ai_requests_per_lead,
      maxDailyCents: b.max_daily_cents, maxMonthlyCents: b.max_monthly_cents } };
  }
  async saveLimits(l: Limits) {
    for (const [k, v] of Object.entries(l)) if (!Number.isInteger(v) || v < 0) throw new Error(`Ungültiger Wert für ${k}`);
    await this.pool.query(
      `insert into budgets(owner_id, max_leads_per_run, max_audits_per_run, max_ai_requests_per_lead, max_daily_cents, max_monthly_cents)
       values ($1,$2,$3,$4,$5,$6) on conflict (owner_id) do update set max_leads_per_run=$2, max_audits_per_run=$3, max_ai_requests_per_lead=$4, max_daily_cents=$5, max_monthly_cents=$6`,
      [this.ownerId, l.maxLeadsPerRun, l.maxAuditsPerRun, l.maxAiRequestsPerLead, l.maxDailyCents, l.maxMonthlyCents]);
    await this.event(this.pool, null, 'limits_changed', { actor: 'user', limits: l });
  }
  async setKillSwitch(on: boolean) {
    await this.pool.query(`insert into budgets(owner_id, kill_switch) values ($1,$2) on conflict (owner_id) do update set kill_switch=$2`, [this.ownerId, on]);
    await this.event(this.pool, null, on ? 'kill_switch_on' : 'kill_switch_off', { actor: 'user' });
  }

  async getScoringConfig(fallback: ScoringConfig): Promise<ScoringConfig> {
    const r = await this.pool.query('select config from scoring_configs where owner_id=$1 and is_active order by created_at desc limit 1', [this.ownerId]);
    return r.rows[0]?.config ?? fallback;
  }
  async saveScoringConfig(cfg: ScoringConfig) {
    for (const [k, v] of Object.entries(cfg.weights)) if (!Number.isInteger(v) || v < 0 || v > 100) throw new Error(`Gewicht ${k} muss 0–100 sein`);
    await this.tx(async (c) => {
      await c.query('update scoring_configs set is_active=false where owner_id=$1', [this.ownerId]);
      await c.query('insert into scoring_configs(owner_id, config, is_active) values ($1,$2,true)', [this.ownerId, JSON.stringify(cfg)]);
      await this.event(c, null, 'scoring_changed', { actor: 'user', weights: cfg.weights });
    });
  }

  async listSuppression() {
    return (await this.pool.query('select kind, value, reason, created_at from suppression_list where owner_id=$1 order by created_at desc', [this.ownerId])).rows;
  }
  async addSuppression(kind: string, value: string, reason?: string) {
    await this.pool.query('insert into suppression_list(owner_id, kind, value, reason) values ($1,$2,lower($3),$4) on conflict do nothing', [this.ownerId, kind, value.trim(), reason ?? null]);
    await this.event(this.pool, null, 'suppression_added', { actor: 'user', kind });
  }

  /** Legt eine Demo mit geheimem Link-Token an. Setzt den Lead auf DEMO_CREATED, wenn er QUALIFIED ist. */
  async createDemo(leadId: string, template: string, html: string, validDays: number): Promise<{ id: string; token: string }> {
    return this.tx(async (c) => {
      const l = await c.query('select status from leads where id=$1 and owner_id=$2 for update', [leadId, this.ownerId]);
      if (!l.rows[0]) throw new Error('Lead nicht gefunden');
      const token = randomBytes(32).toString('hex');
      const r = await c.query('insert into demos(owner_id, lead_id, template, token, html, expires_at) values ($1,$2,$3,$4,$5, now() + ($6 || \' days\')::interval) returning id',
        [this.ownerId, leadId, template, token, html, String(validDays)]);
      if (l.rows[0].status === 'QUALIFIED') {
        const ev = transition(leadId, 'QUALIFIED', 'DEMO_CREATED', 'Demo erstellt');
        await c.query("update leads set status='DEMO_CREATED' where id=$1 and owner_id=$2", [leadId, this.ownerId]);
        await this.event(c, leadId, 'status_change', { from: ev.from, to: ev.to, reason: ev.reason, actor: 'system' });
      }
      await this.event(c, leadId, 'demo_created', { demo_id: r.rows[0].id, template, actor: 'user' });
      return { id: r.rows[0].id, token };
    });
  }
  async listDemos(leadId: string) {
    return (await this.pool.query('select id, template, token, expires_at, revoked, view_count, last_viewed_at, created_at from demos where lead_id=$1 and owner_id=$2 order by created_at desc', [leadId, this.ownerId])).rows;
  }
  async revokeDemo(demoId: string) {
    const r = await this.pool.query('update demos set revoked=true where id=$1 and owner_id=$2 returning lead_id', [demoId, this.ownerId]);
    if (!r.rowCount) throw new Error('Demo nicht gefunden');
    await this.event(this.pool, r.rows[0].lead_id, 'demo_revoked', { demo_id: demoId, actor: 'user' });
    return r.rows[0].lead_id as string;
  }
  /** Öffentlicher Abruf per Token (nur gültige, nicht widerrufene, nicht abgelaufene Demos). */
  async getDemoByToken(token: string): Promise<string | null> {
    if (!/^[0-9a-f]{64}$/.test(token)) return null;
    const r = await this.pool.query('update demos set view_count = view_count + 1, last_viewed_at = now() where token=$1 and owner_id=$2 and not revoked and expires_at > now() returning html', [token, this.ownerId]);
    return r.rows[0]?.html ?? null;
  }

  async createOffer(leadId: string, o: Offer) {
    return this.tx(async (c) => {
      const l = await c.query('select 1 from leads where id=$1 and owner_id=$2', [leadId, this.ownerId]);
      if (!l.rowCount) throw new Error('Lead nicht gefunden');
      const r = await c.query('insert into offers(owner_id, lead_id, content, price_cents, deposit_cents, final_cents, maintenance_cents) values ($1,$2,$3,$4,$5,$6,$7) returning id',
        [this.ownerId, leadId, JSON.stringify(o), o.priceCents, o.depositCents, o.finalCents, o.maintenanceCentsPerMonth]);
      await this.event(c, leadId, 'offer_created', { offer_id: r.rows[0].id, actor: 'user' });
      return r.rows[0].id as string;
    });
  }
  async latestOffer(leadId: string) {
    return (await this.pool.query('select * from offers where lead_id=$1 and owner_id=$2 order by created_at desc, id desc limit 1', [leadId, this.ownerId])).rows[0] ?? null;
  }
  async approveOffer(offerId: string) {
    const r = await this.pool.query("update offers set status='APPROVED', approved_at=now() where id=$1 and owner_id=$2 and status='DRAFT' returning lead_id", [offerId, this.ownerId]);
    if (!r.rowCount) throw new Error('Angebot nicht gefunden oder nicht im Entwurf');
    await this.event(this.pool, r.rows[0].lead_id, 'offer_approved', { offer_id: offerId, actor: 'user' });
    return r.rows[0].lead_id as string;
  }
  /** Markiert das Angebot als von dir versendet. Nur freigegebene Angebote, nur aus Status INTERESTED. */
  async markOfferSent(offerId: string) {
    return this.tx(async (c) => {
      const o = await c.query('select lead_id, status from offers where id=$1 and owner_id=$2 for update', [offerId, this.ownerId]);
      if (!o.rows[0]) throw new Error('Angebot nicht gefunden');
      if (o.rows[0].status !== 'APPROVED') throw new Error('Angebot muss zuerst freigegeben werden');
      const leadId = o.rows[0].lead_id as string;
      const l = await c.query('select status from leads where id=$1 and owner_id=$2 for update', [leadId, this.ownerId]);
      const ev = transition(leadId, l.rows[0].status, 'OFFER_SENT', 'Angebot versendet (manuell)');
      await c.query("update leads set status='OFFER_SENT' where id=$1 and owner_id=$2", [leadId, this.ownerId]);
      await c.query("update offers set status='SENT', sent_at=now() where id=$1 and owner_id=$2", [offerId, this.ownerId]);
      await this.event(c, leadId, 'status_change', { from: ev.from, to: ev.to, reason: ev.reason, actor: 'user' });
      return leadId;
    });
  }

  async createSocialPlan(leadId: string, profile: string, items: Item[]): Promise<string> {
    const planId = randomUUID();
    await this.tx(async (c) => {
      const l = await c.query('select 1 from leads where id=$1 and owner_id=$2', [leadId, this.ownerId]);
      if (!l.rowCount) throw new Error('Lead nicht gefunden');
      for (const i of items) {
        await c.query('insert into social_items(owner_id, lead_id, plan_id, profile, scheduled_for, platform, format, title, body, hashtags, notes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [this.ownerId, leadId, planId, profile, i.date, i.platform, i.format, i.title, i.body, JSON.stringify(i.hashtags), JSON.stringify(i.notes)]);
      }
      await this.event(c, leadId, 'social_plan_created', { plan_id: planId, items: items.length, profile, actor: 'user' });
    });
    return planId;
  }
  async listSocial(leadId: string) {
    return (await this.pool.query('select * from social_items where lead_id=$1 and owner_id=$2 order by scheduled_for, platform, created_at', [leadId, this.ownerId])).rows;
  }
  async setSocialStatus(id: string, status: 'APPROVED' | 'REJECTED' | 'DRAFT') {
    const cur = (await this.pool.query('select platform, body, hashtags from social_items where id=$1 and owner_id=$2', [id, this.ownerId])).rows[0];
    if (!cur) throw new Error('Eintrag nicht gefunden');
    if (status === 'APPROVED') { const e = validateItem(cur); if (e.length) throw new Error(e.join('; ')); }
    const r = await this.pool.query('update social_items set status=$1, approved_at = case when $1=\'APPROVED\' then now() else null end where id=$2 and owner_id=$3 returning lead_id', [status, id, this.ownerId]);
    await this.event(this.pool, r.rows[0].lead_id, 'social_' + status.toLowerCase(), { item_id: id, actor: 'user' });
    return r.rows[0].lead_id as string;
  }
  /** Ein geänderter Text muss erneut freigegeben werden. */
  async editSocial(id: string, title: string, body: string) {
    if (!title.trim() || !body.trim()) throw new Error('Titel und Text dürfen nicht leer sein');
    const r = await this.pool.query("update social_items set title=$1, body=$2, status='DRAFT', approved_at=null where id=$3 and owner_id=$4 returning lead_id", [title.trim().slice(0, 200), body.slice(0, 20000), id, this.ownerId]);
    if (!r.rowCount) throw new Error('Eintrag nicht gefunden');
    return r.rows[0].lead_id as string;
  }

  async recentEvents(limit = 30) {
    return (await this.pool.query('select e.type, e.payload, e.created_at, l.company_name from events e left join leads l on l.id=e.lead_id where e.owner_id=$1 order by e.id desc limit $2', [this.ownerId, limit])).rows;
  }
}

export type { Lead };
