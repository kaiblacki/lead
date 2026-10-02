import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appSetup, skip, enablePhone, quickSearch, type App } from './helpers.ts';

/**
 * Kompletter Weg einer Website-Bestellung – über echte HTTP-Anfragen an das Dashboard, mit Mock-Providern:
 * LEAD → QUALIFIED → CALL → INTERESTED → DEMO → OFFER → DEPOSIT → PRODUCTION → QA → CUSTOMER_REVIEW (Änderung, dann Freigabe)
 * → FINAL PAYMENT → DEPLOYED → MAINTENANCE. Jede Stufe prüft Lead-Status, Bestellstatus und die Sperren (keine Abkürzungen).
 */
const OWNER = '00000000-0000-0000-0000-0000000000e1';
let app: App;
before(async () => { if (!skip) app = await appSetup(OWNER, { cfgDir: 'config.mock' }); });
after(async () => { if (!skip) await app.close(); });

const S: { leadId: string; orderId: string; token: string; slug?: string; payId?: string } = { leadId: '', orderId: '', token: '' };
const leadStatus = async () => (await app.pool.query('select status from leads where id=$1', [S.leadId])).rows[0].status as string;
const orderStatus = async () => (await app.pool.query('select status from orders where id=$1', [S.orderId])).rows[0].status as string;
const flash = async (r: Response) => app.text(await app.follow(r));
const history = async () => (await app.pool.query("select payload->>'to' as to from events where lead_id=$1 and type='status_change' order by created_at, id", [S.leadId])).rows.map((r) => r.to as string);

test('1 LEAD → QUALIFIED: Suche findet Leads, der beste Lead steht mit Begründung oben in der Anrufliste', { skip }, async () => {
  await enablePhone(app);
  await quickSearch(app, 'Völklingen + 30 km + Nagelstudios ohne Website');
  const q = await app.ctx.calls.queue();
  assert.ok(q.items.length > 0, 'Anrufliste gefüllt');
  const top = q.items[0];
  S.leadId = top.id;
  assert.equal(await leadStatus(), 'QUALIFIED');
  const detail = app.text(await (await app.get(`/leads/${S.leadId}`)).text());
  assert.match(detail, /Warum ist dieser Lead interessant/); assert.match(detail, /Kontaktstrategie/);
  assert.match(detail, /Gesprächseinstieg/);
});

test('2 CALL → INTERESTED: Anruf-Ergebnis bewegt den Lead; ohne Ergebnis keine Bewegung', { skip }, async () => {
  assert.match(await flash(await app.post(`/leads/${S.leadId}/call`, { result: 'INTERESTED', note: 'Möchte Website sehen' })), /Ergebnis gespeichert: INTERESTED/);
  assert.equal(await leadStatus(), 'INTERESTED');
  // Abkürzung über das Status-Formular ist nicht erlaubt (INTERESTED → DEPLOYED)
  const bad = await flash(await app.post(`/leads/${S.leadId}/status`, { to: 'DEPLOYED', reason: 'Abkürzung' }));
  assert.match(bad, /nicht erlaubt|Übergang/);
  assert.equal(await leadStatus(), 'INTERESTED');
});

test('3 DEMO: individuelle Demo mit privatem Link, Seite enthält Firmendaten, keine Fantasie-Inhalte, Kennzeichnung „Demo“', { skip }, async () => {
  await app.post(`/leads/${S.leadId}/demo`, { template: 'auto', confirm: '1' });
  assert.equal(await leadStatus(), 'DEMO_CREATED');
  const d = (await app.pool.query('select token, template from demos where lead_id=$1 and not revoked order by created_at desc', [S.leadId])).rows[0];
  const res = await app.get(`/d/${d.token}`, false);
  assert.equal(res.status, 200);
  const page = await res.text();
  const name = (await app.pool.query('select company_name from leads where id=$1', [S.leadId])).rows[0].company_name as string;
  assert.ok(page.includes(name.replace(/&/g, '&amp;')) || page.includes(name), 'Firmenname in der Demo');
  assert.match(page, /Demo|Entwurf|Vorschau/i);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  // widerrufener Link liefert 404
  const demoId = (await app.pool.query('select id from demos where token=$1', [d.token])).rows[0].id;
  await app.post(`/demos/${demoId}/revoke`);
  assert.equal((await app.get(`/d/${d.token}`, false)).status, 404);
  // neue Demo erzeugen, damit die nächsten Schritte eine gültige haben
  await app.post(`/leads/${S.leadId}/demo`, { template: 'auto', confirm: '1' });
  const again = (await app.pool.query('select token from demos where lead_id=$1 and not revoked', [S.leadId])).rows;
  assert.equal(again.length, 1); assert.equal((await app.get(`/d/${again[0].token}`, false)).status, 200);
});

test('4 OFFER: Angebot aus config/pricing.json, nur Schätzungen sind gekennzeichnet; Freigabe + Versand-Markierung → OFFER_SENT', { skip }, async () => {
  assert.match(await flash(await app.post(`/leads/${S.leadId}/offer`)), /Angebot erstellt/);
  const o = (await app.pool.query('select id, status, content from offers where lead_id=$1 order by created_at desc', [S.leadId])).rows[0];
  assert.equal(o.status, 'DRAFT');
  assert.deepEqual(o.content.warnings ?? [], []);
  const cfgPrice = JSON.stringify(o.content);
  assert.ok(/Anzahlung/.test(cfgPrice), 'Anzahlung im Angebot');
  assert.ok(!/\[[A-ZÄÖÜ][^\]]{2,}\]/.test(cfgPrice), 'keine Platzhalter im Angebotstext');
  await app.post(`/offers/${o.id}/approve`);
  assert.equal((await app.pool.query('select status from offers where id=$1', [o.id])).rows[0].status, 'APPROVED');
  await app.post(`/offers/${o.id}/sent`);
  assert.equal((await app.pool.query('select status from offers where id=$1', [o.id])).rows[0].status, 'SENT');
  assert.equal(await leadStatus(), 'OFFER_SENT');
});

test('5 OFFER_ACCEPTED → DEPOSIT_PENDING: Bestellung entsteht, vor der Anzahlung sind Produktion, Restzahlung und Veröffentlichung gesperrt', { skip }, async () => {
  const r = await app.post(`/leads/${S.leadId}/accept`);
  assert.equal(r.status, 303);
  S.orderId = /\/orders\/([0-9a-f-]{36})/.exec(r.headers.get('location')!)![1];
  assert.equal(await leadStatus(), 'DEPOSIT_PENDING'); assert.equal(await orderStatus(), 'PAYMENT_PENDING');
  // Keine Produktion ohne Anzahlung
  assert.match(await flash(await app.post(`/orders/${S.orderId}/build`)), /nur im Status IN_PRODUCTION|Fehler|nicht/i);
  assert.match(await flash(await app.post(`/orders/${S.orderId}/deploy`, { deploy_approval: '1' })), /vollständiger Zahlung/);
  assert.match(await flash(await app.post(`/orders/${S.orderId}/checkout/final`)), /nicht möglich/);
  assert.match(await flash(await app.post(`/orders/${S.orderId}/checkout/maintenance`)), /nicht möglich/);
  assert.equal(await orderStatus(), 'PAYMENT_PENDING');
  assert.equal((await app.pool.query('select count(*)::int n from projects where order_id=$1', [S.orderId])).rows[0].n, 0);
});

test('6 DEPOSIT_PAID → PRODUCTION: Mock-Anzahlung (Checkout-Seite + signierter Webhook) startet die Produktion genau einmal', { skip }, async () => {
  const c = await flash(await app.post(`/orders/${S.orderId}/checkout/deposit`));
  assert.match(c, /Anzahlung-Link erstellt/);
  const pay = (await app.pool.query("select id, provider_ref, amount_cents, status, checkout_url from payments where order_id=$1 and kind='deposit'", [S.orderId])).rows[0];
  assert.equal(pay.status, 'pending'); assert.match(pay.provider_ref, /^mock_cs_[0-9a-f]{24}$/);
  // Link wiederverwendet statt doppelt angelegt
  await app.post(`/orders/${S.orderId}/checkout/deposit`);
  assert.equal((await app.pool.query("select count(*)::int n from payments where order_id=$1 and kind='deposit' and status='pending'", [S.orderId])).rows[0].n, 1);
  // Kunde öffnet die Mock-Checkout-Seite
  const page = await (await app.get(`/mock-pay/${pay.provider_ref}`, false)).text();
  assert.match(page, /MOCK-CHECKOUT/); assert.match(page, /keine echte Zahlung/);
  // Zahlen über die öffentliche Mock-Seite
  const done = await fetch(`${app.base}/mock-pay/${pay.provider_ref}/complete`, { method: 'POST', redirect: 'manual' });
  assert.equal(done.status, 303); assert.match(done.headers.get('location') ?? '', /\/danke$/);
  assert.equal(await orderStatus(), 'IN_PRODUCTION'); assert.equal(await leadStatus(), 'PRODUCTION');
  assert.equal((await app.pool.query('select status from payments where id=$1', [pay.id])).rows[0].status, 'paid');
  assert.equal((await app.pool.query('select count(*)::int n from projects where order_id=$1', [S.orderId])).rows[0].n, 1);
  // zweite Zahlung desselben Links ändert nichts (idempotent)
  const again = await fetch(`${app.base}/mock-pay/${pay.provider_ref}/complete`, { method: 'POST', redirect: 'manual' });
  assert.ok([303, 400, 500].includes(again.status));
  assert.equal(await orderStatus(), 'IN_PRODUCTION');
  assert.equal((await app.pool.query("select count(*)::int n from payments where order_id=$1 and status='paid'", [S.orderId])).rows[0].n, 1);
});

test('7 QA: Beispieltexte/fehlende Rechtsangaben blockieren die Seite; nach Ergänzung besteht die QA → CUSTOMER_REVIEW', { skip }, async () => {
  const first = await flash(await app.post(`/orders/${S.orderId}/build`));
  assert.match(first, /QA nicht bestanden/);
  assert.equal(await orderStatus(), 'IN_PRODUCTION'); assert.equal(await leadStatus(), 'PRODUCTION');
  const b1 = (await app.pool.query('select qa_passed, qa_issues from builds b join projects p on p.id=b.project_id where p.order_id=$1 order by version', [S.orderId])).rows;
  assert.equal(b1.length, 1); assert.equal(b1[0].qa_passed, false); assert.ok(b1[0].qa_issues.some((i: any) => i.severity === 'error'));
  // Kundendaten ergänzen (Platzhalter ersetzen, Rechtliches bestätigen)
  const proj = (await app.pool.query('select content from projects where order_id=$1', [S.orderId])).rows[0].content;
  const save = await app.post(`/orders/${S.orderId}/project`, {
    companyName: proj.companyName, tagline: '', phone: '0681 998877', email: 'kontakt@beispiel-salon.example', address: 'Hauptstraße 12', postalCode: '66333', city: 'Völklingen',
    openingHours: 'Mo–Fr 9–18 Uhr', about: 'Persönliche Beratung und saubere Arbeit – seit vielen Jahren in Völklingen.', bookingUrl: '',
    services: 'Maniküre | Pflege und Lack für gepflegte Hände\nGelnägel | Neumodellage und Auffüllen', legalOwner: 'Erika Mustermann', vatId: '', register: '', hosting: 'Mock-Hosting', template: proj.template ?? '', legalConfirmed: '1' });
  assert.match(await app.follow(save), /Projektdaten gespeichert/);
  const ok = await flash(await app.post(`/orders/${S.orderId}/build`));
  assert.match(ok, /QA bestanden/);
  assert.equal(await orderStatus(), 'CUSTOMER_REVIEW'); assert.equal(await leadStatus(), 'CUSTOMER_REVIEW');
  S.token = (await app.pool.query('select review_token from orders where id=$1', [S.orderId])).rows[0].review_token;
  assert.match(S.token, /^[0-9a-f]{64}$/);
  // Produktion ist jetzt nicht erneut startbar
  assert.match(await flash(await app.post(`/orders/${S.orderId}/build`)), /nur im Status|nicht/i);
});

test('8 Kundenansicht ohne Login: Vorschau, Freigabe, Änderungswunsch – aber keine Dashboard-Daten', { skip }, async () => {
  const page = await (await app.get(`/r/${S.token}`, false)).text();
  assert.match(page, /FREIGEBEN/); assert.match(page, /ÄNDERUNG ANFORDERN/); assert.ok(!/<script/i.test(page));
  const site = await app.get(`/r/${S.token}/site/index.html`, false);
  assert.equal(site.status, 200); assert.match(await site.text(), /<html/i); assert.equal(site.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  // Falscher / erratener Token
  assert.equal((await app.get(`/r/${'0'.repeat(64)}`, false)).status, 404);
  assert.equal((await app.get(`/r/abc`, false)).status, 401);            // kein Token-Format → fällt auf die geschützte Route
  // Dashboard bleibt geschützt
  for (const p of ['/orders', '/leads', '/settings', `/orders/${S.orderId}`]) assert.equal((await app.get(p, false)).status, 401, p);
});

test('9 Änderungswunsch: Produktion wird zurückgesetzt, KI setzt um (Whitelist), QA, neue Vorschau – zweiter Wunsch mit Unklarem → manuell', { skip }, async () => {
  const ch = await fetch(`${app.base}/r/${S.token}/changes`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ note: 'Telefonnummer: 0681 112233' }) });
  assert.equal(ch.status, 303); assert.match(ch.headers.get('location') ?? '', /msg=changed$/);
  assert.equal(await orderStatus(), 'CUSTOMER_REVIEW', 'nach automatischer Umsetzung + QA wieder in der Kundenfreigabe');
  const content = (await app.pool.query('select content from projects where order_id=$1', [S.orderId])).rows[0].content;
  assert.equal(content.phone, '0681 112233');
  const builds = (await app.pool.query('select version, qa_passed from builds b join projects p on p.id=b.project_id where p.order_id=$1 order by version', [S.orderId])).rows;
  assert.ok(builds.length >= 3 && builds.at(-1).qa_passed, 'neue Vorschau gebaut');
  const newPage = await (await app.get(`/r/${S.token}/site/index.html`, false)).text();
  assert.ok(newPage.includes('0681 112233'), 'neue Nummer in der Vorschau');
  const hist = await history(); assert.ok(hist.includes('PRODUCTION') && hist.lastIndexOf('CUSTOMER_REVIEW') > hist.indexOf('PRODUCTION'));
  const status = (await app.pool.query("select change_status from reviews where order_id=$1 and status='changes_requested'", [S.orderId])).rows;
  assert.deepEqual(status.map((x) => x.change_status), ['APPLIED']);

  // zweiter Wunsch: nicht eindeutig umsetzbar → manuell, nichts verändert, im Dashboard sichtbar
  const before = JSON.stringify((await app.pool.query('select content from projects where order_id=$1', [S.orderId])).rows[0].content);
  const ch2 = await fetch(`${app.base}/r/${S.token}/changes`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ note: 'Bitte ein neues Logo in Gold und größere Bilder' }) });
  assert.match(ch2.headers.get('location') ?? '', /msg=received$/);
  assert.equal(await orderStatus(), 'IN_PRODUCTION');
  assert.equal(JSON.stringify((await app.pool.query('select content from projects where order_id=$1', [S.orderId])).rows[0].content), before);
  const dash = app.text(await (await app.get(`/orders/${S.orderId}`)).text());
  assert.match(dash, /Änderungswünsche des Kunden/); assert.match(dash, /manuell nötig/); assert.match(dash, /Logo in Gold/);
  // Kunde kann die alte Vorschau jetzt nicht freigeben (Status nicht CUSTOMER_REVIEW)
  const stale = await fetch(`${app.base}/r/${S.token}/approve`, { method: 'POST', redirect: 'manual' });
  assert.equal(stale.status, 400);
  assert.equal(await orderStatus(), 'IN_PRODUCTION');
  // Manuell bearbeitet → neue Produktion + QA → neue Vorschau
  assert.match(await flash(await app.post(`/orders/${S.orderId}/build`)), /QA bestanden/);
  assert.equal(await orderStatus(), 'CUSTOMER_REVIEW');
});

test('10 Freigabe → APPROVED → FINAL_PAYMENT: Kunde wird zur Restzahlung weitergeleitet; Veröffentlichung weiterhin gesperrt', { skip }, async () => {
  const ap = await fetch(`${app.base}/r/${S.token}/approve`, { method: 'POST', redirect: 'manual' });
  assert.equal(ap.status, 303);
  assert.match(ap.headers.get('location') ?? '', /\/mock-pay\/mock_cs_[0-9a-f]{24}$/, 'Kunde landet direkt im Restzahlungs-Checkout');
  assert.equal(await orderStatus(), 'FINAL_PAYMENT_PENDING'); assert.equal(await leadStatus(), 'FINAL_PAYMENT');
  assert.match(await flash(await app.post(`/orders/${S.orderId}/deploy`, { deploy_approval: '1' })), /vollständiger Zahlung/);
  // doppelte Freigabe nicht möglich
  assert.equal((await fetch(`${app.base}/r/${S.token}/approve`, { method: 'POST', redirect: 'manual' })).status, 400);
  const fin = (await app.pool.query("select id, amount_cents from payments where order_id=$1 and kind='final'", [S.orderId])).rows;
  assert.equal(fin.length, 1); S.payId = fin[0].id;
  const dep = (await app.pool.query("select amount_cents from payments where order_id=$1 and kind='deposit'", [S.orderId])).rows[0];
  const ord = (await app.pool.query('select deposit_cents, final_cents from orders where id=$1', [S.orderId])).rows[0];
  assert.equal(dep.amount_cents, ord.deposit_cents); assert.equal(fin[0].amount_cents, ord.final_cents);
});

test('11 FULLY_PAID → DEPLOYED: Mock-Restzahlung im Dashboard simuliert, erst dann lässt sich veröffentlichen; Seite ist unter /hosted erreichbar', { skip }, async () => {
  assert.match(await flash(await app.post(`/payments/${S.payId}/simulate`)), /Restzahlung bezahlt/);
  assert.equal(await orderStatus(), 'FULLY_PAID');
  const dash = app.text(await (await app.get(`/orders/${S.orderId}`)).text());
  assert.match(dash, /Veröffentlichen/);
  const dep = await flash(await app.post(`/orders/${S.orderId}/deploy`, { deploy_approval: '1' }));
  assert.match(dep, /Veröffentlicht: /);
  assert.equal(await orderStatus(), 'DEPLOYED'); assert.equal(await leadStatus(), 'DEPLOYED');
  const url = (await app.pool.query('select url, adapter from deployments where order_id=$1', [S.orderId])).rows[0];
  assert.equal(url.adapter, 'mock-hosting'); assert.match(url.url, /\/hosted\/[a-z0-9-]+\/?$/);
  S.slug = /\/hosted\/([a-z0-9-]+)/.exec(url.url)![1];
  const live = await app.get(`/hosted/${S.slug}/`, false);
  assert.equal(live.status, 200); const html = await live.text(); assert.match(html, /<html/i); assert.ok(html.includes('0681 112233'));
  // doppeltes Veröffentlichen nicht möglich
  assert.match(await flash(await app.post(`/orders/${S.orderId}/deploy`, { deploy_approval: '1' })), /vollständiger Zahlung/);
});

test('12 MAINTENANCE: Wartungs-Abo (Mock) → Plan aktiv, Prüfung ohne Fehler, Fehler-Simulation erzeugt Aufgabe, Aufgabe erledigt', { skip }, async () => {
  assert.match(await flash(await app.post(`/orders/${S.orderId}/checkout/maintenance`)), /Wartung \(Abo\)-Link erstellt/);
  const pay = (await app.pool.query("select id from payments where order_id=$1 and kind='maintenance'", [S.orderId])).rows[0];
  await app.post(`/payments/${pay.id}/simulate`);
  assert.equal(await orderStatus(), 'MAINTENANCE_ACTIVE'); assert.equal(await leadStatus(), 'MAINTENANCE');
  const plan = (await app.pool.query('select status, monthly_cents, next_check_at from maintenance_plans where order_id=$1', [S.orderId])).rows[0];
  assert.equal(plan.status, 'ACTIVE'); assert.ok(plan.monthly_cents > 0); assert.ok(plan.next_check_at);

  const list = app.text(await (await app.get('/maintenance')).text());
  assert.match(list, /ACTIVE|aktiv/i);
  // Prüfung: Seite erreichbar → ok
  assert.match(await flash(await app.post(`/maintenance/${S.orderId}/check`)), /alles in Ordnung/);
  // Ausfall simulieren → Fehler, offene Aufgabe
  await app.post(`/maintenance/${S.orderId}/mock-down`, { slug: S.slug!, down: '1' });
  assert.match(await flash(await app.post(`/maintenance/${S.orderId}/check`)), /Prüfung: /);
  const tasks = (await app.pool.query("select id, title, status from maintenance_tasks where order_id=$1", [S.orderId])).rows;
  assert.ok(tasks.some((t) => t.status === 'OPEN'), 'offene Wartungsaufgabe nach Ausfall');
  const detail = app.text(await (await app.get(`/maintenance/${S.orderId}`)).text());
  assert.match(detail, /Offene Aufgaben|offene/i);
  // Ausfall beenden, Aufgabe erledigen
  await app.post(`/maintenance/${S.orderId}/mock-down`, { slug: S.slug!, down: '0' });
  assert.match(await flash(await app.post(`/maintenance/${S.orderId}/check`)), /alles in Ordnung/);
  for (const t of tasks.filter((x) => x.status === 'OPEN')) await app.post(`/maintenance/tasks/${t.id}/done`);
  assert.equal((await app.pool.query("select count(*)::int n from maintenance_tasks where order_id=$1 and status='OPEN'", [S.orderId])).rows[0].n, 0);
});

test('13 Verlauf: alle Stufen der Reihe nach im Audit-Log, Analytics-Funnel und Learning-Loop zählen den Abschluss', { skip }, async () => {
  const hist = await history();
  const want = ['INTERESTED', 'DEMO_CREATED', 'OFFER_SENT', 'OFFER_ACCEPTED', 'DEPOSIT_PENDING', 'DEPOSIT_PAID', 'PRODUCTION', 'QA', 'CUSTOMER_REVIEW', 'APPROVED', 'FINAL_PAYMENT', 'DEPLOYED', 'MAINTENANCE'];
  let at = -1;
  for (const s of want) { const i = hist.indexOf(s, at + 1); assert.ok(i > at, `${s} fehlt oder steht an falscher Stelle in ${hist.join(' → ')}`); at = i; }
  // Audit-Log-Seite + CSV enthalten den Lead
  const audit = app.text(await (await app.get(`/audit?lead=${S.leadId}`)).text());
  assert.match(audit, /status_change/); assert.match(audit, /order_status/);
  const csv = await (await app.get('/audit.csv')).text(); assert.match(csv, /status_change/);
  // Analytics: Funnel kennt Anrufe, Interessenten, Demo, Angebot, Anzahlung, Kunde – jede Stufe ≥ 1 für diesen Lead
  const an = app.text(await (await app.get('/analytics')).text());
  assert.match(an, /Leads gefunden/); assert.match(an, /Gewonnene Kunden/); assert.match(an, /Umsatz|MRR/i);
  const ov = await app.ctx.analytics.overview('all', app.ctx.now());
  const n = (k: string) => ov.funnel.find((f: any) => f.key === k)!.count;
  for (const k of ['found', 'analyzed', 'qualified', 'called', 'interested', 'demo', 'offer', 'deposit', 'customer']) assert.ok(n(k) >= 1, `Funnel-Stufe ${k}`);
  for (let i = 1; i < ov.funnel.length; i++) assert.ok(ov.funnel[i].count <= ov.funnel[i - 1].count, `Trichter steigt bei ${ov.funnel[i].label}: ${ov.funnel.map((f: any) => f.count)}`);
  assert.ok(n('found') >= n('qualified') && n('qualified') >= n('interested') && n('interested') >= n('customer'), 'Trichter nimmt nach unten nicht zu');
  assert.ok(ov.steps.every((s: any) => s.rate === null || (s.rate >= 0 && s.rate <= 100)), 'Konversionsraten plausibel');
  assert.ok(ov.revenueCents > 0 && ov.activePlans >= 1 && ov.mrrCents > 0);
  // Learning-Loop: Merkmale + Scores vor dem Kontakt, Ergebnisse danach
  const rows = await app.ctx.learning.rows();
  const mine = rows.find((r: any) => r.lead_id === S.leadId)!;
  assert.ok(mine, 'Learning-Loop-Zeile für den Lead');
  assert.equal(mine.won, true); assert.equal(mine.reached_interested, true); assert.equal(mine.reached_demo, true); assert.equal(mine.reached_offer, true);
  assert.ok(typeof mine.sales_opportunity === 'number' && typeof mine.digital_need === 'number' && mine.config_hash, 'Scores + Konfigurations-Hash gespeichert');
  assert.equal(mine.first_call_result, 'INTERESTED');
  const csvL = await (await app.get('/analytics/learning.csv')).text();
  assert.match(csvL, /^lead_id;/);   // fetch().text() entfernt die BOM bereits assert.match(csvL, /sales_opportunity/); assert.ok(csvL.includes(S.leadId));
  const json = JSON.parse(await (await app.get('/analytics/learning.json')).text());
  assert.ok(Array.isArray(json) && json.some((r: any) => r.lead_id === S.leadId && r.won === true));
});

test('14 Nichts wurde automatisch versendet; Nachrichten-Protokoll enthält keine echten Sendungen', { skip }, async () => {
  const sent = (await app.pool.query("select count(*)::int n from contact_history where owner_id=$1 and direction='outbound' and channel in ('EMAIL','WHATSAPP')", [OWNER])).rows[0].n;
  assert.equal(sent, 0);
  assert.equal((app.ctx.registry.providers.email as any).sent?.length ?? 0, 0);
  assert.equal((app.ctx.registry.providers.whatsapp as any).sent?.length ?? 0, 0);
});
