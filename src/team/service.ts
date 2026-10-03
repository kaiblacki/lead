import type { Repo } from '../db/repo.ts';
import { startOfBerlinDay } from '../core/time.ts';
import { UserError } from '../dashboard/types.ts';
import { hashPassword, normLogin, verifyPassword } from './auth.ts';
import { METRICS, RESULT_BY_KEY, ROLES, STAFF_STATUSES, HANDOFF_REASONS, type ResultKey, type Role, type SessionUser, type ContactStatus } from './rules.ts';

const clean = (v: unknown, max: number) => { const t = String(v ?? '').trim(); return t ? t.slice(0, max) : null; };
const list = (v: unknown) => String(v ?? '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 30);
const intIn = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) && v !== '' && v !== null && v !== undefined ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
export const LOCK_MINUTES = 30;
const ASSIGNABLE_STATUS = ['QUALIFIED', 'DEMO_CREATED', 'CONTACTED', 'REPLIED', 'INTERESTED'];

export type AssignFilter = { industry?: string; region?: string; radiusKm?: number; priorities?: string[]; website?: string; minOpportunity?: number; partnerPotential?: string[]; contactability?: string[]; limit?: number };
export type StatsFilter = { userId?: string; from?: Date; to?: Date; industry?: string; region?: string; campaignId?: string; playbook?: string; channel?: string; result?: string; leadStatus?: string; priority?: string };

/** Benutzer, Zuweisung, Sperren, Kontaktversuche, Übergaben, Kampagnen, Kennzahlen und Audit der Mitarbeiter. Sendet nie Nachrichten. */
export class TeamService {
  repo: Repo; now: () => Date; calls: any; engine: any; growth: any; copilot: any;
  constructor(o: { repo: Repo; now?: () => Date; calls?: any; engine?: any; growth?: any }) { this.repo = o.repo; this.now = o.now ?? (() => new Date()); this.calls = o.calls; this.engine = o.engine; this.growth = o.growth; }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }

  // ---- Audit ---------------------------------------------------------------------------------------------------------------------------------
  async audit(u: SessionUser, event: string, leadId: string | null = null, meta: Record<string, unknown> = {}) {
    await this.pool.query('insert into team_audit(owner_id, at, user_id, user_name, role, event, lead_id, meta) values ($1,$2,$3,$4,$5,$6,$7,$8)', [this.owner, this.now(), u.id, u.name, u.role, event, leadId, JSON.stringify(meta)]);
  }
  async auditList(o: { userId?: string; leadId?: string; event?: string; limit?: number } = {}) {
    const p: unknown[] = [this.owner]; let w = 'owner_id = $1'; if (o.userId) { p.push(o.userId); w += ` and user_id = $${p.length}`; } if (o.leadId) { p.push(o.leadId); w += ` and lead_id = $${p.length}`; } if (o.event) { p.push(o.event); w += ` and event = $${p.length}`; }
    p.push(Math.min(o.limit ?? 100, 500)); return (await this.pool.query(`select * from team_audit where ${w} order by at desc, id desc limit $${p.length}`, p)).rows;
  }

  // ---- Benutzer ------------------------------------------------------------------------------------------------------------------------------
  async users() { return (await this.pool.query('select id, name, login, role, status, active_since, team, industries, regions, preferred_categories, goal_calls, goal_reached, goal_qualified, goal_followups, admin_notes, last_login_at, last_activity_at from staff_users where owner_id = $1 order by status, name', [this.owner])).rows; }
  async user(id: string) { return (await this.pool.query('select id, name, login, role, status, active_since, team, industries, regions, preferred_categories, goal_calls, goal_reached, goal_qualified, goal_followups, admin_notes, last_login_at, last_activity_at from staff_users where id = $1 and owner_id = $2', [id, this.owner])).rows[0] ?? null; }
  async createUser(f: Record<string, unknown>, by: SessionUser): Promise<string> {
    const name = clean(f.name, 120); const login = normLogin(String(f.login ?? '')); const role = String(f.role ?? 'SALES');
    if (!name) throw new UserError('Bitte einen Namen angeben.'); if (!/^[a-z0-9._@-]{2,80}$/.test(login)) throw new UserError('Login: 2–80 Zeichen (Buchstaben, Ziffern, . _ @ -).');
    if (!(ROLES as readonly string[]).includes(role)) throw new UserError('Unbekannte Rolle.');
    let hash: string; try { hash = hashPassword(String(f.password ?? '')); } catch (e) { throw new UserError((e as Error).message); }
    if ((await this.pool.query('select 1 from staff_users where owner_id = $1 and login = $2', [this.owner, login])).rowCount) throw new UserError('Dieser Login ist bereits vergeben.');
    const r = await this.pool.query(`insert into staff_users(owner_id, name, login, password_hash, role, team, industries, regions, preferred_categories) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [this.owner, name, login, hash, role, clean(f.team, 80), list(f.industries), list(f.regions), list(f.preferred_categories)]);
    await this.audit(by, 'USER_CREATED', null, { user: r.rows[0].id, role }); return r.rows[0].id as string;
  }
  async updateUser(id: string, f: Record<string, unknown>, by: SessionUser) {
    const u = await this.user(id); if (!u) throw new UserError('Mitarbeiter nicht gefunden.');
    const role = f.role ? String(f.role) : u.role; const status = f.status ? String(f.status) : u.status;
    if (!(ROLES as readonly string[]).includes(role)) throw new UserError('Unbekannte Rolle.'); if (!(STAFF_STATUSES as readonly string[]).includes(status)) throw new UserError('Unbekannter Status.');
    await this.pool.query('update staff_users set name = coalesce($3, name), role = $4, status = $5, team = $6, industries = $7, regions = $8, preferred_categories = $9, admin_notes = $10 where id = $1 and owner_id = $2',
      [id, this.owner, clean(f.name, 120), role, status, clean(f.team, 80), list(f.industries), list(f.regions), list(f.preferred_categories), clean(f.admin_notes, 4000)]);
    if (f.password) { let h: string; try { h = hashPassword(String(f.password)); } catch (e) { throw new UserError((e as Error).message); } await this.pool.query('update staff_users set password_hash = $3 where id = $1 and owner_id = $2', [id, this.owner, h]); }
    await this.audit(by, 'USER_UPDATED', null, { user: id, role, status });
  }
  async setGoals(id: string, f: Record<string, unknown>, by: SessionUser) {
    await this.pool.query('update staff_users set goal_calls = $3, goal_reached = $4, goal_qualified = $5, goal_followups = $6 where id = $1 and owner_id = $2', [id, this.owner, intIn(f.goal_calls, 0, 1000, 40), intIn(f.goal_reached, 0, 1000, 12), intIn(f.goal_qualified, 0, 1000, 5), intIn(f.goal_followups, 0, 1000, 6)]);
    await this.audit(by, 'GOALS_SET', null, { user: id });
  }
  /** Anmeldung per Basic-Auth: Login + Passwort eines aktiven Mitarbeiters. Deaktivierte können sich nicht anmelden. */
  async authenticate(login: string, password: string): Promise<SessionUser | null> {
    const r = (await this.pool.query('select id, name, role, status, password_hash from staff_users where owner_id = $1 and login = $2', [this.owner, normLogin(login)])).rows[0];
    if (!r || r.status === 'DISABLED' || !verifyPassword(password, r.password_hash)) return null;
    return { id: r.id, name: r.name, role: r.role as Role };
  }
  /** Letzte Aktivität (höchstens je Minute) und LOGIN-Audit (höchstens alle 30 Minuten) festhalten. */
  async touch(u: SessionUser) {
    if (!u.id) return; const now = this.now();
    const r = (await this.pool.query('select last_login_at, last_activity_at from staff_users where id = $1', [u.id])).rows[0]; if (!r) return;
    if (!r.last_activity_at || now.getTime() - new Date(r.last_activity_at).getTime() > 60_000) await this.pool.query('update staff_users set last_activity_at = $2 where id = $1', [u.id, now]);
    if (!r.last_login_at || now.getTime() - new Date(r.last_login_at).getTime() > 30 * 60_000) { await this.pool.query('update staff_users set last_login_at = $2 where id = $1', [u.id, now]); await this.audit(u, 'LOGIN'); }
  }

  // ---- Zuweisung -----------------------------------------------------------------------------------------------------------------------------
  private candidateSql(f: AssignFilter) {
    const p: unknown[] = [this.owner]; let w = `l.owner_id = $1 and l.assignment_status in ('UNASSIGNED','RETURNED') and not l.paused and l.contact_readiness <> 'DO_NOT_CONTACT' and not coalesce(l.contact_blocked, false) and l.status = any($2)`; p.push(ASSIGNABLE_STATUS);
    const add = (sql: string, v: unknown) => { p.push(v); w += ` and ${sql.replaceAll('?', `$${p.length}`)}`; };
    if (f.industry) add('(l.sub_industry ilike ? or l.industry ilike ?)', `%${f.industry}%`);
    if (f.region) add('(l.city ilike ? or l.region ilike ?)', `%${f.region}%`);
    if (f.radiusKm) add('l.distance_km <= ?', f.radiusKm);
    if (f.priorities?.length) add('l.effective_priority = any(?)', f.priorities);
    if (f.website === 'none') w += " and l.website_state = 'none'"; else if (f.website === 'weak') w += " and l.website_state in ('none','needs_improvement')";
    if (f.minOpportunity) add("coalesce((l.growth_scores->>'salesOpportunity')::int, 0) >= ?", f.minOpportunity);
    if (f.partnerPotential?.length) add('l.partnership_potential = any(?)', f.partnerPotential);
    if (f.contactability?.length) add('l.contactability = any(?)', f.contactability);
    return { w, p };
  }
  async preview(f: AssignFilter): Promise<number> { const { w, p } = this.candidateSql(f); return (await this.pool.query(`select count(*)::int n from leads l where ${w}`, p)).rows[0].n; }
  async assignBatch(f: AssignFilter, userIds: string[], by: SessionUser, o: { source?: 'BATCH_ASSIGNMENT' | 'ROUND_ROBIN'; campaignId?: string | null } = {}): Promise<{ assigned: number; perUser: Record<string, number> }> {
    if (!userIds.length) throw new UserError('Bitte mindestens einen Mitarbeiter wählen.');
    const users = await Promise.all(userIds.map((id) => this.user(id))); for (const u of users) { if (!u) throw new UserError('Mitarbeiter nicht gefunden.'); if (u.status !== 'ACTIVE') throw new UserError(`${u.name} ist nicht aktiv – es werden keine Leads zugewiesen.`); }
    const limit = Math.min(Math.max(1, f.limit ?? 50), 1000); const { w, p } = this.candidateSql(f);
    const ids: string[] = (await this.pool.query(`select l.id from leads l where ${w} order by l.action_priority desc nulls last, l.created_at limit ${limit}`, p)).rows.map((r) => r.id);
    const per: Record<string, number> = {}; const source = users.length > 1 || o.source === 'ROUND_ROBIN' ? 'ROUND_ROBIN' : o.source ?? 'BATCH_ASSIGNMENT';
    for (let i = 0; i < ids.length; i++) { const u = users[i % users.length]!; await this.assignRow(ids[i], u.id, by, source, o.campaignId ?? null); per[u.id] = (per[u.id] ?? 0) + 1; }
    if (o.campaignId) await this.pool.query('update campaigns set assigned_count = assigned_count + $2 where id = $1', [o.campaignId, ids.length]);
    await this.audit(by, 'LEAD_ASSIGNED', null, { count: ids.length, source, users: userIds, campaign: o.campaignId ?? null });
    await this.growth?.refresh?.();
    return { assigned: ids.length, perUser: per };
  }
  private async assignRow(leadId: string, userId: string, by: SessionUser, source: string, campaignId: string | null) {
    await this.pool.query(`update leads set assigned_to_user_id = $3, assigned_at = $4, assigned_by = $5, assignment_source = $6, assignment_status = 'ASSIGNED', working_user_id = null, locked_at = null, lock_expires_at = null, campaign_id = coalesce($7, campaign_id) where id = $1 and owner_id = $2`, [leadId, this.owner, userId, this.now(), by.name, source, campaignId]);
  }
  async assignOne(leadId: string, userId: string, by: SessionUser) {
    const u = await this.user(userId); if (!u || u.status !== 'ACTIVE') throw new UserError('Mitarbeiter ist nicht aktiv.');
    const l = (await this.pool.query('select contact_readiness from leads where id = $1 and owner_id = $2', [leadId, this.owner])).rows[0]; if (!l) throw new UserError('Lead nicht gefunden.');
    if (l.contact_readiness === 'DO_NOT_CONTACT') throw new UserError('Gesperrte Leads werden nicht zugewiesen.');
    await this.assignRow(leadId, userId, by, 'MANUAL', null); await this.audit(by, 'LEAD_ASSIGNED', leadId, { to: userId, source: 'MANUAL' });
  }
  async unassign(leadId: string, by: SessionUser, reason = 'RETURNED') {
    await this.pool.query(`update leads set assigned_to_user_id = null, assignment_status = $3, working_user_id = null, locked_at = null, lock_expires_at = null where id = $1 and owner_id = $2`, [leadId, this.owner, reason === 'RETURNED' ? 'RETURNED' : 'UNASSIGNED']);
    await this.audit(by, 'LEAD_RETURNED', leadId, {});
  }
  async leadAssignmentOf(leadId: string) { return (await this.pool.query(`select l.assigned_to_user_id, l.assigned_at, l.assigned_by, l.assignment_source, l.assignment_status, l.working_user_id, l.lock_expires_at, l.contact_status, s.name as assignee from leads l left join staff_users s on s.id = l.assigned_to_user_id where l.id = $1 and l.owner_id = $2`, [leadId, this.owner])).rows[0] ?? null; }

  // ---- Sperren (Doppelbearbeitung verhindern) ------------------------------------------------------------------------------------------------
  /** Liefert { ok:true } und setzt/verlängert die Sperre – oder { ok:false, by } wenn jemand anderes gerade arbeitet. Sperren laufen nach 30 Minuten ab. */
  async acquireLock(leadId: string, u: SessionUser): Promise<{ ok: boolean; by?: string }> {
    const now = this.now(); const exp = new Date(now.getTime() + LOCK_MINUTES * 60_000);
    const r = await this.pool.query(`update leads l set working_user_id = $3, locked_at = $4, lock_expires_at = $5 where l.id = $1 and l.owner_id = $2 and (l.working_user_id is null or l.working_user_id is not distinct from $3 or l.lock_expires_at is null or l.lock_expires_at <= $4) returning l.id`, [leadId, this.owner, u.id, now, exp]);
    if (r.rowCount) return { ok: true };
    const w = (await this.pool.query('select s.name from leads l join staff_users s on s.id = l.working_user_id where l.id = $1', [leadId])).rows[0]; return { ok: false, by: w?.name ?? 'einem anderen Mitarbeiter' };
  }
  async releaseLock(leadId: string, u: SessionUser) { await this.pool.query('update leads set working_user_id = null, locked_at = null, lock_expires_at = null where id = $1 and owner_id = $2 and working_user_id is not distinct from $3', [leadId, this.owner, u.id]); }
  async adminUnlock(leadId: string, by: SessionUser) { await this.pool.query('update leads set working_user_id = null, locked_at = null, lock_expires_at = null where id = $1 and owner_id = $2', [leadId, this.owner]); await this.audit(by, 'LOCK_RELEASED', leadId, {}); }

  /** Darf diese Person den Lead im Arbeitsplatz bearbeiten? Admin/Teamleitung: ja; Vertrieb: nur eigene. */
  async mayWork(u: SessionUser, leadId: string): Promise<boolean> {
    if (u.role !== 'SALES') return true; const r = (await this.pool.query('select assigned_to_user_id from leads where id = $1 and owner_id = $2', [leadId, this.owner])).rows[0]; return !!r && r.assigned_to_user_id === u.id;
  }

  // ---- Arbeitsplatz ---------------------------------------------------------------------------------------------------------------------------
  private mineWhere(userId: string) { return `l.owner_id = $1 and l.assigned_to_user_id = $2`; }
  async myDay(userId: string) {
    const now = this.now();
    const r = (await this.pool.query(`select
        count(*) filter (where l.assignment_status = 'ASSIGNED' and l.call_count = 0)::int as new_leads,
        count(*) filter (where l.callback_at is not null and l.callback_at <= $3 and l.assignment_status in ('ASSIGNED','IN_PROGRESS'))::int as callbacks,
        count(*) filter (where l.contact_status = 'INTERESTED' and l.assignment_status in ('ASSIGNED','IN_PROGRESS'))::int as interested,
        count(*) filter (where l.assignment_status in ('ASSIGNED','IN_PROGRESS'))::int as open_leads,
        count(*) filter (where exists (select 1 from demos d where d.lead_id = l.id and not d.revoked) and l.assignment_status in ('ASSIGNED','IN_PROGRESS'))::int as demo_follow
      from leads l where ${this.mineWhere(userId)}`, [this.owner, userId, new Date(now.getTime() + 0)])).rows[0];
    const tasks = (await this.pool.query(`select count(*) filter (where t.due_at <= $3)::int as due, count(*)::int as open from tasks t join leads l on l.id = t.lead_id where l.owner_id = $1 and l.assigned_to_user_id = $2 and t.status = 'OPEN' and not t.for_admin`, [this.owner, userId, now])).rows[0];
    return { ...r, dueTasks: tasks.due as number, openTasks: tasks.open as number };
  }
  async progress(userId: string, from = startOfDay(this.now()), to = new Date(from.getTime() + 86400000)) {
    const m = await this.metricsFor({ userId, from, to }); const row = m[0] ?? {}; const u = await this.user(userId);
    const fu = (await this.pool.query(`select count(*)::int n from tasks t join leads l on l.id = t.lead_id where l.assigned_to_user_id = $1 and t.status = 'DONE' and t.done_at >= $2 and t.done_at < $3 and not t.for_admin`, [userId, from, to])).rows[0].n as number;
    return { calls: row.calls ?? 0, reached: row.reached ?? 0, qualified: row.qualified ?? 0, followups: fu, goals: { calls: u?.goal_calls ?? 0, reached: u?.goal_reached ?? 0, qualified: u?.goal_qualified ?? 0, followups: u?.goal_followups ?? 0 } };
  }
  private myLeadsWhere(f: string) {
    switch (f) {
      case 'today': return "(l.callback_at <= now() + interval '0 minutes' or l.call_count = 0) and l.assignment_status in ('ASSIGNED','IN_PROGRESS')";
      case 'new': return "l.assignment_status = 'ASSIGNED' and l.call_count = 0";
      case 'callbacks': return "l.callback_at is not null and l.assignment_status in ('ASSIGNED','IN_PROGRESS')";
      case 'noanswer': return "l.contact_status = 'CONTACT_ATTEMPTED'";
      case 'interested': return "l.contact_status in ('INTERESTED','QUALIFIED') and l.assignment_status in ('ASSIGNED','IN_PROGRESS')";
      case 'demo': return "exists (select 1 from demos d where d.lead_id = l.id and not d.revoked)";
      case 'handoff': return "l.assignment_status = 'TRANSFERRED'";
      case 'done': return "l.assignment_status in ('COMPLETED','TRANSFERRED') or l.contact_status in ('NO_INTEREST','DO_NOT_CONTACT')";
      default: return "l.assignment_status in ('ASSIGNED','IN_PROGRESS')";
    }
  }
  async myLeads(userId: string, filter = 'open', limit = 100) {
    return (await this.pool.query(`select l.id, l.company_name, l.city, l.sub_industry, l.industry, l.phone, l.effective_priority, l.action_priority, l.contact_status, l.assignment_status, l.callback_at, l.call_count, l.last_contact_at, l.next_step, l.assigned_at, l.working_user_id, l.lock_expires_at, s.name as working_name
      from leads l left join staff_users s on s.id = l.working_user_id where ${this.mineWhere(userId)} and (${this.myLeadsWhere(filter)}) order by l.callback_at nulls last, l.action_priority desc nulls last, l.created_at limit $3`, [this.owner, userId, limit])).rows;
  }
  /** Nächster sinnvoller Lead: fällige Rückrufe → noch nicht versuchte nach Handlungspriorität/Priorität → nichts Gesperrtes, nichts mit Rückruf in der Zukunft. Nur zum Anruf freigegebene Leads. */
  async nextLead(u: SessionUser, excludeId?: string): Promise<string | null> {
    const now = this.now();
    const r = (await this.pool.query(`select l.id from leads l where l.owner_id = $1 and l.assigned_to_user_id = $2 and l.assignment_status in ('ASSIGNED','IN_PROGRESS') and not l.paused
        and l.contact_readiness = 'READY_FOR_MANUAL_CALL' and l.phone is not null and (l.callback_at is null or l.callback_at <= $3) and ($4::uuid is null or l.id <> $4)
        and (l.working_user_id is null or l.working_user_id = $2 or l.lock_expires_at <= $3)
      order by (l.callback_at is not null) desc, l.callback_at, (select count(*) from tasks t where t.lead_id = l.id and t.status = 'OPEN' and t.due_at <= $3 and not t.for_admin) desc,
        case l.effective_priority when 'A' then 0 when 'B' then 1 when 'C' then 2 else 3 end, l.action_priority desc nulls last, l.assigned_at limit 1`, [this.owner, u.id, now, excludeId ?? null])).rows[0];
    return r?.id ?? null;
  }
  async phoneEnabled(): Promise<boolean> { return !!(await this.repo.getSettings()).phoneEnabled; }
  /** Kontaktfreigabe je Lead (abgeleitet, nie automatisch erlaubt): CALL_APPROVED nur bei freigegebener Telefonakquise UND bereitem Lead. */
  async permissions(leadId: string): Promise<string[]> {
    const l = (await this.pool.query('select contact_readiness, contact_blocked, email from leads where id = $1 and owner_id = $2', [leadId, this.owner])).rows[0]; if (!l) return ['CONTACT_REVIEW_REQUIRED'];
    if (l.contact_readiness === 'DO_NOT_CONTACT' || l.contact_blocked) return ['DO_NOT_CONTACT'];
    const out: string[] = []; if (l.contact_readiness === 'READY_FOR_MANUAL_CALL' && (await this.phoneEnabled())) out.push('CALL_APPROVED');
    const consent = (await this.pool.query("select 1 from contact_history where lead_id = $1 and owner_id = $2 and result = 'CONSENT_EMAIL' limit 1", [leadId, this.owner])).rowCount; if (consent) out.push('EMAIL_PERMISSION');
    return out.length ? out : ['CONTACT_REVIEW_REQUIRED'];
  }

  // ---- Kontaktversuche -----------------------------------------------------------------------------------------------------------------------
  async attemptsForLead(leadId: string) { return (await this.pool.query('select * from contact_attempts where lead_id = $1 and owner_id = $2 order by started_at desc, created_at desc', [leadId, this.owner])).rows; }
  async attemptsForUser(userId: string, limit = 50) { return (await this.pool.query('select a.*, l.company_name from contact_attempts a join leads l on l.id = a.lead_id where a.user_id = $1 and a.owner_id = $2 order by a.started_at desc limit $3', [userId, this.owner, limit])).rows; }
  private async insertAttempt(u: SessionUser, leadId: string, a: { channel: string; status?: string; result: string; note?: string | null; nextAction?: string | null; nextAt?: Date | null; playbook?: string | null; started?: Date }) {
    const camp = (await this.pool.query('select campaign_id from leads where id = $1', [leadId])).rows[0]?.campaign_id ?? null; const now = this.now();
    const r = await this.pool.query(`insert into contact_attempts(owner_id, lead_id, user_id, user_name, channel, status, started_at, ended_at, result, note, next_action, next_action_at, campaign_id, playbook_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
      [this.owner, leadId, u.id, u.name, a.channel, a.status ?? 'DONE', a.started ?? now, now, a.result, a.note ?? null, a.nextAction ?? null, a.nextAt ?? null, camp, a.playbook ?? null]);
    return r.rows[0].id as string;
  }
  /** Hook für die bestehende Anruf-Pipeline (Admin-Ablauf): jeder Anruf landet auch als Kontaktversuch. */
  async sink(a: { leadId: string; call: string; note?: string | null; callbackAt?: Date | null; actor?: SessionUser | null }) {
    const MAP: Record<string, ResultKey | string> = { NO_ANSWER: 'NO_ANSWER', NO_INTEREST: 'NO_INTEREST', CALL_BACK: 'CALL_BACK', INTERESTED: 'WEBSITE_INTEREST', DEMO: 'DEMO_WANTED', NEEDS_ANALYSIS: 'NEEDS_ANALYSIS', PARTNERSHIP: 'PARTNER_INTEREST', MULTIPLE: 'MULTIPLE_TOPICS', OFFER: 'OFFER_REQUESTED', DO_NOT_CONTACT: 'DO_NOT_CONTACT' };
    const key = MAP[a.call] ?? a.call; const u = a.actor ?? { id: null, name: 'Admin', role: 'ADMIN' as Role };
    await this.insertAttempt(u, a.leadId, { channel: 'PHONE', result: key, note: a.note ?? null, nextAction: (RESULT_BY_KEY as Record<string, { next: string } | undefined>)[key]?.next ?? null, nextAt: a.callbackAt ?? null });
    const st = (RESULT_BY_KEY as Record<string, { status: ContactStatus } | undefined>)[key]?.status; if (st) await this.pool.query('update leads set contact_status = $3 where id = $1 and owner_id = $2', [a.leadId, this.owner, st]);
  }
  /** Anrufergebnis (Mitarbeiter-Arbeitsplatz). Reihenfolge: Prüfung → bestehende Pipeline (Status, Aufgaben) → Kontaktversuch → Lead-Status → Audit. Demo/Angebot werden NICHT erstellt, sondern als Aufgabe für Kai vorgemerkt. */
  async recordResult(u: SessionUser, leadId: string, key: string, o: { note?: string; callbackAt?: Date | null; topics?: string[]; playbook?: string | null; handoff?: { reason: string; interest?: string; nextStep?: string } } = {}): Promise<{ message: string; next: string }> {
    const def = (RESULT_BY_KEY as Record<string, (typeof RESULT_BY_KEY)[ResultKey] | undefined>)[key]; if (!def) throw new UserError('Unbekanntes Ergebnis.');
    if (!(await this.mayWork(u, leadId))) throw new UserError('Dieser Lead ist dir nicht zugewiesen.');
    const lk = await this.acquireLock(leadId, u); if (!lk.ok) throw new UserError(`Wird gerade von ${lk.by} bearbeitet.`);
    const perm = await this.permissions(leadId); if (perm[0] === 'DO_NOT_CONTACT') throw new UserError('Dieser Lead ist gesperrt (Do not contact).');
    if (!perm.includes('CALL_APPROVED')) throw new UserError('Für diesen Lead ist kein Anruf freigegeben (Kontaktfreigabe oder Telefonakquise fehlt).');
    const note = clean(o.note, 4000); if (def.needsNote && !note) throw new UserError('Bitte eine Notiz speichern: was wurde besprochen, was soll passieren?');
    if (key === 'CALL_BACK' && !o.callbackAt) throw new UserError('Für den Rückruf bitte Datum und Uhrzeit wählen.');
    const lead = (await this.pool.query('select company_name, call_count, campaign_id from leads where id = $1', [leadId])).rows[0];
    let message = 'Gespräch gespeichert.';
    if (key === 'HANDOFF') { await this.createHandoff(u, leadId, { reason: o.handoff?.reason ?? 'SONDERFALL', note: note!, interest: o.handoff?.interest, nextStep: o.handoff?.nextStep, callbackAt: o.callbackAt ?? null, playbook: o.playbook ?? null }); return { message: 'Lead wurde an Kai übergeben.', next: def.next }; }
    if (def.call) {
      const out = await this.calls.applyResult(leadId, def.call, { note: note ?? '', callbackAt: o.callbackAt ?? null, topics: o.topics ?? [], actor: u, skipAttempt: true });
      void out; if (key === 'CALL_BACK') message = `Rückruf für ${o.callbackAt!.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' })} gespeichert.`;
    } else {   // REACHED
      await this.pool.query('update leads set call_count = call_count + 1, last_contact_at = $3 where id = $1 and owner_id = $2', [leadId, this.owner, this.now()]);
    }
    if (def.adminTask) { await this.engine.create({ type: def.adminTask, title: `${def.adminTask === 'PREPARE_DEMO' ? 'Demo prüfen/erstellen' : 'Angebot vorbereiten'}: ${lead.company_name} (Wunsch von ${u.name})`, dueAt: this.now(), priority: 'HIGH', leadId, source: 'system', notes: note ?? undefined }).catch((e: Error) => { void e; return null; }); await this.pool.query("update tasks set for_admin = true where lead_id = $1 and type = $2 and status = 'OPEN'", [leadId, def.adminTask]); await this.audit(u, 'TASK_CREATED', leadId, { type: def.adminTask }); }
    const done = ['NO_INTEREST', 'DO_NOT_CONTACT'].includes(key);
    await this.insertAttempt(u, leadId, { channel: 'PHONE', result: key, note, nextAction: def.next, nextAt: o.callbackAt ?? null, playbook: o.playbook ?? null });
    await this.pool.query(`update leads set contact_status = $3, assignment_status = $4, next_step = coalesce($5, next_step) where id = $1 and owner_id = $2`, [leadId, this.owner, def.status, done ? 'COMPLETED' : 'IN_PROGRESS', def.next]);
    await this.releaseLock(leadId, u);
    await this.audit(u, 'CONTACT_ATTEMPT', leadId, { channel: 'PHONE', result: key }); await this.audit(u, 'CALL_RESULT', leadId, { result: key }); if (note) await this.audit(u, 'NOTE_ADDED', leadId, {}); if (key === 'DEMO_WANTED') await this.audit(u, 'DEMO_REQUESTED', leadId, {});
    if (key === 'CALL_BACK' || key === 'NO_ANSWER') await this.audit(u, 'TASK_CREATED', leadId, { type: key === 'CALL_BACK' ? 'CALLBACK' : 'CALL_RETRY' });
    void lead; return { message, next: def.next };
  }
  /** E-Mail: Entwurf speichern (DRAFT) oder – nur nach ausdrücklicher Bestätigung und vorhandener Freigabe – als SELBST versendet vermerken (SENT). Das System sendet nie. */
  async recordEmail(u: SessionUser, leadId: string, mode: 'DRAFT' | 'SENT', o: { note?: string; confirmed?: boolean } = {}) {
    if (!(await this.mayWork(u, leadId))) throw new UserError('Dieser Lead ist dir nicht zugewiesen.');
    const perm = await this.permissions(leadId); if (perm[0] === 'DO_NOT_CONTACT') throw new UserError('Dieser Lead ist gesperrt (Do not contact).');
    const l = (await this.pool.query('select email from leads where id = $1', [leadId])).rows[0]; const hasMail = l?.email || (await this.pool.query("select 1 from lead_facts where lead_id = $1 and key = 'email'", [leadId])).rowCount;
    if (!hasMail) throw new UserError('Keine öffentliche geschäftliche E-Mail-Adresse bekannt.');
    if (mode === 'SENT') {
      if (!perm.includes('EMAIL_PERMISSION')) throw new UserError('Keine E-Mail-Freigabe (dokumentierte Einwilligung/Rechtsgrundlage) – Versand nicht vermerkbar.');
      if (!o.confirmed) throw new UserError('Bitte bestätigen, dass du die E-Mail selbst versendet hast.');
    }
    const note = clean(o.note, 4000); await this.insertAttempt(u, leadId, { channel: 'EMAIL', status: mode, result: mode === 'SENT' ? 'EMAIL_SENT' : 'EMAIL_DRAFT', note, nextAction: mode === 'SENT' ? 'Antwort abwarten / nachfassen' : 'Entwurf prüfen und selbst senden' });
    if (mode === 'SENT') await this.pool.query("update leads set contact_status = case when contact_status = 'NOT_CONTACTED' then 'CONTACT_ATTEMPTED' else contact_status end, last_contact_at = $3 where id = $1 and owner_id = $2", [leadId, this.owner, this.now()]);
    await this.audit(u, mode === 'SENT' ? 'EMAIL_SENT_MARKED' : 'EMAIL_DRAFTED', leadId, {}); if (note) await this.audit(u, 'NOTE_ADDED', leadId, {});
  }
  async addNote(u: SessionUser, leadId: string, text: string) {
    if (!(await this.mayWork(u, leadId))) throw new UserError('Dieser Lead ist dir nicht zugewiesen.'); const n = clean(text, 4000); if (!n) throw new UserError('Notiz ist leer.');
    await this.insertAttempt(u, leadId, { channel: 'OTHER', result: 'NOTE', note: n }); await this.audit(u, 'NOTE_ADDED', leadId, {});
  }

  // ---- Übergaben -----------------------------------------------------------------------------------------------------------------------------
  async createHandoff(u: SessionUser, leadId: string, o: { reason: string; note: string; interest?: string; nextStep?: string; callbackAt?: Date | null; playbook?: string | null }) {
    if (!(HANDOFF_REASONS as readonly string[]).includes(o.reason)) throw new UserError('Bitte einen Übergabegrund wählen.'); if (!clean(o.note, 4000)) throw new UserError('Bitte eine Notiz zur Übergabe schreiben.');
    const l = (await this.pool.query(`select l.company_name, l.last_contact_at, (select value from lead_facts f where f.lead_id = l.id and f.key = 'contactPerson' order by captured_at desc limit 1) as person, (select result from contact_attempts a where a.lead_id = l.id order by started_at desc limit 1) as last_result from leads l where l.id = $1 and l.owner_id = $2`, [leadId, this.owner])).rows[0]; if (!l) throw new UserError('Lead nicht gefunden.');
    const r = await this.pool.query(`insert into handoffs(owner_id, lead_id, from_user_id, from_name, reason, company_name, contact_person, last_contact_at, last_result, note, interest, callback_wanted_at, next_step) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [this.owner, leadId, u.id, u.name, o.reason, l.company_name, l.person, l.last_contact_at, l.last_result, o.note.trim(), clean(o.interest, 300), o.callbackAt ?? null, clean(o.nextStep, 300)]);
    await this.insertAttempt(u, leadId, { channel: 'PHONE', result: 'HANDOFF', note: o.note, nextAction: 'Übergabe an Kai', nextAt: o.callbackAt ?? null, playbook: o.playbook ?? null });
    await this.pool.query(`update leads set assignment_status = 'TRANSFERRED', contact_status = 'QUALIFIED', working_user_id = null, locked_at = null, lock_expires_at = null where id = $1 and owner_id = $2`, [leadId, this.owner]);
    await this.engine?.create({ type: 'CUSTOM', title: `Übergabe von ${u.name}: ${l.company_name} (${o.reason})`, dueAt: this.now(), priority: 'HIGH', leadId, source: 'system', notes: o.note }).catch(() => null);
    await this.pool.query("update tasks set for_admin = true where lead_id = $1 and type = 'CUSTOM' and status = 'OPEN'", [leadId]);
    await this.audit(u, 'HANDOFF_CREATED', leadId, { reason: o.reason }); await this.audit(u, 'CONTACT_ATTEMPT', leadId, { channel: 'PHONE', result: 'HANDOFF' }); await this.audit(u, 'NOTE_ADDED', leadId, {});
    return r.rows[0].id as string;
  }
  async handoffs(o: { status?: string; userId?: string } = {}) {
    const p: unknown[] = [this.owner]; let w = 'owner_id = $1'; if (o.status) { p.push(o.status); w += ` and status = $${p.length}`; } if (o.userId) { p.push(o.userId); w += ` and from_user_id = $${p.length}`; }
    return (await this.pool.query(`select * from handoffs where ${w} order by (status = 'OPEN') desc, created_at desc limit 200`, p)).rows;
  }
  async handleHandoff(id: string, to: 'ACCEPTED' | 'DONE', note: string | null, by: SessionUser) {
    const h = (await this.pool.query('select status, lead_id from handoffs where id = $1 and owner_id = $2', [id, this.owner])).rows[0]; if (!h) throw new UserError('Übergabe nicht gefunden.');
    if (to === 'ACCEPTED' && h.status !== 'OPEN') throw new UserError('Nur offene Übergaben können übernommen werden.'); if (to === 'DONE' && h.status === 'DONE') throw new UserError('Bereits erledigt.');
    await this.pool.query('update handoffs set status = $3, handled_note = coalesce($4, handled_note), handled_at = $5 where id = $1 and owner_id = $2', [id, this.owner, to, clean(note, 2000), this.now()]);
    if (to === 'DONE') await this.pool.query("update leads set assignment_status = 'COMPLETED' where id = $1 and owner_id = $2 and assignment_status = 'TRANSFERRED'", [h.lead_id, this.owner]);
    await this.audit(by, 'HANDOFF_' + to, h.lead_id, {});
  }

  // ---- Kampagnen -----------------------------------------------------------------------------------------------------------------------------
  async campaigns() {
    return (await this.pool.query(`select c.*, s.name as assignee_name,
        (select count(*)::int from leads l where l.campaign_id = c.id) as total,
        (select count(distinct a.lead_id)::int from contact_attempts a join leads l on l.id = a.lead_id where l.campaign_id = c.id and a.result not in ('EMAIL_DRAFT','NOTE')) as worked,
        (select count(distinct a.lead_id)::int from contact_attempts a join leads l on l.id = a.lead_id where l.campaign_id = c.id and a.channel = 'PHONE' and a.result <> 'NO_ANSWER') as reached,
        (select count(distinct a.lead_id)::int from contact_attempts a join leads l on l.id = a.lead_id where l.campaign_id = c.id and a.result in ('WEBSITE_INTEREST','DEMO_WANTED','OFFER_REQUESTED')) as interested,
        (select count(distinct a.lead_id)::int from contact_attempts a join leads l on l.id = a.lead_id where l.campaign_id = c.id and a.result = 'DEMO_WANTED') as demos,
        (select count(distinct a.lead_id)::int from contact_attempts a join leads l on l.id = a.lead_id where l.campaign_id = c.id and a.result = 'HANDOFF') as handoffs
      from campaigns c left join staff_users s on s.id = c.assignee_id where c.owner_id = $1 order by c.created_at desc`, [this.owner])).rows;
  }
  async campaign(id: string) { return (await this.campaigns()).find((c: any) => c.id === id) ?? null; }
  async createCampaign(f: Record<string, unknown>, by: SessionUser): Promise<{ id: string; assigned: number }> {
    const name = clean(f.name, 160); if (!name) throw new UserError('Bitte einen Kampagnennamen angeben.'); const assignee = String(f.assignee ?? ''); if (!assignee) throw new UserError('Bitte einen Mitarbeiter wählen.');
    const filter = filterFromForm(f); const pb = String(f.playbook ?? '') || null; if (pb && !['PLAYBOOK_A_NO_WEBSITE', 'PLAYBOOK_B_WEBSITE_IMPROVEMENT', 'PLAYBOOK_C_PARTNER', 'PLAYBOOK_D_NEEDS_ANALYSIS', 'PLAYBOOK_E_WEBSITE_PARTNER'].includes(pb)) throw new UserError('Unbekanntes Playbook.');
    const r = await this.pool.query('insert into campaigns(owner_id, name, rules, playbook, assignee_id, target_count, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id', [this.owner, name, JSON.stringify(filter), pb, assignee, filter.limit ?? 0, by.name]);
    const res = await this.assignBatch({ ...filter }, [assignee], by, { source: 'BATCH_ASSIGNMENT', campaignId: r.rows[0].id }); await this.audit(by, 'CAMPAIGN_CREATED', null, { campaign: r.rows[0].id, assigned: res.assigned });
    return { id: r.rows[0].id, assigned: res.assigned };
  }
  async campaignPlaybook(leadId: string): Promise<string | null> { return (await this.pool.query('select c.playbook from leads l join campaigns c on c.id = l.campaign_id where l.id = $1', [leadId])).rows[0]?.playbook ?? null; }

  // ---- Kennzahlen ----------------------------------------------------------------------------------------------------------------------------
  private statsWhere(f: StatsFilter) {
    const p: unknown[] = [this.owner]; let w = 'a.owner_id = $1'; const add = (sql: string, v: unknown) => { p.push(v); w += ` and ${sql.replaceAll('?', `$${p.length}`)}`; };
    if (f.userId) add('a.user_id = ?', f.userId); if (f.from) add('a.started_at >= ?', f.from); if (f.to) add('a.started_at < ?', f.to);
    if (f.industry) add('(l.sub_industry ilike ? or l.industry ilike ?)', `%${f.industry}%`); if (f.region) add('(l.city ilike ? or l.region ilike ?)', `%${f.region}%`);
    if (f.campaignId) add('a.campaign_id = ?', f.campaignId); if (f.playbook) add('a.playbook_id = ?', f.playbook); if (f.channel) add('a.channel = ?', f.channel); if (f.result) add('a.result = ?', f.result);
    if (f.leadStatus) add('l.status = ?', f.leadStatus); if (f.priority) add('l.effective_priority = ?', f.priority);
    return { w, p };
  }
  /** Kennzahlen je Mitarbeiter (Zeilen mit user_id; Admin-/Altbestand ohne Benutzer unter „Admin“). */
  async metricsFor(f: StatsFilter): Promise<Record<string, any>[]> {
    const { w, p } = this.statsWhere(f);
    const cols = Object.entries(METRICS).map(([k, m]) => `count(*) filter (where ${m.sql})::int as ${k}`).join(', ');
    const rows = (await this.pool.query(`select a.user_id, coalesce(max(a.user_name), 'Admin') as user_name, count(distinct a.lead_id) filter (where a.result not in ('EMAIL_DRAFT','NOTE'))::int as worked_leads, ${cols}, max(a.started_at) as last_attempt
      from contact_attempts a join leads l on l.id = a.lead_id where ${w} group by a.user_id order by max(a.user_name)`, p)).rows;
    return rows;
  }
  /** Leads hinter einer Kennzahl (Drilldown). */
  async leadsFor(metric: string, f: StatsFilter) {
    const m = METRICS[metric]; if (!m) throw new UserError('Unbekannte Kennzahl.'); const { w, p } = this.statsWhere(f);
    return (await this.pool.query(`select l.id, l.company_name, l.city, l.sub_industry, l.effective_priority, l.contact_status, max(a.started_at) as at, (array_agg(a.user_name order by a.started_at desc))[1] as user_name, (array_agg(a.channel order by a.started_at desc))[1] as channel, (array_agg(a.result order by a.started_at desc))[1] as result, (array_agg(a.note order by a.started_at desc))[1] as note
      from contact_attempts a join leads l on l.id = a.lead_id where ${w} and (${m.sql}) group by l.id order by max(a.started_at) desc limit 500`, p)).rows;
  }
  /** Faire Vergleichbarkeit: Aufschlüsselung je Mitarbeiter nach Branche, Priorität, Playbook. */
  async breakdown(f: StatsFilter, by: 'industry' | 'priority' | 'playbook' | 'region') {
    const col = { industry: "coalesce(l.sub_industry, l.industry, 'nicht verfügbar')", priority: "coalesce(l.effective_priority, 'nicht verfügbar')", playbook: "coalesce(a.playbook_id, 'nicht verfügbar')", region: "coalesce(l.city, 'nicht verfügbar')" }[by]; const { w, p } = this.statsWhere(f);
    return (await this.pool.query(`select a.user_id, coalesce(max(a.user_name), 'Admin') as user_name, ${col} as key, count(*) filter (where a.result not in ('EMAIL_DRAFT','NOTE'))::int as attempts, count(*) filter (where a.channel = 'PHONE' and a.result <> 'NO_ANSWER')::int as reached, count(*) filter (where ${METRICS.interested.sql})::int as interested
      from contact_attempts a join leads l on l.id = a.lead_id where ${w} group by a.user_id, 3 order by 2, 4 desc`, p)).rows;
  }
  async assignedStats(userId?: string) {
    const p: unknown[] = [this.owner]; let w = 'l.owner_id = $1 and l.assigned_to_user_id is not null'; if (userId) { p.push(userId); w += ' and l.assigned_to_user_id = $2'; }
    return (await this.pool.query(`select l.assigned_to_user_id as user_id, count(*)::int as assigned, count(*) filter (where l.assignment_status = 'ASSIGNED' and l.call_count = 0)::int as fresh, count(*) filter (where l.assignment_status in ('COMPLETED','TRANSFERRED'))::int as finished,
        count(*) filter (where l.assignment_status in ('ASSIGNED','IN_PROGRESS'))::int as open_leads,
        (select count(*)::int from tasks t join leads l2 on l2.id = t.lead_id where l2.assigned_to_user_id = l.assigned_to_user_id and t.status = 'OPEN' and not t.for_admin) as open_tasks,
        (select count(*)::int from tasks t join leads l2 on l2.id = t.lead_id where l2.assigned_to_user_id = l.assigned_to_user_id and t.status = 'OPEN' and t.due_at < $${p.length + 1} and not t.for_admin) as overdue_tasks
      from leads l where ${w} group by l.assigned_to_user_id`, [...p, this.now()])).rows;
  }
  async assignedLeads(userId: string) {
    return (await this.pool.query(`select l.id, l.company_name, l.city, l.sub_industry, l.assigned_at, l.assignment_status, l.contact_status, l.last_contact_at, l.next_step, l.callback_at,
        (select a.channel from contact_attempts a where a.lead_id = l.id and a.result not in ('NOTE') order by a.started_at desc limit 1) as channel,
        (select a.result from contact_attempts a where a.lead_id = l.id and a.result not in ('NOTE') order by a.started_at desc limit 1) as result,
        (select a.note from contact_attempts a where a.lead_id = l.id and a.note is not null order by a.started_at desc limit 1) as note
      from leads l where l.owner_id = $1 and l.assigned_to_user_id = $2 order by l.assigned_at desc, l.company_name limit 500`, [this.owner, userId])).rows;
  }
  async addFeedback(by: SessionUser, o: { attemptId?: string; staffId?: string; leadId?: string; text: string }) {
    const t = clean(o.text, 2000); if (!t) throw new UserError('Feedback ist leer.'); await this.pool.query('insert into team_feedback(owner_id, attempt_id, lead_id, staff_id, author, text) values ($1,$2,$3,$4,$5,$6)', [this.owner, o.attemptId ?? null, o.leadId ?? null, o.staffId ?? null, by.name, t]); await this.audit(by, 'FEEDBACK_ADDED', o.leadId ?? null, {});
  }
  async feedbackFor(staffId: string) { return (await this.pool.query('select * from team_feedback where owner_id = $1 and staff_id = $2 order by created_at desc limit 30', [this.owner, staffId])).rows; }
}

export const startOfDay = (d: Date) => startOfBerlinDay(d);
export function filterFromForm(f: Record<string, unknown>): AssignFilter {
  const arr = (v: unknown) => (Array.isArray(v) ? v : String(v ?? '').split(/[,+\s]+/)).map((x) => String(x).trim()).filter(Boolean);
  return { industry: clean(f.industry, 80) ?? undefined, region: clean(f.region, 80) ?? undefined, radiusKm: f.radiusKm ? intIn(f.radiusKm, 1, 500, 0) || undefined : undefined, priorities: arr(f.priorities).filter((x) => ['A', 'B', 'C', 'D'].includes(x)),
    website: ['none', 'weak'].includes(String(f.website)) ? String(f.website) : undefined, minOpportunity: f.minOpportunity ? intIn(f.minOpportunity, 0, 100, 0) || undefined : undefined, partnerPotential: arr(f.partnerPotential).filter((x) => ['HIGH', 'MEDIUM', 'LOW'].includes(x)),
    contactability: arr(f.contactability).filter((x) => ['READY', 'PHONE_ONLY', 'EMAIL_ONLY', 'WEB_FORM_ONLY', 'SOCIAL_ONLY'].includes(x)), limit: intIn(f.limit, 1, 1000, 50) };
}
