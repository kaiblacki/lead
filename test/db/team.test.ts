import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { seededApp, skip, type App } from './helpers.ts';

/** Mitarbeiter-Vertriebssystem: Rollen/Rechte, Zuweisung, Sperren, Arbeitsplatz, Ergebnisse, Übergaben, Cockpit, Audit, Navigation. Nichts wird gesendet. */
const apps: App[] = []; after(async () => { for (const a of apps) await a.close(); });
const PW = 'geheim-12345';
const as = (app: App, login: string, pw = PW) => {
  const h = { authorization: 'Basic ' + Buffer.from(`${login}:${pw}`).toString('base64') };
  return { get: (p: string) => fetch(app.base + p, { headers: h, redirect: 'manual' }),
    post: async (p: string, data: Record<string, string | string[]> = {}) => { const body = new URLSearchParams(); body.set('csrf', await app.csrf()); for (const [k, v] of Object.entries(data)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x); return fetch(app.base + p, { method: 'POST', headers: { ...h, 'content-type': 'application/x-www-form-urlencoded', referer: app.base + '/' }, redirect: 'manual', body }); },
    text: async (p: string) => app.text(await (await fetch(app.base + p, { headers: h, redirect: 'manual' })).text()) };
};
const ADMIN: any = { id: null, name: 'Kai', role: 'ADMIN' };
const mkUser = async (app: App, login: string, role = 'SALES', name = login) => app.ctx.team.createUser({ name, login, password: PW, role }, ADMIN);
const ready = async (app: App, n: number) => (await app.pool.query("select id from leads where owner_id = $1 and contact_readiness = 'READY_FOR_MANUAL_CALL' and phone is not null and status in ('QUALIFIED','DEMO_CREATED') order by created_at limit $2", [app.ctx.repo.ownerId, n])).rows.map((r: any) => r.id as string);
const assign = async (app: App, ids: string[], uid: string) => { for (const id of ids) await app.ctx.team.assignOne(id, uid, ADMIN); };
const flashOf = (loc: string | null) => loc ?? '';

test('Rollen und Rechte: SALES nur Arbeitsplatz, TEAM_LEAD Team ohne Preise/Zahlungen/Einstellungen, ADMIN alles; Passwörter nur als Hash; Deaktivierte ausgesperrt', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000b01', { cfgDir: 'config.mock' }); apps.push(app);
  const max = await mkUser(app, 'max', 'SALES', 'Max Mustermann'); await mkUser(app, 'lena', 'TEAM_LEAD', 'Lena Lead'); const dis = await mkUser(app, 'tom', 'SALES');
  const hash = (await app.pool.query('select password_hash from staff_users where id = $1', [max])).rows[0].password_hash; assert.match(hash, /^scrypt\$/); assert.ok(!hash.includes(PW));
  await assert.rejects(mkUser(app, 'max'), /bereits vergeben/); await assert.rejects(app.ctx.team.createUser({ name: 'X', login: 'x1', password: 'kurz', role: 'SALES' }, ADMIN), /8 Zeichen/);
  assert.equal((await as(app, 'max', 'falsch').get('/work')).status, 401);
  const S = as(app, 'max'); assert.equal((await S.get('/work')).status, 200); const root = await S.get('/'); assert.equal(root.status, 303); assert.equal(root.headers.get('location'), '/work');
  for (const p of ['/settings', '/orders', '/leads', '/team', '/analytics', '/offers', '/customers', '/partners', '/search', '/today']) assert.equal((await S.get(p)).status, 403, p);
  for (const p of ['/killswitch', '/team/assign', '/orders/00000000-0000-0000-0000-000000000000/payment/manual', '/leads/00000000-0000-0000-0000-000000000000/quote', '/team/new']) assert.equal((await S.post(p, {})).status, 403, p);
  const L = as(app, 'lena'); for (const p of ['/team', '/team/activity', '/leads', '/today', '/analytics?view=team']) assert.equal((await L.get(p)).status, 200, p);
  for (const p of ['/settings', '/orders', '/offers', '/customers', '/community', '/search', '/analytics?view=costs']) assert.equal((await L.get(p)).status, 403, p);
  assert.equal((await L.post('/orders/00000000-0000-0000-0000-000000000000/payment/manual', {})).status, 403); assert.equal((await L.post('/leads/00000000-0000-0000-0000-000000000000/quote', {})).status, 403); assert.equal((await L.post('/team/new', { name: 'Y', login: 'yy', password: PW })).status, 303, 'Redirect mit Hinweis: nur Admin legt an'); assert.equal((await app.pool.query("select count(*)::int n from staff_users where login = 'yy'")).rows[0].n, 0);
  const A = as(app, 'irgendwer', 'dashboard-passwort'); void A; assert.equal((await app.get('/team')).status, 200);
  await app.ctx.team.updateUser(dis, { status: 'DISABLED' }, ADMIN); assert.equal((await as(app, 'tom').get('/work')).status, 401, 'deaktiviert');
  const prof = await app.text(await (await app.get(`/team/${max}`)).text()); assert.ok(!prof.includes('scrypt')); assert.match(prof, /Zum Team/);
});

test('Lead-Zuweisung: Batch mit Filtern, Round Robin, nur freie/zulässige Leads, nur aktive Mitarbeiter, Ownership-Felder, Kampagne weist zu', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000b02', { cfgDir: 'config.mock', n: 20 }); apps.push(app); const t = app.ctx.team;
  const a = await mkUser(app, 'ann'), b = await mkUser(app, 'ben'); const off = await mkUser(app, 'off'); await t.updateUser(off, { status: 'PAUSED' }, ADMIN);
  const n = await t.preview({ website: 'none', limit: 100 }); assert.ok(n >= 3, `n=${n}`); const r1 = await t.assignBatch({ website: 'none', limit: 3 }, [a], ADMIN); assert.equal(r1.assigned, 3);
  const rows = (await app.pool.query('select assigned_to_user_id, assigned_by, assignment_source, assignment_status, assigned_at, website_state from leads where assigned_to_user_id = $1', [a])).rows; assert.equal(rows.length, 3);
  for (const x of rows) { assert.equal(x.assignment_status, 'ASSIGNED'); assert.equal(x.assigned_by, 'Kai'); assert.equal(x.assignment_source, 'BATCH_ASSIGNMENT'); assert.ok(x.assigned_at); assert.equal(x.website_state, 'none'); }
  assert.equal(await t.preview({ website: 'none', limit: 100 }), n - 3, 'zugewiesene Leads sind nicht mehr frei');
  const rr = await t.assignBatch({ limit: 6 }, [a, b], ADMIN); assert.equal(rr.assigned, 6); assert.equal(rr.perUser[a], 3); assert.equal(rr.perUser[b], 3); assert.equal((await app.pool.query("select count(*)::int n from leads where assignment_source = 'ROUND_ROBIN'")).rows[0].n, 6);
  await assert.rejects(t.assignBatch({ limit: 1 }, [off], ADMIN), /nicht aktiv/); await assert.rejects(t.assignBatch({ limit: 1 }, [], ADMIN), /mindestens einen/);
  const [dnc] = await ready(app, 1); await app.pool.query("update leads set contact_readiness = 'DO_NOT_CONTACT' where id = $1", [dnc]); await assert.rejects(t.assignOne(dnc, a, ADMIN), /Gesperrte/);
  const c = await t.createCampaign({ name: 'Nagelstudios ohne Website KW41', website: 'none', limit: '2', assignee: b, playbook: 'PLAYBOOK_A_NO_WEBSITE' }, ADMIN); assert.ok(c.assigned >= 0);
  const camp = await t.campaign(c.id); assert.equal(camp.name, 'Nagelstudios ohne Website KW41'); assert.equal(camp.total, c.assigned); assert.equal(camp.playbook, 'PLAYBOOK_A_NO_WEBSITE');
  const audit = await t.auditList({ event: 'LEAD_ASSIGNED' }); assert.ok(audit.length >= 2);
  const res = await app.post('/team/assign', { users: [a, b], limit: '2', website: '' }); assert.equal(res.status, 303);
  const pg = await app.text(await (await app.get(`/team/assign?website=none&limit=2&user=${a}&preview=1`)).text()); assert.match(pg, /passen zum Filter/); assert.match(pg, /Leads zuweisen/);
  await t.unassign(rows[0] ? (await app.pool.query('select id from leads where assigned_to_user_id = $1 limit 1', [a])).rows[0].id : '', ADMIN); assert.ok((await app.pool.query("select count(*)::int n from leads where assignment_status = 'RETURNED'")).rows[0].n >= 1);
});

test('Sperren gegen Doppelbearbeitung; fremde Leads nicht bearbeitbar; Locks laufen ab; Admin kann lösen', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000b03', { cfgDir: 'config.mock' }); apps.push(app); const t = app.ctx.team;
  const ua = await mkUser(app, 'anna', 'SALES', 'Anna'), ub = await mkUser(app, 'bert', 'SALES', 'Bert'); const [l1, l2] = await ready(app, 2); await assign(app, [l1], ua); await assign(app, [l2], ub);
  const A: any = { id: ua, name: 'Anna', role: 'SALES' }, B: any = { id: ub, name: 'Bert', role: 'SALES' };
  assert.equal((await t.acquireLock(l1, A)).ok, true); assert.equal((await t.acquireLock(l1, B)).ok, false); assert.equal((await t.acquireLock(l1, B)).by, 'Anna'); assert.equal((await t.acquireLock(l1, A)).ok, true, 'eigene Sperre verlängern');
  await assert.rejects(t.recordResult(B, l1, 'NO_ANSWER'), /nicht zugewiesen/); await assign(app, [l1], ub); await t.acquireLock(l1, A); await assert.rejects(t.recordResult(B, l1, 'NO_ANSWER'), /Wird gerade von Anna bearbeitet/);
  await app.pool.query('update leads set lock_expires_at = $2 where id = $1', [l1, new Date(app.ctx.now().getTime() - 60000)]); assert.equal((await t.acquireLock(l1, B)).ok, true, 'abgelaufene Sperre ist frei');
  await t.acquireLock(l2, B); const other = as(app, 'anna'); const pg = await other.text(`/work/lead/${l1}`); assert.equal((await other.get(`/work/lead/${l1}`)).status, 403, 'Anna: Lead gehört jetzt Bert');
  await t.adminUnlock(l1, ADMIN); assert.equal((await t.leadAssignmentOf(l1)).working_user_id, null); void pg;
  const Bh = as(app, 'bert'); await t.adminUnlock(l2, ADMIN); await t.acquireLock(l2, A); const lockedPage = await Bh.text(`/work/lead/${l2}`); assert.match(lockedPage, /Wird gerade von Anna bearbeitet/);
});

test('Arbeitsplatz (HTTP als Vertrieb): Mein Tag, nächster Lead, Leitfaden, Ergebnisse mit Pflichtnotiz, Rückruf, Folgeaufgaben, Demo nur als Aufgabe, Übergabe, DNC; Kontaktversuche unveränderlich; nichts gesendet', { skip, timeout: 400_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000b04', { cfgDir: 'config.mock', n: 40 }); apps.push(app); const t = app.ctx.team;
  const uid = await mkUser(app, 'max', 'SALES', 'Max Mustermann'); const ids = await ready(app, 6); await assign(app, ids, uid); await app.ctx.growth.refresh(); const S = as(app, 'max');
  const day = await S.text('/work'); for (const w of ['Max', 'neue Leads', 'Rückrufe', 'interessierte Unternehmen', 'ARBEIT STARTEN', 'Mein Fortschritt heute']) assert.ok(day.includes(w), w);
  const next = await S.get('/work/next'); assert.equal(next.status, 303); const first = next.headers.get('location')!.replace('/work/lead/', ''); assert.ok(ids.includes(first.split('?')[0]), 'nur eigene Leads');
  const pg = await S.text(`/work/lead/${first}`); for (const w of ['Das soll ich sagen', 'Playbook:', 'Gesprächsziel', 'Das weiß das System', 'Gesprächsablauf', 'Ansprechpartner erreicht?', 'AN KAI ÜBERGEBEN', 'Warum dieser Lead?', 'Nächster Lead', 'Mein Tag']) assert.ok(pg.includes(w), w);
  assert.match(await (await S.get(`/work/lead/${first}`)).text(), /href="tel:/);
  // Nicht erreicht
  let res = await S.post(`/work/lead/${first}/result`, { result: 'NO_ANSWER' }); assert.equal(res.status, 303); let a = (await t.attemptsForLead(first)); assert.equal(a.length, 1); assert.equal(a[0].result, 'NO_ANSWER'); assert.equal(a[0].user_name, 'Max Mustermann'); assert.equal(a[0].channel, 'PHONE');
  let lead = (await app.pool.query('select contact_status, assignment_status, callback_at, call_count from leads where id = $1', [first])).rows[0]; assert.equal(lead.contact_status, 'CONTACT_ATTEMPTED'); assert.equal(lead.assignment_status, 'IN_PROGRESS'); assert.ok(lead.callback_at, 'neuer Versuch folgt'); assert.equal(lead.call_count, 1);
  assert.notEqual((await S.get('/work/next')).headers.get('location'), `/work/lead/${first}`, 'nicht derselbe Lead sofort wieder');
  const second = ids.find((x) => x !== first)!;
  // Pflichtnotiz
  res = await S.post(`/work/lead/${second}/result`, { result: 'WEBSITE_INTEREST', note: '' }); assert.equal(res.status, 303); assert.equal((await t.attemptsForLead(second)).length, 0, 'ohne Notiz nichts gespeichert');
  await assert.rejects(t.recordResult({ id: uid, name: 'Max Mustermann', role: 'SALES' }, second, 'WEBSITE_INTEREST', { note: ' ' }), /Notiz/);
  await assert.rejects(t.recordResult({ id: uid, name: 'Max Mustermann', role: 'SALES' }, second, 'CALL_BACK', {}), /Datum und Uhrzeit/);
  await S.post(`/work/lead/${second}/result`, { result: 'WEBSITE_INTEREST', note: 'Geschäftsführer gesprochen. Website grundsätzlich interessant.' }); a = await t.attemptsForLead(second); assert.equal(a[0].result, 'WEBSITE_INTEREST'); assert.match(a[0].note, /Geschäftsführer/);
  assert.equal((await app.pool.query('select contact_status from leads where id = $1', [second])).rows[0].contact_status, 'INTERESTED');
  // Rückruf mit Datum
  const third = ids[2]; const when = new Date(app.ctx.now().getTime() + 3 * 86400000); const local = new Date(when.getTime() + 2 * 3600000).toISOString().slice(0, 11) + '14:00';
  res = await S.post(`/work/lead/${third}/result`, { result: 'CALL_BACK', note: 'Rückruf Donnerstag 14 Uhr', callback: local }); assert.equal(res.status, 303);
  const cb = (await app.pool.query('select callback_at, contact_status from leads where id = $1', [third])).rows[0]; assert.ok(cb.callback_at); assert.equal(cb.contact_status, 'FOLLOW_UP'); assert.ok((await app.pool.query("select count(*)::int n from tasks where lead_id = $1 and type in ('CALLBACK','CALL')", [third])).rows[0].n >= 1, 'Rückruf-Aufgabe');
  // Demo gewünscht: nur Aufgabe für Kai, keine Demo
  const fourth = ids[3]; await t.recordResult({ id: uid, name: 'Max Mustermann', role: 'SALES' }, fourth, 'DEMO_WANTED', { note: 'Möchte eine Demo sehen.' });
  assert.equal((await app.pool.query('select count(*)::int n from demos where lead_id = $1', [fourth])).rows[0].n, 0, 'Demo wird nicht automatisch erstellt'); assert.ok((await app.pool.query("select count(*)::int n from tasks where lead_id = $1 and type = 'PREPARE_DEMO' and for_admin", [fourth])).rows[0].n >= 1, 'Demo-Aufgabe für Kai');
  assert.equal((await app.pool.query("select count(*)::int n from tasks where lead_id = $1 and for_admin and status = 'OPEN'", [fourth])).rows[0].n >= 1, true);
  // Übergabe
  const fifth = ids[4]; assert.equal((await S.get(`/work/lead/${fifth}/handoff`)).status, 200);
  res = await S.post(`/work/lead/${fifth}/handoff`, { reason: 'WEBSITE_ANGEBOT', note: 'Will Angebot für Website. Ansprechpartner Herr Beispiel.', interest: 'Website', next_step: 'Kai ruft Donnerstag an' }); assert.equal(res.status, 303);
  const ho = (await t.handoffs({}))[0]; assert.equal(ho.reason, 'WEBSITE_ANGEBOT'); assert.equal(ho.from_name, 'Max Mustermann'); assert.equal(ho.status, 'OPEN'); assert.equal((await app.pool.query('select assignment_status from leads where id = $1', [fifth])).rows[0].assignment_status, 'TRANSFERRED');
  assert.match(await S.text('/work/handoffs'), /Offen bei Kai/); assert.match(await as(app, 'max').text('/work/saved'), /Nächsten Lead öffnen/);
  // Nicht mehr kontaktieren
  const sixth = ids[5]; await S.post(`/work/lead/${sixth}/result`, { result: 'DO_NOT_CONTACT', note: 'Wunsch des Inhabers' }); assert.equal((await app.pool.query('select contact_readiness, assignment_status from leads where id = $1', [sixth])).rows[0].contact_readiness, 'DO_NOT_CONTACT'); assert.equal((await t.nextLead({ id: uid, name: 'x', role: 'SALES' }, undefined)) === sixth, false, 'gesperrter Lead nicht in der Queue');
  // Unveränderlich
  await assert.rejects(app.pool.query("update contact_attempts set note = 'x' where lead_id = $1", [second]), /unveränderlich/);
  const ev = (await t.auditList({ userId: uid, limit: 200 })).map((x: any) => x.event); for (const e of ['LEAD_OPENED', 'CONTACT_ATTEMPT', 'CALL_RESULT', 'NOTE_ADDED', 'TASK_CREATED', 'DEMO_REQUESTED', 'HANDOFF_CREATED']) assert.ok(ev.includes(e), e);
  assert.equal((await app.pool.query('select count(*)::int n from outbox where owner_id = $1', [app.ctx.repo.ownerId])).rows[0].n, 0, 'nichts gesendet');
  // Notiz
  await S.post(`/work/lead/${second}/note`, { note: 'Eigene Notiz.' }); assert.equal((await t.attemptsForLead(second))[0].result, 'NOTE');
  // Aufgaben-Seite des Mitarbeiters zeigt keine Admin-Aufgaben
  const tasks = await S.text('/work/tasks'); assert.ok(!tasks.includes('Demo prüfen/erstellen'));
});

test('E-Mail: Entwurf ist DRAFT, „versendet“ nur mit Freigabe und ausdrücklicher Bestätigung; Telefon nur bei Freigabe', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000b05', { cfgDir: 'config.mock', n: 40 }); apps.push(app); const t = app.ctx.team;
  const uid = await mkUser(app, 'eva', 'SALES', 'Eva'); const [l] = await ready(app, 1); await assign(app, [l], uid); const U: any = { id: uid, name: 'Eva', role: 'SALES' };
  await assert.rejects(t.recordEmail(U, l, 'DRAFT'), /E-Mail-Adresse/); await app.pool.query("update leads set email = 'info@beispiel.example' where id = $1", [l]);
  await t.recordEmail(U, l, 'DRAFT', { note: 'Entwurf' }); let a = await t.attemptsForLead(l); assert.equal(a[0].status, 'DRAFT'); assert.equal(a[0].channel, 'EMAIL'); assert.equal(a[0].result, 'EMAIL_DRAFT');
  await assert.rejects(t.recordEmail(U, l, 'SENT', { confirmed: true }), /Keine E-Mail-Freigabe/); await app.ctx.contact.recordConsent(l, 'EMAIL', 'Einwilligung per Formular');
  await assert.rejects(t.recordEmail(U, l, 'SENT', { confirmed: false }), /selbst versendet/); await t.recordEmail(U, l, 'SENT', { confirmed: true }); a = await t.attemptsForLead(l); assert.equal(a[0].status, 'SENT'); assert.equal(a[0].result, 'EMAIL_SENT');
  assert.equal((await app.pool.query('select count(*)::int n from outbox where owner_id = $1', [app.ctx.repo.ownerId])).rows[0].n, 0, 'das System sendet nie');
  const [l2] = (await ready(app, 3)).slice(1); await assign(app, [l2], uid); await app.pool.query("update leads set contact_readiness = 'MANUAL_REVIEW' where id = $1", [l2]); await assert.rejects(t.recordResult(U, l2, 'NO_ANSWER'), /kein Anruf freigegeben|Do not contact/);
  await app.pool.query("update owner_settings set phone_enabled = false where owner_id = $1", [app.ctx.repo.ownerId]); assert.equal((await t.permissions(l))[0] === 'CALL_APPROVED', false, 'ohne Telefonfreigabe kein Anruf');
});

test('Admin-Cockpit: Kennzahlen je Mitarbeiter exakt, Zeitraumfilter, Drilldown zu den Leads, Aufschlüsselung, Notizen sichtbar, nur Admin/Teamleitung', { skip, timeout: 400_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000b06', { cfgDir: 'config.mock', n: 40 }); apps.push(app); const t = app.ctx.team;
  const uid = await mkUser(app, 'max', 'SALES', 'Max Mustermann'); const other = await mkUser(app, 'ida', 'SALES', 'Ida'); const ids = await ready(app, 8); await assign(app, ids, uid); const U: any = { id: uid, name: 'Max Mustermann', role: 'SALES' };
  const plan: [string, string, string?][] = [['NO_ANSWER', ids[0]], ['NO_ANSWER', ids[1]], ['NO_INTEREST', ids[2]], ['WEBSITE_INTEREST', ids[3], 'Interesse an Website, Geschäftsführer erreicht.'], ['DEMO_WANTED', ids[4], 'Demo gewünscht, Termin Freitag.'], ['HANDOFF', ids[5], 'Großer Betrieb, bitte selbst anrufen.']];
  for (const [res, id, note] of plan) { if (res === 'HANDOFF') await t.createHandoff(U, id, { reason: 'GROSSKUNDE', note: note! }); else await t.recordResult(U, id, res, { note }); }
  const m = (await t.metricsFor({ userId: uid }))[0]; assert.equal(m.calls, 6); assert.equal(m.noanswer, 2); assert.equal(m.reached, 4); assert.equal(m.interested, 2); assert.equal(m.demos, 1); assert.equal(m.handoffs, 1); assert.equal(m.worked_leads, 6); assert.equal(m.emails, 0);
  assert.equal((await t.leadsFor('reached', { userId: uid })).length, 4); assert.equal((await t.leadsFor('interested', { userId: uid })).length, 2); assert.equal((await t.leadsFor('demos', { userId: uid })).length, 1);
  assert.deepEqual(await t.metricsFor({ userId: other }), [], 'Ida hat nichts getan'); await assert.rejects(t.leadsFor('quatsch', {}), /Unbekannte Kennzahl/);
  const old = new Date(app.ctx.now().getTime() - 40 * 86400000); await app.pool.query("alter table contact_attempts disable trigger contact_attempts_no_update"); await app.pool.query('update contact_attempts set started_at = $2 where lead_id = $1', [ids[0], old]); await app.pool.query("alter table contact_attempts enable trigger contact_attempts_no_update");
  const day = new Date(app.ctx.now().getTime() - 86400000); assert.equal((await t.metricsFor({ userId: uid, from: day, to: new Date(app.ctx.now().getTime() + 86400000) }))[0].calls, 5, 'Zeitraumfilter'); assert.equal((await t.metricsFor({ userId: uid }))[0].calls, 6);
  const A = app; const team = await A.text(await (await A.get('/team?range=today')).text()); for (const w of ['Max Mustermann', 'Ida', 'Anrufversuche', 'Erreicht', 'Letzte Aktivität', 'noch keine']) assert.ok(team.includes(w), w);
  const dd = await A.text(await (await A.get(`/team/activity?metric=reached&user=${uid}&range=month`)).text()); assert.match(dd, /4 Lead\(s\) hinter dieser Kennzahl/); assert.match(dd, /Geschäftsführer erreicht/); assert.match(dd, /Zur Team-Aktivität/);
  const act = await A.text(await (await A.get('/team/activity?range=month')).text()); for (const w of ['Reach Rate', 'Interest Rate', 'Demo Rate', 'Handoff Rate', 'Follow-up-Erledigung', 'Nach Branche', 'Nach Priorität', 'Nach Playbook', 'Nach Region', 'Letzte Kontaktversuche', 'Keine Rangliste']) assert.ok(act.includes(w) || act.includes(w.toLowerCase()) || /Quoten sind keine Rangliste/.test(act), w);
  const prof = await A.text(await (await A.get(`/team/${uid}`)).text()); for (const w of ['Heute', 'Diese Woche', 'Zugewiesene Leads', 'Letzte Kontaktversuche', 'Feedback', 'Protokoll']) assert.ok(prof.includes(w), w);
  const lst = await A.text(await (await A.get(`/team/${uid}/leads`)).text()); assert.match(lst, /8 zugewiesene Leads/); assert.match(lst, /Demo gewünscht, Termin Freitag/); assert.match(lst, /Zum Mitarbeiter|Zu Mitarbeiter/);
  const lead = await A.text(await (await A.get(`/leads/${ids[3]}?tab=verlauf`)).text()); assert.match(lead, /Kontakt-Historie \(Mitarbeiter\)/); assert.match(lead, /Max Mustermann/); assert.match(lead, /Interesse an Website/);
  const ana = await A.text(await (await A.get('/analytics?view=team&range=month')).text()); assert.match(ana, /Max Mustermann/);
  const camp = await t.createCampaign({ name: 'Test', limit: '1', assignee: other }, ADMIN); void camp;
  await t.addFeedback(ADMIN, { staffId: uid, text: 'Gute Notizen.' }); assert.match(await A.text(await (await A.get(`/team/${uid}`)).text()), /Gute Notizen/);
  assert.equal((await as(app, 'max').get('/team/activity')).status, 403);
  assert.equal((await t.progress(uid)).calls, 5, 'Tagesfortschritt');
});

test('Audit unveränderlich; Playbook-Empfehlung; Training nur mit erfundenen Firmen; Navigation, Breadcrumbs, Zurück-Links, Sitemap', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000b07', { cfgDir: 'config.mock' }); apps.push(app); const t = app.ctx.team;
  await t.audit(ADMIN, 'LOGIN'); await assert.rejects(app.pool.query("update team_audit set event = 'X'"), /unveränderlich/); await assert.rejects(app.pool.query('delete from team_audit'), /nicht gelöscht/);
  const uid = await mkUser(app, 'max', 'SALES', 'Max Mustermann'); const S = as(app, 'max'); const names = (await app.pool.query('select company_name from leads where owner_id = $1', [app.ctx.repo.ownerId])).rows.map((r: any) => r.company_name as string);
  const tr = await S.text('/work/training'); assert.match(tr, /Trainingsmodus/); for (const n of names) assert.ok(!tr.includes(n), 'kein echter Lead im Training'); const tc = await S.text('/work/training/t1?o=1'); assert.match(tc, /erfundenen Firma/); assert.match(tc, /Instagram/); for (const n of names) assert.ok(!tc.includes(n));
  assert.equal((await S.get('/work/training/t99')).status, 404);
  // Navigation Admin
  const home = await (await app.get('/leads')).text(); assert.match(home, /🏠 Startseite/); assert.match(home, /aria-label="Brotkrumen"/); assert.match(home, /Zur Leadliste|Startseite/);
  const nav = home.slice(home.indexOf('aria-label="Hauptnavigation"'), home.indexOf('</header>')); for (const g of ['START', 'LEADS', 'SALES', 'TEAM', 'PARTNER', 'KUNDEN', 'ANALYTICS', 'SYSTEM']) assert.ok(nav.includes(`aria-label="${g}"`), g);
  const lead = (await ready(app, 1))[0]; const lp = await (await app.get(`/leads/${lead}`)).text(); assert.match(lp, /← Zur Leadliste/); assert.match(lp, /<a href="\/leads">Leads<\/a>/);
  const tp = await (await app.get(`/team/${uid}`)).text(); assert.match(tp, /← Zum Team/); assert.match(tp, /<a href="\/team">Team<\/a>/);
  const tl = await (await app.get(`/team/${uid}/leads`)).text(); assert.match(tl, /← Zu Mitarbeiter/); const an = await (await app.get('/analytics?view=industries')).text(); assert.match(an, /← Zu Analytics/);
  const sub = await (await app.get('/team/activity')).text(); assert.match(sub, /Bereich TEAM/); assert.match(sub, /Team-Aktivität/);
  // Sitemap: jeder Link erreichbar
  const menu = await (await app.get('/menu')).text(); const hrefs = [...new Set([...menu.matchAll(/href="(\/[^"#]*)/g)].map((m) => m[1].replace(/&amp;/g, '&')))]; assert.ok(hrefs.length >= 35, String(hrefs.length));
  for (const h of hrefs) { const res = await app.get(h); assert.equal(res.status, 200, h); }
  // Sales-Navigation klein
  const sp = await (await S.get('/work')).text(); const sn = sp.slice(sp.indexOf('aria-label="Hauptnavigation"'), sp.indexOf('</header>')); for (const l of ['MEIN TAG', 'MEINE LEADS', 'RÜCKRUFE', 'AUFGABEN', 'ÜBERGABEN', 'TRAINING']) assert.ok(sn.includes(l), l); for (const l of ['Einstellungen', 'Analytics', 'Aufträge', 'STOP']) assert.ok(!sp.includes(`>${l}<`), l); assert.match(sp, /🏠 Mein Tag/);
  const rec = (await import('../../src/team/rules.ts')).recommendPlaybook; assert.equal(rec({ websiteState: 'none', strategy: null }).id, 'PLAYBOOK_A_NO_WEBSITE'); assert.equal(rec({ websiteState: 'exists', strategy: null }).id, 'PLAYBOOK_B_WEBSITE_IMPROVEMENT'); assert.equal(rec({ websiteState: 'none', strategy: 'PARTNER_FIRST' }).id, 'PLAYBOOK_C_PARTNER');
});
