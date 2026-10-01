import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/core/config.ts';
import { compareRecords } from '../../src/dedupe/match.ts';
import { dedupeCandidates } from '../../src/dedupe/merge.ts';
import { computePriority, type PriorityInput } from '../../src/scoring/priority.ts';
import { effectiveModules, familyFor, recommendModules, FAMILIES } from '../../src/site/modules.ts';
import { extractContactFacts, findAddressIn } from '../../src/sources/site-contact.ts';
import { createSources } from '../../src/sources/registry.ts';
import { BraveSearchProvider } from '../../src/providers/real/websearch.ts';
import { WebSearchError } from '../../src/sources/types.ts';
import { toEurCents, NOT_OWN_SITE } from '../../src/enrich/service.ts';
import { MockWebSearchProvider } from '../../src/providers/mock/websearch.ts';
import { OsmPlacesProvider } from '../../src/providers/real/osm.ts';
import { createProviders, osmOptions } from '../../src/providers/registry.ts';
import { normalizeCriteria, parseQuickSearch, criteriaFromForm } from '../../src/search/criteria.ts';
import { renderDemo } from '../../src/site/engine.ts';
import { contentFromFacts } from '../../src/site/content.ts';
import { templateByKey } from '../../src/site/templates.ts';
import { SyntheticPlaces } from '../synthetic.ts';
import { getWorld } from '../../src/fixtures/world.ts';

const cfg = loadConfig(); const D = cfg.pipeline.dedupe; const tax = cfg.taxonomy;
const cmp = (a: any, b: any) => compareRecords(a, b, D);

// ---------- 1. Suchgrößen ----------
test('Suchgrößen: SMALL 50 (Standard), MEDIUM 200, LARGE 500; ungültige Größe wird abgelehnt', () => {
  const base = { location: 'Völklingen', radiusKm: '30', subIndustries: ['nagelstudio'] };
  const n = (o: object) => normalizeCriteria({ ...base, ...o }, tax, cfg.pipeline.sizes);
  assert.deepEqual([n({}).size, n({}).maxLeads], ['SMALL', 50]);
  assert.deepEqual([n({ size: 'MEDIUM' }).size, n({ size: 'MEDIUM' }).maxLeads], ['MEDIUM', 200]);
  assert.deepEqual([n({ size: 'LARGE' }).size, n({ size: 'LARGE' }).maxLeads], ['LARGE', 500]);
  assert.equal(n({ maxLeads: '200' }).size, 'MEDIUM'); assert.equal(n({ maxLeads: '60' }).size, 'CUSTOM');
  assert.throws(() => n({ size: 'HUGE' }), /Suchgröße/);
  assert.equal(parseQuickSearch('Völklingen + 30 km + Nagelstudios + MEDIUM', tax).criteria.size, 'MEDIUM');
  assert.equal(normalizeCriteria(criteriaFromForm(new URLSearchParams('location=Völklingen&radiusKm=30&sub=nagelstudio&size=LARGE&maxLeads=7')), tax, cfg.pipeline.sizes).maxLeads, 500);
  assert.deepEqual(cfg.pipeline.sizes, { SMALL: 50, MEDIUM: 200, LARGE: 500 }); assert.equal(cfg.pipeline.defaultSize, 'SMALL');
});

// ---------- 2. Dedupe ----------
test('Dedupe: gleiche Telefonnummer, gleiche Domain, ähnlicher Name + gleiche Adresse → MATCH; ähnlicher Name, anderer Betrieb → NO_MATCH; unsichere Fälle → POSSIBLE_MATCH', () => {
  const phone = cmp({ name: 'Nagelstudio Anna', phone: '06898 123456' }, { name: 'Anna Nails GmbH', phone: '+49 6898 123456' });
  assert.equal(phone.verdict, 'MATCH'); assert.ok(phone.reasons.some((r) => /Telefon/.test(r)));
  const domain = cmp({ name: 'Haarwerk', website: 'https://www.haarwerk.de' }, { name: 'Haarwerk Saarbrücken', website: 'http://haarwerk.de/kontakt', city: 'Saarbrücken' });
  assert.equal(domain.verdict, 'MATCH');
  const addr = cmp({ name: 'Nagelstudio Anna', address: 'Bahnhofstraße 87, 66333 Völklingen', point: { lat: 49.25, lng: 6.85 } }, { name: 'Anna Nagelstudio', address: 'Bahnhofstr. 87', postalCode: '66333', point: { lat: 49.2501, lng: 6.8501 } });
  assert.equal(addr.verdict, 'MATCH');
  // ähnlicher Name, aber anderer Betrieb: andere Straße / andere Hausnummer
  assert.equal(cmp({ name: 'Nagelstudio Anna', address: 'Bahnhofstraße 87', postalCode: '66333' }, { name: 'Nagelstudio Anja', address: 'Hauptstraße 5', postalCode: '66333' }).verdict, 'NO_MATCH');
  assert.equal(cmp({ name: 'Nagelstudio Anna', address: 'Bahnhofstraße 87', postalCode: '66333' }, { name: 'Nagelstudio Anna', address: 'Bahnhofstraße 89', postalCode: '66333', phone: '0681 5555' }).verdict, 'NO_MATCH');
  // kein Merkmal allein: nur gleiche Nummer bei völlig anderem Namen = unsicher; nur gleiche Adresse bei anderem Namen = kein Verdacht
  assert.equal(cmp({ name: 'Studio Eins', phone: '0681 111222' }, { name: 'Kosmetik Müller', phone: '0681111222' }).verdict, 'POSSIBLE_MATCH');
  assert.equal(cmp({ name: 'Friseur Müller', address: 'Hauptstraße 5', postalCode: '66333' }, { name: 'Kosmetik Schmidt', address: 'Hauptstraße 5', postalCode: '66333' }).verdict, 'NO_MATCH');
  // unterschiedliche Telefonnummern bei sonst gleichem Betrieb blockieren den Match nicht
  assert.equal(cmp({ name: 'Nagelstudio Sonja', address: 'Hauptstraße 9', postalCode: '66333', phone: '06898 222222', point: { lat: 49.25, lng: 6.85 } }, { name: 'Nagelstudio Sonja', address: 'Hauptstraße 9', postalCode: '66333', phone: '06898 222225', point: { lat: 49.25, lng: 6.85 } }).verdict, 'MATCH');
});
test('Dedupe über Listen: Duplikate zusammenführen (Quellen bleiben als Alias), Lücken aus dem Duplikat ergänzen, Verdachtsfälle nur markieren; 500 Datensätze schnell', () => {
  const mk = (o: object) => ({ externalId: 'x', source: 'osm', capturedAt: '2026-06-01T10:00:00Z', quality: 'medium' as const, name: 'A', categories: [], ...o });
  const places = [mk({ externalId: 'n1', name: 'Nagelstudio Kovan', phone: '06898 111111', address: 'Weg 1', postalCode: '66333' }),
    mk({ externalId: 'w9', name: 'Nagelstudio Kovan', phone: '+49 6898 111111', website: 'https://kovan.example', openingHours: ['Mo 9-18'] }),
    mk({ externalId: 'p3', name: 'Studio Eins', phone: '0681 7777' }), mk({ externalId: 'p4', name: 'Beautyoase Lumi', phone: '0681 7777' })];
  const r = dedupeCandidates(places, [], D);
  assert.equal(r.items.length, 3); assert.deepEqual(r.stats, { raw: 4, unique: 3, merged: 1, possible: 1 });
  const k = r.items.find((i) => i.place?.name === 'Nagelstudio Kovan')!;
  assert.equal(k.place!.website, 'https://kovan.example', 'Website aus dem Duplikat ergänzt'); assert.equal(k.place!.address, 'Weg 1'); assert.deepEqual(k.aliases.map((a) => a.ref), ['w9']);
  assert.equal(r.items.flatMap((i) => i.possible).length, 1, 'gleiche Nummer, anderer Name → nur zur Prüfung');
  const t = Date.now(); const big = new SyntheticPlaces({ n: 500, dupEvery: 25 }).items(); const rr = dedupeCandidates(big, [], D);
  assert.equal(big.length, 520); assert.equal(rr.items.length, 500); assert.equal(rr.stats.possible, 0); assert.ok(Date.now() - t < 5000);
});

// ---------- 3. Priorität ----------
const P = (o: Partial<PriorityInput>): PriorityInput => ({ websiteState: 'fine', auditStatus: 'ANALYZED', websiteScore: 70, salesOpportunity: 50, hasPhone: true, hasEmail: false, closed: false, active: true, localIndustry: true, clearWeaknesses: 0, hasDemo: false, dataQuality: 70, blocked: false, ...o });
test('Priorität A–D: keine Website + Telefon → A; schlechte Website; gute Website → D; nicht erreichbar; fehlende Daten; Begründung nennt die Faktoren', () => {
  const pc = cfg.pipeline.priority;
  const a = computePriority(P({ websiteState: 'none', auditStatus: 'NO_WEBSITE', websiteScore: null, salesOpportunity: 78 }), pc);
  assert.equal(a.priority, 'A'); assert.match(a.reason, /^A – keine Website, hohe Verkaufschance 78\/100, Telefonnummer vorhanden/);
  const bad = computePriority(P({ websiteState: 'needs_improvement', websiteScore: 30, salesOpportunity: 66, clearWeaknesses: 5 }), pc); assert.ok(['A', 'B'].includes(bad.priority)); assert.match(bad.reason, /sehr schlechte Website \(30\/100\)/);
  const good = computePriority(P({ websiteState: 'fine', websiteScore: 92, salesOpportunity: 20 }), pc); assert.equal(good.priority, 'D'); assert.match(good.reason, /sehr gute Website/);
  const down = computePriority(P({ websiteState: 'unknown', auditStatus: 'UNREACHABLE', websiteScore: null, salesOpportunity: null }), pc); assert.ok(['C', 'D'].includes(down.priority)); assert.match(down.reason, /nicht erreichbar/);
  const nodata = computePriority(P({ websiteState: 'none', auditStatus: 'NO_WEBSITE', websiteScore: null, salesOpportunity: 30, hasPhone: false, hasEmail: false, dataQuality: 20, active: false }), pc); assert.equal(nodata.priority, 'D'); assert.match(nodata.reason, /keine brauchbaren Kontaktdaten.*Daten unsicher|Daten unsicher.*keine brauchbaren Kontaktdaten/);
  assert.equal(computePriority(P({ closed: true, websiteState: 'none', salesOpportunity: 90 }), pc).priority, 'D'); assert.equal(computePriority(P({ blocked: true, websiteState: 'none', salesOpportunity: 90 }), pc).priority, 'D');
  assert.equal(computePriority(P({ websiteState: 'none', auditStatus: 'NO_WEBSITE', websiteScore: null, salesOpportunity: 78, hasDemo: true }), pc).priority, 'A');
});

// ---------- 4. Layout-Familien und Module ----------
test('Layout-Familien und empfohlene Module: Restaurant, Nagelstudio und Handwerker bekommen unterschiedliche Funktionen', () => {
  assert.deepEqual([familyFor(cfg, { subIndustry: 'restaurant' }), familyFor(cfg, { subIndustry: 'nagelstudio' }), familyFor(cfg, { subIndustry: 'elektriker' })], ['GASTRO_RETAIL', 'APPOINTMENT', 'SERVICE']);
  assert.equal(familyFor(cfg, { subIndustry: 'unbekannt', industry: 'gastro' }), 'GASTRO_RETAIL'); assert.equal(familyFor(cfg, {}), 'SERVICE');
  const rest = recommendModules(cfg, { family: 'GASTRO_RETAIL', subIndustry: 'restaurant' }), nail = recommendModules(cfg, { family: 'APPOINTMENT', subIndustry: 'nagelstudio' }), hw = recommendModules(cfg, { family: 'SERVICE', subIndustry: 'elektriker' });
  for (const m of ['menu', 'reservation']) assert.ok(rest.includes(m), `Restaurant: ${m}`); for (const m of ['booking', 'gallery', 'whatsapp']) assert.ok(nail.includes(m), `Nagelstudio: ${m}`); for (const m of ['quote', 'services', 'callback']) assert.ok(hw.includes(m), `Handwerker: ${m}`);
  assert.ok(!hw.includes('booking') && !hw.includes('menu') && !rest.includes('quote') && !nail.includes('menu'));
  assert.ok([rest, nail, hw].every((l) => l.length <= 6 && new Set(l).size === l.length));
  assert.deepEqual(effectiveModules(cfg, { recommended: nail, selected: ['gallery', 'bogus'] }), ['gallery'], 'Auswahl vor Empfehlung, Unbekanntes fällt weg'); assert.deepEqual(effectiveModules(cfg, { recommended: nail, selected: null }), nail);
  for (const k of ['contact_form', 'whatsapp', 'booking', 'reservation', 'menu', 'gallery', 'services', 'price_list', 'map', 'social', 'newsletter', 'quote', 'callback', 'jobs']) assert.ok(k in cfg.pipeline.demo.modules, k);
});
test('Demo v2: drei Layout-Familien sichtbar verschieden, nur gewählte Module, Demo-Funktionen und Beispiele gekennzeichnet, nichts erfunden, kein Formular-Versand', () => {
  const tpl = templateByKey('allgemein'); const base = { companyName: 'Salon Kovan', city: 'Völklingen', address: 'Weg 1', postalCode: '66333', phone: '06898 111111', services: [{ title: 'Maniküre', text: '' }], legal: {} };
  const labels = Object.fromEntries(Object.entries(cfg.pipeline.demo.modules).map(([k, v]: any) => [k, v.label]));
  const make = (family: any, modules: string[]) => renderDemo(base as never, tpl, { name: 'Kai Schwarz', contactEmail: 'k@example.com' }, { servicesAreExamples: true }, { plan: { family, modules, moduleLabels: labels }, extras: {} });
  const nail = make('APPOINTMENT', ['booking', 'gallery', 'whatsapp']), rest = make('GASTRO_RETAIL', ['menu', 'reservation']), hw = make('SERVICE', ['quote', 'services', 'callback']);
  assert.match(nail, /id="termin"/); assert.match(nail, /id="galerie"/); assert.match(nail, /id="whatsapp"/); assert.doesNotMatch(nail, /id="speisekarte"|id="angebot"/);
  assert.match(rest, /id="speisekarte"/); assert.match(rest, /id="reservierung"/); assert.doesNotMatch(rest, /id="termin"|id="angebot"/);
  assert.match(hw, /id="angebot"/); assert.match(hw, /id="rueckruf"/); assert.match(hw, /id="leistungen"/); assert.doesNotMatch(hw, /id="galerie"/);
  assert.equal(new Set([nail, rest, hw].map((h) => /<style>([\s\S]*?)<\/style>/.exec(h)![1])).size, 3, 'drei verschiedene Layouts (CSS)');
  for (const h of [nail, rest, hw]) {
    assert.match(h, /Unverbindliche Demo \/ Beispiel/); assert.match(h, /width=device-width/); assert.match(h, /@media \(max-width:640px\)/); assert.match(h, /@media \(min-width:641px\) and \(max-width:960px\)/);
    assert.doesNotMatch(h, /<form\b|onsubmit|<script|\bSterne\b|★|Kundenstimmen|\d,\d\s*\/\s*5|€/); for (const sec of ['ueber-uns', 'oeffnungszeiten', 'kontakt']) assert.match(h, new RegExp(`id="${sec}"`));
  }
  assert.match(nail, /Demo-Funktion/); assert.match(nail, /Beispiel/); assert.match(rest, /Beispiel: Tagesgericht/); assert.match(hw, /Beispiel-Inhalte|class="badge ex">Beispiel/);
  assert.match(make('SERVICE', ['whatsapp']), /Der WhatsApp-Link wird später mit der echten Nummer/);
  assert.match(renderDemo({ ...base, openingHours: 'Mo–Fr 9–18 Uhr' } as never, tpl, { name: 'A', contactEmail: 'a@b.example' }, {}, { plan: { family: 'SERVICE', modules: ['map'], moduleLabels: labels } }), /openstreetmap\.org\/search\?query=/);
});

// ---------- 5. Website-Kontakt (DIRECT_WEBSITE) ----------
test('Website-Anreicherung: Telefon, E-Mail, Adresse, Formular, WhatsApp, Social, Ansprechpartner, Öffnungszeiten – je Angabe mit Quell-Seite; nichts Verstecktes', () => {
  const pages = [
    { url: 'https://x.example/', html: '<html><body><a href="https://www.instagram.com/salon_x">IG</a><a href="https://wa.me/49681123456">WA</a><a href="https://www.facebook.com/salonx">FB</a><script type="application/ld+json">{"@type":"HairSalon","telephone":"+49 681 123456","address":{"streetAddress":"Hauptstr. 1","postalCode":"66111","addressLocality":"Saarbrücken"},"openingHours":["Mo-Fr 09:00-18:00"]}</script></body></html>' },
    { url: 'https://x.example/kontakt', html: '<html><body><h1>Kontakt</h1><a href="tel:+49681123456">Anrufen</a><a href="mailto:info@x.example?subject=Hi">Mail</a><form><input name="n"><textarea></textarea></form><a href="mailto:noreply@x.example">x</a></body></html>' },
    { url: 'https://x.example/impressum', html: '<html><body><h1>Impressum</h1><p>Inhaberin: Erika Mustermann</p><p>Musterweg 12, 66111 Saarbrücken</p><p>Tel: 0681 123456 E-Mail: info@x.example</p><h2>Öffnungszeiten</h2><p>Mo 9:00-18:00 Di 9:00-18:00 Mi 9:00-13:00</p></body></html>' },
  ];
  const f = extractContactFacts(pages, '2026-06-01T10:00:00Z'); const by = (k: string) => f.filter((x) => x.key === k);
  assert.ok(f.every((x) => x.source === 'website-crawl' && x.url && x.url.startsWith('https://x.example')), 'jede Angabe mit Quell-URL');
  assert.ok(by('phone').some((x) => x.url!.endsWith('/kontakt'))); assert.deepEqual([...new Set(by('email').map((x) => x.value))], ['info@x.example']);   // noreply entfällt
  assert.equal(by('contactForm')[0].url, 'https://x.example/kontakt'); assert.equal(by('whatsapp')[0].value, 'https://wa.me/49681123456');
  assert.deepEqual(by('social').map((x: any) => x.value.platform).sort(), ['facebook', 'instagram']);
  assert.equal(by('contactPerson')[0].value, 'Erika Mustermann'); assert.match(by('contactPerson')[0].note!, /bitte prüfen/); assert.ok(by('address').every((x) => x.quality === 'low'));
  assert.ok(by('openingHours').length >= 1); assert.ok(by('postalCode').some((x) => x.value === '66111'));
  assert.deepEqual(extractContactFacts([{ url: 'https://y.example/', html: '' }], 'x'), []);
});

// ---------- 6. Web Search ----------
test('Websuche-Adapter Brave: Schlüssel, Anfrage, Antwort, Kosten in USD (5 USD / 1000), Rate-Limit, 429-Wiederholung, Fehlerklassen; ohne Schlüssel Mock/„keine Quelle“, Quellenübersicht', async () => {
  const orig = globalThis.fetch; const calls: { url: string; init?: RequestInit }[] = []; let script: (n: number) => Response = () => new Response(JSON.stringify({ web: { results: [{ url: 'https://a.example', title: '<b>A</b> GmbH', description: 'Text' }] } }), { status: 200, headers: { 'x-ratelimit-remaining': '1, 1999', 'x-ratelimit-limit': '1, 2000' } });
  globalThis.fetch = (async (url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return script(calls.length); }) as typeof fetch;
  try {
    const p = new BraveSearchProvider('KEY', { usdPerThousandRequests: 5, minIntervalMs: 0, maxRetries: 2 }, () => new Date('2026-06-01T10:00:00Z'));
    const r = await p.search({ query: 'Salon X Völklingen', count: 3 });
    assert.equal(r.hits[0].title, 'A GmbH'); assert.deepEqual(r.cost, { amount: 0.005, currency: 'USD' }); assert.equal(r.requests, 1); assert.match(r.rateLimit!, /remaining=1, 1999/);
    assert.match(calls[0].url, /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?q=Salon%20X%20V.*count=3.*country=DE.*search_lang=de/); assert.equal((calls[0].init!.headers as any)['x-subscription-token'], 'KEY'); assert.doesNotMatch(calls[0].url, /KEY/, 'Schlüssel nie in der URL');
    assert.equal(toEurCents(r.cost, 0.92), 0.46, '0,005 USD = 0,46 EUR-Cent bei 0,92 EUR/USD'); assert.equal(toEurCents({ amount: 0.005, currency: 'EUR' }, 0.92), 0.5);
    // 429 → wiederholen (Retry-After), danach Erfolg
    calls.length = 0; script = (n) => (n === 1 ? new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }) : new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }));
    const t0 = Date.now(); const r2 = await p.search({ query: 'x' }); assert.equal(calls.length, 2); assert.deepEqual(r2.hits, []); assert.ok(Date.now() - t0 >= 900);
    // 401 → fatal (Stapel bricht ab), 500 → nicht fatal, Netzfehler → nicht fatal; Schlüssel steht nie im Fehlertext
    script = () => new Response('{"error":"bad token"}', { status: 401 }); await assert.rejects(p.search({ query: 'x' }), (e: any) => e instanceof WebSearchError && e.fatal && e.status === 401 && /Schlüssel ungültig/.test(e.message) && !/KEY/.test(e.message));
    script = () => new Response('oops', { status: 500 }); await assert.rejects(p.search({ query: 'x' }), (e: any) => e instanceof WebSearchError && !e.fatal && e.status === 500);
    script = () => new Response('quota', { status: 429 }); await assert.rejects(new BraveSearchProvider('KEY', { usdPerThousandRequests: 5, minIntervalMs: 0, maxRetries: 0 }).search({ query: 'x' }), (e: any) => e.fatal === true && e.status === 429);
    const t1 = Date.now(); script = () => new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }); const slow = new BraveSearchProvider('KEY', { usdPerThousandRequests: 5, minIntervalMs: 300 }); await slow.search({ query: 'a' }); await slow.search({ query: 'b' }); assert.ok(Date.now() - t1 >= 290, 'Mindestabstand zwischen Anfragen');
    await assert.rejects(new BraveSearchProvider(undefined).search({ query: 'x' }), /BRAVE_SEARCH_API_KEY fehlt/);
    // Brave meldet einen ungültigen/fehlenden Schlüssel mit HTTP 422 (nicht 401) – das ist fatal, damit nicht jeder Lead erneut scheitert (echte Antworttexte der API)
    calls.length = 0; script = () => new Response('{"error":{"code":"SUBSCRIPTION_TOKEN_INVALID","detail":"The provided subscription token is invalid.","meta":{"component":"authentication"},"status":422},"type":"ErrorResponse"}', { status: 422 });
    await assert.rejects(p.search({ query: 'x' }), (e: any) => e instanceof WebSearchError && e.fatal === true && e.status === 422 && /Schlüssel ungültig/.test(e.message) && /SUBSCRIPTION_TOKEN_INVALID/.test(e.message) && !/\bKEY\b/.test(e.message)); assert.equal(calls.length, 1, 'kein Wiederholen bei ungültigem Schlüssel');
    script = () => new Response('{"error":{"code":"VALIDATION","detail":"Unable to validate request parameter(s)","meta":{"errors":[{"input":null,"loc":["header","x-subscription-token"],"msg":"Field required","type":"missing"}]},"status":422},"type":"ErrorResponse"}', { status: 422 });
    await assert.rejects(p.search({ query: 'x' }), (e: any) => e.fatal === true && /Schlüssel ungültig oder fehlt/.test(e.message));
    // abgelehnter optionaler Parameter (country/search_lang): einmal ohne ihn wiederholen; andere Validierungsfehler sind nicht fatal und werden nicht wiederholt
    calls.length = 0; script = (n) => (n === 1 ? new Response('{"error":{"code":"VALIDATION","detail":"Unable to validate request parameter(s)","meta":{"errors":[{"loc":["query","country"],"msg":"Input should be a valid enum value","type":"enum"}]},"status":422},"type":"ErrorResponse"}', { status: 422 }) : new Response(JSON.stringify({ web: { results: [{ url: 'https://b.example', title: 'B', description: '' }] } }), { status: 200 }));
    const rr = await p.search({ query: 'Salon Y' }); assert.equal(calls.length, 2); assert.match(calls[0].url, /country=DE/); assert.doesNotMatch(calls[1].url, /country=/); assert.match(calls[1].url, /search_lang=de/); assert.equal(rr.hits[0].url, 'https://b.example'); assert.equal(rr.requests, 1);
    calls.length = 0; script = () => new Response('{"error":{"code":"VALIDATION","detail":"Unable to validate request parameter(s)","meta":{"errors":[{"loc":["query","q"],"msg":"String too long"}]},"status":422},"type":"ErrorResponse"}', { status: 422 });
    await assert.rejects(p.search({ query: 'x' }), (e: any) => e.fatal === false && e.status === 422 && /query\.q: String too long/.test(e.message)); assert.equal(calls.length, 1);
    script = () => new Response('{"type":"ErrorResponse","error":{"status":429,"code":"QUOTA_LIMITED","detail":"Request quota limit exceeded for plan."}}', { status: 429 }); await assert.rejects(new BraveSearchProvider('KEY', { usdPerThousandRequests: 5, minIntervalMs: 0, maxRetries: 0 }).search({ query: 'x' }), (e: any) => e.fatal === true && /Kontingent erschöpft/.test(e.message));
  } finally { globalThis.fetch = orig; }
  const mockP = createProviders({}, { baseUrl: 'http://x' }).providers;
  assert.ok(createSources({}, cfg, mockP).webSearch.isMock);
  const live = createSources({ APP_MODE: 'live' }, cfg, createProviders({ APP_MODE: 'live' }, { baseUrl: 'http://x' }).providers);
  assert.equal(live.webSearch.name, 'keine-quelle'); assert.deepEqual((await live.webSearch.search({ query: 'x' })).hits, []);
  assert.equal(createSources({ APP_MODE: 'live', BRAVE_SEARCH_API_KEY: 'k' }, cfg, createProviders({ APP_MODE: 'live' }, { baseUrl: 'http://x' }).providers).webSearch.name, 'brave-search');
  const st = Object.fromEntries(live.status.map((s) => [s.id, s])); assert.deepEqual(Object.keys(st).sort(), ['DIRECT_WEBSITE', 'GOOGLE_PLACES', 'OSM', 'WEB_SEARCH']);
  assert.equal(st.OSM.mode, 'PUBLIC_DEMO'); assert.equal(st.GOOGLE_PLACES.enabled, false); assert.match(st.GOOGLE_PLACES.note, /standardmäßig aus/); assert.equal(st.WEB_SEARCH.enabled, false); assert.match(st.WEB_SEARCH.pricing, /^5 USD je 1\.000 Anfragen$/);
  const w = getWorld().find((b) => b.domain && b.variant === 'modern')!; const hit = await new MockWebSearchProvider().search({ query: `${w.name} ${w.city}` });
  assert.ok(hit.hits.some((h) => h.url.includes(w.domain!))); assert.deepEqual(hit.cost, { amount: 0, currency: 'EUR' });
  // Kostenkonfiguration: Providerpreis mit Währung, Budget in EUR, ein einziger Wechselkurs
  const W = cfg.pipeline.sources.WEB_SEARCH.pricing; assert.deepEqual([W.usdPerThousandRequests, W.currency, W.monthlyCreditUsd], [5, 'USD', 5]); assert.equal(cfg.pipeline.enrichment.monthly_enrichment_budget_eur, 10); assert.equal(cfg.pipeline.enrichment.daily_enrichment_budget_eur, 2); assert.equal(typeof cfg.ai.eurPerUsd, 'number');
  assert.ok(!('centsPerRequest' in cfg.pipeline.sources.WEB_SEARCH), 'keine mehrdeutige Cent-Angabe ohne Währung');
});

// ---------- 7. OSM-Modi ----------
test('OSM-Provider-Modi: PUBLIC_DEMO (Zwischenspeicher, Deckel), LOCAL_EXTRACT (eigener Server, kein Drosseln), COMMERCIAL_PROVIDER (Schlüssel Pflicht)', async () => {
  assert.equal(osmOptions({}).mode, 'PUBLIC_DEMO'); assert.equal(osmOptions({ OSM_MODE: 'LOCAL_EXTRACT' }).mode, 'LOCAL_EXTRACT'); assert.throws(() => osmOptions({ OSM_MODE: 'FOO' }), /OSM_MODE/);
  assert.equal(osmOptions({ APP_MODE: 'live' }).cacheDir, 'out/cache/osm'); assert.equal(osmOptions({}).cacheDir, undefined);
  assert.throws(() => new OsmPlacesProvider('a@b.example', undefined, { mode: 'LOCAL_EXTRACT' }), /OSM_OVERPASS_URL/);
  assert.throws(() => new OsmPlacesProvider('a@b.example', undefined, { mode: 'COMMERCIAL_PROVIDER', overpassUrl: 'https://o.example' }), /OSM_API_KEY/);
  const orig = globalThis.fetch; const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(String(url).includes('nominatim') || String(url).includes('geo.example') ? [{ lat: '49.25', lon: '6.85', display_name: 'V' }] : { elements: [{ type: 'node', id: 1, lat: 49.25, lon: 6.85, tags: { name: 'Salon A', shop: 'hairdresser' } }] }), { status: 200 }); }) as typeof fetch;
  try {
    const cacheDir = mkdtempSync(join(tmpdir(), 'osmcache-')); const pub = new OsmPlacesProvider('a@b.example', undefined, { mode: 'PUBLIC_DEMO', cacheDir }); (pub as any).throttle = async () => {};
    await pub.geocode('Völklingen'); await pub.geocode('Völklingen'); const q = { center: { lat: 49.25, lng: 6.85 }, radiusKm: 30, keywords: ['Friseur'], limit: 10 };
    await pub.search(q); await pub.search(q); assert.equal(calls.length, 2, 'zweite Anfrage kommt aus dem Zwischenspeicher'); assert.equal(pub.cacheHits, 2);
    assert.match(String((calls[0].init!.headers as any)['user-agent']), /a@b\.example/);
    calls.length = 0; const local = new OsmPlacesProvider('a@b.example', undefined, { mode: 'LOCAL_EXTRACT', overpassUrl: 'https://overpass.intern.example/api/interpreter', nominatimUrl: 'https://geo.example' });
    const t = Date.now(); await local.geocode('Völklingen'); await local.search({ ...q, radiusKm: 120 }); await local.search({ ...q, radiusKm: 120 });
    assert.ok(Date.now() - t < 1000, 'keine 1-Sekunden-Drosselung auf eigenem Server'); assert.match(calls[0].url, /^https:\/\/geo\.example\/search/); assert.match(calls[1].url, /^https:\/\/overpass\.intern\.example/); assert.ok(!calls.some((c) => /openstreetmap|overpass-api/.test(c.url)));
    assert.match(decodeURIComponent(String(calls[1].init!.body)), /around:120000/, 'eigener Server: großer Radius erlaubt'); assert.doesNotMatch(decodeURIComponent(String(calls[1].init!.body)), /around:50000/);
    calls.length = 0; const com = new OsmPlacesProvider('a@b.example', undefined, { mode: 'COMMERCIAL_PROVIDER', overpassUrl: 'https://api.anbieter.example/op', nominatimUrl: 'https://api.anbieter.example/geo', apiKey: 'SECRET' });
    await com.search(q); assert.equal((calls[0].init!.headers as any).authorization, 'Bearer SECRET');
    calls.length = 0; await pub.search({ ...q, radiusKm: 120 }); assert.match(decodeURIComponent(String(calls[0].init!.body)), /around:50000/, 'öffentliche Server: Radiusdeckel 50 km');
  } finally { globalThis.fetch = orig; }
});

test('Verzeichnisse, Portale, Buchungs- und Jobseiten gelten nie als eigene Website; eigene Domains und Baukasten-Adressen schon', () => {
  const dir = ['www.gelbeseiten.de', 'www.dasoertliche.de', 'sellwerk.de', 'www.oeffnungszeitenbuch.de', 'www.provenexpert.com', 'bridebook.com', 'www.stepstone.de', 'www.planity.com', 'www.treatwell.de', 'www.fresha.com', 'calendly.com', 'www.facebook.com', 'm.instagram.com', 'x.com', 'de.wikipedia.org', 'www.golocal.de', 'web2.cylex.de'];
  for (const h of dir) assert.ok(NOT_OWN_SITE.test(h + '.'), `${h} ist ein Verzeichnis/Portal`);
  const own = ['www.haarstudio-tanja.de', 'saarschere.de', 'hairloft-saarlouis.de', 'salon-lisa.jimdosite.com', 'www.friseur-tamer.de', 'sellwerkstatt.de', 'www.boxer.de'];
  for (const h of own) assert.ok(!NOT_OWN_SITE.test(h + '.'), `${h} ist (möglicherweise) eine eigene Website`);
});

test('Anschrift auf Websites: Straße + Hausnummer vor „PLZ Ort“; Telefonnummern, Firmennamen und Platzhalter werden nie als Anschrift gelesen (an einer echten Salon-Website gefundener Fehler)', () => {
  const cases: [string, string | null][] = [
    ['Wir freuen uns auf Ihren Anruf. 0683146306 Instagraminhalte von @wellapro_dach', null],      // Telefonnummer enthält „46306“ – keine PLZ
    ['Telefon: 06831 46306 Instagram', null], ['Fax 6831 46306 Foo', null],
    ['Dieselstr. 5 66740 Saarlouis Hier finden Sie unseren Salon', 'Dieselstr. 5|66740|Saarlouis'],
    ['Salon Schoenes GmbH Dieselstr. // Globus // Globus 66740 Saarlouis Telefon: 0683146306', null],  // Hausnummer fehlt (Platzhalter) – nichts raten
    ['Impressum Nagelstudio Mafezun Testweg 3, 66333 Völklingen', 'Testweg 3|66333|Völklingen'],
    ['Haarstudio Tanja, Am Markt 25, 66763 Dillingen/Saar', 'Am Markt 25|66763|Dillingen/Saar'], ['Lange Straße 7, 66333 Völklingen', 'Lange Straße 7|66333|Völklingen'],
    ['Silberherzstraße 22-24, 66740 Saarlouis', 'Silberherzstraße 22-24|66740|Saarlouis'], ['Stummstraße 46a · 66763 Dillingen/Saar', 'Stummstraße 46a|66763|Dillingen/Saar'],
    ['Lisdorfer Str. 4 66740 Saarlouis', 'Lisdorfer Str. 4|66740|Saarlouis'], ['Postfach 12 66740 Saarlouis', null],
    ['Hauptstraße 12 | 66333 Völklingen', 'Hauptstraße 12|66333|Völklingen'], ['Bahnhofstr. 3a, 66111 Saarbrücken', 'Bahnhofstr. 3a|66111|Saarbrücken'],
  ];
  for (const [text, want] of cases) { const r = findAddressIn(text); assert.equal(r ? [r.street, r.postalCode, r.city].join('|') : null, want, text); }
});
