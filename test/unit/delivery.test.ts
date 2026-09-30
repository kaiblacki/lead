import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyStripeSignature, StripeProvider } from '../../src/providers/real/stripe.ts';
import { assertOrderTransition } from '../../src/orders/status.ts';
import { buildSite } from '../../src/site/engine.ts';
import { staticQa, qaLoop } from '../../src/qa/check.ts';
import { browserQa } from '../../src/qa/browser.ts';
import { FolderHostingProvider as FolderDeployer, VercelHostingProvider as VercelDeployer } from '../../src/providers/real/hosting.ts';
import { slugify } from '../../src/core/text.ts';
import { sanitizeContent, applyPatch } from '../../src/orders/delivery.ts';
import { templateByKey } from '../../src/site/templates.ts';
import type { ProjectContent } from '../../src/orders/service.ts';

const SECRET = 'whsec_test_123';
const sign = (body: string, t = Math.floor(Date.now() / 1000), secret = SECRET) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

const content: ProjectContent = {
  companyName: 'Salon Müller', industryLabel: 'Friseur', address: 'Hauptstr. 1', postalCode: '66111', city: 'Saarbrücken', phone: '0681 123456', email: 'info@salon-mueller.example',
  openingHours: 'Di–Fr 9–18 Uhr\nSa 9–14 Uhr', about: 'Seit vielen Jahren schneiden wir Haare in Saarbrücken.\nKommen Sie vorbei.',
  services: [{ title: 'Herrenschnitt', text: 'Klassisch oder modern, nach Absprache.' }, { title: 'Färben', text: 'Farbberatung und Ausführung.' }],
  legal: { owner: 'Erika Müller', hosting: 'Vercel Inc.' },
};
const ctx = { content, legalConfirmed: true };
const t = templateByKey('friseur');

test('Stripe-Signatur: gültig, manipuliert, abgelaufen, fehlend, falsches Secret', () => {
  const body = '{"a":1}';
  verifyStripeSignature(body, sign(body), SECRET);
  assert.throws(() => verifyStripeSignature(body + ' ', sign(body), SECRET), /ungültig/);
  assert.throws(() => verifyStripeSignature(body, sign(body, Math.floor(Date.now() / 1000) - 3600), SECRET), /abgelaufen/);
  assert.throws(() => verifyStripeSignature(body, undefined, SECRET), /fehlt/);
  assert.throws(() => verifyStripeSignature(body, sign(body, undefined, 'anderes'), SECRET), /ungültig/);
});

test('StripeProvider: Ereignisse, nur bezahlte Sitzungen zählen, Schlüssel-Format', () => {
  const p = new StripeProvider('sk_test_abc', SECRET);
  const ev = (type: string, o: object) => { const b = JSON.stringify({ id: 'evt_1', type, data: { object: o } }); return p.parseWebhook(b, sign(b)); };
  const paid = ev('checkout.session.completed', { id: 'cs_1', payment_status: 'paid', amount_total: 39000, currency: 'eur', mode: 'payment' });
  assert.deepEqual(paid, { id: 'evt_1', kind: 'paid', sessionId: 'cs_1', amountCents: 39000, currency: 'eur', mode: 'payment' });
  assert.equal(ev('checkout.session.completed', { id: 'cs_1', payment_status: 'unpaid' }).kind, 'ignored');
  assert.equal(ev('checkout.session.expired', { id: 'cs_1' }).kind, 'expired');
  assert.equal(ev('customer.created', {}).kind, 'ignored');
  assert.throws(() => new StripeProvider('pk_live_x', SECRET), /Format/);
  assert.throws(() => new StripeProvider(undefined, SECRET), /fehlt/);
});

test('Stripe createCheckout: Anfrage-Form (gemockt)', async () => {
  const orig = globalThis.fetch; let seen: any;
  globalThis.fetch = (async (u: any, init: any) => { seen = { u, init }; return new Response(JSON.stringify({ id: 'cs_9', url: 'https://checkout.stripe.com/c/x' }), { status: 200 }); }) as any;
  try {
    const s = await new StripeProvider('sk_test_abc', SECRET).createCheckout({ amountCents: 4900, currency: 'eur', description: 'Wartung', mode: 'subscription', orderId: 'o1', paymentId: 'p1', successUrl: 's', cancelUrl: 'c' });
    assert.equal(s.id, 'cs_9');
    const body = seen.init.body as URLSearchParams;
    assert.equal(body.get('line_items[0][price_data][unit_amount]'), '4900');
    assert.equal(body.get('line_items[0][price_data][recurring][interval]'), 'month');
    assert.equal(body.get('metadata[payment_id]'), 'p1');
    assert.equal(seen.init.headers['idempotency-key'], 'p1');
  } finally { globalThis.fetch = orig; }
});

test('Bestellstatus: Zahlungslogik nicht umgehbar', () => {
  assertOrderTransition('PAYMENT_PENDING', 'DEPOSIT_PAID');
  assert.throws(() => assertOrderTransition('PAYMENT_PENDING', 'IN_PRODUCTION'));
  assert.throws(() => assertOrderTransition('APPROVED', 'FULLY_PAID'));      // Restzahlung nicht überspringbar
  assert.throws(() => assertOrderTransition('FINAL_PAYMENT_PENDING', 'DEPLOYED')); // kein Deploy ohne FULLY_PAID
  assert.throws(() => assertOrderTransition('IN_PRODUCTION', 'APPROVED'));
});

test('Build + QA: Firmennamen mit Sonderzeichen (& \' \" <) bestehen die QA, Injektionen bleiben escaped', () => {
  for (const name of ["Linh's Nagelwelt", 'Müller & Söhne', 'Salon "Chic"', 'A <b>B</b> Friseur']) {
    const c = { ...content, companyName: name };
    const files = buildSite(c, t, { hosting: 'Vercel Inc.' });
    assert.deepEqual(staticQa(files, { content: c, legalConfirmed: true }).filter((i) => i.severity === 'error'), [], name);
    assert.ok(!/<b>B<\/b>/.test(files['index.html']), 'HTML im Namen wird escaped');
  }
});

test('Build + QA: vollständige Daten bestehen', () => {
  const files = buildSite(content, t, { hosting: 'Vercel Inc.' });
  assert.deepEqual(staticQa(files, ctx).filter((i) => i.severity === 'error'), []);
  assert.ok(files['index.html'].includes('href="tel:0681123456"'));
  assert.ok(files['impressum.html'].includes('Erika Müller'));
  assert.doesNotMatch(files['index.html'], /<script|https?:\/\//);
});

test('QA: Platzhalter, fehlende Pflichtangaben, Rechtstexte, kaputte Links werden gefunden', () => {
  const demoish = { ...content, phone: undefined, email: undefined, openingHours: undefined, about: undefined, services: templateByKey('friseur').services };
  const issues = staticQa(buildSite(demoish, t), { content: demoish, legalConfirmed: false });
  const codes = new Set(issues.map((i) => i.code));
  for (const c of ['CONTENT_MISSING', 'LEGAL_NOT_CONFIRMED', 'PLACEHOLDER']) assert.ok(codes.has(c), c);
  const f = buildSite(content, t); f['index.html'] = f['index.html'].replace('href="#kontakt"', 'href="#gibtsnicht"').replace('impressum.html', 'fehlt.html');
  const c2 = new Set(staticQa(f, ctx).map((i) => i.code));
  assert.ok(c2.has('BROKEN_LINK') && c2.has('LEGAL_LINKS'));
  const g = buildSite(content, t); g['index.html'] = g['index.html'].replace('</main>', '<img src="https://x.example/a.png"><a href="tel:abc">x</a></main>');
  const c3 = new Set(staticQa(g, ctx).map((i) => i.code));
  assert.ok(c3.has('IMG_ALT') && c3.has('EXTERNAL_RESOURCE') && c3.has('BAD_TEL'));
});

test('QA-Schleife korrigiert behebbare Fehler automatisch, inhaltliche bleiben offen', () => {
  const f = buildSite(content, t);
  f['index.html'] = f['index.html'].replace('<html lang="de">', '<html>').replace(/<meta name="description"[^>]*>/, '').replace('<meta name="viewport" content="width=device-width,initial-scale=1">', '');
  assert.ok(staticQa(f, ctx).some((i) => i.code === 'MISSING_LANG'));
  const r = qaLoop(f, ctx);
  assert.deepEqual(r.issues.filter((i) => i.severity === 'error'), []);
  assert.ok(r.fixed.length >= 3);
  const open = qaLoop(buildSite(content, t), { content, legalConfirmed: false });
  assert.ok(open.issues.some((i) => i.code === 'LEGAL_NOT_CONFIRMED'));
});

test('Browser-QA: fertige Seite hat kein seitliches Scrollen und keine Fehler', async () => {
  const issues = await browserQa(buildSite(content, t));
  assert.deepEqual(issues.filter((i) => i.severity === 'error'), []);
});

test('Browser-QA erkennt seitliches Scrollen', async () => {
  const f = buildSite(content, t); f['index.html'] = f['index.html'].replace('</main>', '<div style="width:900px;height:10px"></div></main>');
  const issues = await browserQa(f);
  if (issues.some((i) => i.code === 'BROWSER_SKIPPED')) return;
  assert.ok(issues.some((i) => i.code === 'H_SCROLL'));
});

test('Eingaben werden bereinigt und validiert', () => {
  assert.throws(() => sanitizeContent({}), /Firmenname/);
  assert.throws(() => sanitizeContent({ companyName: 'A', bookingUrl: 'javascript:alert(1)' }), /https/);
  assert.throws(() => sanitizeContent({ companyName: 'A', email: 'kein-mail' }), /E-Mail/);
  const c = sanitizeContent({ companyName: ' A ', services: [{ title: 'x', text: '' }, { title: 'T', text: 'Text' }], legal: {} });
  assert.equal(c.companyName, 'A'); assert.equal(c.services.length, 1);
});

test('Deployer: Ordner (Pfad-Schutz, Slug) und Vercel-Anfrage (gemockt)', async () => {
  assert.equal(slugify('Café Müller & Söhne GmbH'), 'cafe-muller-sohne-gmbh');
  const root = mkdtempSync(join(tmpdir(), 'sites-'));
  const d = new FolderDeployer(root);
  const { url } = await d.deploy('Salon Müller', { 'index.html': '<p>hi</p>' });
  assert.equal(readFileSync(url.replace('file://', ''), 'utf8'), '<p>hi</p>');
  await assert.rejects(() => d.deploy('x', { '../evil.html': 'x' }), /Ungültig/);
  const orig = globalThis.fetch; let body: any;
  globalThis.fetch = (async (_u: any, init: any) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ url: 'salon-abc.vercel.app' }), { status: 200 }); }) as any;
  try {
    const r = await new VercelDeployer('tok').deploy('Salon Müller', { 'index.html': 'x' });
    assert.equal(r.url, 'https://salon-abc.vercel.app');
    assert.equal(body.target, 'production'); assert.equal(body.files[0].file, 'index.html');
  } finally { globalThis.fetch = orig; }
});

test('Abo-Ereignisse: Kündigung und fehlgeschlagene Zahlung werden erkannt', () => {
  const p = new StripeProvider('sk_test_abc', SECRET);
  const parse = (type: string, o: object) => { const b = JSON.stringify({ id: 'evt_s', type, data: { object: o } }); return p.parseWebhook(b, sign(b)); };
  assert.deepEqual(parse('customer.subscription.deleted', { metadata: { order_id: 'o1' } }), { id: 'evt_s', kind: 'subscription_problem', reason: 'canceled', orderId: 'o1' });
  assert.deepEqual(parse('invoice.payment_failed', { subscription_details: { metadata: { order_id: 'o2' } } }), { id: 'evt_s', kind: 'subscription_problem', reason: 'payment_failed', orderId: 'o2' });
  assert.equal(parse('invoice.payment_failed', {}).kind, 'ignored');
});
