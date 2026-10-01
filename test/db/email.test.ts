import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appSetup, skip, enablePhone, quickSearch, leadsWhere, makeCustomer, type App } from './helpers.ts';

const OWNER = '00000000-0000-0000-0000-0000000000f5';
let app: App;
before(async () => { if (skip) return; app = await appSetup(OWNER, { cfgDir: 'config.mock' }); await enablePhone(app); await quickSearch(app); });
after(async () => { if (!skip) await app.close(); });
const flash = async (r: Response) => app.text(await app.follow(r));
const outbox = async (where = 'true') => (await app.pool.query(`select kind, to_addr, subject, body, status, provider from outbox where owner_id=$1 and ${where} order by created_at`, [OWNER])).rows as any[];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('Einstellungen: Adresse prüfen/speichern, Test-Mail landet im Postausgang (Mock: nicht verschickt, deutlich gekennzeichnet)', { skip }, async () => {
  assert.match(app.text(await (await app.get('/settings')).text()), /nicht verschickt/);
  assert.match(await flash(await app.post('/settings/notify', { notifyEmail: 'keine-mail', notifyEnabled: '1' })), /ungültig/);
  assert.match(await flash(await app.post('/settings/notify', { notifyEmail: 'chef@beispiel.example', notifyEnabled: '1', test: '1' })), /Mock-Modus.*Postausgang/);
  const s = await app.repo.getSettings(); assert.equal(s.notifyEmail, 'chef@beispiel.example'); assert.equal(s.notifyEnabled, true);
  const [m] = await outbox("kind='test'"); assert.equal(m.to_addr, 'chef@beispiel.example'); assert.equal(m.status, 'mock_recorded'); assert.equal(m.provider, 'mock-email');
  const page = app.text(await (await app.get('/outbox')).text());
  assert.match(page, /Test-E-Mail von AI Agency OS/); assert.match(page, /nichts davon wurde wirklich verschickt/); assert.match(page, /nur aufgezeichnet/);
});

test('Benachrichtigungen: Zahlungen, Freigabe/Änderung und Wartungsproblem lösen Mails an den Betreiber aus; abschaltbar', { skip }, async () => {
  const l = (await leadsWhere(app, "status='QUALIFIED' and contact_readiness='READY_FOR_MANUAL_CALL'"))[0];
  const c = await makeCustomer(app, l.id, { stopAt: 'review' });
  await wait(900);
  let subj = (await outbox("kind like 'owner_%'")).map((m) => m.subject);
  assert.ok(subj.some((s) => /Anzahlung eingegangen/.test(s)), subj.join(' | '));
  assert.ok(subj.some((s) => /wartet auf Kundenfreigabe/.test(s)), subj.join(' | '));
  const mail = (await outbox("kind='owner_order'"))[0]; assert.equal(mail.to_addr, 'chef@beispiel.example'); assert.match(mail.body, /\/orders\//);
  await app.ctx.delivery.decide(c.token, 'changes', 'Bitte Telefonnummer ändern');
  await wait(600);
  assert.ok((await outbox("kind='owner_review'")).some((m) => /Änderungswunsch/.test(m.subject) && /Telefonnummer/.test(m.body)));
  // abgeschaltet → keine neuen Mails
  await app.post('/settings/notify', { notifyEmail: 'chef@beispiel.example' });
  const n = (await outbox()).length;
  await app.ctx.notifier.notifyOwner('owner_order', 'x', 'y'); await wait(300);
  assert.equal((await outbox()).length, n);
  await app.post('/settings/notify', { notifyEmail: 'chef@beispiel.example', notifyEnabled: '1' });
});

test('Kunden-Mail aus dem Auftrag: Freigabe-Link und Zahlungslink, Sperrliste und ungültige Adressen werden abgelehnt', { skip }, async () => {
  const o = (await app.pool.query("select o.id, o.review_token from orders o where o.owner_id=$1 and o.review_token is not null limit 1", [OWNER])).rows[0];
  const page = app.text(await (await app.get(`/orders/${o.id}`)).text()); assert.match(page, /E-Mail an den Kunden/);
  assert.match(await flash(await app.post(`/orders/${o.id}/mail`, { what: 'deposit', to: 'kunde@beispiel.example' })), /Kein offener Zahlungslink/);
  assert.match(await flash(await app.post(`/orders/${o.id}/mail`, { what: 'review', to: 'kein-mail' })), /gültige E-Mail/);
  assert.match(await flash(await app.post(`/orders/${o.id}/mail`, { what: 'hack', to: 'kunde@beispiel.example' })), /auswählen/);
  assert.match(await flash(await app.post(`/orders/${o.id}/mail`, { what: 'review', to: 'kunde@beispiel.example' })), /Postausgang aufgezeichnet/);
  const m = (await outbox("kind='customer_review'"))[0];
  assert.equal(m.to_addr, 'kunde@beispiel.example'); assert.ok(m.body.includes(`/r/${o.review_token}`)); assert.doesNotMatch(m.body, /undefined|\[object/);
  await app.post('/settings/suppression', { kind: 'email', value: 'optout@beispiel.example', reason: 'Opt-out' });
  assert.match(await flash(await app.post(`/orders/${o.id}/mail`, { what: 'review', to: 'optout@beispiel.example' })), /Sperrliste/);
  assert.equal((await outbox("to_addr='optout@beispiel.example'")).length, 0);
  // Zahlungslink-Mail nach „Link erstellen“
  const l2 = (await leadsWhere(app, "status='QUALIFIED' and contact_readiness='READY_FOR_MANUAL_CALL'"))[0];
  const call = await app.ctx.calls.applyResult(l2.id, 'BOUGHT');
  await app.post(`/orders/${call.orderId}/checkout/deposit`);
  assert.match(await flash(await app.post(`/orders/${call.orderId}/mail`, { what: 'deposit', to: 'kunde2@beispiel.example' })), /Postausgang aufgezeichnet/);
  const pm = (await outbox("kind='customer_deposit'"))[0]; assert.match(pm.body, /\/mock-pay\/mock_cs_[0-9a-f]{24}/); assert.match(pm.subject, /Anzahlung/);
});

test('Postausgang: Fehler beim Senden werden protokolliert statt zu stören; nichts geht an Interessenten', { skip }, async () => {
  const mail = app.ctx.registry.providers.email as any; const orig = mail.send;
  mail.send = async () => { throw new Error('SMTP 535: Anmeldung abgelehnt'); };
  try {
    const r = await app.ctx.notifier.send('test', 'a@beispiel.example', 'Betreff', 'Text');
    assert.equal(r.ok, false); assert.match(r.error!, /535/);
    const f = (await outbox("status='failed'"))[0]; assert.equal(f.to_addr, 'a@beispiel.example');
    assert.match(app.text(await (await app.get('/outbox')).text()), /fehlgeschlagen/);
  } finally { mail.send = orig; }
  // Kaltkontakte: Mails gibt es nur an chef@ und kunde*@ (Betreiber/Kunden), nie an Leads ohne Auftrag
  const leadMails = (await app.pool.query("select count(*)::int n from outbox where owner_id=$1 and kind not like 'owner_%' and kind not like 'customer_%' and kind <> 'test'", [OWNER])).rows[0].n;
  assert.equal(leadMails, 0);
});

test('Tagesübersicht: Zahlen stimmen, Knopf sendet, automatisch nur einmal pro Tag', { skip }, async () => {
  const r = await flash(await app.post('/settings/notify', { notifyEmail: 'chef@beispiel.example', notifyEnabled: '1', digest: '1' }));
  assert.match(r, /Tagesübersicht im Postausgang aufgezeichnet/);
  const [d] = (await outbox("kind='owner_digest'")).slice(-1);
  assert.match(d.subject, /Tagesübersicht/); assert.match(d.body, /neue Leads bereit/); assert.match(d.body, /warten auf Kundenfreigabe/); assert.match(d.body, /\/calls/);
  const n = (await outbox("kind='owner_digest'")).length;
  assert.equal(await app.ctx.notifier.dailyDigest(), null, 'heute schon gesendet');
  assert.equal((await outbox("kind='owner_digest'")).length, n);
  await app.post('/settings/notify', { notifyEmail: 'chef@beispiel.example' });
  assert.equal(await app.ctx.notifier.dailyDigest({ force: true }), null, 'abgeschaltet → keine Mail');
  await app.post('/settings/notify', { notifyEmail: 'chef@beispiel.example', notifyEnabled: '1' });
});
