import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appSetup, skip, enablePhone, type App } from './helpers.ts';
import { createProviders } from '../../src/providers/registry.ts';
import { OsmPlacesProvider } from '../../src/providers/real/osm.ts';
import { buildReport, formatReport } from '../../src/acceptance/report.ts';
import { parseQuickSearch, normalizeCriteria } from '../../src/search/criteria.ts';

/**
 * Kern-Abnahmetest OFFLINE: die echte OSM-Provider-Klasse läuft gegen nachgestellte Nominatim-/Overpass-Antworten (so wie sie OSM liefert: oft ohne Telefon/Website).
 * Der echte Lauf gegen die OSM-Server ist `npm run acceptance` (braucht Netzfreigabe).
 */
const OWNER = '00000000-0000-0000-0000-0000000000f8';
let app: App; let origFetch: typeof fetch; let runId = '';
const T = (id: number, tags: Record<string, string>, extra: object = {}) => ({ type: 'node', id, lat: 49.25 + id / 1000, lon: 6.85 + id / 1000, tags, ...extra });
const OVERPASS = { elements: [
  T(1, { name: 'Nail Atelier Völklingen', shop: 'beauty', beauty: 'nails', phone: '+49 6898 111111', website: 'https://nail-atelier-voelklingen.example', 'addr:street': 'Rathausstraße', 'addr:housenumber': '3', 'addr:postcode': '66333', 'addr:city': 'Völklingen' }),
  T(2, { name: 'Nagelstudio Sonja', shop: 'beauty', beauty: 'nails', phone: '06898 222222', 'addr:street': 'Hauptstraße', 'addr:housenumber': '9', 'addr:city': 'Völklingen' }),
  T(3, { name: 'Glamour Nails', shop: 'beauty', beauty: 'nails' }),                    // nur Name + Ort: weder Telefon noch Website noch Adresse
  T(4, { name: 'Kosmetik Müller', shop: 'beauty', phone: '06898 444444', 'addr:street': 'Bahnhofstraße', 'addr:city': 'Großrosseln' }),
  { type: 'way', id: 5, center: { lat: 49.3, lon: 6.9 }, tags: { name: 'Beauty & Nails Lounge', shop: 'beauty', 'contact:phone': '+49 6898 555555', 'contact:website': 'https://lounge.example', 'addr:city': 'Püttlingen' } },
  T(6, { shop: 'beauty', beauty: 'nails' }),                                              // ohne Namen → wird nicht übernommen
  T(1, { name: 'Nail Atelier Völklingen' }),                                               // Dublette
] };

before(async () => {
  if (skip) return;
  app = await appSetup(OWNER, { cfgDir: 'config.mock' });
  origFetch = globalThis.fetch; const base = app.base;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(base)) return origFetch(url, init);
    if (u.includes('nominatim')) return new Response(JSON.stringify([{ lat: '49.2515', lon: '6.8465', display_name: 'Völklingen, Saarland, Deutschland' }]), { status: 200 });
    if (u.includes('overpass')) return new Response(JSON.stringify(OVERPASS), { status: 200 });
    throw new Error('unerwarteter Netzzugriff in Test: ' + u);
  }) as typeof fetch;
  const osm = new OsmPlacesProvider('test@beispiel.example', () => new Date('2026-06-01T10:00:00Z')); (osm as any).throttle = async () => {};
  const live = createProviders({ APP_MODE: 'live' }, { baseUrl: base });   // wie im Live-Modus: Verzeichnis/Social = „keine Quelle“, nicht Mock
  // Website-Abruf: statt des echten Crawlers (offline im Test) liefert ein Stub eine schlichte Seite für die zwei OSM-Websites
  const page = (u: string) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Nagelstudio</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>Nagelstudio</h1><p>Wir freuen uns auf Sie. Telefon <a href="tel:06898111111">06898 111111</a>.</p><a href="${u}/impressum">Impressum</a></body></html>`;
  const crawler = { name: 'test-crawler', isMock: false, async crawl(url: string) { return { ok: true, startUrl: url, finalUrl: url, pages: [{ url, status: 200, html: page(url), loadMs: 900, bytes: 600 }], capturedAt: '2026-06-01T10:00:00Z', requests: 1, source: 'test-crawler' }; } };
  Object.assign(app.ctx.registry.providers, { crawler, places: osm, directory: live.providers.directory, social: live.providers.social });
  await enablePhone(app);
  const c = normalizeCriteria(parseQuickSearch('Völklingen + 30 km + Nagelstudios + 200 Leads', app.ctx.cfg.taxonomy).criteria, app.ctx.cfg.taxonomy);
  runId = await app.ctx.runner.start(c); await app.ctx.runner.idle();
});
after(async () => { if (!skip) { globalThis.fetch = origFetch; await app.close(); } });

test('Live-Modus erfindet nichts: ohne angebundenes Verzeichnis/Social liefern diese Quellen keine Daten (kein Mock)', { skip }, async () => {
  const P = createProviders({ APP_MODE: 'live' }, { baseUrl: 'http://x' }).providers;
  assert.equal(P.directory.isMock, false); assert.deepEqual(await P.directory.search({ center: { lat: 49, lng: 6 }, radiusKm: 30, keywords: ['nagel'], limit: 50 }), { items: [], requests: 0 });
  const s = await P.social.lookup({ name: 'Nail Atelier Völklingen', city: 'Völklingen' }); assert.deepEqual(s.profiles, []); assert.equal(s.complete, false);
  assert.ok(!(await app.pool.query('select 1 from leads where owner_id=$1 and is_mock', [OWNER])).rowCount, 'keine Mock-Leads zwischen den echten');
});

test('OSM → Leads: Namenlose und Dubletten fallen weg, Lücken bleiben als Leads erhalten (DATA ENRICHMENT NEEDED), nichts erfunden', { skip }, async () => {
  const run = (await app.pool.query('select status, summary from lead_runs where id=$1', [runId])).rows[0];
  assert.equal(run.status, 'DONE'); assert.equal(run.summary.found, 5);
  const rows = (await app.pool.query("select company_name, phone, website_url, address, source, website_state from leads where owner_id=$1 order by company_name", [OWNER])).rows;
  assert.equal(rows.length, 5); assert.ok(rows.every((r) => r.source === 'osm'));
  const glam = rows.find((r) => r.company_name === 'Glamour Nails');
  assert.equal(glam.phone, null); assert.equal(glam.website_url, null); assert.equal(glam.address, null);      // nichts ergänzt
  assert.equal(rows.find((r) => r.company_name === 'Beauty & Nails Lounge').website_url, 'https://lounge.example');
  assert.equal(rows.find((r) => r.company_name === 'Beauty & Nails Lounge').phone, '+49 6898 555555');
});

test('Dashboard-Liste: Name, Adresse, Entfernung, Website, Telefon, Quelle, Branche, Datenqualität, Analyse, Score – Lücken als „nicht verfügbar“, ENRICHMENT-Status, OSM-Attribution', { skip }, async () => {
  const page = app.text(await (await app.get('/leads')).text());
  for (const w of ['Adresse', 'Entfernung', 'Telefon', 'Website', 'Quelle', 'Datenqualität', 'Analyse', 'Opportunity Score']) assert.ok(page.includes(w), w);
  assert.match(page, /Glamour Nails/); assert.match(page, /nicht verfügbar/); assert.match(page, /DATA ENRICHMENT NEEDED/);
  assert.match(page, /Fehlt: Telefonnummer · Website \(in OpenStreetMap nicht hinterlegt – bitte prüfen\) · Adresse/);
  assert.match(page, /OpenStreetMap/); assert.match(page, /Daten © OpenStreetMap-Mitwirkende \(ODbL\)/); assert.match(page, /openstreetmap\.org\/copyright/);
  assert.match(page, /\d+,\d km/);
  assert.doesNotMatch(page, /undefined|NaN|\[object/);
  assert.match(app.text(await (await app.get('/search')).text()), /Daten © OpenStreetMap-Mitwirkende/);
  const id = (await app.pool.query("select id from leads where company_name='Glamour Nails' and owner_id=$1", [OWNER])).rows[0].id;
  const d = app.text(await (await app.get(`/leads/${id}`)).text());
  assert.match(d, /DATA ENRICHMENT NEEDED/); assert.match(d, /Telefon nicht verfügbar/); assert.match(d, /Website nicht verfügbar/); assert.match(d, /Quelle OpenStreetMap/);
});

test('Leads ohne Website werden trotzdem analysiert und bewertet (NO_WEBSITE), die Bewertung erfindet nichts', { skip }, async () => {
  const rows = (await app.pool.query(`select l.company_name, l.website_state, o.score, o.category, o.missing, o.why from leads l left join lateral (select score, category, missing, why from opportunities where lead_id=l.id order by created_at desc limit 1) o on true where l.owner_id=$1 and l.website_url is null`, [OWNER])).rows;
  assert.ok(rows.length >= 3);
  for (const r of rows) { assert.equal(r.website_state, 'none', r.company_name); assert.ok(r.score !== null, `${r.company_name} hat einen Score`); assert.match(JSON.stringify(r.why), /keine eigene Website/i); }
  const glam = rows.find((r) => r.company_name === 'Glamour Nails');
  assert.ok(JSON.stringify(glam.missing).match(/Telefon|nicht/i), 'fehlende Daten sind als „nicht verfügbar“ ausgewiesen');
});

test('Anrufliste „Heute anrufen“: nur Leads mit Telefonnummer, Sortierung Score → Datenqualität → Contactability → Digital Need, Pflichtangaben je Lead', { skip }, async () => {
  const q = await app.ctx.calls.queue();
  assert.equal(q.items.length, 2, 'Websites sind in Ordnung → niedrige Chance → nicht in der Liste');
  assert.ok(q.items.every((i: any) => i.phone), 'ohne Telefonnummer keine Anrufliste');
  assert.ok(!q.items.some((i: any) => i.company_name === 'Glamour Nails'));
  const key = (i: any) => [i.score ?? -1, i.dq ?? -1, i.contactability ?? -1, i.digital_need ?? -1];
  for (let k = 1; k < q.items.length; k++) { const a = key(q.items[k - 1]), b = key(q.items[k]); const cmp = a.findIndex((v, n) => v !== b[n]); assert.ok(cmp === -1 || a[cmp] > b[cmp], `Reihenfolge verletzt bei ${k}: ${a} vs ${b}`); }
  const page = app.text(await (await app.get('/calls')).text());
  assert.match(page, /Heute anrufen/); assert.match(page, /Die wichtigsten Verkaufsgründe/); assert.match(page, /Gesprächseinstieg/); assert.match(page, /Empfohlene Leistung/); assert.match(page, /Opportunity Score/); assert.match(page, /Website nicht verfügbar|Website <code>/);
});

test('Abnahme-Bericht: Zahlen stimmen mit der Datenbank überein; es wurde nichts gesendet', { skip }, async () => {
  const r = await buildReport(app.repo, runId, app.ctx.registry.providers.ai);
  assert.equal(r.osm.found, 5); assert.equal(r.osm.withWebsite, 2); assert.equal(r.osm.withPhone, 4); assert.equal(r.osm.withoutWebsite, 3);
  assert.equal(r.osm.nailStudios, 4);   // Kosmetik Müller ist laut OSM kein Nagelstudio, obwohl die Suche es so einordnet assert.equal(r.osm.incomplete, 4);   // nur Nail Atelier hat Telefon + Website + Adresse
  assert.equal(r.ai.scoresCreated, 5); assert.equal(r.ai.websitesAnalyzed, 2); assert.equal(r.ai.aiCostPerLeadCents, null);
  assert.ok(r.sales.contactReady === 4 && r.sales.best.length === 5 && r.sales.best[0].score! >= r.sales.best[4].score!);
  const text = formatReport(r); assert.match(text, /SALES/); assert.match(text, /nicht verfügbar/); assert.match(text, /OSM/);
  assert.equal((app.ctx.registry.providers.email as any).sent.length, 0); assert.equal((app.ctx.registry.providers.whatsapp as any).sent.length, 0);
  assert.equal((await app.pool.query('select count(*)::int n from outbox where owner_id=$1', [OWNER])).rows[0].n, 0);
  assert.equal((await app.pool.query('select count(*)::int n from payments where owner_id=$1', [OWNER])).rows[0].n, 0);
});
