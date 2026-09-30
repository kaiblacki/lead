import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { Repo } from '../src/db/repo.ts';
import { createApp } from '../src/dashboard/app.ts';
import { StripeProvider } from '../src/payments/provider.ts';
import { FolderDeployer } from '../src/deploy/adapters.ts';
import { buildAudit } from '../src/auditor/analyze.ts';
import { scoreOpportunity } from '../src/scoring/opportunity.ts';
import { buildSalesPackage } from '../src/ai/sales.ts';
import { buildOffer } from '../src/offers/generate.ts';

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'TEST_DATABASE_URL nicht gesetzt (npm run test:db)';
const OWNER = '00000000-0000-0000-0000-00000000000c';
const PASSWORD = 'test-passwort-123', SECRET = 'whsec_flow';
const cfg = JSON.parse(readFileSync(new URL('../config/scoring.json', import.meta.url), 'utf8'));
const pricing = JSON.parse(readFileSync(new URL('../config/pricing.json', import.meta.url), 'utf8'));
const auth = { authorization: 'Basic ' + Buffer.from(`u:${PASSWORD}`).toString('base64') };

let pool: pg.Pool, repo: Repo, server: ReturnType<typeof createApp>, base: string, leadId: string, sites: string;
const realFetch = globalThis.fetch;
let sessions = 0;
const stripeFake = (async (u: any, init?: any) => {
  if (String(u).startsWith('https://api.stripe.com')) { const id = `cs_${++sessions}`; return new Response(JSON.stringify({ id, url: `https://checkout.stripe.com/c/${id}` }), { status: 200 }); }
  return realFetch(u, init);
}) as typeof fetch;

const get = (p: string, a = true) => fetch(base + p, { headers: a ? auth : {}, redirect: 'manual' });
async function csrf() { return /name="csrf" value="([0-9a-f]+)"/.exec(await (await get('/settings')).text())![1]; }
async function post(p: string, data: Record<string, string> = {}) {
  return fetch(base + p, { method: 'POST', headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual', body: new URLSearchParams({ csrf: await csrf(), ...data }) });
}
const sign = (body: string, secret = SECRET) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`; };
const webhook = (eventId: string, session: string, amount: number, secret = SECRET, status = 'paid') => {
  const body = JSON.stringify({ id: eventId, type: 'checkout.session.completed', data: { object: { id: session, payment_status: status, amount_total: amount, currency: 'eur', mode: 'payment' } } });
  return fetch(base + '/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': sign(body, secret), 'content-type': 'application/json' }, body });
};
const order = async () => (await pool.query('select * from orders where lead_id=$1', [leadId])).rows[0];
const leadStatus = async () => (await pool.query('select status from leads where id=$1', [leadId])).rows[0].status;
const pay = async (kind: string) => (await pool.query("select * from payments where order_id=$1 and kind=$2 order by created_at desc limit 1", [(await order()).id, kind])).rows[0];

before(async () => {
  if (skip) return;
  globalThis.fetch = stripeFake;
  pool = new pg.Pool({ connectionString: url });
  await pool.query('insert into auth.users values ($1) on conflict do nothing', [OWNER]);
  repo = new Repo(pool, OWNER);
  sites = mkdtempSync(join(tmpdir(), 'sites-'));
  server = createApp(repo, { password: PASSWORD, payments: () => new StripeProvider('sk_test_x', SECRET), deployer: () => new FolderDeployer(sites),
    baseUrl: 'http://shop.example', fetchSite: async (u) => u.endsWith('fehlt.html') ? { ok: false, status: 404 } : { ok: true, finalUrl: 'https://x/' + u, html: '<a href="tel:+49681123456">x</a><a href="mailto:a@b.de">m</a>', loadMs: 120 } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Lead ohne Website → Verkaufspaket → Angebot versendet
  const lead = { id: 'flow-1', companyName: 'Salon Fluss', industry: 'Friseur', address: 'Hauptstr. 1', city: 'Saarbrücken', phone: '0681 123456', source: 'flow' };
  const audit = buildAudit(lead, null); const opp = scoreOpportunity(lead, audit, cfg);
  leadId = await repo.saveReport({ lead, audit, opportunity: opp, sales: buildSalesPackage(lead, audit, opp, pricing) }, null);
  await repo.createOffer(leadId, buildOffer(lead, { offerName: 'Website Starter' }, pricing));
  for (const s of ['CONTACTED', 'REPLIED', 'INTERESTED'] as const) await repo.setStatus(leadId, s, 'Gespräch');
  await repo.approveOffer((await repo.latestOffer(leadId)).id);
  await repo.markOfferSent((await repo.latestOffer(leadId)).id);
});
after(async () => { if (skip) return; globalThis.fetch = realFetch; server.close(); await pool.end(); });

test('Bestellung und Anzahlungs-Link; Reihenfolge der Zahlungen wird erzwungen', { skip }, async () => {
  assert.equal((await post(`/lead/${leadId}/order`)).status, 303);
  let o = await order();
  assert.equal(o.status, 'PAYMENT_PENDING'); assert.equal(o.deposit_cents + o.final_cents, 129000);
  assert.equal(await leadStatus(), 'DEPOSIT_PENDING');
  assert.equal((await post(`/lead/${leadId}/order`)).status, 303);               // idempotent
  assert.equal((await pool.query('select count(*)::int n from orders where lead_id=$1', [leadId])).rows[0].n, 1);
  assert.equal((await post(`/order/${o.id}/checkout/final`)).status, 400);       // Rest vor Anzahlung verboten
  assert.equal((await post(`/order/${o.id}/build`)).status, 400);                // keine Produktion ohne Anzahlung
  assert.equal((await post(`/order/${o.id}/deploy`)).status, 400);
  await post(`/order/${o.id}/checkout/deposit`);
  const p1 = await pay('deposit'); assert.equal(p1.status, 'pending'); assert.equal(p1.amount_cents, 39000);
  await post(`/order/${o.id}/checkout/deposit`);
  assert.equal((await pool.query("select count(*)::int n from payments where order_id=$1 and kind='deposit'", [o.id])).rows[0].n, 1); // wiederverwendet
});

test('Webhook: falsche Signatur 400, falscher Betrag ändert nichts, Wiederholung wirkungslos', { skip }, async () => {
  const p = await pay('deposit');
  assert.equal((await webhook('evt_bad', p.provider_ref, 39000, 'falsches-secret')).status, 400);
  assert.equal((await webhook('evt_unpaid', p.provider_ref, 39000, SECRET, 'unpaid')).status, 200);
  assert.equal((await order()).status, 'PAYMENT_PENDING');
  const mm = await (await webhook('evt_mm', p.provider_ref, 100)).json(); assert.equal(mm.handled, 'mismatch');
  assert.equal((await order()).status, 'PAYMENT_PENDING'); assert.equal((await pay('deposit')).status, 'pending');
  const ok = await (await webhook('evt_ok', p.provider_ref, 39000)).json(); assert.equal(ok.handled, 'paid');
  const o = await order(); assert.equal(o.status, 'IN_PRODUCTION'); assert.equal(await leadStatus(), 'PRODUCTION');
  assert.ok((await pool.query('select 1 from projects where order_id=$1', [o.id])).rowCount);
  const dup = await (await webhook('evt_ok', p.provider_ref, 39000)).json(); assert.equal(dup.handled, 'duplicate');
  const again = await (await webhook('evt_ok2', p.provider_ref, 39000)).json(); assert.equal(again.handled, 'not_pending');
});

test('Produktion: unvollständige Daten bestehen die QA nicht, vollständige schon → Kundenfreigabe', { skip }, async () => {
  const o = await order();
  await post(`/order/${o.id}/build`);
  let b = (await pool.query('select * from builds where project_id=(select id from projects where order_id=$1) order by version desc', [o.id])).rows;
  assert.equal(b[0].qa_passed, false); assert.equal((await order()).status, 'IN_PRODUCTION');
  assert.ok(b[0].qa_issues.some((i: any) => i.code === 'CONTENT_MISSING') && b[0].qa_issues.some((i: any) => i.code === 'LEGAL_NOT_CONFIRMED'));
  const full = { companyName: 'Salon Fluss', tagline: '', phone: '0681 123456', email: 'info@fluss.example', address: 'Hauptstr. 1', city: '66111 Saarbrücken',
    openingHours: 'Di–Fr 9–18 Uhr', about: 'Friseursalon mitten in Saarbrücken.', bookingUrl: '', services: 'Herrenschnitt | Klassisch oder modern.\nFärben | Mit Farbberatung.',
    legalOwner: 'Erika Fluss', vatId: '', register: '', hosting: 'Vercel Inc.', template: 'friseur' };
  assert.equal((await post(`/order/${o.id}/project`, { ...full, email: 'kaputt' })).status, 400);
  assert.equal((await post(`/order/${o.id}/project`, { ...full, legalConfirmed: '1' })).status, 303);
  await post(`/order/${o.id}/build`);
  b = (await pool.query('select * from builds where project_id=(select id from projects where order_id=$1) order by version desc', [o.id])).rows;
  assert.equal(b[0].qa_passed, true, JSON.stringify(b[0].qa_issues));
  const o2 = await order(); assert.equal(o2.status, 'CUSTOMER_REVIEW'); assert.equal(await leadStatus(), 'CUSTOMER_REVIEW');
  assert.match(o2.review_token, /^[0-9a-f]{64}$/);
  assert.equal((await get(`/order/${o.id}/preview/index.html`)).status, 200);
  assert.equal((await fetch(`${base}/order/${o.id}/preview/index.html`)).status, 401);
});

test('Kundenfreigabe: öffentlich per Token, Änderungswunsch → neuer Build → Freigabe → Restzahlung', { skip }, async () => {
  let o = await order(); const t = o.review_token;
  assert.equal((await get('/r/' + '0'.repeat(64), false)).status, 404);
  const page = await get(`/r/${t}`, false);
  assert.equal(page.status, 200); const html = await page.text();
  assert.match(html, /Ihre Website ist bereit/); assert.match(html, /FREIGEBEN/); assert.match(html, /ÄNDERUNG ANFORDERN/);
  const site = await get(`/r/${t}/site/index.html`, false);
  assert.equal(site.status, 200); assert.match(site.headers.get('content-security-policy') ?? '', /default-src 'none'/); assert.match(await site.text(), /Salon Fluss/);
  assert.equal((await get(`/r/${t}/site/nix.html`, false)).status, 404);
  const postPub = (p: string, body = '', headers: Record<string, string> = {}) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body });
  assert.equal((await postPub(`/r/${t}/changes`, 'note=x')).status, 400);                               // zu kurz
  assert.equal((await postPub(`/r/${t}/approve`, '', { origin: 'http://evil.example' })).status, 403);  // fremde Herkunft
  assert.equal((await postPub(`/r/${t}/changes`, 'note=' + encodeURIComponent('Bitte Öffnungszeiten am Samstag ergänzen'))).status, 200);
  o = await order(); assert.equal(o.status, 'IN_PRODUCTION'); assert.equal(await leadStatus(), 'PRODUCTION');
  assert.match(await (await get('/lead/' + leadId)).text(), /Samstag ergänzen/);
  assert.equal((await postPub(`/r/${t}/approve`)).status, 400);                                          // nicht mehr in Freigabe
  await post(`/order/${o.id}/build`);
  assert.equal((await order()).status, 'CUSTOMER_REVIEW');
  const ap = await postPub(`/r/${t}/approve`);
  assert.equal(ap.status, 303); assert.match(ap.headers.get('location') ?? '', /^https:\/\/checkout\.stripe\.com\//);
  o = await order(); assert.equal(o.status, 'FINAL_PAYMENT_PENDING'); assert.equal(await leadStatus(), 'FINAL_PAYMENT');
  assert.equal((await pay('final')).amount_cents, 90000);
  assert.equal((await post(`/order/${o.id}/deploy`)).status, 400);                                       // Veröffentlichen ohne Restzahlung verboten
});

test('Restzahlung → Veröffentlichung → Wartung (Abo) → Wartungscheck', { skip }, async () => {
  const f = await pay('final');
  assert.equal((await (await webhook('evt_final', f.provider_ref, 90000)).json()).handled, 'paid');
  let o = await order(); assert.equal(o.status, 'FULLY_PAID');
  assert.equal((await post(`/order/${o.id}/checkout/maintenance`)).status, 400);                         // Wartung erst nach Deployment
  assert.equal((await post(`/order/${o.id}/deploy`)).status, 303);
  o = await order(); assert.equal(o.status, 'DEPLOYED'); assert.equal(await leadStatus(), 'DEPLOYED');
  const dep = (await pool.query('select * from deployments where order_id=$1', [o.id])).rows[0];
  assert.ok(existsSync(dep.url.replace('file://', '')));
  assert.match(readFileSync(dep.url.replace('file://', ''), 'utf8'), /Salon Fluss/);
  await post(`/order/${o.id}/checkout/maintenance`);
  const m = await pay('maintenance'); assert.equal(m.amount_cents, 4900);
  assert.equal((await (await webhook('evt_m', m.provider_ref, 4900)).json()).handled, 'paid');
  assert.equal((await order()).status, 'MAINTENANCE_ACTIVE'); assert.equal(await leadStatus(), 'MAINTENANCE');
  await post(`/order/${o.id}/maintenance-check`);
  const c = (await pool.query('select * from maintenance_checks where order_id=$1', [o.id])).rows[0];
  assert.equal(c.ok, true);
  const hist = (await pool.query("select type from events where owner_id=$1 and type in ('payment_paid','order_status','customer_approved','build_done')", [OWNER])).rows;
  assert.ok(hist.length >= 10);
});

test('Social Media: Kalender erzeugen, bearbeiten, freigeben (nur gültige), CSV-Export', { skip }, async () => {
  assert.equal((await post(`/lead/${leadId}/social`, { profile: 'friseur', weeks: '2', services: 'Herrenschnitt\nFärben', openingHours: '', offer: '', website: '' })).status, 303);
  let items = await repo.listSocial(leadId);
  assert.ok(items.length >= 6); assert.ok(items.every((i: any) => i.status === 'DRAFT'));
  assert.match(await (await get(`/lead/${leadId}/social`)).text(), /Kalender erzeugen/);
  assert.equal((await post(`/lead/${leadId}/social`, { profile: 'friseur', weeks: '99' })).status, 400);
  const it = items[0];
  assert.equal((await post(`/social/${it.id}/approve`)).status, 303);
  assert.equal((await repo.listSocial(leadId)).find((x: any) => x.id === it.id).status, 'APPROVED');
  await post(`/social/${it.id}/edit`, { title: 'Neu', body: 'Geänderter Text' });
  assert.equal((await repo.listSocial(leadId)).find((x: any) => x.id === it.id).status, 'DRAFT');   // erneute Freigabe nötig
  await post(`/social/${it.id}/edit`, { title: 'Neu', body: 'Hallo {name}' });
  assert.equal((await post(`/social/${it.id}/approve`)).status, 400);                              // Platzhalter blockiert Freigabe
  await post(`/social/${it.id}/edit`, { title: 'Neu', body: 'Geänderter Text' });
  await post(`/social/${it.id}/approve`);
  await post(`/social/${items[1].id}/reject`);
  const csv = await (await get(`/lead/${leadId}/social.csv`)).text();
  assert.match(csv, /Geänderter Text/); assert.equal(csv.trim().split('\n').length, 2);             // Kopfzeile + 1 freigegebener Eintrag
  assert.equal((await post(`/social/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}/approve`)).status, 400);
});
