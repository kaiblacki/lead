import pg from 'pg';
import { DEFAULT_LIMITS, type Limits } from '../guardrails/budget.ts';
import { norm, normPhone } from '../core/text.ts';

type Q = pg.Pool | pg.PoolClient;

export type OwnerSettings = { notifyEmail: string | null; notifyEnabled: boolean; phoneEnabled: boolean; phoneAckAt: string | null; dailyCallTarget: number; callerName: string | null; channels: Record<string, { autoSend: boolean; dailyLimit: number; platformConfirmed?: boolean; legalBasis?: string }> };
export const DEFAULT_SETTINGS: OwnerSettings = { notifyEmail: null, notifyEnabled: true, phoneEnabled: false, phoneAckAt: null, dailyCallTarget: 20, callerName: null, channels: {} };

/** Kern-Zugriff auf Postgres (Supabase). Läuft nur serverseitig; jede Abfrage ist auf owner_id beschränkt. */
export class Repo {
  pool: pg.Pool;
  ownerId: string;
  constructor(pool: pg.Pool, ownerId: string) { this.pool = pool; this.ownerId = ownerId; }

  static fromEnv(env = process.env): Repo {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL fehlt');
    if (!env.OWNER_ID) throw new Error('OWNER_ID fehlt (UUID deines Supabase-Auth-Nutzers)');
    return new Repo(new pg.Pool({ connectionString: env.DATABASE_URL, max: 6 }), env.OWNER_ID);
  }
  close() { return this.pool.end(); }

  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; }
    catch (e) { await c.query('rollback'); throw e; }
    finally { c.release(); }
  }

  /** Audit-Log-Eintrag (append-only). */
  onEvent?: (type: string, leadId: string | null, payload: Record<string, unknown>) => void;
  async event(q: Q, leadId: string | null, type: string, payload: object, quiet = false) {
    await q.query('insert into events(owner_id, lead_id, type, payload) values ($1,$2,$3,$4)', [this.ownerId, leadId, type, JSON.stringify(payload)]);
    // Hook für Benachrichtigungen: erst nach dem aktuellen Aufruf (die Transaktion ist dann i. d. R. abgeschlossen)
    if (!quiet && this.onEvent) { const h = this.onEvent; setTimeout(() => { try { h(type, leadId, payload as Record<string, unknown>); } catch { /* egal */ } }, 250); }
  }

  // ---------- Limits / Kill Switch ----------
  async getLimits(): Promise<{ limits: Limits; killSwitch: boolean }> {
    const r = await this.pool.query('select * from budgets where owner_id=$1', [this.ownerId]);
    const b = r.rows[0];
    if (!b) return { limits: DEFAULT_LIMITS, killSwitch: false };
    return { killSwitch: b.kill_switch, limits: {
      maxLeadsPerRun: b.max_leads_per_run, maxAuditsPerRun: b.max_audits_per_run, maxAiRequestsPerLead: b.max_ai_requests_per_lead,
      maxDailyCents: b.max_daily_cents, maxMonthlyCents: b.max_monthly_cents, maxPlacesRequestsPerRun: b.max_places_requests_per_run, maxCrawlPagesPerRun: b.max_crawl_pages_per_run } };
  }
  async saveLimits(l: Limits) {
    for (const [k, v] of Object.entries(l)) if (!Number.isInteger(v) || v < 0) throw new Error(`Ungültiger Wert für ${k}`);
    await this.pool.query(
      `insert into budgets(owner_id, max_leads_per_run, max_audits_per_run, max_ai_requests_per_lead, max_daily_cents, max_monthly_cents, max_places_requests_per_run, max_crawl_pages_per_run)
       values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (owner_id) do update set max_leads_per_run=$2, max_audits_per_run=$3, max_ai_requests_per_lead=$4, max_daily_cents=$5, max_monthly_cents=$6,
         max_places_requests_per_run=$7, max_crawl_pages_per_run=$8`,
      [this.ownerId, l.maxLeadsPerRun, l.maxAuditsPerRun, l.maxAiRequestsPerLead, l.maxDailyCents, l.maxMonthlyCents, l.maxPlacesRequestsPerRun, l.maxCrawlPagesPerRun]);
    await this.event(this.pool, null, 'limits_changed', { actor: 'user', limits: l });
  }
  async setKillSwitch(on: boolean) {
    await this.pool.query(`insert into budgets(owner_id, kill_switch) values ($1,$2) on conflict (owner_id) do update set kill_switch=$2`, [this.ownerId, on]);
    await this.event(this.pool, null, on ? 'kill_switch_on' : 'kill_switch_off', { actor: 'user' });
  }

  // ---------- Scoring-Konfiguration (Dateien + optionale Überschreibung in der DB) ----------
  async getScoringConfig<T extends { version: number }>(fallback: T): Promise<T> {
    const r = await this.pool.query('select config from scoring_configs where owner_id=$1 and is_active order by created_at desc limit 1', [this.ownerId]);
    const c = r.rows[0]?.config;
    return c && c.version === fallback.version && c.salesWeights && c.digitalNeedWeights ? c : fallback;
  }
  async saveScoringConfig(cfg: { version: number; digitalNeedWeights: Record<string, number>; salesWeights: Record<string, number>; thresholds: Record<string, number> }) {
    for (const group of [cfg.digitalNeedWeights, cfg.salesWeights]) for (const [k, v] of Object.entries(group)) if (typeof v !== 'number' || !(v >= 0 && v <= 1)) throw new Error(`Gewicht ${k} muss zwischen 0 und 1 liegen`);
    const t = cfg.thresholds;
    if (!(t.HOT > t.HIGH_POTENTIAL && t.HIGH_POTENTIAL > t.MEDIUM && t.MEDIUM > t.LOW && t.LOW >= 0 && t.HOT <= 100)) throw new Error('Schwellen müssen absteigend sein: HOT > HIGH > MEDIUM > LOW ≥ 0');
    await this.tx(async (c) => {
      await c.query('update scoring_configs set is_active=false where owner_id=$1', [this.ownerId]);
      await c.query('insert into scoring_configs(owner_id, config, is_active) values ($1,$2,true)', [this.ownerId, JSON.stringify(cfg)]);
      await this.event(c, null, 'scoring_changed', { actor: 'user', digitalNeedWeights: cfg.digitalNeedWeights, salesWeights: cfg.salesWeights, thresholds: cfg.thresholds });
    });
  }

  // ---------- Einstellungen ----------
  async getSettings(): Promise<OwnerSettings> {
    const r = (await this.pool.query('select * from owner_settings where owner_id=$1', [this.ownerId])).rows[0];
    if (!r) return DEFAULT_SETTINGS;
    return { phoneEnabled: r.phone_enabled, phoneAckAt: r.phone_ack_at?.toISOString?.() ?? r.phone_ack_at, dailyCallTarget: r.daily_call_target, callerName: r.caller_name, channels: r.channels ?? {}, notifyEmail: r.notify_email ?? null, notifyEnabled: r.notify_enabled ?? true };
  }
  async saveSettings(patch: Partial<Pick<OwnerSettings, 'phoneEnabled' | 'dailyCallTarget' | 'callerName' | 'channels' | 'notifyEmail' | 'notifyEnabled'>>) {
    const cur = await this.getSettings();
    const next = { ...cur, ...patch };
    if (!Number.isInteger(next.dailyCallTarget) || next.dailyCallTarget < 1 || next.dailyCallTarget > 200) throw new Error('Tägliches Call-Ziel: 1 bis 200');
    if (next.callerName && next.callerName.length > 80) throw new Error('Name ist zu lang (max. 80 Zeichen)');
    for (const [ch, cfg] of Object.entries(next.channels)) if (!['email', 'whatsapp'].includes(ch) || !Number.isInteger(cfg.dailyLimit) || cfg.dailyLimit < 0 || cfg.dailyLimit > 1000) throw new Error('Ungültige Kanal-Einstellung');
    if (next.notifyEmail && (next.notifyEmail.length > 200 || !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(next.notifyEmail))) throw new Error('Benachrichtigungs-Adresse ist ungültig');
    const enabling = next.phoneEnabled && !cur.phoneEnabled;
    await this.pool.query(
      `insert into owner_settings(owner_id, phone_enabled, phone_ack_at, daily_call_target, caller_name, channels, notify_email, notify_enabled, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8, now())
       on conflict (owner_id) do update set phone_enabled=$2, phone_ack_at=$3, daily_call_target=$4, caller_name=$5, channels=$6, notify_email=$7, notify_enabled=$8, updated_at=now()`,
      [this.ownerId, next.phoneEnabled, enabling ? new Date() : next.phoneEnabled ? cur.phoneAckAt : null, next.dailyCallTarget, next.callerName || null, JSON.stringify(next.channels), next.notifyEmail || null, next.notifyEnabled]);
    await this.event(this.pool, null, 'settings_changed', { actor: 'user', phoneEnabled: next.phoneEnabled, dailyCallTarget: next.dailyCallTarget, channels: next.channels });
    return { changedPhone: next.phoneEnabled !== cur.phoneEnabled };
  }

  // ---------- Sperrliste (Opt-out / Do-not-contact) ----------
  static normalizeSuppression(kind: string, value: string): string {
    const v = value.trim();
    if (kind === 'phone') return normPhone(v);
    if (kind === 'email') return v.toLowerCase();
    if (kind === 'domain') return v.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    return norm(v);
  }
  async listSuppression() {
    return (await this.pool.query('select id, kind, value, reason, created_at from suppression_list where owner_id=$1 order by created_at desc', [this.ownerId])).rows;
  }
  async addSuppression(kind: string, value: string, reason?: string, leadId?: string | null, q: Q = this.pool) {
    if (!['email', 'phone', 'domain', 'company'].includes(kind)) throw new Error('Ungültige Art des Eintrags');
    const v = Repo.normalizeSuppression(kind, value);
    if (!v || v.length < 3) throw new Error('Wert ist zu kurz oder ungültig');
    if ((reason ?? '').length > 300) throw new Error('Begründung ist zu lang');
    await q.query('insert into suppression_list(owner_id, kind, value, reason) values ($1,$2,$3,$4) on conflict do nothing', [this.ownerId, kind, v, reason ?? null]);
    await this.event(q, leadId ?? null, 'suppression_added', { actor: 'user', kind, reason: reason ?? null });
  }
  async removeSuppression(id: string) {
    const r = await this.pool.query('delete from suppression_list where id=$1 and owner_id=$2 returning kind', [id, this.ownerId]);
    if (!r.rowCount) throw new Error('Eintrag nicht gefunden');
    await this.event(this.pool, null, 'suppression_removed', { actor: 'user', kind: r.rows[0].kind });
  }
  async findSuppression(keys: { kind: string; value: string }[]): Promise<{ kind: string; value: string; reason: string | null }[]> {
    if (!keys.length) return [];
    const kinds = keys.map((k) => k.kind), values = keys.map((k) => Repo.normalizeSuppression(k.kind, k.value));
    const r = await this.pool.query(
      `select s.kind, s.value, s.reason from suppression_list s join unnest($2::text[], $3::text[]) as k(kind, value) on k.kind = s.kind and k.value = s.value where s.owner_id=$1`,
      [this.ownerId, kinds, values]);
    return r.rows;
  }

  // ---------- Audit-Log ----------
  async auditLog(f: { type?: string; leadId?: string; actor?: string; from?: string; to?: string; q?: string; limit?: number; offset?: number } = {}) {
    const p: unknown[] = [this.ownerId]; let where = 'e.owner_id = $1';
    if (f.type) { p.push(f.type); where += ` and e.type = $${p.length}`; }
    if (f.leadId) { p.push(f.leadId); where += ` and e.lead_id = $${p.length}`; }
    if (f.actor) { p.push(f.actor); where += ` and e.payload->>'actor' = $${p.length}`; }
    if (f.from) { p.push(f.from); where += ` and e.created_at >= $${p.length}`; }
    if (f.to) { p.push(f.to); where += ` and e.created_at < $${p.length}::date + 1`; }
    if (f.q) { p.push(`%${f.q}%`); where += ` and (l.company_name ilike $${p.length} or e.type ilike $${p.length} or e.payload::text ilike $${p.length})`; }
    const limit = Math.min(f.limit ?? 100, 1000), offset = Math.max(f.offset ?? 0, 0);
    const total = (await this.pool.query(`select count(*)::int n from events e left join leads l on l.id=e.lead_id where ${where}`, p)).rows[0].n;
    p.push(limit, offset);
    const rows = (await this.pool.query(`select e.id, e.type, e.payload, e.created_at, e.lead_id, l.company_name from events e left join leads l on l.id=e.lead_id where ${where} order by e.id desc limit $${p.length - 1} offset $${p.length}`, p)).rows;
    return { total, rows };
  }
  async eventTypes() { return (await this.pool.query('select distinct type from events where owner_id=$1 order by type', [this.ownerId])).rows.map((r) => r.type as string); }
  async recentEvents(limit = 30) {
    return (await this.pool.query('select e.type, e.payload, e.created_at, l.company_name from events e left join leads l on l.id=e.lead_id where e.owner_id=$1 order by e.id desc limit $2', [this.ownerId, limit])).rows;
  }
  async usage(runId: string | null, provider: string, operation: string, requests: number) {
    if (requests > 0) await this.pool.query('insert into provider_usage(owner_id, run_id, provider, operation, requests) values ($1,$2,$3,$4,$5)', [this.ownerId, runId, provider, operation, requests]);
  }
}
