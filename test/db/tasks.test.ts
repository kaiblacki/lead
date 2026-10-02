import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { seededApp, skip, NOW, type App } from './helpers.ts';

/** Phase B: Aufgaben aus Anruf-Ergebnissen (Follow-up-Regeln), Dashboard-Gruppen, Zurückstellen. Es entstehen nur Aufgaben – nichts wird gesendet oder erstellt. */
const apps: App[] = []; after(async () => { for (const a of apps) await a.close(); });
const page = async (app: App, path: string) => app.text(await (await app.get(path)).text());
const callable = async (app: App) => (await app.ctx.leads.list({ limit: 100 })).rows.filter((l: any) => l.work_status === 'CONTACTABLE' && l.phone);
const tasksOf = async (app: App, leadId: string) => (await app.pool.query("select type, status, source, due_at, priority, notes from tasks where lead_id=$1 order by created_at", [leadId])).rows;

test('Anruf-Ergebnis → Folgeaufgaben: nicht erreicht, Rückruf, interessiert, Demo, Bedarfsanalyse, Kooperation, mehrere Themen, kein Interesse', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000481'); apps.push(app);
  const [a, b, c, d, e, f, g] = await callable(app);
  const call = (id: string, result: string, extra: Record<string, string> = {}) => app.ctx.calls.applyResult(id, result as never, { note: 'x', ...(extra as object) });
  await call(a.id, 'NO_ANSWER'); const ta = await tasksOf(app, a.id); assert.deepEqual(ta.map((t: any) => t.type), ['CALL_RETRY']); assert.equal(ta[0].source, 'followup'); assert.ok(new Date(ta[0].due_at) > NOW);
  await call(a.id, 'NO_ANSWER'); assert.equal((await tasksOf(app, a.id)).filter((t: any) => t.status === 'OPEN').length, 1, 'höchstens eine offene Aufgabe je Typ');
  const cb = new Date(NOW.getTime() + 5 * 86400_000); await app.ctx.calls.applyResult(b.id, 'CALL_BACK', { note: 'x', callbackAt: cb }); const tb = await tasksOf(app, b.id); assert.equal(tb[0].type, 'CALLBACK'); assert.equal(new Date(tb[0].due_at).getTime(), cb.getTime());
  await app.ctx.calls.applyResult(b.id, 'INTERESTED', { note: 'ja', nextStep: 'Demo am Dienstag zeigen' }); const tb2 = await tasksOf(app, b.id);
  assert.equal(tb2.find((t: any) => t.type === 'CALLBACK').status, 'DONE', 'Rückruf-Aufgabe ist erledigt, weil gesprochen wurde'); const prep = tb2.find((t: any) => t.type === 'PREPARE_DEMO'); assert.ok(prep); assert.match(prep.notes, /Demo am Dienstag zeigen/);
  await call(c.id, 'DEMO'); assert.ok((await tasksOf(app, c.id)).some((t: any) => ['CREATE_DEMO', 'DEMO_FOLLOW_UP'].includes(t.type)));
  await call(d.id, 'NEEDS_ANALYSIS'); assert.deepEqual((await tasksOf(app, d.id)).map((t: any) => t.type), ['NEEDS_ANALYSIS_APPOINTMENT']);
  await call(e.id, 'PARTNERSHIP'); assert.deepEqual((await tasksOf(app, e.id)).map((t: any) => t.type), ['PARTNER_CONVERSATION']);
  await app.ctx.calls.applyResult(f.id, 'MULTIPLE', { note: 'alles', topics: ['website', 'needs', 'partner'] } as never); assert.deepEqual((await tasksOf(app, f.id)).map((t: any) => t.type).sort(), ['NEEDS_ANALYSIS_APPOINTMENT', 'PARTNER_CONVERSATION', 'PREPARE_DEMO']);
  await call(g.id, 'NO_ANSWER'); await call(g.id, 'NO_INTEREST'); assert.ok((await tasksOf(app, g.id)).every((t: any) => t.status === 'CANCELLED'), 'kein Interesse → offene Aufgaben abgebrochen');
  assert.equal((await app.pool.query('select count(*)::int n from outbox')).rows[0].n, 0, 'nichts gesendet');
  assert.equal((await app.pool.query('select count(*)::int n from demos where owner_id=$1', ['00000000-0000-0000-0000-000000000481'])).rows[0].n, 0, 'keine Demo automatisch erstellt');
});

test('Aufgaben-Dashboard: überfällig / heute / diese Woche / später, erledigen, verschieben, abbrechen, manuell anlegen, zurückgestellte kommen wieder; Seiten', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000482', { n: 6 }); apps.push(app);
  const [a] = await callable(app); const E = app.ctx.taskEngine; const day = 86400_000;
  const mk = (title: string, dueMs: number, extra: object = {}) => E.create({ type: 'CUSTOM', title, dueAt: new Date(NOW.getTime() + dueMs), priority: 'NORMAL', leadId: a.id, ...extra });
  const overdue = await mk('ÜBERFÄLLIG-A', -2 * day); const today = await mk('HEUTE-A', 2 * 3600_000); await mk('WOCHE-A', 3 * day); await mk('SPÄTER-A', 30 * day); const high = await mk('HEUTE-HOCH', 3 * 3600_000, { priority: 'HIGH' });
  const g = await E.groups(); assert.deepEqual([g.OVERDUE.length, g.TODAY.length, g.LATER.length], [1, 2, 1]); assert.equal(g.OVERDUE[0].title, 'ÜBERFÄLLIG-A'); assert.ok(g.WEEK.length + g.LATER.length >= 2);
  assert.equal(g.TODAY[0].title, 'HEUTE-A', 'nach Fälligkeit'); void high;
  const pg = await page(app, '/tasks'); for (const t of ['Überfällig', 'Heute', 'Diese Woche', 'Später', 'ÜBERFÄLLIG-A', 'Erledigt', '+1 Tag', 'Aufgabe anlegen']) assert.ok(pg.includes(t), t);
  assert.match(await page(app, '/today'), /Überfällig \(1\)/); assert.match(await page(app, `/leads/${a.id}`), /Aufgaben/);
  assert.equal((await app.post(`/tasks/${overdue}/done`, {})).status, 303); assert.equal((await app.pool.query('select status from tasks where id=$1', [overdue])).rows[0].status, 'DONE');
  assert.equal((await app.post(`/tasks/${today}/snooze`, { days: '7' })).status, 303); const sn = (await app.pool.query('select status, snoozed_until from tasks where id=$1', [today])).rows[0]; assert.equal(sn.status, 'SNOOZED'); assert.ok(new Date(sn.snoozed_until) > NOW);
  assert.equal((await E.groups()).SNOOZED.length, 1); await assert.rejects(E.snooze(today, new Date(NOW.getTime() - 1000)), /Zukunft/);
  await app.pool.query("update tasks set snoozed_until = now() - interval '1 minute' where id=$1", [today]); const w = await E.groups(); assert.equal(w.SNOOZED.length, 0); assert.ok([...w.OVERDUE, ...w.TODAY, ...w.WEEK, ...w.LATER].some((t) => t.id === today), 'Zurückstellung abgelaufen → wieder offen');
  assert.equal((await app.post('/tasks', { title: 'Hausaufgabe', type: 'CUSTOM', due: '2030-01-10T10:00', priority: 'HIGH', lead: a.id })).status, 303); assert.ok((await app.pool.query("select 1 from tasks where title='Hausaufgabe' and lead_id=$1 and source='manual'", [a.id])).rowCount);
  await assert.rejects(E.create({ type: 'NOPE' as never, title: 'x', dueAt: NOW, priority: 'NORMAL' }), /Unbekannter/); await assert.rejects(E.create({ type: 'CUSTOM', title: '', dueAt: NOW, priority: 'NORMAL' }), /Titel/);
  await E.cancel(high); await assert.rejects(E.done(high), /bereits abgeschlossen/);
});
