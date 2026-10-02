import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { seededApp, skip, type App } from './helpers.ts';

/** Phase H: Kundenprofil aus bezahltem Auftrag, Wartungsübersicht mit Änderungsbudget, Änderungswünsche (Freigabe nötig), Portal per Token. Nichts wird gesendet. */
const apps: App[] = []; after(async () => { for (const a of apps) await a.close(); });
const page = async (app: App, path: string) => app.text(await (await app.get(path)).text());

async function paidOrder(app: App, care = 'CARE_PLUS') {
  const lead = (await app.ctx.leads.list({ limit: 100 })).rows.find((l: any) => l.work_status === 'CONTACTABLE' && l.phone)!;
  await app.ctx.quotes.save(lead.id, { package: 'STARTER', care }); const { offerId } = await app.ctx.offerFlow.createFromQuote(lead.id);
  await app.ctx.offerFlow.approve(offerId, { confirmPrices: true }); await app.ctx.sales.markOfferSent(offerId); const orderId = await app.ctx.orders.acceptOffer(lead.id);
  return { lead, orderId };
}

test('Kundenprofil: erst nach vollständiger Zahlung; Profil übernimmt Paket/Pflege; idempotent; Änderungsbudget je Pflegepaket', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000701', { cfgDir: 'config.mock' }); apps.push(app);
  const { lead, orderId } = await paidOrder(app);
  await assert.rejects(app.ctx.customers.createFromOrder(orderId), /vollständiger Bezahlung/);
  await app.pool.query("update orders set status = 'FULLY_PAID' where id = $1", [orderId]);
  assert.equal((await app.ctx.customers.ordersWithoutProfile()).length, 1);
  const res = await app.post(`/customers/from-order/${orderId}`, {}); assert.equal(res.status, 303);
  const cid = await app.ctx.customers.createFromOrder(orderId); assert.equal((await app.ctx.customers.list()).length, 1, 'idempotent');
  const c = await app.ctx.customers.get(cid); assert.equal(c.package, 'STARTER'); assert.equal(c.care, 'CARE_PLUS'); assert.equal(c.lead_id, lead.id); assert.match(c.portal_token, /^[0-9a-f]{64}$/);
  const m = await app.ctx.customers.maintenance(cid); assert.equal(m!.includedChanges, 2); assert.equal(m!.remaining, 2); assert.equal(m!.monthlyCents, 6900);
  const pg = await page(app, `/customers/${cid}`); for (const t of ['Wartung', 'Care Plus', 'nächste Abrechnung', 'Änderungen diesen Monat', 'Kundenportal', 'nicht automatisch versendet']) assert.ok(pg.includes(t), t);
  assert.ok((await page(app, '/customers')).includes(c.company_name));
});

test('Änderungswünsche: Statuskette, Freigabe verlangt Zuordnung (im Paket / Extra mit Preis), verbraucht Budget, nichts wird gesendet', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000702', { cfgDir: 'config.mock' }); apps.push(app);
  const { orderId } = await paidOrder(app); await app.pool.query("update orders set status = 'DEPLOYED' where id = $1", [orderId]); const cid = await app.ctx.customers.createFromOrder(orderId);
  const post = await app.post(`/customers/${cid}/request`, { title: 'Öffnungszeiten ändern' }); assert.equal(post.status, 303);
  const [q] = await app.ctx.customers.requests(cid); assert.equal(q.status, 'NEW'); assert.equal(q.source, 'manual');
  await assert.rejects(app.ctx.customers.setRequestStatus(q.id, 'DONE'), /nicht möglich/); await assert.rejects(app.ctx.customers.setRequestStatus(q.id, 'APPROVED'), /nicht möglich/);
  await app.ctx.customers.setRequestStatus(q.id, 'IN_REVIEW');
  await assert.rejects(app.ctx.customers.setRequestStatus(q.id, 'APPROVED'), /im Wartungspaket/); await assert.rejects(app.ctx.customers.setRequestStatus(q.id, 'APPROVED', { scope: 'EXTRA' }), /Preis/);
  await app.ctx.customers.setRequestStatus(q.id, 'APPROVED', { scope: 'IN_PLAN' }); assert.equal((await app.ctx.customers.maintenance(cid))!.usedChanges, 1);
  await app.ctx.customers.setRequestStatus(q.id, 'IN_PROGRESS'); await app.ctx.customers.setRequestStatus(q.id, 'DONE'); assert.equal((await app.ctx.customers.maintenance(cid))!.remaining, 1);
  const q2 = await app.ctx.customers.addRequest(cid, 'Neue Unterseite', 'Team-Seite'); await app.ctx.customers.setRequestStatus(q2, 'IN_REVIEW');
  await app.ctx.customers.setRequestStatus(q2, 'APPROVED', { scope: 'EXTRA', extraPriceCents: 9900 }); const r2 = (await app.ctx.customers.requests(cid)).find((x: any) => x.id === q2); assert.equal(r2.extra_price_cents, 9900); assert.equal((await app.ctx.customers.maintenance(cid))!.usedChanges, 1, 'Extra zählt nicht gegen das Budget');
  assert.ok((await page(app, `/customers/${cid}`)).includes('Extra-Aufwand: 99,00'));
  const q3 = await app.ctx.customers.addRequest(cid, 'Abgelehnt'); await app.ctx.customers.setRequestStatus(q3, 'DECLINED'); await assert.rejects(app.ctx.customers.setRequestStatus(q3, 'IN_REVIEW'), /nicht möglich/);
  assert.equal((await app.pool.query('select count(*)::int n from outbox')).rows[0].n, 0);
});

test('Portal per Token: sieht nur eigene Daten, kann Änderungswunsch senden (landet als NEU + Aufgabe), ungültiger/erneuerter Token → 404; keine Preise/Rechnungen/Partnerdaten', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000703', { cfgDir: 'config.mock' }); apps.push(app);
  const { orderId } = await paidOrder(app); await app.pool.query("update orders set status = 'MAINTENANCE_ACTIVE' where id = $1", [orderId]); const cid = await app.ctx.customers.createFromOrder(orderId);
  const tok = (await app.ctx.customers.get(cid)).portal_token;
  const pg = await page(app, `/c/${tok}`); assert.ok(pg.includes('Änderung anfragen') && pg.includes('Care Plus')); assert.doesNotMatch(pg, /€|Rechnung|Partner|Anzahlung|csrf/i);
  const bad = await app.get(`/c/${'0'.repeat(64)}`); assert.equal(bad.status, 404);
  const sent = await app.post(`/c/${tok}/request`, { title: 'Logo austauschen', detail: 'Neues Logo folgt' }); assert.ok([302, 303].includes(sent.status), `status ${sent.status}`);
  const reqs = await app.ctx.customers.requests(cid); assert.equal(reqs.length, 1); assert.equal(reqs[0].source, 'portal'); assert.equal(reqs[0].status, 'NEW');
  assert.ok((await app.pool.query("select 1 from tasks where customer_id = $1 and type = 'CUSTOMER_REQUEST'", [cid])).rowCount! >= 1);
  assert.equal((await app.get(`/c/${tok}`).then((x) => x.status)), 200);
  await app.ctx.customers.rotatePortalToken(cid); assert.equal((await app.get(`/c/${tok}`)).status, 404, 'alter Link ungültig');
  await app.ctx.customers.update(cid, { status: 'ENDED' }); const t2 = (await app.ctx.customers.get(cid)).portal_token;
  assert.equal((await app.post(`/c/${t2}/request`, { title: 'x ändern' })).status, 403);
  assert.equal((await app.pool.query('select count(*)::int n from outbox')).rows[0].n, 0, 'nichts gesendet');
});
