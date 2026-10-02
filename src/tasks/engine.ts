import type { Repo } from '../db/repo.ts';
import { endOfBerlinDay, startOfBerlinDay } from '../core/time.ts';
import { followUps, groupOf, type TaskPriority, type TaskSpec, type TaskType, TASK_TYPES } from './rules.ts';

const MAX_ATTEMPTS = 3;
export type TaskRow = { id: string; lead_id: string | null; partner_id: string | null; customer_id: string | null; type: TaskType; title: string; due_at: Date; status: string; priority: TaskPriority; source: string; notes: string | null; snoozed_until: Date | null; company_name?: string | null; phone?: string | null; group?: 'OVERDUE' | 'TODAY' | 'WEEK' | 'LATER' };

/** Aufgaben (OPEN/DONE/CANCELLED/SNOOZED) mit Follow-up-Regeln aus Anruf-Ergebnissen. Erzeugt nur Aufgaben für Kai – nie Nachrichten, Demos oder Zahlungen. */
export class TaskEngine {
  repo: Repo; now: () => Date;
  constructor(d: { repo: Repo; now?: () => Date }) { this.repo = d.repo; this.now = d.now ?? (() => new Date()); }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }

  async create(s: TaskSpec & { leadId?: string | null; partnerId?: string | null; customerId?: string | null; source?: 'manual' | 'followup' | 'system' }): Promise<string> {
    if (!(TASK_TYPES as readonly string[]).includes(s.type)) throw new Error('Unbekannter Aufgabentyp.');
    const title = s.title.trim(); if (!title || title.length > 300) throw new Error('Titel: 1 bis 300 Zeichen.');
    if (Number.isNaN(s.dueAt.getTime())) throw new Error('Fälligkeit ungültig.');
    const src = s.source ?? 'manual';
    const r = await this.pool.query(`insert into tasks(owner_id, lead_id, partner_id, customer_id, type, title, due_at, priority, source, notes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      on conflict (lead_id, type) where source = 'followup' and status in ('OPEN','SNOOZED') and lead_id is not null do update set due_at = excluded.due_at, title = excluded.title, notes = excluded.notes, priority = excluded.priority, status = 'OPEN', snoozed_until = null
      returning id`, [this.owner, s.leadId ?? null, s.partnerId ?? null, s.customerId ?? null, s.type, title, s.dueAt, s.priority, src, s.notes ?? null]);
    return r.rows[0].id;
  }

  /** Anruf-Ergebnis → Folgeaufgaben anlegen, erledigte Aufgaben abschließen, bei Absage/Sperre alles Offene abbrechen. */
  async applyCallResult(leadId: string, result: string, o: { callbackAt?: Date | null; topics?: string[]; nextStep?: string } = {}): Promise<{ created: TaskType[]; cancelled: number }> {
    const l = (await this.pool.query('select company_name, call_count from leads where id=$1 and owner_id=$2', [leadId, this.owner])).rows[0]; if (!l) throw new Error('Lead nicht gefunden');
    const hasDemo = (await this.pool.query('select 1 from demos where lead_id=$1 and owner_id=$2 and not revoked limit 1', [leadId, this.owner])).rowCount! > 0;
    const plan = followUps(result, { now: this.now(), callbackAt: o.callbackAt, topics: o.topics ?? [], nextStep: o.nextStep, hasDemo, attempts: Number(l.call_count ?? 0), maxAttempts: MAX_ATTEMPTS, company: l.company_name });
    let cancelled = 0;
    if (plan.cancelAll) cancelled = (await this.pool.query("update tasks set status='CANCELLED', done_at=now() where lead_id=$1 and owner_id=$2 and status in ('OPEN','SNOOZED')", [leadId, this.owner])).rowCount ?? 0;
    else if (plan.completeTypes.length) await this.pool.query("update tasks set status='DONE', done_at=now() where lead_id=$1 and owner_id=$2 and status in ('OPEN','SNOOZED') and source='followup' and type = any($3)", [leadId, this.owner, plan.completeTypes]);
    for (const s of plan.create) await this.create({ ...s, leadId, source: 'followup' });
    return { created: plan.create.map((x) => x.type), cancelled };
  }

  async done(id: string) { const r = await this.pool.query("update tasks set status='DONE', done_at=now() where id=$1 and owner_id=$2 and status in ('OPEN','SNOOZED')", [id, this.owner]); if (!r.rowCount) throw new Error('Aufgabe nicht gefunden oder bereits abgeschlossen.'); }
  async cancel(id: string) { const r = await this.pool.query("update tasks set status='CANCELLED', done_at=now() where id=$1 and owner_id=$2 and status in ('OPEN','SNOOZED')", [id, this.owner]); if (!r.rowCount) throw new Error('Aufgabe nicht gefunden oder bereits abgeschlossen.'); }
  async snooze(id: string, until: Date) {
    if (Number.isNaN(until.getTime()) || until.getTime() <= this.now().getTime()) throw new Error('Das Verschieben-Datum muss in der Zukunft liegen.');
    const r = await this.pool.query("update tasks set status='SNOOZED', snoozed_until=$3 where id=$1 and owner_id=$2 and status in ('OPEN','SNOOZED')", [id, this.owner, until]); if (!r.rowCount) throw new Error('Aufgabe nicht gefunden oder bereits abgeschlossen.');
  }
  async reopen(id: string) { await this.pool.query("update tasks set status='OPEN', snoozed_until=null, done_at=null where id=$1 and owner_id=$2", [id, this.owner]); }

  /** Abgelaufene Zurückstellungen werden wieder OFFEN (fällig zum Ende der Zurückstellung). */
  async wake() { await this.pool.query("update tasks set status='OPEN', due_at = snoozed_until, snoozed_until = null where owner_id=$1 and status='SNOOZED' and snoozed_until <= now()", [this.owner]); }

  async forLead(leadId: string) { return (await this.pool.query("select * from tasks where lead_id=$1 and owner_id=$2 and status in ('OPEN','SNOOZED') order by due_at", [leadId, this.owner])).rows as TaskRow[]; }

  /** Dashboard: ÜBERFÄLLIG · HEUTE · DIESE WOCHE · SPÄTER (+ zurückgestellt), je Gruppe nach Priorität und Fälligkeit. */
  async groups() {
    await this.wake(); const now = this.now(); const s = startOfBerlinDay(now), e = endOfBerlinDay(now);
    const rows = (await this.pool.query(`select t.*, l.company_name, l.phone from tasks t left join leads l on l.id = t.lead_id where t.owner_id=$1 and t.status in ('OPEN','SNOOZED')
      order by case t.priority when 'HIGH' then 0 when 'NORMAL' then 1 else 2 end, t.due_at`, [this.owner])).rows as TaskRow[];
    const g = { OVERDUE: [] as TaskRow[], TODAY: [] as TaskRow[], WEEK: [] as TaskRow[], LATER: [] as TaskRow[], SNOOZED: [] as TaskRow[] };
    for (const r of rows) { if (r.status === 'SNOOZED') { g.SNOOZED.push(r); continue; } const k = groupOf(new Date(r.due_at), now, s, e); r.group = k; g[k].push(r); }
    for (const k of ['OVERDUE', 'TODAY', 'WEEK', 'LATER'] as const) g[k].sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime() || ({ HIGH: 0, NORMAL: 1, LOW: 2 }[a.priority] - { HIGH: 0, NORMAL: 1, LOW: 2 }[b.priority]));
    return g;
  }
  async counts() { const g = await this.groups(); return { overdue: g.OVERDUE.length, today: g.TODAY.length, week: g.WEEK.length, later: g.LATER.length, snoozed: g.SNOOZED.length }; }
}
