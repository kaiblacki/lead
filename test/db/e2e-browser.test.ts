import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { findChromium } from '../../src/providers/real/render.ts';
import { seededApp, skip, AUTH, type App } from './helpers.ts';

/**
 * Abnahme im echten Browser (Chromium, 390 px): der gesamte Kreislauf von der Suche bis zu Analytics – mit den echten Formularen des Dashboards.
 * Mock-Konfiguration; es wird nichts gesendet, bezahlt oder veröffentlicht (Zahlungen manuell bestätigt, Veröffentlichung nur lokal/Mock-Hosting).
 * Mit SHOTS_DIR=… werden Screenshots je Station gespeichert.
 */
const apps: App[] = []; after(async () => { for (const a of apps) await a.close(); });
const steps: string[] = [];

async function submit(page: Page, action: string, fields: Record<string, string | boolean | string[]> = {}, o: { nth?: number; button?: string; has?: string } = {}) {
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { (d as HTMLDetailsElement).open = true; }));
  const forms = page.locator(`form[action="${action}"]`); const form = (o.has ? forms.filter({ has: page.locator(o.has) }) : forms).nth(o.nth ?? 0); assert.ok(await form.count() > 0 || (await page.locator(`form[action="${action}"]`).count()) > 0, `Formular ${action} fehlt auf ${page.url()}`);
  for (const [name, value] of Object.entries(fields)) {
    const el = form.locator(`[name="${name}"]`).first(); assert.ok(await el.count() > 0, `Feld ${name} fehlt in ${action}`);
    const tag = await el.evaluate((e) => e.tagName.toLowerCase() + ':' + ((e as HTMLInputElement).type ?? ''));
    if (tag === 'input:hidden') assert.equal(await el.getAttribute('value'), String(value)); else if (tag === 'select:select-one') await el.selectOption(String(value)); else if (tag === 'input:checkbox') { if (Array.isArray(value)) for (const v of value) await form.locator(`[name="${name}"][value="${v}"]`).check(); else await el.setChecked(Boolean(value)); }
    else if (tag === 'input:radio') await form.locator(`[name="${name}"][value="${value}"]`).check(); else await el.fill(String(value));
  }
  await Promise.all([page.waitForLoadState('load'), (o.button ? page.locator(`form[action="${action}"] ${o.button}`).first() : form.locator('button').last()).click()]);
}
const text = async (page: Page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
const lead = (app: App, id: string, tab = 'alle') => `/leads/${id}?tab=${tab}`;

test('Browser-Abnahme: Suche → Lead → Strategie → Assistent → Partner → Demo → Anruf → Rückruf → Partnerstatus → Paket/Partnerpreis → Angebot → Auftrag → Anzahlung → Produktion → Freigabe → Restzahlung → Veröffentlichung → Kunde → Wartung → Community → Analytics', { skip: skip || (findChromium() ? false : 'Chromium nicht gefunden'), timeout: 600_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000a01', { cfgDir: 'config.mock' }); apps.push(app);
  const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] }); const shots = process.env.SHOTS_DIR; if (shots) mkdirSync(shots, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, extraHTTPHeaders: AUTH, baseURL: app.base }); const page = await ctx.newPage(); const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`)); page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
  const shot = async (name: string) => { steps.push(name); if (shots) await page.screenshot({ path: join(shots, `${String(steps.length).padStart(2, '0')}-${name}.png`), fullPage: true }); };
  try {
    // 1 Suche (echtes Formular, Synthetik-Provider, Mock-Config)
    await page.goto('/search'); await submit(page, '/search/quick', { q: 'Saarlouis + 20 km + Nagelstudios' }); await app.ctx.runner.idle(); await shot('suche');
    // 2 Lead: Liste nach Handlungspriorität, Detailseite mit Reitern
    await page.goto('/leads?sort=action'); assert.match(await text(page), /Handlungspriorität/); await shot('leads');
    const row = (await app.pool.query("select id, company_name from leads where owner_id = $1 and phone is not null and work_status = 'CONTACTABLE' and status in ('QUALIFIED','DEMO_CREATED') order by action_priority desc nulls last limit 1", [app.ctx.repo.ownerId])).rows[0]; assert.ok(row, 'Lead mit Telefon'); const id = row.id as string;
    await page.goto(lead(app, id, 'uebersicht')); const t0 = await text(page); for (const w of ['ÜBERSICHT', 'VERKAUF', 'WEBSITE', 'DEMO', 'PARTNER', 'BEDARFSANALYSE', 'ANGEBOT', 'VERLAUF', 'ANRUFEN']) assert.ok(t0.includes(w), w); await shot('lead-uebersicht');
    // 3 Strategie (Kontaktstrategie: System empfiehlt, Kai entscheidet)
    await page.goto(lead(app, id)); await submit(page, `/leads/${id}/strategy`, {}, { button: 'button[value="CALL_AND_DEMO"]' }); assert.equal((await app.pool.query('select contact_strategy c from leads where id=$1', [id])).rows[0].c, 'CALL_AND_DEMO');
    // 4 Verkaufsassistent
    await page.goto(lead(app, id, 'verkauf')); await submit(page, `/leads/${id}/copilot`, {}); assert.match(await text(page), /Verkaufsassistent/); await shot('verkaufsassistent');
    // 5 Partner-Kandidat (nur vormerken)
    await page.goto(lead(app, id, 'partner')); await submit(page, `/leads/${id}/partner/candidate`, {}); const partner = (await app.ctx.partners.forLead(id))!; assert.equal(partner.status, 'PARTNER_CANDIDATE'); await shot('partner-kandidat');
    // 6 Demo: schnelle Standard-Demo nach ausdrücklicher Bestätigung
    await page.goto(lead(app, id, 'demo')); await submit(page, `/leads/${id}/demo/quick`, { family: 'APPOINTMENT', confirm: true }); assert.ok((await app.pool.query('select count(*)::int n from demos where lead_id=$1', [id])).rows[0].n >= 1, 'Demo vorhanden'); await shot('demo');
    // 7 Anruf mit Rückruf; Aufgabe entsteht
    await page.goto(lead(app, id, 'uebersicht')); const cb = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 16);
    await submit(page, `/leads/${id}/call`, { note: 'Rückruf Donnerstag', callback: cb }, { button: 'button[name="result"][value="CALL_BACK"]' }); assert.ok((await app.pool.query("select count(*)::int n from tasks where lead_id=$1 and type in ('CALLBACK','CALL')", [id])).rows[0].n >= 1, 'Rückruf-Aufgabe'); await page.goto('/tasks'); await shot('aufgaben');
    // 8 Partnerstatus: Kriterien → Gespräch → freigegeben → aktiv (im Browser)
    await page.goto(`/partners/${partner.id}`); await submit(page, `/partners/${partner.id}/criteria`, { crit: ['conversation_held', 'referral_willingness', 'agreement', 'contact_person_known'] });
    for (const to of ['PARTNER_DISCUSSION', 'PARTNER_APPROVED', 'ACTIVE_PARTNER']) { await page.goto(`/partners/${partner.id}`); const f = page.locator(`form[action="/partners/${partner.id}/status"]`).filter({ has: page.locator(`input[value="${to}"]`) }).first(); assert.ok(await f.count() > 0, `Statuswechsel ${to} angeboten`); await Promise.all([page.waitForLoadState('load'), f.locator('button').click()]); }
    assert.equal((await app.ctx.partners.get(partner.id)).status, 'ACTIVE_PARTNER'); await shot('partner-aktiv');
    // 9 Paket/Add-ons/Partnerpreis (Rabatt nur nach ausdrücklicher Freigabe, separat ausgewiesen)
    await page.goto(lead(app, id, 'angebot')); await submit(page, `/leads/${id}/quote`, { package: 'BUSINESS', addon: ['whatsapp_cta', 'online_booking'], care: 'CARE_PLUS', partner_approved: true });
    const q = (await app.ctx.quotes.get(id))!; assert.equal(q.computed.partner_discount.applied, true); assert.equal(q.computed.partner_discount.reason, 'ACTIVE_PARTNER'); assert.equal(q.computed.partner_discount.cents, 74500, '50 % nur auf den Paketpreis');
    await page.goto(lead(app, id, 'angebot')); const tq = await text(page); for (const w of ['partner_discount', 'ACTIVE_PARTNER', 'INTERNAL_DRAFT_PRICE']) assert.ok(tq.includes(w), w); assert.doesNotMatch(tq, /2\.800|Marktrichtwert/); await shot('konfigurator');
    // 10 Angebot: erstellen → zur Prüfung → Preise bestätigen → freigeben → von Kai versendet → angenommen (Annahme simuliert: Kunde sagt zu)
    await submit(page, `/leads/${id}/offer/create`, {}); const offer = (await app.ctx.offerFlow.forLead(id))[0]; assert.ok(offer); await page.goto(`/offers/${offer.id}`); await submit(page, `/offers/${offer.id}/ready`, {});
    await page.goto(`/offers/${offer.id}`); await submit(page, `/offers/${offer.id}/approve`, { confirm_prices: true }); await page.goto(lead(app, id, 'angebot')); await submit(page, `/offers/${offer.id}/sent`, {});
    await page.goto(lead(app, id, 'angebot')); await submit(page, `/leads/${id}/accept`, {}); const orderId = (await app.ctx.orders.orderForLead(id)).id as string; assert.match(page.url(), new RegExp(`/orders/${orderId}`)); await shot('auftrag');
    assert.equal((await app.pool.query('select count(*)::int n from outbox where owner_id = $1', [app.ctx.repo.ownerId])).rows[0].n, 0, 'bis hier nichts gesendet');
    // 11 Anzahlung (manuell bestätigt, mit Referenz) → Produktion
    await page.goto(`/orders/${orderId}`); await submit(page, `/orders/${orderId}/payment/manual`, { kind: 'deposit', reference: 'Überweisung 14.10. RE-1', checked: true }, { has: 'input[name="kind"][value="deposit"]' }); assert.equal((await app.ctx.orders.getOrder(orderId)).status, 'IN_PRODUCTION');
    // 12 Produktion: Inhalte, Build + interne QA
    await page.goto(`/orders/${orderId}`); await submit(page, `/orders/${orderId}/project`, { phone: '0681 998877', email: 'kontakt@beispiel.example', address: 'Hauptstraße 12', postalCode: '66740', city: 'Saarlouis', openingHours: 'Mo–Fr 9–18 Uhr', about: 'Persönliche Beratung und saubere Arbeit seit vielen Jahren.', services: 'Maniküre | Pflege und Lack\nGelnägel | Neumodellage und Auffüllen', legalOwner: 'Erika Mustermann', hosting: 'Mock-Hosting', legalConfirmed: true });
    await page.goto(`/orders/${orderId}`); await submit(page, `/orders/${orderId}/build`, {}); const o2 = await app.ctx.orders.getOrder(orderId); assert.equal(o2.status, 'CUSTOMER_REVIEW', 'QA bestanden → Kundenfreigabe'); await shot('produktion-qa');
    // 13 Kundenfreigabe über den öffentlichen Link (ohne Login) – anschließend Restzahlung offen
    const pub = await browser.newContext({ viewport: { width: 390, height: 900 }, baseURL: app.base }); const cp = await pub.newPage(); await cp.goto(`/r/${o2.review_token}`); assert.match(await cp.locator('body').innerText(), /Ihre Website ist bereit/);
    await Promise.all([cp.waitForLoadState('load'), cp.locator(`form[action="/r/${o2.review_token}/approve"] button`).click()]); await pub.close();
    assert.ok(['APPROVED', 'FINAL_PAYMENT_PENDING'].includes((await app.ctx.orders.getOrder(orderId)).status), (await app.ctx.orders.getOrder(orderId)).status);
    // 14 Restzahlung (manuell bestätigt) → vollständig bezahlt
    await page.goto(`/orders/${orderId}`); await submit(page, `/orders/${orderId}/payment/manual`, { kind: 'final', reference: 'Überweisung 20.10. RE-2', checked: true }, { has: 'input[name="kind"][value="final"]' }); assert.equal((await app.ctx.orders.getOrder(orderId)).status, 'FULLY_PAID');
    // 15 Veröffentlichung nur mit ausdrücklicher Freigabe (Mock-Hosting)
    await page.goto(`/orders/${orderId}`); await submit(page, `/orders/${orderId}/deploy`, { deploy_approval: false }); assert.equal((await app.pool.query('select count(*)::int n from deployments where order_id=$1', [orderId])).rows[0].n, 0, 'ohne Freigabe nichts veröffentlicht');
    await page.goto(`/orders/${orderId}`); await submit(page, `/orders/${orderId}/deploy`, { deploy_approval: true }); assert.equal((await app.pool.query('select count(*)::int n from deployments where order_id=$1', [orderId])).rows[0].n, 1); await shot('veroeffentlicht');
    // 16 Kundenprofil → Wartung → Änderungswunsch
    await page.goto('/customers'); await submit(page, `/customers/from-order/${orderId}`, {}); const cust = (await app.ctx.customers.byLead(id))!; assert.ok(cust); await page.goto(`/customers/${cust.id}`); const tc = await text(page); for (const w of ['Wartung', 'Care Plus', 'Änderungswünsche', 'Kundenportal']) assert.ok(tc.includes(w), w);
    await submit(page, `/customers/${cust.id}/request`, { title: 'Öffnungszeiten ergänzen' }); assert.equal((await app.ctx.customers.requests(cust.id)).length, 1); await shot('kunde');
    await page.goto('/maintenance'); await shot('wartung');
    // 17 Community (Opt-in Pflicht; Partner kostenlos)
    await page.goto('/community'); await submit(page, '/community/invite', { partner_id: partner.id }); const mem = (await app.ctx.community.list())[0]; assert.ok(mem); assert.equal(mem.fee.free, true);
    await page.goto('/community'); await submit(page, `/community/${mem.id}/optin`, { note: 'mündlich, per Mail bestätigt' }); await page.goto('/community'); await submit(page, `/community/${mem.id}/status`, { to: 'ACTIVE' } as never).catch(() => undefined);
    assert.equal((await app.ctx.community.get(mem.id)).status, 'ACTIVE'); await shot('community');
    // 18 Analytics (alle Ansichten) + Heute
    for (const v of ['funnel', 'industries', 'regions', 'strategies', 'partners', 'costs']) { await page.goto(`/analytics?view=${v}`); assert.equal((await text(page)).includes('Analytics'), true, v); }
    await shot('analytics'); await page.goto('/today'); assert.match(await text(page), /Als Nächstes/); await shot('heute');
    // Gesamtprüfung: nichts gesendet, keine JS-/Serverfehler
    assert.equal((await app.pool.query('select count(*)::int n from outbox where owner_id = $1', [app.ctx.repo.ownerId])).rows[0].n, 0, 'nichts gesendet'); assert.deepEqual(errors, []);
  } finally { await browser.close(); }
  assert.ok(steps.length >= 15, steps.join(','));
});
