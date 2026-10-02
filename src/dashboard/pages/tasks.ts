import type { Route } from '../types.ts';
import { UserError } from '../types.ts';
import { html, fmt, postForm, type Safe } from '../ui.ts';
import { render, redirect, okFlash, uuid } from './_page.ts';
import { parseBerlinLocal } from '../../core/time.ts';
import { TASK_LABEL, TASK_TYPES, nextBusinessDay, type TaskType } from '../../tasks/rules.ts';
import type { TaskRow } from '../../tasks/engine.ts';

const id = uuid.source;
const wrap = async <T>(f: () => Promise<T>): Promise<T> => { try { return await f(); } catch (e) { throw new UserError(e instanceof Error ? e.message : String(e)); } };
const PRIO: Record<string, string> = { HIGH: 'hoch', NORMAL: 'normal', LOW: 'niedrig' };

export function taskList(rows: TaskRow[], csrf: string, o: { empty?: string; compact?: boolean; back?: string } = {}): Safe {
  if (!rows.length) return html`<p class="mute">${o.empty ?? 'Nichts offen.'}</p>`;
  const back = o.back ?? '/tasks';
  return html`<ul class="items">${rows.map((t) => html`<li><div class="row"><span class="badge ${t.priority === 'HIGH' ? 'b-warn' : 'b-info'}" title="Priorität ${PRIO[t.priority]}">${TASK_LABEL[t.type] ?? t.type}</span>
    <span class="grow"><b>${t.title}</b>${t.lead_id ? html`<br><small><a href="/leads/${t.lead_id}">${t.company_name ?? 'Lead'}</a>${t.phone ? html` · <a class="tel" href="tel:${String(t.phone).replace(/[^\d+]/g, '')}">${t.phone}</a>` : ''}</small>` : ''}${t.partner_id ? html`<br><small><a href="/partners/${t.partner_id}">Partner</a></small>` : ''}</span>
    <small>${t.status === 'SNOOZED' ? `zurückgestellt bis ${fmt(t.snoozed_until)}` : `fällig ${fmt(t.due_at)}`}</small></div>
    ${t.notes ? html`<small class="mute">${t.notes}</small>` : ''}
    <div class="row" style="margin-top:4px">${postForm(csrf, `/tasks/${t.id}/done`, html`<input type="hidden" name="back" value="${back}"><button class="primary">Erledigt</button>`)}
      ${postForm(csrf, `/tasks/${t.id}/snooze`, html`<input type="hidden" name="back" value="${back}"><button name="days" value="1">+1 Tag</button><button name="days" value="7">+1 Woche</button>`)}
      ${postForm(csrf, `/tasks/${t.id}/cancel`, html`<input type="hidden" name="back" value="${back}"><button>Abbrechen</button>`)}</div></li>`)}</ul>`;
}

export const routes: Route[] = [
  { method: 'GET', path: /^\/tasks$/, h: async (r) => {
    const g = await r.ctx.taskEngine.groups(); const lead = r.url.searchParams.get('lead') ?? '';
    const tomorrow = nextBusinessDay(r.ctx.now()); const p = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' }).format(d).replace(' ', 'T');
    const sec = (title: string, key: 'OVERDUE' | 'TODAY' | 'WEEK' | 'LATER' | 'SNOOZED', note?: string) => html`<div class="card" id="${key.toLowerCase()}"><h2>${title} <small class="mute">(${g[key].length})</small></h2>${note ? html`<p class="mute">${note}</p>` : ''}${taskList(g[key], r.app.csrf)}</div>`;
    return render(r, { title: 'Aufgaben', nav: 'tasks', body: html`
      <div class="grid">${([['Überfällig', g.OVERDUE.length, '#overdue'], ['Heute', g.TODAY.length, '#today'], ['Diese Woche', g.WEEK.length, '#week'], ['Später', g.LATER.length, '#later']] as const).map(([l, n, h]) => html`<a class="kpi" href="${h}" style="text-decoration:none;color:inherit"><b>${n}</b><span>${l}</span></a>`)}</div>
      ${sec('Überfällig', 'OVERDUE')}${sec('Heute', 'TODAY')}${sec('Diese Woche', 'WEEK')}${sec('Später', 'LATER')}${g.SNOOZED.length ? sec('Zurückgestellt', 'SNOOZED', 'Kommen automatisch zurück, wenn die Zurückstellung endet.') : ''}
      <details class="card"><summary>Aufgabe anlegen</summary>${postForm(r.app.csrf, '/tasks', html`<label>Titel<input name="title" required maxlength="300"></label>
        <label>Typ<select name="type">${TASK_TYPES.map((t) => html`<option value="${t}" ${t === 'CUSTOM' ? 'selected' : ''}>${TASK_LABEL[t]}</option>`)}</select></label>
        <label>Fällig am<input type="datetime-local" name="due" value="${p(tomorrow)}"></label><label>Priorität<select name="priority"><option value="NORMAL">normal</option><option value="HIGH">hoch</option><option value="LOW">niedrig</option></select></label>
        ${lead ? html`<input type="hidden" name="lead" value="${lead}">` : ''}<label>Notiz<textarea name="notes" rows="2" maxlength="4000"></textarea></label><p><button class="primary">Anlegen</button></p>`, { style: 'display:block' })}</details>` });
  } },
  { method: 'POST', path: /^\/tasks$/, h: async (r) => {
    const due = parseBerlinLocal(r.form.get('due') ?? ''); if (!due) throw new UserError('Fälligkeit ungültig.');
    const lead = r.form.get('lead') ?? ''; if (lead && !uuid.test(lead)) throw new UserError('Ungültiger Lead.');
    await wrap(() => r.ctx.taskEngine.create({ type: (r.form.get('type') ?? 'CUSTOM') as TaskType, title: r.form.get('title') ?? '', dueAt: due, priority: (r.form.get('priority') ?? 'NORMAL') as never, notes: r.form.get('notes') || undefined, leadId: lead || null }));
    return redirect(lead ? `/leads/${lead}` : '/tasks', okFlash('Aufgabe angelegt.'));
  } },
  { method: 'POST', path: new RegExp(`^/tasks/${id}/done$`), h: async (r) => { await wrap(() => r.ctx.taskEngine.done(r.params[0])); return redirect(r.form.get('back') || '/tasks', okFlash('Aufgabe erledigt.')); } },
  { method: 'POST', path: new RegExp(`^/tasks/${id}/cancel$`), h: async (r) => { await wrap(() => r.ctx.taskEngine.cancel(r.params[0])); return redirect(r.form.get('back') || '/tasks', okFlash('Aufgabe abgebrochen.')); } },
  { method: 'POST', path: new RegExp(`^/tasks/${id}/snooze$`), h: async (r) => {
    const days = Number(r.form.get('days') ?? 1); if (![1, 7].includes(days)) throw new UserError('Bitte „+1 Tag“ oder „+1 Woche“ wählen.');
    await wrap(() => r.ctx.taskEngine.snooze(r.params[0], new Date(r.ctx.now().getTime() + days * 86400_000))); return redirect(r.form.get('back') || '/tasks', okFlash(`Aufgabe um ${days === 1 ? '1 Tag' : '1 Woche'} verschoben.`));
  } },
];
