import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { seededApp, skip, type App } from './helpers.ts';

/** Phase F: manuelle Zahlungsbestätigung (Betrag, Status, paid_at, Referenz), Pipeline-Anzeige, ausdrückliche Veröffentlichungsfreigabe. Keine echte Zahlungsintegration, nichts wird veröffentlicht. */
const apps: App[] = []; after(async () => { for (const a of apps) await a.close(); });
const page = async (app: App, path: string) => app.text(await (await app.get(path)).text());
const flashOf = (loc: string | null) => decodeURIComponent(loc ?? '');

test('Angebot angenommen → Auftrag → Anzahlung manuell bestätigt (mit Referenz) → Produktion; Reihenfolge wird erzwungen; Pipeline zeigt die Schritte', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000511', { cfgDir: 'config.mock' }); apps.push(app);
  const lead = (await app.ctx.leads.list({ limit: 100 })).rows.find((l: any) => l.work_status === 'CONTACTABLE' && l.phone)!;
  await app.ctx.quotes.save(lead.id, { package: 'STARTER', care: 'CARE' }); const { offerId } = await app.ctx.offerFlow.createFromQuote(lead.id);
  await app.ctx.offerFlow.approve(offerId, { confirmPrices: true }); await app.ctx.sales.markOfferSent(offerId); const orderId = await app.ctx.orders.acceptOffer(lead.id);
  const ord = await app.ctx.orders.getOrder(orderId); assert.equal(ord.status, 'PAYMENT_PENDING'); assert.equal(ord.deposit_cents + ord.final_cents, 79000);
  const pg = await page(app, `/orders/${orderId}`); assert.match(await (await app.get(`/orders/${orderId}`)).text(), /aria-label="Auftragspipeline"/); for (const t of ['Anzahlung offen', 'Zahlung manuell bestätigen', 'Referenz']) assert.ok(pg.includes(t), t);
  assert.ok(pg.includes('Angebot angenommen') && pg.includes('Interne Kontrolle') && pg.includes('Kundenfreigabe') && pg.includes('Bereit zur Veröffentlichung') && pg.includes('Wartung'), 'alle Pipeline-Schritte sichtbar');
  // Fehlerfälle
  await assert.rejects(app.ctx.orders.confirmManualPayment(orderId, 'deposit', { reference: '' }), /Zahlungsreferenz/); await assert.rejects(app.ctx.orders.confirmManualPayment(orderId, 'final', { reference: 'Überweisung 14.10.' }), /nicht möglich/);
  const noCheck = await app.post(`/orders/${orderId}/payment/manual`, { kind: 'deposit', reference: 'Überweisung 14.10.' }); assert.equal(noCheck.status, 303); assert.equal((await app.ctx.orders.getOrder(orderId)).status, 'PAYMENT_PENDING', 'ohne Prüf-Bestätigung keine Buchung');
  // Bestätigen
  const ok = await app.post(`/orders/${orderId}/payment/manual`, { kind: 'deposit', reference: 'Überweisung 14.10., Betreff RE-2026-001', checked: '1' }); assert.equal(ok.status, 303);
  const o2 = await app.ctx.orders.getOrder(orderId); assert.equal(o2.status, 'IN_PRODUCTION'); const pays = await app.ctx.orders.payments(orderId); assert.equal(pays.length, 1); const p = pays[0];
  assert.equal(p.provider, 'manual'); assert.equal(p.kind, 'deposit'); assert.equal(p.status, 'paid'); assert.equal(p.amount_cents, ord.deposit_cents); assert.ok(p.paid_at); assert.equal(p.reference, 'Überweisung 14.10., Betreff RE-2026-001'); assert.equal(p.confirmed_by, 'user');
  assert.ok(await app.ctx.delivery.getProject(orderId), 'Produktionsprojekt vorbereitet (nicht veröffentlicht)'); assert.equal((await app.pool.query('select count(*)::int n from deployments where order_id=$1', [orderId])).rows[0].n, 0, 'nichts veröffentlicht');
  await assert.rejects(app.ctx.orders.confirmManualPayment(orderId, 'deposit', { reference: 'nochmal' }), /nicht möglich/, 'doppelte Bestätigung blockiert');
  const pg2 = await page(app, `/orders/${orderId}`); assert.ok(pg2.includes('Produktion vorbereitet') && pg2.includes('Anzahlung'), 'Pipeline weiter'); assert.equal((await app.pool.query("select count(*)::int n from events where lead_id=$1 and type='payment_confirmed_manually'", [lead.id])).rows[0].n, 1);
  // Restzahlung manuell (Reihenfolge: erst im Status FINAL_PAYMENT_PENDING) → FULLY_PAID; Veröffentlichung braucht ausdrückliche Freigabe
  await app.pool.query("update orders set status='FINAL_PAYMENT_PENDING' where id=$1", [orderId]); await app.ctx.orders.confirmManualPayment(orderId, 'final', { reference: 'Überweisung 28.10.' }); assert.equal((await app.ctx.orders.getOrder(orderId)).status, 'FULLY_PAID');
  const pg3 = await page(app, `/orders/${orderId}`); assert.ok(pg3.includes('Bereit zur Veröffentlichung') && pg3.includes('DEPLOY_APPROVAL'));
  const noAppr = await app.post(`/orders/${orderId}/deploy`, {}); assert.match(flashOf(noAppr.headers.get('location')), /ausdrücklich freigeben|f=/); assert.equal((await app.pool.query('select count(*)::int n from deployments where order_id=$1', [orderId])).rows[0].n, 0);
  assert.equal((await app.pool.query('select deploy_approved_at from orders where id=$1', [orderId])).rows[0].deploy_approved_at, null, 'ohne Freigabe kein Vermerk');
  assert.equal((await app.pool.query('select count(*)::int n from outbox where owner_id = $1', [app.ctx.repo.ownerId])).rows[0].n, 0, 'nichts gesendet');
});
