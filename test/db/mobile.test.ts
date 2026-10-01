import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { findChromium } from '../../src/providers/real/render.ts';
import { appSetup, skip, enablePhone, quickSearch, leadsWhere, makeCustomer, AUTH, type App } from './helpers.ts';

/**
 * Mobile-Prüfung im echten Browser: das gesamte Dashboard (alle Seiten und Detailansichten) plus die öffentlichen Kundenseiten
 * bei 375, 390 und 430 px. Geprüft wird: kein seitliches Scrollen, nichts ragt über den Rand, Tap-Ziele ≥ 44 px, keine JS-/Ladefehler.
 * Mit SHOTS_DIR=… werden zusätzlich Screenshots (390 px) gespeichert.
 */
const OWNER = '00000000-0000-0000-0000-0000000000c9';
const WIDTHS = [375, 390, 430];
let app: App, browser: Browser;
const pages: { name: string; path: string; auth: boolean }[] = [];

before(async () => {
  if (skip) return;
  app = await appSetup(OWNER, { cfgDir: 'config.mock' });
  await enablePhone(app);
  await quickSearch(app, 'Völklingen + 30 km + Nagelstudios'); await quickSearch(app, 'Saarbrücken + 15 km + Friseure');
  const ready = await leadsWhere(app, "status='QUALIFIED' and contact_readiness='READY_FOR_MANUAL_CALL'");
  const [full, review, pay, demo, social] = ready.slice(0, 5);
  const c1 = await makeCustomer(app, full.id);                                   // Wartung aktiv, Seite veröffentlicht
  const c2 = await makeCustomer(app, review.id, { stopAt: 'review' });           // Kundenfreigabe offen
  const call = await app.ctx.calls.applyResult(pay.id, 'BOUGHT'); await app.ctx.orders.startCheckout(call.orderId!, 'deposit', app.ctx.registry.providers.payments, app.base);
  const payRef = (await app.pool.query("select provider_ref from payments where order_id=$1", [call.orderId])).rows[0].provider_ref;
  await app.ctx.calls.applyResult(demo.id, 'DEMO');
  const demoToken = (await app.pool.query('select token from demos where lead_id=$1', [demo.id])).rows[0].token;
  await app.post(`/social/${social.id}`, { profile: 'nagelstudio', weeks: '2', services: 'Maniküre\nGelnägel' });
  await app.post('/killswitch', { on: '0' });
  const nosite = (await leadsWhere(app, "website_state='none'"))[0], audited = (await leadsWhere(app, "website_state in ('needs_improvement','exists')"))[0];
  const slug = /\/hosted\/([a-z0-9-]+)/.exec(c1.url!)![1];
  const runId = (await app.pool.query('select id from lead_runs where owner_id=$1 order by created_at desc limit 1', [OWNER])).rows[0].id;
  const add = (name: string, path: string, auth = true) => pages.push({ name, path, auth });
  add('start', '/'); add('heute', '/today'); add('daten-beschaffen', '/enrichment'); add('suche', '/search'); add('suchlauf', `/search/run/${runId}`); add('leads', '/leads'); add('leads-gefiltert', '/leads?status=QUALIFIED&category=HOT&sort=distance');
  add('lead-ohne-website', `/leads/${nosite.id}`); if (audited) add('lead-mit-audit', `/leads/${audited.id}`); add('lead-kunde', `/leads/${full.id}`); add('lead-demo', `/leads/${demo.id}`);
  add('calls', '/calls'); add('pipeline', '/pipeline'); add('auftraege', '/orders'); add('auftrag-zahlung', `/orders/${call.orderId}`); add('auftrag-freigabe', `/orders/${c2.orderId}`); add('auftrag-wartung', `/orders/${c1.orderId}`);
  add('wartung', '/maintenance'); add('wartung-detail', `/maintenance/${c1.orderId}`); add('analytics', '/analytics'); add('einstellungen', '/settings'); add('postausgang', '/outbox'); add('audit-log', '/audit'); add('social', `/social/${social.id}`);
  add('kunde-freigabe', `/r/${c2.token}`, false); add('kunde-mock-zahlung', `/mock-pay/${payRef}`, false); add('kunde-demo', `/d/${demoToken}`, false); add('kunde-danke', '/danke', false); add('kunde-website', `/hosted/${slug}/`, false);
  browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
});
after(async () => { if (!skip) { await browser?.close(); await app.close(); } });

type Probe = { sw: number; cw: number; overflowing: string[]; small: string[]; h: number };
const probe = () => {
  const vw = document.documentElement.clientWidth;
  const inScroll = (e: Element) => !!e.closest('.scroll, pre, code, nav');   // Scroll-Container (Navigation wischt seitlich)
  const label = (e: Element) => `${e.tagName.toLowerCase()}${(e as HTMLElement).className ? '.' + String((e as HTMLElement).className).split(' ')[0] : ''} "${(e.textContent ?? (e as HTMLInputElement).value ?? '').trim().slice(0, 28).replace(/\s+/g, ' ')}"`;
  const overflowing = [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && !inScroll(e) && (r.right > vw + 1 || r.left < -1) && getComputedStyle(e).position !== 'fixed'; }).slice(0, 6).map(label);
  const tappable = [...document.querySelectorAll('button, .btn, nav a, summary, select, textarea, input:not([type=hidden]):not([type=checkbox]):not([type=radio])')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const small = tappable.filter((e) => e.getBoundingClientRect().height < 43.5).slice(0, 6).map((e) => `${label(e)} ${Math.round(e.getBoundingClientRect().height)}px`);
  return { sw: document.documentElement.scrollWidth, cw: vw, overflowing, small, h: document.documentElement.scrollHeight } satisfies Probe;
};

test('Mobile: alle Dashboard- und Kundenseiten bei 375/390/430 px ohne seitliches Scrollen, mit großen Tap-Zielen und ohne Fehler', { skip, timeout: 280_000 }, async () => {
  const problems: string[] = [];
  const shots = process.env.SHOTS_DIR; if (shots) mkdirSync(shots, { recursive: true });
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, extraHTTPHeaders: AUTH });
    for (const p of pages) {
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push('JS: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push('Konsole: ' + m.text()); });
      const resp = await page.goto(app.base + p.path, { waitUntil: 'load' });
      if (!resp?.ok()) problems.push(`${p.name} @${width}: HTTP ${resp?.status()}`);
      if (shots && width === 390) { const h = await page.evaluate(() => document.documentElement.scrollHeight); await page.screenshot({ path: join(shots, `${p.name}.png`), fullPage: true, clip: { x: 0, y: 0, width, height: Math.min(h, 4200) } }); }
      // Aufklappbare Abschnitte öffnen, damit auch verborgene Inhalte geprüft werden
      await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { (d as HTMLDetailsElement).open = true; }));
      const m = (await page.evaluate(probe)) as Probe;
      if (m.sw > m.cw) problems.push(`${p.name} @${width}: seitliches Scrollen (${m.sw} > ${m.cw})`);
      if (m.overflowing.length) problems.push(`${p.name} @${width}: ragt über den Rand: ${m.overflowing.join(' | ')}`);
      if (p.auth && m.small.length) problems.push(`${p.name} @${width}: Tap-Ziele < 44px: ${m.small.join(' | ')}`);
      for (const e of errors) problems.push(`${p.name} @${width}: ${e}`);
      await page.close();
    }
    await ctx.close();
  }
  assert.deepEqual(problems, []);
});

test('Mobile: Bedienbarkeit – Schnellsuche, Anruf-Ergebnisse und Freigabe-Buttons sind per Touch erreichbar (kein Hover nötig, keine Überdeckung)', { skip, timeout: 120_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, extraHTTPHeaders: AUTH });
  const page = await ctx.newPage();
  await page.goto(app.base + '/calls');
  const first = page.locator('details.card').first();
  assert.ok(await first.evaluate((d) => (d as HTMLDetailsElement).open), 'erster Call ist aufgeklappt');
  const second = page.locator('details.card').nth(1);
  if (await second.count()) { await second.locator(':scope > summary').tap(); assert.ok(await second.evaluate((d) => (d as HTMLDetailsElement).open), 'Antippen klappt den Call auf'); }
  for (const label of ['Nicht erreicht', 'Kein Interesse', 'Rückruf', 'Interessiert', 'Demo gewünscht', 'Angebot gewünscht', 'Gekauft', 'Nicht mehr kontaktieren']) {
    const b = first.getByRole('button', { name: label, exact: true });
    await b.scrollIntoViewIfNeeded();
    const box = await b.boundingBox(); assert.ok(box && box.height >= 44 && box.width >= 44 && box.x >= 0 && box.x + box.width <= 390, `${label}: ${JSON.stringify(box)}`);
    const hit = await b.evaluate((el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return top === el || el.contains(top); });
    assert.ok(hit, `${label} wird überdeckt`);
  }
  // Ergebnis tippen: Seite lädt neu, Lead verschwindet aus der Liste
  const action = (await first.locator('form').first().getAttribute('action'))!;
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), first.getByRole('button', { name: 'Nicht erreicht', exact: true }).tap()]);
  assert.match(await page.locator('.flash').first().innerText(), /Nicht erreicht/, 'Bestätigung sichtbar');
  assert.equal(await page.locator(`form[action="${action}"]`).count(), 0, 'bearbeiteter Lead verschwindet aus der Tagesliste');
  assert.match(await page.locator('body').innerText(), /Nicht erreicht – neuer Versuch morgen/);
  await ctx.close();
});

test('Browser-Klickstrecke (Handy): Schnellsuche und Formulare im Dashboard funktionieren mit echten Browser-Formularen (Origin/CSRF)', { skip, timeout: 120_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, extraHTTPHeaders: AUTH });
  const page = await ctx.newPage();
  const statuses: string[] = []; page.on('response', (r) => { if (r.request().method() === 'POST') statuses.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  await page.goto(app.base + '/search');
  await page.getByLabel(/Suchsatz/).fill('Saarlouis + 25 km + Kosmetikstudios ohne Website + 5 Leads');
  await Promise.all([page.waitForURL(/\/search\/run\//), page.locator('form[action="/search/quick"] button.primary').tap()]);
  assert.match(await page.locator('.flash').first().innerText(), /Verstanden:.*Saarlouis.*25 km.*Kosmetik/s);
  await app.ctx.runner.idle(); await page.reload();
  assert.match(await page.locator('main').innerText(), /Lauf|Ergebnis|Leads/);
  // Beispielsuche per Antippen
  await page.goto(app.base + '/search');
  await Promise.all([page.waitForURL(/\/search\/run\//), page.locator('form[action="/search/quick"] button:not(.primary)').first().tap()]);
  assert.match(await page.locator('.flash').first().innerText(), /Verstanden:.*Völklingen/s);
  // Einstellungen speichern (Formular ohne Referer/Origin-Besonderheiten)
  await page.goto(app.base + '/settings');
  await page.locator('input[name="dailyCallTarget"]').fill('12');
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.locator('form[action="/settings/phone"] button.primary').tap()]);
  assert.equal((await app.repo.getSettings()).dailyCallTarget, 12);
  assert.ok(statuses.every((s) => s.startsWith('303')), `Formular-Antworten: ${statuses.join(', ')}`);
  await ctx.close();
});

test('Browser-Klickstrecke (Kunde, ohne Login): Änderung anfordern → neue Vorschau → Freigeben → Mock-Zahlung → Danke', { skip, timeout: 180_000 }, async () => {
  const [review] = (await leadsWhere(app, "status='CUSTOMER_REVIEW'"));
  assert.ok(review, 'Lead in Kundenfreigabe');
  const order = (await app.pool.query('select id, review_token from orders where lead_id=$1', [review.id])).rows[0];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });   // bewusst OHNE Dashboard-Zugang
  const page = await ctx.newPage();
  const responses: string[] = []; page.on('response', (r) => { if (r.request().method() === 'POST') responses.push(`${r.status()} ${new URL(r.url()).pathname.replace(/[0-9a-f]{64}/, ':token')}`); });
  await page.goto(`${app.base}/r/${order.review_token}`);
  assert.ok(await page.frameLocator('iframe').locator('h1').first().isVisible(), 'Vorschau der Website ist im Rahmen sichtbar');
  // 1) Änderungswunsch
  await page.getByLabel(/Änderung anfordern/).fill('Telefonnummer: 0681 445566');
  await Promise.all([page.waitForURL(/msg=changed/), page.getByRole('button', { name: 'ÄNDERUNG ANFORDERN' }).tap()]);
  assert.match(await page.locator('main').innerText(), /Änderung wurde umgesetzt/);
  assert.ok((await page.frameLocator('iframe').locator('body').innerText()).length > 50);
  assert.equal((await app.pool.query('select status from orders where id=$1', [order.id])).rows[0].status, 'CUSTOMER_REVIEW');
  assert.ok((await app.pool.query('select content from projects where order_id=$1', [order.id])).rows[0].content.phone === '0681 445566');
  // 2) Freigeben → Weiterleitung zur Mock-Kasse
  await Promise.all([page.waitForURL(/\/mock-pay\/mock_cs_/), page.getByRole('button', { name: 'FREIGEBEN' }).tap()]);
  assert.match(await page.locator('main').innerText(), /MOCK-CHECKOUT/); assert.match(await page.locator('h1').innerText(), /Restzahlung/);
  assert.equal((await app.pool.query('select status from orders where id=$1', [order.id])).rows[0].status, 'FINAL_PAYMENT_PENDING');
  // 3) Bezahlen (Simulation) → Danke, Auftrag vollständig bezahlt; Zurück-Navigation zum Freigabelink ändert nichts mehr
  await Promise.all([page.waitForURL(/\/danke$/), page.getByRole('button', { name: /Jetzt bezahlen/ }).tap()]);
  assert.match(await page.locator('main').innerText(), /Vielen Dank/);
  assert.equal((await app.pool.query('select status from orders where id=$1', [order.id])).rows[0].status, 'FULLY_PAID');
  await page.goto(`${app.base}/r/${order.review_token}`);
  assert.doesNotMatch(await page.locator('main').innerText(), /FREIGEBEN/);
  assert.ok(responses.every((r) => r.startsWith('303')), `Antworten: ${responses.join(', ')}`);
  // Kunde hat keinen Zugriff auf das Dashboard
  assert.equal((await ctx.request.get(`${app.base}/orders/${order.id}`)).status(), 401);
  await ctx.close();
});
