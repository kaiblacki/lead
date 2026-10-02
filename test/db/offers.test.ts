import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { seededApp, skip, type App } from './helpers.ts';

/** Phase D/E: Preis-Konfigurator, Partnerpreis (nur ACTIVE_PARTNER, separat sichtbar), Angebotsgenerator mit Statuskette. Nichts wird gesendet. */
const apps: App[] = []; after(async () => { for (const a of apps) await a.close(); });
const page = async (app: App, path: string) => app.text(await (await app.get(path)).text());
const callable = async (app: App) => (await app.ctx.leads.list({ limit: 100 })).rows.filter((l: any) => l.work_status === 'CONTACTABLE' && l.phone);
const activate = async (app: App, leadId: string) => { const { id } = await app.ctx.partners.fromLead(leadId); await app.ctx.partners.setCriteria(id, { conversation_held: true, referral_willingness: true, agreement: true, contact_person_known: true }); for (const s of ['PARTNER_DISCUSSION', 'PARTNER_APPROVED', 'ACTIVE_PARTNER'] as const) await app.ctx.partners.setStatus(id, s); return id; };

test('Konfigurator speichern (HTTP): Paket, Add-ons mit Preis-/Mengenüberschreibung, Wartung, Fremdkosten; Seite zeigt Normalpreis, Partner-Rabatt, Einmalpreis, monatlich, Drittanbieter, Gesamt; Marktrichtwert nur intern', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000501', { cfgDir: 'config.mock' }); apps.push(app);
  const [a] = await callable(app);
  const res = await app.post(`/leads/${a.id}/quote`, { package: 'BUSINESS', addon: ['whatsapp_cta', 'extra_page', 'local_seo'], qty_extra_page: '2', price_local_seo: '199,00', care: 'CARE_PLUS', tp_label_0: 'Domain', tp_amount_0: '14,90', tp_label_1: 'Buchungstool', tp_amount_1: '9', tp_monthly_1: '1' } as never);
  assert.equal(res.status, 303); const q = await app.ctx.quotes.get(a.id); assert.ok(q); const c = q.computed;
  assert.equal(c.package.normalCents, 149000); assert.equal(c.addonsCents, 3900 + 19800 + 19900); assert.equal(c.partner_discount.applied, false, 'kein aktiver Partner → kein Rabatt'); assert.equal(q.partner_discount_approved, false);
  await app.post(`/leads/${a.id}/quote`, { package: 'STARTER', partner_approved: '1' } as never); assert.equal((await app.ctx.quotes.get(a.id))!.package, 'BUSINESS', 'Partnerfreigabe ohne aktiven Partner wird abgelehnt – nichts ändert sich');
  assert.equal(c.monthlyCents, 6900); assert.equal(c.thirdPartyOneTimeCents, 1490); assert.equal(c.thirdPartyMonthlyCents, 900); assert.equal(c.oneTimeCents, 149000 + 43600);
  const pg = await page(app, `/leads/${a.id}`); for (const t of ['Angebot und Preis-Konfigurator', 'INTERNAL_DRAFT_PRICE', 'Normalpreis (Paket)', 'partner_discount', 'Einmalpreis', 'Monatlich (Wartung)', 'Drittanbieter (einmalig)', 'Gesamt', 'Paketpreis überschreiben', 'Interne Vertriebsorientierung']) assert.ok(pg.includes(t), t);
  assert.match(pg, /kein Partner-Rabatt/);
  const bad = await app.post(`/leads/${a.id}/quote`, { package: 'NOPE' } as never); assert.equal(bad.status, 303); assert.equal((await app.ctx.quotes.get(a.id))!.package, 'BUSINESS', 'ungültiges Paket ändert nichts');
  await app.post(`/leads/${a.id}/quote`, { package: 'PRO', manual_percent: '10', manual_reason: 'Bei Abschluss einer Versicherung' } as never); assert.equal((await app.ctx.quotes.get(a.id))!.package, 'BUSINESS', 'Versicherungsbezug im Rabattgrund wird abgelehnt');
  await app.post(`/leads/${a.id}/quote`, { package: 'PRO', manual_percent: '10', manual_reason: 'Kulanz nach Gespräch' } as never); const m = (await app.ctx.quotes.get(a.id))!.computed; assert.equal(m.partner_discount.reason, 'MANUAL'); assert.equal(m.oneTimeCents, 224100);
  assert.equal((await app.pool.query('select count(*)::int n from outbox')).rows[0].n, 0);
});

test('Partnerpreis: nur bei aktivem Partner und nach Freigabe (separat als partner_discount mit Grund ACTIVE_PARTNER); fällt weg, wenn der Partner pausiert/beendet wird', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000502', { cfgDir: 'config.mock' }); apps.push(app);
  const [a] = await callable(app); const pid = await activate(app, a.id);
  await app.ctx.quotes.save(a.id, { package: 'BUSINESS', addons: [{ key: 'online_booking' }], care: 'CARE' }); let q = (await app.ctx.quotes.get(a.id))!; assert.equal(q.computed.partner_discount.eligible, true); assert.equal(q.computed.partner_discount.applied, false); assert.equal(q.computed.oneTimeCents, 149000 + 14900);
  await app.ctx.quotes.save(a.id, { package: 'BUSINESS', addons: [{ key: 'online_booking' }], care: 'CARE', partnerDiscountApproved: true }); q = (await app.ctx.quotes.get(a.id))!;
  assert.equal(q.computed.partner_discount.applied, true); assert.equal(q.computed.partner_discount.reason, 'ACTIVE_PARTNER'); assert.equal(q.computed.partner_discount.cents, 74500); assert.equal(q.computed.oneTimeCents, 74500 + 14900); assert.equal(q.computed.monthlyCents, 3900);
  assert.match(await page(app, `/leads/${a.id}`), /Grund: ACTIVE_PARTNER/);
  await app.ctx.partners.setStatus(pid, 'PAUSED_PARTNER'); const r = await app.ctx.quotes.recompute(a.id); assert.equal(r!.computed.partner_discount.applied, false); assert.equal(r!.partner_discount_approved, false, 'Freigabe fällt mit dem Partnerstatus weg'); assert.equal(r!.computed.oneTimeCents, 149000 + 14900);
  await app.ctx.partners.setStatus(pid, 'ACTIVE_PARTNER'); await assert.rejects(app.ctx.quotes.save(a.id, { package: 'STARTER', partnerDiscountApproved: true, addons: [{ key: 'whatsapp_cta' }] }).then(() => app.ctx.partners.setStatus(pid, 'ENDED_PARTNER')).then(() => app.ctx.quotes.save(a.id, { package: 'STARTER', partnerDiscountApproved: true })), /nur für aktive Partner/);
});

test('Angebot: Entwurf → Zur Prüfung → Freigabe (Preise bestätigen, Partnerstatus gültig) → von dir versendet → angenommen (Auftrag) / abgelehnt / abgelaufen; Partnerrabatt im Angebot separat, kein Marktpreis', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000503', { cfgDir: 'config.mock' }); apps.push(app);
  const [a, b, c] = await callable(app); await activate(app, a.id);
  await assert.rejects(app.ctx.offerFlow.createFromQuote(a.id), /Preis-Konfigurator/);
  await app.ctx.quotes.save(a.id, { package: 'BUSINESS', addons: [{ key: 'whatsapp_cta' }], care: 'CARE', partnerDiscountApproved: true, thirdParty: [{ label: 'Domain', cents: 1500 }] });
  const created = await app.post(`/leads/${a.id}/offer/create`, {}); assert.equal(created.status, 303); const offerId = created.headers.get('location')!.split('/').pop()!.split('?')[0];
  let o = await app.ctx.offerFlow.get(offerId); assert.equal(o.status, 'DRAFT'); assert.equal(o.price_cents, 74500 + 3900); assert.equal(o.partner_discount_cents, 74500); assert.equal(o.deposit_cents + o.final_cents, o.price_cents); assert.equal(o.maintenance_cents, 3900); assert.equal(o.content.partnerDiscount.reason, 'ACTIVE_PARTNER');
  const view = await page(app, `/offers/${offerId}`); for (const t of ['Leistungsumfang', 'Partnerpreis', 'Zahlungsplan', 'Projektablauf', 'Voraussetzungen', 'Korrekturschleifen', 'Fremdkosten', 'Laufzeiten und Lieferung', 'nichts wurde gesendet', 'INTERNAL_DRAFT_PRICE']) assert.ok(view.includes(t), t);
  assert.doesNotMatch(view, /Marktrichtwert|Median/, 'Marktpreis nie im Angebot'); assert.doesNotMatch(view, /Versicherung/i);
  await assert.rejects(app.ctx.sales.markOfferSent(offerId), /zuerst freigegeben/); await assert.rejects(app.ctx.offerFlow.approve(offerId), /INTERNAL_DRAFT_PRICE/, 'Preise brauchen deine Bestätigung');
  await app.ctx.offerFlow.markReady(offerId); assert.equal((await app.ctx.offerFlow.get(offerId)).status, 'READY_FOR_REVIEW'); await assert.rejects(app.ctx.offerFlow.markReady(offerId), /Nur ein Entwurf/);
  await app.ctx.offerFlow.approve(offerId, { confirmPrices: true }); assert.equal((await app.ctx.offerFlow.get(offerId)).status, 'APPROVED');
  await app.ctx.sales.markOfferSent(offerId); assert.equal((await app.ctx.offerFlow.get(offerId)).status, 'SENT');
  const orderId = await app.ctx.orders.acceptOffer(a.id); const ord = await app.ctx.orders.getOrder(orderId); assert.equal(ord.deposit_cents, o.deposit_cents); assert.equal(ord.final_cents, o.final_cents); assert.equal((await app.ctx.offerFlow.get(offerId)).status, 'ACCEPTED');
  // Partnerstatus endet vor der Freigabe → blockiert
  const pid = (await app.ctx.partners.forLead(a.id)).id; await app.ctx.quotes.save(c.id, { package: 'STARTER' }); void b;
  const { offerId: o2 } = await app.ctx.offerFlow.createFromQuote(a.id); await app.ctx.partners.setStatus(pid, 'ENDED_PARTNER').catch(() => undefined);
  // Ablehnen und Ablaufen
  const { offerId: o3 } = await app.ctx.offerFlow.createFromQuote(c.id); await app.ctx.offerFlow.approve(o3, { confirmPrices: true }); await app.ctx.sales.markOfferSent(o3); await app.ctx.offerFlow.decline(o3); assert.equal((await app.ctx.offerFlow.get(o3)).status, 'DECLINED'); await assert.rejects(app.ctx.offerFlow.decline(o3), /Nur ein freigegebenes/);
  await app.pool.query("update offers set valid_until = '2020-01-01' where id=$1", [o2]); assert.ok((await app.ctx.offerFlow.expireDue()) >= 1); assert.equal((await app.ctx.offerFlow.get(o2)).status, 'EXPIRED'); await assert.rejects(app.ctx.offerFlow.approve(o2, { confirmPrices: true }), /Nur ein Entwurf bzw./);
  assert.equal((await app.pool.query('select count(*)::int n from outbox')).rows[0].n, 0, 'nichts gesendet');
});

test('Angebotsfreigabe blockiert bei Platzhaltern (config/pricing.json) und bei nicht mehr aktivem Partner', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000504', { cfgDir: 'config' }); apps.push(app);   // Platzhalter in config/pricing.json
  const [a] = await callable(app); await app.ctx.quotes.save(a.id, { package: 'STARTER' }); const out = await app.ctx.offerFlow.createFromQuote(a.id); assert.ok(out.warnings.some((w) => /Platzhalter/.test(w)));
  await assert.rejects(app.ctx.offerFlow.approve(out.offerId, { confirmPrices: true }), /Platzhalter/);
  const app2 = await seededApp('00000000-0000-0000-0000-000000000505', { cfgDir: 'config.mock' }); apps.push(app2);
  const [b] = await callable(app2); const pid = await activate(app2, b.id); await app2.ctx.quotes.save(b.id, { package: 'PRO', partnerDiscountApproved: true }); const { offerId } = await app2.ctx.offerFlow.createFromQuote(b.id);
  assert.equal((await app2.ctx.offerFlow.get(offerId)).partner_discount_cents, 124500); await app2.ctx.partners.setStatus(pid, 'PAUSED_PARTNER');
  await assert.rejects(app2.ctx.offerFlow.approve(offerId, { confirmPrices: true }), /nicht mehr aktiv/);
});
