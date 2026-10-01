import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getWorld } from '../../src/fixtures/world.ts';
import { distanceKm } from '../../src/core/geo.ts';
import { MockGooglePlacesProvider, MockDirectoryProvider } from '../../src/providers/mock/places.ts';
import { MockCrawlerProvider, MockRenderProvider } from '../../src/providers/mock/crawler.ts';
import { MockSocialDataProvider } from '../../src/providers/mock/social.ts';
import { MockAIProvider, interpretChangeRules } from '../../src/providers/mock/ai.ts';
import { MockStripeProvider, buildMockEvent } from '../../src/providers/mock/payment.ts';
import { MockEmailProvider, MockWhatsAppProvider } from '../../src/providers/mock/messaging.ts';
import { MockHostingProvider } from '../../src/providers/mock/hosting.ts';
import { HttpCrawlerProvider, isPrivateIp } from '../../src/providers/real/crawler.ts';
import { GooglePlacesProvider } from '../../src/providers/real/places.ts';
import { AnthropicProvider } from '../../src/providers/real/ai.ts';
import { StripeProvider } from '../../src/providers/real/stripe.ts';
import { PlaywrightRenderProvider, findChromium } from '../../src/providers/real/render.ts';
import { createProviders } from '../../src/providers/registry.ts';
import { selectLinks } from '../../src/providers/crawl-util.ts';
import { loadConfig } from '../../src/core/config.ts';

const NOW = new Date('2026-06-01T10:00:00Z');
const now = () => NOW;
const VK = { lat: 49.2514, lng: 6.8447 };

test('Fixture-Welt: deterministisch, genug Masse, alle Website-Varianten, Nagelstudios rund um Völklingen', () => {
  const w = getWorld();
  assert.equal(getWorld(), w);
  assert.ok(w.length >= 400);
  assert.deepEqual(new Set(w.map((b) => b.variant)), new Set(['none', 'modern', 'modern-nobooking', 'outdated', 'nomobile', 'slow', 'nohttps', 'spa', 'unreachable', 'social-only']));
  const near = w.filter((b) => b.subKey === 'nagelstudio' && distanceKm(VK, b.point) <= 30);
  assert.ok(near.length >= 10, `Nagelstudios ≤30 km: ${near.length}`);
  assert.ok(near.some((b) => b.variant === 'none') && near.some((b) => b.variant === 'outdated'));
  assert.equal(new Set(w.map((b) => b.id)).size, w.length);
});

test('Fixture-Daten sind als fiktiv erkennbar und wählbar unsicher: .example-Domains, ungültige Rufnummern', () => {
  for (const b of getWorld()) {
    if (b.domain) assert.ok(b.domain.endsWith('.example'), b.domain);
    if (b.email) assert.ok(/\.example$/.test(b.email));
    if (b.phone) assert.match(b.phone, /^\d{4,5} 0\d{5}$/);   // Teilnehmernummer beginnt mit 0 → nicht vergeben
  }
});

test('Geo: Entfernung Völklingen–Saarbrücken plausibel', () => {
  const d = distanceKm(VK, { lat: 49.2402, lng: 6.9969 });
  assert.ok(d > 9 && d < 13, String(d));
});

test('MockPlaces: Geocoding', async () => {
  const p = new MockGooglePlacesProvider({ now });
  assert.deepEqual((await p.geocode('Völklingen'))?.point, VK);
  assert.equal((await p.geocode('voelklingen'))?.name, 'Völklingen');
  assert.equal((await p.geocode('66333'))?.name, 'Völklingen');
  assert.equal(await p.geocode('Atlantis'), null);
  assert.equal(await p.geocode(''), null);
});

test('MockPlaces: Radius, Stichwort, Limit, Sortierung, Felder wie bei Google', async () => {
  const p = new MockGooglePlacesProvider({ now });
  const r = await p.search({ center: VK, radiusKm: 30, keywords: ['nagelstudio'], limit: 50 });
  assert.ok(r.items.length >= 10 && r.requests >= 1);
  assert.ok(r.items.every((i) => distanceKm(VK, i.point!) <= 30 && i.fixture && i.source === 'mock-google-places'));
  const ds = r.items.map((i) => distanceKm(VK, i.point!));
  assert.deepEqual(ds, [...ds].sort((a, b) => a - b));
  assert.ok(r.items.every((i) => i.categories[0] === 'nail_salon'));
  const small = await p.search({ center: VK, radiusKm: 5, keywords: ['nagelstudio'], limit: 50 });
  assert.ok(small.items.length < r.items.length);
  assert.equal((await p.search({ center: VK, radiusKm: 30, keywords: ['nagelstudio'], limit: 3 })).items.length, 3);
  assert.equal((await p.search({ center: VK, radiusKm: 30, keywords: ['zzzunbekannt'], limit: 10 })).items.length, 0);
  assert.ok((await p.search({ center: VK, radiusKm: 30, keywords: ['Friseur', 'Nagelstudio'], limit: 500 })).items.length > r.items.length);
});

test('MockDirectory: Anreicherung, Größe nur wenn bekannt, Quellenkonflikte bei Telefon', async () => {
  const d = new MockDirectoryProvider({ now });
  const all = await d.search({ center: VK, radiusKm: 40, keywords: ['friseur', 'nagelstudio', 'kosmetik'], limit: 500 });
  assert.ok(all.items.length > 20);
  assert.ok(all.items.some((r) => r.employeeBucket) && all.items.some((r) => !r.employeeBucket));
  const places = await new MockGooglePlacesProvider({ now }).search({ center: VK, radiusKm: 40, keywords: ['friseur', 'nagelstudio', 'kosmetik'], limit: 500 });
  const byId = new Map(places.items.map((p) => [p.externalId, p]));
  const conflicts = all.items.filter((r) => byId.get(r.externalId) && byId.get(r.externalId)!.phone && r.phone !== byId.get(r.externalId)!.phone);
  assert.ok(conflicts.length >= 1, 'erwartet mind. einen Telefon-Konflikt');
  const one = all.items[0];
  assert.equal((await d.lookup(one.name, one.city))?.externalId, one.externalId);
  assert.equal(await d.lookup('Gibt es nicht', 'Nirgendwo'), null);
});

test('MockCrawler: moderne Seite mit Unterseiten, alte Seite, SPA, Ausfall, unbekannte Domain', async () => {
  const c = new MockCrawlerProvider({ now });
  const w = getWorld();
  const url = (v: string) => { const b = w.find((x) => x.variant === v)!; return { b, url: `${v === 'nohttps' || v === 'outdated' ? 'http' : 'https'}://${b.domain}` }; };
  const m = await c.crawl(url('modern').url, { maxPages: 4 });
  assert.ok(m.ok && m.pages.length >= 3 && m.finalUrl!.startsWith('https://'));
  assert.ok(m.pages.some((p) => /Impressum/.test(p.html)) && m.hasSitemap);
  const o = await c.crawl(url('outdated').url);
  assert.ok(o.ok && o.finalUrl!.startsWith('http://') && o.pages.some((p) => p.status === 404));
  const s = await c.crawl(url('spa').url);
  assert.equal(s.pages.length, 1); assert.match(s.pages[0].html, /id="root"/);
  const slow = await c.crawl(url('slow').url);
  assert.ok(slow.pages[0].loadMs > 5000 && slow.pages[0].bytes > 3_000_000);
  const un = await c.crawl(url('unreachable').url);
  assert.ok(!un.ok && /ENOTFOUND/.test(un.error!));
  const bad = await c.crawl('https://www.gibt-es-nicht.example');
  assert.ok(!bad.ok);
  assert.equal(await c.crawl(url('modern').url).then((r) => JSON.stringify(r)), JSON.stringify(await c.crawl(url('modern').url)));
});

test('MockRender schätzt: Seite ohne Viewport läuft bei Smartphone-Breite über, moderne nicht', async () => {
  const c = new MockCrawlerProvider({ now }); const r = new MockRenderProvider();
  const w = getWorld();
  const get = async (v: string) => (await c.crawl(`https://${w.find((b) => b.variant === v)!.domain}`)).pages[0].html;
  const bad = await r.measure({ html: await get('nomobile') });
  assert.ok(bad!.estimated && bad!.viewports[0].scrollWidth > bad!.viewports[0].clientWidth);
  const good = await r.measure({ html: await get('modern') });
  assert.ok(good!.viewports.every((v) => v.scrollWidth <= v.clientWidth));
  assert.ok(good!.viewports[0].hasMenuToggle);
  assert.equal(await r.measure({ url: 'https://x' }), null);
});

test('MockSocial: bekannte Betriebe mit Aktivität relativ zu „jetzt", unbekannte unvollständig', async () => {
  const s = new MockSocialDataProvider({ now });
  const b = getWorld().find((x) => x.instagram && !x.socialUnverifiable)!;
  const r = await s.lookup({ name: b.name, city: b.city });
  const ig = r.profiles.find((p) => p.platform === 'instagram')!;
  assert.equal(r.complete, true);
  assert.equal(Math.round((NOW.getTime() - Date.parse(ig.lastPostAt!)) / 86400000), b.instagram!.lastPostDaysAgo);
  const none = getWorld().find((x) => !x.instagram && !x.facebook && !x.socialUnverifiable)!;
  assert.deepEqual((await s.lookup({ name: none.name, city: none.city })).profiles, []);
  const unk = await s.lookup({ name: 'Unbekannt GmbH', knownUrls: ['https://www.instagram.com/foo'] });
  assert.equal(unk.complete, false); assert.equal(unk.profiles[0].quality, 'low'); assert.equal(unk.profiles[0].lastPostAt, undefined);
});

test('MockAI: Gesprächseinstieg nur aus übergebenen Fakten; Änderungswünsche als Patch', async () => {
  const ai = new MockAIProvider();
  const res = await ai.complete({ task: 'sales_opener', prompt: 'TASK\nFACTS_JSON:\n' + JSON.stringify({ company: 'Salon X', reasons: [{ code: 'NO_BOOKING', text: 'Keine Online-Terminbuchung erkennbar.' }, { code: 'NO_HTTPS', text: 'Kein HTTPS.' }] }) });
  const j = JSON.parse(res.text);
  assert.deepEqual(j.used_codes, ['NO_BOOKING', 'NO_HTTPS']); assert.match(j.opener, /Salon X/);
  assert.equal(res.model, 'mock-ai-1');
  const ch = interpretChangeRules('Telefonnummer ändern auf 0681 998877\nÖffnungszeiten: Mo–Fr 9–18 Uhr | Sa 9–13 Uhr\nBitte das Logo größer machen');
  assert.equal(ch.patch.phone, '0681 998877');
  assert.equal(ch.patch.openingHours, 'Mo–Fr 9–18 Uhr\nSa 9–13 Uhr');
  assert.deepEqual(ch.unclear, ['Bitte das Logo größer machen']);
  assert.deepEqual(interpretChangeRules('Leistung hinzufügen: Gelnägel – Neu im Angebot').patch.addService, { title: 'Gelnägel', text: 'Neu im Angebot' });
  assert.equal(interpretChangeRules('E-Mail bitte neu: info@beispiel.example').patch.email, 'info@beispiel.example');
  assert.match(JSON.parse((await ai.complete({ task: 'generic', prompt: 'x' })).text).note, /mock-ai/);
});

test('MockStripe: Checkout-Link, signierte Ereignisse im Stripe-Format, Signatur-/Zeitprüfung', async () => {
  const p = new MockStripeProvider('http://localhost:3000/');
  const s = await p.createCheckout({ amountCents: 100, currency: 'eur', description: 'x', mode: 'payment', orderId: 'o', paymentId: 'p', successUrl: 's', cancelUrl: 'c' });
  assert.match(s.url, /^http:\/\/localhost:3000\/mock-pay\/mock_cs_[0-9a-f]{24}$/);
  const { body, signature } = buildMockEvent({ type: 'checkout.session.completed', sessionId: s.id, amountCents: 100 });
  assert.deepEqual(p.parseWebhook(body, signature), { id: JSON.parse(body).id, kind: 'paid', sessionId: s.id, amountCents: 100, currency: 'eur', mode: 'payment' });
  assert.throws(() => p.parseWebhook(body + ' ', signature), /Signatur/);
  assert.throws(() => p.parseWebhook(body, signature, Date.now() + 3600_000), /abgelaufen/);
  assert.equal(p.parseWebhook(...Object.values(buildMockEvent({ type: 'checkout.session.expired', sessionId: s.id })) as [string, string]).kind, 'expired');
  const sub = buildMockEvent({ type: 'customer.subscription.deleted', orderId: 'o1' });
  assert.deepEqual(p.parseWebhook(sub.body, sub.signature), { id: JSON.parse(sub.body).id, kind: 'subscription_problem', reason: 'canceled', orderId: 'o1' });
  assert.equal(p.isMock, true);
});

test('Mock E-Mail/WhatsApp: speichern nur, versenden nichts', async () => {
  const e = new MockEmailProvider(), w = new MockWhatsAppProvider();
  assert.deepEqual(await e.send({ to: 'a@b.example', text: 'Hi' }), { id: 'mock_msg_1', status: 'mock_recorded' });
  await w.send({ to: '+49 0', text: 'Hi' });
  assert.equal(e.sent.length, 1); assert.equal(w.sent.length, 1); assert.ok(e.isMock && w.isMock);
});

test('MockHosting: deploy, lesen, Ausfall, Pfad-Schutz; Crawler sieht die veröffentlichte Seite', async () => {
  const h = new MockHostingProvider('http://localhost:3000', mkdtempSync(join(tmpdir(), 'mh-')));
  const { url } = await h.deploy('Salon Müller', { 'index.html': '<h1>Hi</h1><a href="impressum.html">I</a>', 'impressum.html': '<p>Impressum</p>' });
  assert.equal(url, 'http://localhost:3000/hosted/salon-muller/');
  assert.equal(h.read('Salon Müller', 'index.html'), '<h1>Hi</h1><a href="impressum.html">I</a>');
  assert.equal(h.read('Salon Müller', '../x'), null);
  await assert.rejects(() => h.deploy('x', { '../evil.html': 'x' }), /Ungültig/);
  const c = new MockCrawlerProvider({ now, hosted: h });
  const ok = await c.crawl(url);
  assert.ok(ok.ok && ok.pages.length === 2);
  h.setDown('Salon Müller', true);
  const down = await c.crawl(url);
  assert.ok(!down.ok && /ECONNREFUSED/.test(down.error!));
  h.setDown('Salon Müller', false);
  assert.ok((await c.crawl(url)).ok);
});

test('Link-Auswahl: intern, priorisiert (Kontakt, Impressum), ohne Dateien/Anker/tel', () => {
  const html = '<a href="/team">T</a><a href="/kontakt">K</a><a href="/impressum">I</a><a href="/bild.jpg">B</a><a href="https://fremd.example/x">F</a><a href="tel:123">t</a><a href="#top">a</a><a href="/leistungen">L</a>';
  assert.deepEqual(selectLinks(html, 'https://x.example/', 3).map((u) => new URL(u).pathname), ['/kontakt', '/impressum', '/leistungen']);
  assert.deepEqual(selectLinks(html, 'kaputt', 3), []);
});

test('isPrivateIp', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.0.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', '::ffff:127.0.0.1', '100.64.0.1']) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700::1111']) assert.ok(!isPrivateIp(ip), ip);
});

async function withServer(handler: Parameters<typeof createServer>[1], fn: (base: string) => Promise<void>) {
  const srv = createServer(handler);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`); } finally { srv.close(); }
}

test('HttpCrawler (echter Adapter, lokaler Server): Startseite + Unterseiten, Sitemap, Weiterleitung, 404, Timeout', async () => {
  await withServer((req, res) => {
    const u = req.url ?? '/';
    if (u === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return void res.end('<a href="/kontakt">K</a><a href="/impressum">I</a><h1>Hi</h1>'); }
    if (u === '/kontakt') { res.writeHead(200, { 'content-type': 'text/html' }); return void res.end('<p>Kontakt</p>'); }
    if (u === '/impressum') { res.writeHead(404); return void res.end('x'); }
    if (u === '/sitemap.xml') { res.writeHead(200, { 'content-type': 'application/xml' }); return void res.end('<urlset/>'); }
    if (u === '/alt') { res.writeHead(301, { location: '/' }); return void res.end(); }
    if (u === '/slow') return; // hängt
    res.writeHead(404); res.end();
  }, async (base) => {
    const c = new HttpCrawlerProvider({ allowPrivate: true, timeoutMs: 400, now });
    const r = await c.crawl(base + '/alt', { maxPages: 3 });
    assert.ok(r.ok && r.finalUrl === base + '/'); assert.equal(r.pages.length, 3);
    assert.ok(r.pages.find((p) => p.url.endsWith('/impressum'))!.status === 404);
    assert.equal(r.hasSitemap, true); assert.ok(r.requests >= 4);
    const nf = await c.crawl(base + '/gibtsnicht');
    assert.ok(!nf.ok && nf.error === 'HTTP 404');
    const t = await c.crawl(base + '/slow');
    assert.ok(!t.ok && /abort|timeout/i.test(t.error!));
  });
});

test('HttpCrawler: robots.txt wird beachtet', async () => {
  await withServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return void res.end('User-agent: *\nDisallow: /'); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>x</h1>');
  }, async (base) => {
    const r = await new HttpCrawlerProvider({ allowPrivate: true }).crawl(base + '/');
    assert.ok(!r.ok && r.robotsBlocked);
  });
});

test('HttpCrawler: SSRF-Schutz blockiert interne Adressen, auch per Weiterleitung', async () => {
  await withServer((req, res) => { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }); res.end(); }, async (base) => {
    const strict = new HttpCrawlerProvider();
    const direct = await strict.crawl(base + '/');
    assert.ok(!direct.ok && /Interne oder private/.test(direct.error!));
    assert.ok(!(await strict.crawl('http://localhost:1/')).ok);
    assert.match((await strict.crawl('ftp://x.example/')).error ?? '', /http|URL|Invalid|Nur/i);
    const viaRedirect = await new HttpCrawlerProvider({ allowPrivate: false }).crawl('http://127.0.0.1:1/');
    assert.ok(!viaRedirect.ok);
  });
});

test('Echte Adapter mit gemocktem HTTP: Places (Kreis, Feldmaske, Seiten), Geocoding, Anthropic, Stripe-Schlüsselformat', async () => {
  const orig = globalThis.fetch; const calls: any[] = [];
  globalThis.fetch = (async (u: any, init: any) => {
    calls.push({ u: String(u), init });
    if (String(u).includes('geocode')) return new Response(JSON.stringify({ status: 'OK', results: [{ formatted_address: 'Völklingen, Deutschland', geometry: { location: { lat: 49.25, lng: 6.84 } } }] }));
    if (String(u).includes('places.googleapis.com')) {
      const first = !JSON.parse(init.body).pageToken;
      return new Response(JSON.stringify({ places: [{ id: first ? 'a' : 'b', displayName: { text: first ? 'A' : 'B' }, location: { latitude: 49.25, longitude: 6.84 }, rating: 4.5, userRatingCount: 12, websiteUri: 'https://a.example', regularOpeningHours: { weekdayDescriptions: ['Montag: 9–18'] } }], nextPageToken: first ? 'tok' : undefined }));
    }
    if (String(u).includes('anthropic')) return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Hallo' }], usage: { input_tokens: 3, output_tokens: 1 } }));
    throw new Error('unerwartet ' + u);
  }) as any;
  try {
    const g = new GooglePlacesProvider('KEY', now);
    assert.equal((await g.geocode('Völklingen'))!.point.lat, 49.25);
    const r = await g.search({ center: VK, radiusKm: 80, keywords: ['nagelstudio'], limit: 2 });
    assert.equal(r.items.length, 2); assert.equal(r.requests, 2);
    const body = JSON.parse(calls[1].init.body);
    assert.equal(body.locationBias.circle.radius, 50000);            // API-Limit
    assert.match(calls[1].init.headers['X-Goog-FieldMask'], /userRatingCount/);
    assert.equal(r.items[0].reviewCount, 12); assert.deepEqual(r.items[0].openingHours, ['Montag: 9–18']);
    await assert.rejects(() => new GooglePlacesProvider(undefined).search({ center: VK, radiusKm: 1, keywords: [], limit: 1 }), /KEY|fehlt/i);
    const a = await new AnthropicProvider('m', 'k').complete({ task: 'generic', prompt: 'x', system: 's' });
    assert.deepEqual([a.text, a.inputTokens], ['Hallo', 3]);
    assert.equal(JSON.parse(calls[calls.length - 1].init.body).system, 's');
    await assert.rejects(() => new AnthropicProvider('m', undefined).complete({ task: 'generic', prompt: 'x' }), /fehlt/);
    assert.throws(() => new StripeProvider('pk_live_x', 'whsec'), /Format/);
  } finally { globalThis.fetch = orig; }
});

test('PlaywrightRender (echter Browser): erkennt seitliches Scrollen und Menü-Schalter', async () => {
  if (!findChromium()) return;
  const r = new PlaywrightRenderProvider();
  const good = await r.measure({ html: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><button class="menu-toggle" style="min-height:44px;min-width:44px">☰</button><p>Text</p>' });
  assert.equal(good!.estimated, false);
  assert.ok(good!.viewports.every((v) => v.scrollWidth <= v.clientWidth)); assert.ok(good!.viewports[0].hasMenuToggle);
  const bad = await r.measure({ html: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div style="width:1000px;height:10px"></div>' });
  assert.ok(bad!.viewports[0].scrollWidth > bad!.viewports[0].clientWidth);
  assert.equal(await r.measure({ url: 'http://127.0.0.1:1/' }), null);   // private Ziele werden nicht gemessen
});

test('Registry: Standard = Mock, live ohne Keys = Mock mit Begründung, live mit Keys = echte Adapter, Einzelschalter', () => {
  const base = { baseUrl: 'http://localhost:3000', now, hostingRoot: mkdtempSync(join(tmpdir(), 'h-')) };
  const m = createProviders({}, base);
  assert.equal(m.mode, 'mock');
  assert.ok(Object.values(m.providers).every((p) => p.isMock));
  assert.equal(m.status.length, 10);
  const liveNoKeys = createProviders({ APP_MODE: 'live' }, base);
  assert.ok(liveNoKeys.providers.ai.isMock && liveNoKeys.providers.payments.isMock);
  assert.equal(liveNoKeys.providers.places.name, 'osm', 'ohne Google-Key die keyfreie OpenStreetMap-Quelle'); assert.match(liveNoKeys.status.find((s) => s.kind === 'places')!.note, /OpenStreetMap/);
  assert.equal(createProviders({ APP_MODE: 'live', PLACES_SOURCE: 'google' }, base).providers.places.name, 'google-places');
  assert.match(liveNoKeys.status.find((s) => s.kind === 'directory')!.note, /nicht gebaut/); assert.ok(liveNoKeys.providers.whatsapp.isMock);
  const live = createProviders({ APP_MODE: 'live', GOOGLE_PLACES_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: 'whsec_x', VERCEL_TOKEN: 't' }, base);
  assert.deepEqual([live.providers.places.name, live.providers.ai.name, live.providers.payments.name, live.providers.hosting.name, live.providers.crawler.name], ['google-places', 'anthropic', 'stripe', 'vercel', 'http-crawler']);
  assert.ok(live.providers.directory.isMock && live.providers.social.isMock && live.providers.email.isMock && live.providers.whatsapp.isMock);
  assert.equal(createProviders({ APP_MODE: 'live', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: '123456789' }, base).providers.whatsapp.name, 'whatsapp-cloud');
  const mixed = createProviders({ PROVIDER_PAYMENTS: 'real', STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: 'w' }, base);
  assert.equal(mixed.providers.payments.name, 'stripe'); assert.ok(mixed.providers.places.isMock);
  assert.equal(mixed.status.find((s) => s.kind === 'payments')!.mode, 'real');
  assert.ok(m.mockHosting && !live.mockHosting);
});

test('Industrie-Taxonomie: Freitext → Unterbranche (Mehrzahl, Umlaute)', () => {
  const t = loadConfig().taxonomy;
  assert.equal(t.match('Nagelstudios')?.key, 'nagelstudio');
  assert.equal(t.match('Friseure')?.key, 'friseur');
  assert.equal(t.match('Zahnärzte')?.key, 'zahnarzt');
  assert.equal(t.match('Kfz Werkstätten')?.key, 'kfz');
  assert.equal(t.match('Elektriker in Saarbrücken')?.key, 'elektriker');
  assert.equal(t.match('irgendwas'), undefined);
  assert.equal(t.sub('nagelstudio')?.industryKey, 'beauty');
});
