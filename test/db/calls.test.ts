import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appSetup, skip, enablePhone, quickSearch, leadsWhere, type App } from './helpers.ts';

const OWNER = '00000000-0000-0000-0000-0000000000d1';
const OWNER_DEFAULT = '00000000-0000-0000-0000-0000000000d2';
let app: App, appDefault: App;
before(async () => {
  if (skip) return;
  app = await appSetup(OWNER, { cfgDir: 'config.mock' });
  appDefault = await appSetup(OWNER_DEFAULT);      // Standard-Konfiguration mit Platzhaltern
});
after(async () => { if (!skip) { await app.close(); await appDefault.close(); } });

const call = (a: App, id: string, result: string, extra: Record<string, string> = {}) => a.post(`/leads/${id}/call`, { result, next: 'calls', ...extra });
const flash = async (a: App, r: Response) => a.text(await a.follow(r));
const status = async (a: App, id: string) => (await a.pool.query('select status from leads where id=$1', [id])).rows[0].status as string;

test('Ohne Freigabe der Telefonakquise bleibt die Anrufliste leer und erklärt warum', { skip }, async () => {
  await quickSearch(app);
  const ready = await leadsWhere(app, "contact_readiness = 'READY_FOR_MANUAL_CALL'");
  assert.equal(ready.length, 0, 'ohne Freigabe nie bereit für Anruf');
  const page = app.text(await (await app.get('/calls')).text());
  assert.match(page, /Telefonakquise nicht freigegeben/);
  assert.match(page, /0 von \d+ Leads bearbeitet/);
  // Freigabe ohne Bestätigung wird abgelehnt
  const bad = await flash(app, await app.post('/settings/phone', { enable: '1', dailyCallTarget: '30' }));
  assert.match(bad, /rechtliche Grundlage/);
  assert.equal((await app.repo.getSettings()).phoneEnabled, false);
});

test('Mit Freigabe erscheinen qualifizierte Leads mit Verkaufsgründen, Einstieg und Schätzung – nach Priorität', { skip }, async () => {
  await enablePhone(app);
  const s = await app.repo.getSettings(); assert.equal(s.phoneEnabled, true); assert.equal(s.dailyCallTarget, 30);
  const q = await app.ctx.calls.queue();
  assert.ok(q.items.length >= 3, `Anrufliste hat ${q.items.length} Einträge`);
  const prio = q.items.map((i: any) => i.priority);
  assert.deepEqual([...prio].sort(), prio, 'nach Priorität A→D sortiert oder gleichwertig');
  const page = app.text(await (await app.get('/calls')).text());
  assert.match(page, /Die wichtigsten Verkaufsgründe/); assert.match(page, /Gesprächseinstieg/); assert.match(page, /Schätzung möglicher Auftragswert/);
  assert.match(page, /Mögliche Einwände/);
  for (const label of ['Nicht erreicht', 'Kein Interesse', 'Rückruf', 'Interessiert', 'Demo gewünscht', 'Angebot gewünscht', 'Gekauft', 'Nicht mehr kontaktieren']) assert.ok(page.includes(label), label);
  assert.doesNotMatch(page, /\[Dein Name\]|undefined|NaN|\[object/);
});

test('Ergebnis-Buttons: nicht erreicht, kein Interesse, Rückruf (mit Validierung), interessiert', { skip }, async () => {
  const items = (await app.ctx.calls.queue()).items;
  const [a, b, c, d] = items.map((i: any) => i.id as string);

  // Nicht erreicht: bleibt QUALIFIED, morgen wieder in der Liste, Zähler +1, Kontakt protokolliert
  assert.match(await flash(app, await call(app, a, 'NO_ANSWER', { note: 'Mailbox' })), /Nicht erreicht/);
  let row = (await leadsWhere(app, `id='${a}'`))[0];
  assert.equal(row.status, 'QUALIFIED'); assert.equal(row.call_count, 1); assert.ok(row.callback_at);
  const hist = (await app.pool.query("select result, note, channel from contact_history where lead_id=$1", [a])).rows;
  assert.deepEqual(hist.map((h) => [h.channel, h.result, h.note]), [['PHONE', 'NO_ANSWER', 'Mailbox']]);
  assert.ok(!(await app.ctx.calls.queue()).items.some((i: any) => i.id === a), 'heute bereits bearbeitet → nicht erneut in der Liste');

  // Kein Interesse → IGNORED + Learning-Loop-Ergebnis LOST
  await call(app, b, 'NO_INTEREST', { note: 'hat schon Website' });
  assert.equal(await status(app, b), 'IGNORED');
  assert.ok((await app.pool.query("select 1 from lead_outcomes where lead_id=$1 and kind='final' and value='LOST'", [b])).rowCount! >= 1);

  // Rückruf: ohne Datum / ungültig / Vergangenheit → Fehlerhinweis, nichts geändert
  assert.match(await flash(app, await call(app, c, 'CALL_BACK')), /Datum und Uhrzeit/);
  assert.match(await flash(app, await call(app, c, 'CALL_BACK', { callback: '2026-13-45T10:00' })), /ungültig/);
  assert.match(await flash(app, await call(app, c, 'CALL_BACK', { callback: '2026-05-01T09:00' })), /Vergangenheit/);
  assert.equal(await status(app, c), 'QUALIFIED'); assert.equal((await leadsWhere(app, `id='${c}'`))[0].call_count, 0);
  // gültiger Rückruf → CONTACTED, Rückruftermin gespeichert
  assert.match(await flash(app, await call(app, c, 'CALL_BACK', { callback: '2026-06-03T14:30', note: 'Chefin ab Mittwoch' })), /Rückruf am/);
  row = (await leadsWhere(app, `id='${c}'`))[0];
  assert.equal(row.status, 'CONTACTED'); assert.equal(new Date(row.callback_at).toISOString(), '2026-06-03T12:30:00.000Z');   // 14:30 Berlin (Sommerzeit)

  // Interessiert → INTERESTED (über CONTACTED/REPLIED-Pfad, jede Stufe im Verlauf)
  await call(app, d, 'INTERESTED');
  assert.equal(await status(app, d), 'INTERESTED');
  const ev = (await app.pool.query("select payload from events where lead_id=$1 and type='status_change' order by created_at, id", [d])).rows;
  const byUser = ev.filter((e) => e.payload.actor === 'user');
  assert.ok(byUser.length >= 1, 'Statuswechsel durch den Anruf stehen im Audit-Log');
  assert.equal(byUser[byUser.length - 1].payload.to, 'INTERESTED');
  assert.ok(ev.some((e) => e.payload.actor === 'system'), 'Qualifizierung durch das System ebenfalls protokolliert');
});

test('Rückruf in der Zukunft erscheint erst am fälligen Tag als „Rückruf fällig“', { skip }, async () => {
  const cb = (await leadsWhere(app, "callback_at is not null and status='CONTACTED'"))[0];
  assert.ok(cb);
  // Der Rückruf ist am 3.6. fällig, jetzt ist der 1.6. → nicht in der Liste
  assert.ok(!(await app.ctx.calls.queue()).items.some((i: any) => i.id === cb.id));
  // Uhr auf den 3.6. stellen
  const later = new (app.ctx.calls.constructor as any)({ ...(app.ctx.calls as any), now: () => new Date('2026-06-03T09:00:00Z') });
  const q = await later.queue();
  const it = q.items.find((i: any) => i.id === cb.id);
  assert.ok(it, 'fälliger Rückruf'); assert.equal(it.kind, 'callback'); assert.equal(q.items[0].kind, 'callback', 'Rückrufe stehen zuerst');
});

test('Demo gewünscht erzeugt Demo + Link; Angebot gewünscht erzeugt freigegebenes Angebot (Mock-Konfiguration)', { skip }, async () => {
  const items = (await app.ctx.calls.queue()).items;
  const demoLead = items[0].id as string, offerLead = items[1].id as string;
  const m = await flash(app, await call(app, demoLead, 'DEMO'));
  assert.match(m, /Demo erstellt/);
  assert.equal(await status(app, demoLead), 'DEMO_CREATED');
  const demo = (await app.pool.query('select token, template, revoked from demos where lead_id=$1', [demoLead])).rows[0];
  assert.match(demo.token, /^[0-9a-f]{64}$/); assert.equal(demo.revoked, false);
  const dr = await app.get(`/d/${demo.token}`, false); assert.equal(dr.status, 200);
  assert.match(dr.headers.get('x-robots-tag') ?? '', /noindex/);

  const o = await flash(app, await call(app, offerLead, 'OFFER'));
  assert.match(o, /Angebot freigegeben und als versendet/);
  assert.equal(await status(app, offerLead), 'OFFER_SENT');
  const offer = (await app.pool.query('select status, content from offers where lead_id=$1', [offerLead])).rows[0];
  assert.equal(offer.status, 'SENT'); assert.deepEqual(offer.content.warnings ?? [], []);
  assert.ok(offer.content.deposit_cents > 0 || offer.content.depositCents > 0 || JSON.stringify(offer.content).includes('Anzahlung'));
});

test('Gekauft legt Bestellung an (Angebot wird bei Bedarf erzeugt und freigegeben)', { skip }, async () => {
  const id = (await app.ctx.calls.queue()).items[0].id as string;
  const m = await flash(app, await call(app, id, 'BOUGHT', { note: 'Sofort kaufbereit' }));
  assert.match(m, /Bestellung angelegt/);
  assert.equal(await status(app, id), 'DEPOSIT_PENDING');
  const o = (await app.pool.query("select status, deposit_cents, final_cents from orders where lead_id=$1", [id])).rows;
  assert.equal(o.length, 1); assert.equal(o[0].status, 'PAYMENT_PENDING'); assert.ok(o[0].deposit_cents > 0 && o[0].final_cents > 0);
  const offerStatus = (await app.pool.query('select status from offers where lead_id=$1 order by created_at desc', [id])).rows[0].status;
  assert.equal(offerStatus, 'ACCEPTED');
  // erneutes „Gekauft“ darf keine zweite Bestellung anlegen
  await call(app, id, 'BOUGHT').catch(() => null);
  assert.equal((await app.pool.query("select count(*)::int n from orders where lead_id=$1", [id])).rows[0].n, 1);
});

test('Nicht mehr kontaktieren sperrt Lead + Telefonnummer dauerhaft und blockiert weitere Ergebnisse', { skip }, async () => {
  const it = (await app.ctx.calls.queue()).items[0];
  const before = (await app.pool.query('select count(*)::int n from suppression_list where owner_id=$1', [OWNER])).rows[0].n;
  assert.match(await flash(app, await call(app, it.id, 'DO_NOT_CONTACT', { note: 'Anrufer will nicht' })), /Sperrliste/);
  const row = (await leadsWhere(app, `id='${it.id}'`))[0];
  assert.equal(row.status, 'IGNORED'); assert.equal(row.contact_blocked, true); assert.equal(row.contact_readiness, 'DO_NOT_CONTACT');
  assert.ok((await app.pool.query('select count(*)::int n from suppression_list where owner_id=$1', [OWNER])).rows[0].n > before);
  assert.ok(!(await app.ctx.calls.queue()).items.some((i: any) => i.id === it.id));
  assert.match(await flash(app, await call(app, it.id, 'NO_ANSWER')), /gesperrt/);
  // Sperrliste in den Einstellungen sichtbar, Eintrag nicht versehentlich verlierbar
  assert.match(app.text(await (await app.get('/settings')).text()), /Sperrliste/);
});

test('Ungültige Ergebnisse, fremde/unbekannte Lead-IDs und überlange Notizen werden sauber abgelehnt', { skip }, async () => {
  const it = (await app.ctx.calls.queue()).items[0];
  assert.match(await flash(app, await call(app, it.id, 'HACK')), /Ergebnis wählen/);
  assert.match(await flash(app, await call(app, it.id, 'NO_ANSWER', { note: 'x'.repeat(4001) })), /zu lang/);
  const r = await call(app, '00000000-0000-0000-0000-000000000000', 'NO_ANSWER');
  assert.ok([303, 404].includes(r.status));
  assert.equal((await leadsWhere(app, `id='${it.id}'`))[0].call_count, 0);
});

test('Tagesziel begrenzt die Liste (Rückrufe ausgenommen) und zeigt Fortschritt', { skip }, async () => {
  await app.post('/settings/phone', { enable: '1', dailyCallTarget: '2', callerName: 'Kai Test' });
  const q = await app.ctx.calls.queue();
  assert.ok(q.items.filter((i: any) => i.kind !== 'callback').length <= Math.max(0, 2 - q.done));
  assert.equal(q.target, 2);
  const page = app.text(await (await app.get('/calls')).text());
  assert.match(page, new RegExp(`${q.done} von 2 Leads bearbeitet`));
  await app.post('/settings/phone', { enable: '1', dailyCallTarget: '30', callerName: 'Kai Test' });
});

test('Telefonakquise wieder sperren entfernt alle Leads aus der Anrufliste', { skip }, async () => {
  await app.post('/settings/phone', { enable: '0', dailyCallTarget: '30' });
  assert.equal((await app.ctx.calls.queue()).items.length, 0);
  await enablePhone(app);
  assert.ok((await app.ctx.calls.queue()).items.length > 0);
});

test('Standard-Konfiguration (Platzhalter): Angebot nur als Entwurf, „Gekauft“ wird blockiert, Lead bleibt unverändert', { skip }, async () => {
  await quickSearch(appDefault); await enablePhone(appDefault);
  const items = (await appDefault.ctx.calls.queue()).items;
  assert.ok(items.length >= 2);
  const [a, b] = items.map((i: any) => i.id as string);
  const m = await flash(appDefault, await call(appDefault, a, 'OFFER'));
  assert.match(m, /Entwurf/); assert.match(m, /Platzhalter/);
  assert.equal(await status(appDefault, a), 'INTERESTED');
  assert.equal((await appDefault.pool.query('select status from offers where lead_id=$1', [a])).rows[0].status, 'DRAFT');
  // Entwurf mit Platzhaltern lässt sich auch manuell nicht freigeben
  const offerId = (await appDefault.pool.query('select id from offers where lead_id=$1', [a])).rows[0].id;
  assert.match(await flash(appDefault, await appDefault.post(`/offers/${offerId}/approve`)), /Platzhalter|nicht freigegeben|kann nicht/i);
  assert.equal((await appDefault.pool.query('select status from offers where id=$1', [offerId])).rows[0].status, 'DRAFT');

  const g = await flash(appDefault, await call(appDefault, b, 'BOUGHT'));
  assert.match(g, /Platzhalter/);
  assert.equal((await appDefault.pool.query('select count(*)::int n from orders where lead_id=$1', [b])).rows[0].n, 0);
  assert.equal(await status(appDefault, b), 'QUALIFIED');
  assert.equal((await appDefault.pool.query('select count(*)::int n from contact_history where lead_id=$1', [b])).rows[0].n, 0, 'fehlgeschlagenes „Gekauft“ wird nicht protokolliert');
});
