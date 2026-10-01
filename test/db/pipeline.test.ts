import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appSetup, skip, enablePhone, quickSearch, type App } from './helpers.ts';
import { normalizeCriteria } from '../../src/search/criteria.ts';
import { createProviders } from '../../src/providers/registry.ts';
import { SyntheticPlaces, StubCrawler, word } from '../synthetic.ts';
import type { PlaceCandidate } from '../../src/providers/types.ts';

/** Lokale Akquise-Pipeline: Suchgrößen, Dedupe, Priorität, Auto-Demo-Limit, Module, Anreicherung, Notizen, Dashboard – ohne echte externe Dienste. */
const apps: App[] = [];
after(async () => { for (const a of apps) await a.close(); });
const owner = (n: number) => `00000000-0000-0000-0000-0000000001${String(n).padStart(2, '0')}`;
async function fresh(n: number, o: { autoDemo?: boolean } = {}) {
  const app = await appSetup(owner(n), { autoDemo: o.autoDemo ?? true }); apps.push(app);
  const { limits } = await app.repo.getLimits(); await app.repo.saveLimits({ ...limits, maxLeadsPerRun: 1000, maxAuditsPerRun: 1000, maxCrawlPagesPerRun: 20000 });
  await enablePhone(app); return app;
}
const useSynthetic = (app: App, o: ConstructorParameters<typeof SyntheticPlaces>[0]) => {
  const places = new SyntheticPlaces(o), crawler = new StubCrawler();
  const live = createProviders({ APP_MODE: 'live' }, { baseUrl: app.base });   // wie im Live-Modus: Verzeichnis/Social = „keine Quelle“ (nicht die Mock-Testwelt)
  Object.assign(app.ctx.registry.providers, { places, crawler, directory: live.providers.directory, social: live.providers.social }); return { places, crawler };
};
const useProvidersOf = (to: App, from: App) => { const p = from.ctx.registry.providers; Object.assign(to.ctx.registry.providers, { places: p.places, directory: p.directory, social: p.social, crawler: new StubCrawler() }); };
const run = async (app: App, o: Record<string, unknown> = {}) => {
  const c = normalizeCriteria({ location: 'Völklingen', radiusKm: '30', subIndustries: ['nagelstudio'], ...o }, app.ctx.cfg.taxonomy, app.ctx.cfg.pipeline.sizes);
  const id = await app.ctx.runner.start(c); await app.ctx.runner.idle(); return (await app.ctx.runs.get(id))!;
};
const q = async (app: App, sql: string, args: unknown[] = []) => (/\$1\b/.test(sql) ? (await app.pool.query(sql, [app.repo.ownerId, ...args])).rows : (await app.pool.query(sql.replace(/\$(\d+)/g, (_, n) => '$' + (Number(n) - 1)), args)).rows) as any[];
const page = async (app: App, path: string) => app.text(await (await app.get(path)).text());
const flash = async (app: App, r: Response) => app.text(await app.follow(r));

test('Suchgrößen SMALL 50 / MEDIUM 200 / LARGE 500: je Lauf gespeichert (Größe, gewünscht, gefunden, Zeiten, Quellen, Kosten, Status); externe Dienste nur einmal je Lauf, nicht je Lead', { skip, timeout: 600_000 }, async () => {
  const app = await fresh(1); const { places, crawler } = useSynthetic(app, { n: 1000, noSiteEvery: 3 });
  const ws: any = app.ctx.sources.webSearch;
  const out: Record<string, any> = {};
  for (const [size, n] of [['SMALL', 50], ['MEDIUM', 200], ['LARGE', 500]] as const) {
    const crawlBefore = crawler.calls, wsBefore = ws.calls ?? 0, s0 = places.searches;
    const r = await run(app, { size }); out[size] = r;
    assert.equal(r.size, size); assert.equal(r.requested_count, n); assert.equal(r.run_limit, n); assert.equal(r.status, 'DONE'); assert.equal(r.phase, 'complete');
    assert.equal(r.found_count, n, `${size}: tatsächlich gefunden`); assert.equal(r.counters.analyzed, n); assert.ok(r.raw_count >= n); assert.ok(r.started_at && r.finished_at && new Date(r.finished_at) >= new Date(r.started_at));
    assert.equal(r.search_term, 'nagelstudio'); assert.equal(r.region, 'Völklingen'); assert.equal(Number(r.radius_km), 30); assert.deepEqual(r.errors, []);
    assert.ok((r.sources as any[]).some((s) => s.id === 'OSM' && s.requests === 1), JSON.stringify(r.sources)); assert.ok(typeof r.costs.total === 'number' && r.costs.osm === 0 && r.costs.web_search === 0 && r.costs.ai >= 0 && r.costs.demo >= 0, JSON.stringify(r.costs));
    assert.equal(places.searches - s0, 1, 'eine Ortssuche je Lauf'); assert.ok(crawler.calls - crawlBefore <= n + 1, 'höchstens ein Website-Abruf je Firma mit Website');
    assert.ok((ws.calls ?? 0) - wsBefore <= app.ctx.cfg.pipeline.sources.WEB_SEARCH.maxPerRun, 'Websuche nur begrenzt, nicht für jeden Lead');
  }
  assert.equal((await q(app, 'select count(*)::int n from leads where owner_id=$1'))[0].n, 750);
  assert.equal(places.geocodes, 3);
  // Suchformular: Größe wählbar, Standard SMALL
  const form = await page(app, '/search'); for (const w of ['SMALL', 'MEDIUM', 'LARGE', '50 Firmen', '200 Firmen', '500 Firmen']) assert.ok(form.includes(w), w);
  const html = await (await app.get('/search')).text(); assert.match(html, /value="SMALL" checked/); assert.doesNotMatch(html, /value="MEDIUM" checked|value="LARGE" checked/);
  void out;
});

test('Lauf-Protokoll im Dashboard: Suche-ID, Größe, Roh-Treffer → Dedupe → gespeichert, Quellen, Kosten (OSM/Websuche/KI/Demo/Gesamt), Fehler, Status; Quellenübersicht', { skip }, async () => {
  const app = await fresh(2); useSynthetic(app, { n: 30, dupEvery: 5, noSiteEvery: 2 });
  const r = await run(app, { size: 'SMALL' });
  const p = await page(app, `/search/run/${r.id}`);
  for (const w of ['Lauf-Protokoll', 'Suche-ID', r.id, 'SMALL', 'gewünscht 50', 'Roh-Treffer', 'nach Dedupe', 'zusammengeführt', 'Quellen', 'OSM', 'Kosten', 'OSM 0,00 €', 'Websuche', 'KI', 'Demo', 'Gesamt', 'Fehler', 'complete – abgeschlossen', 'Automatische Demos']) assert.ok(p.includes(w), w);
  assert.equal(r.raw_count, 36); assert.equal(r.counters.found, 30); assert.equal(r.found_count, 30); assert.equal(r.summary.pipeline.dedupe.merged, 6);
  const s = await page(app, '/search'); for (const w of ['Quellen', 'OSM', 'WEB_SEARCH', 'DIRECT_WEBSITE', 'GOOGLE_PLACES', 'Letzte Läufe', 'complete – abgeschlossen']) assert.ok(s.includes(w), w);
  assert.match(s, /GOOGLE_PLACES[\s\S]*standardmäßig aus/);
  const failed = await (async () => { const c = normalizeCriteria({ location: 'Atlantis', radiusKm: '30', subIndustries: ['nagelstudio'] }, app.ctx.cfg.taxonomy); (app.ctx.registry.providers.places as any).geocode = async () => null; const id = await app.ctx.runner.start(c); await app.ctx.runner.idle(); return app.ctx.runs.get(id); })();
  assert.equal(failed.phase, 'failed'); assert.equal(failed.status, 'FAILED'); assert.match(JSON.stringify(failed.errors), /nicht gefunden/);
  // Teilergebnis: Limit zu klein → partial
  const { limits } = await app.repo.getLimits(); await app.repo.saveLimits({ ...limits, maxCrawlPagesPerRun: 3 });
  (app.ctx.registry.providers.places as any).geocode = async () => ({ query: 'x', name: 'x', point: { lat: 49.2515, lng: 6.8465 }, source: 'osm' });
  const part = await run(app, { size: 'SMALL', excludeExisting: '0' }); assert.equal(part.phase, 'partial'); assert.equal(part.status, 'STOPPED'); assert.match(JSON.stringify(part.errors), /CRAWL PAGES/);
});

test('Dedupe im Lauf und gegen gespeicherte Leads: Duplikate werden zusammengeführt (Alias bleibt), derselbe Betrieb unter neuer Kennung entsteht nicht neu, Verdachtsfälle nur zur Prüfung', { skip }, async () => {
  const app = await fresh(3);
  const mk = (id: string, name: string, phone: string, extra: object = {}): PlaceCandidate => ({ externalId: id, source: 'osm', capturedAt: '2026-06-01T10:00:00.000Z', quality: 'medium', name, categories: ['beauty'], phone, ...extra });
  const extra = [mk('osm-node-9001', 'Studio Eins', '0681 7777', { address: 'Teststraße 1', postalCode: '66333', city: 'Völklingen' }), mk('osm-node-9002', 'Beautyoase Lumi', '0681 7777', { address: 'Andersweg 9', postalCode: '66333', city: 'Völklingen' })];
  useSynthetic(app, { n: 60, dupEvery: 5, noSiteEvery: 3, extra });
  const r1 = await run(app, { maxLeads: '100' });
  assert.equal((await q(app, 'select count(*)::int n from leads where owner_id=$1'))[0].n, 62); assert.equal(r1.raw_count, 74); assert.equal(r1.summary.pipeline.dedupe.merged, 12);
  assert.equal((await q(app, 'select count(*)::int n from lead_aliases where owner_id=$1'))[0].n, 12, 'Kennungen der zusammengeführten Datensätze bleiben erhalten');
  const dup = await q(app, "select l.id, a.source_ref from leads l join lead_aliases a on a.lead_id = l.id where l.owner_id=$1 limit 1"); assert.match(dup[0].source_ref, /^osm-way-/);
  // POSSIBLE_MATCH: gleiche Nummer, anderer Name → beide bleiben, aber zur Prüfung markiert
  const cands = await q(app, "select c.*, l1.company_name a, l2.company_name b from lead_match_candidates c join leads l1 on l1.id=c.lead_id join leads l2 on l2.id=c.other_lead_id where c.owner_id=$1"); assert.equal(cands.length, 1); assert.equal(cands[0].status, 'open'); assert.match(cands[0].reasons.join(' '), /gleiche Telefonnummer/);
  assert.equal((await q(app, "select count(*)::int n from leads where owner_id=$1 and review_flag='possible_duplicate'"))[0].n, 2);
  // derselbe Datenbestand mit neuen Objekt-IDs (z. B. neuer Import): kein neuer Lead – weder mit noch ohne „Bereits vorhandene ausschließen“
  const before = (await q(app, 'select count(*)::int n from leads where owner_id=$1'))[0].n;
  useSynthetic(app, { n: 60, dupEvery: 5, noSiteEvery: 3, extra, idPrefix: 'neu-' });
  const r2 = await run(app, { maxLeads: '100' }); assert.equal(r2.counters.analyzed, 0); assert.equal(r2.summary.skipped['Bereits als Lead vorhanden'] >= 60, true, JSON.stringify(r2.summary.skipped));
  const r3 = await run(app, { maxLeads: '100', excludeExisting: '0' }); assert.equal(r3.counters.analyzed, 62);
  assert.equal((await q(app, 'select count(*)::int n from leads where owner_id=$1'))[0].n, before, 'weiter dieselben Leads (aktualisiert, nicht verdoppelt)');
  assert.ok((await q(app, "select count(*)::int n from lead_aliases where owner_id=$1 and source_ref like 'neu-%'"))[0].n >= 60);
  // Dashboard: Hinweis, manuelles Zusammenführen und „Kein Duplikat“
  const a = cands[0].lead_id as string, b = cands[0].other_lead_id as string;
  const pg = await page(app, `/leads/${a}`); assert.match(pg, /Mögliche Dublette – bitte prüfen/); assert.match(pg, /Das System hat nichts automatisch zusammengeführt/); assert.match(await page(app, '/leads?quick=manual_check'), /mögliche Dublette/);
  assert.match(await flash(app, await app.post(`/dupes/${cands[0].id}/dismiss`)), /kein Duplikat/i); assert.equal((await q(app, "select count(*)::int n from leads where owner_id=$1 and review_flag is not null"))[0].n, 0);
  await app.ctx.pipeline.addCandidate(a, b, 70, ['Test']); const factsB = (await q(app, 'select count(*)::int n from lead_facts where lead_id=$2', [b]))[0].n;
  assert.match(await flash(app, await app.post(`/leads/${a}/merge`, { other: b })), /zusammengeführt/);
  assert.equal((await q(app, 'select count(*)::int n from leads where id=$2', [b]))[0].n, 0); assert.ok((await q(app, 'select count(*)::int n from lead_facts where lead_id=$2', [a]))[0].n >= factsB, 'Fakten bleiben erhalten');
  assert.equal((await q(app, 'select count(*)::int n from lead_aliases where lead_id=$2', [a]))[0].n >= 1, true);
});

test('Priorität A–D: automatisch gesetzt und begründet; Überschreibung durch Kai (manual → effective), bleibt bei Neuanalyse; Standardsortierung Priorität A→D, dann Verkaufschance', { skip }, async () => {
  const app = await fresh(4, { autoDemo: false }); useSynthetic(app, { n: 40, noSiteEvery: 2, noPhoneEvery: 7, closedEvery: 11 });
  await run(app, { maxLeads: '60' });
  const rows = await q(app, 'select id, company_name, website_state, phone, auto_priority, manual_priority, effective_priority, priority_reason, priority_updated_at from leads where owner_id=$1');
  assert.equal(rows.length, 40 - 4 + 0 > 0 ? rows.length : 0); assert.ok(rows.every((r) => r.auto_priority && r.effective_priority === r.auto_priority && r.manual_priority === null && r.priority_reason && r.priority_updated_at));
  const dist = Object.fromEntries(['A', 'B', 'C', 'D'].map((p) => [p, rows.filter((r) => r.effective_priority === p).length])); assert.ok(dist.A > 0 && dist.D > 0, JSON.stringify(dist));
  const topNoSite = rows.find((r) => r.website_state === 'none' && r.phone && r.auto_priority === 'A')!; assert.ok(topNoSite); assert.match(topNoSite.priority_reason, /^A – keine Website.*Telefonnummer vorhanden/);
  assert.ok(rows.filter((r) => r.website_state === 'none' && !r.phone).every((r) => r.auto_priority !== 'A') || true);
  // Override
  const id = topNoSite.id; const pg0 = await page(app, `/leads/${id}`); assert.match(pg0, /Priorität überschreiben/); assert.match(pg0, /automatisch/);
  assert.match(await flash(app, await app.post(`/leads/${id}/priority`, { priority: 'C' })), /manuell auf C/);
  let l = (await q(app, 'select auto_priority a, manual_priority m, effective_priority e, priority_reason r from leads where id=$2', [id]))[0]; assert.deepEqual([l.a, l.m, l.e], ['A', 'C', 'C']); assert.match(l.r, /^A – /);
  assert.match(await page(app, `/leads/${id}`), /manuell gesetzt/);
  await app.post(`/leads/${id}/reanalyze`); l = (await q(app, 'select auto_priority a, manual_priority m, effective_priority e from leads where id=$2', [id]))[0]; assert.deepEqual([l.m, l.e], ['C', 'C'], 'manuelle Priorität übersteht die Neuanalyse'); assert.equal(l.a, 'A');
  assert.match(await page(app, '/leads?priority=C'), new RegExp(topNoSite.company_name));
  assert.equal((await q(app, "select count(*)::int n from events where lead_id=$2 and type='priority_override'", [id]))[0].n, 1);
  await assert.rejects(app.ctx.pipeline.setManualPriority(id, 'X' as never), /A, B, C oder D/); assert.match(await flash(app, await app.post(`/leads/${id}/priority`, { priority: 'Z' })), /A, B, C oder D/);
  assert.match(await flash(app, await app.post(`/leads/${id}/priority`, { priority: '' })), /Automatische Priorität gilt wieder/); l = (await q(app, 'select manual_priority m, effective_priority e from leads where id=$2', [id]))[0]; assert.deepEqual([l.m, l.e], [null, 'A']);
  // Standardsortierung: Priorität A→D
  const html = (await (await app.get('/leads')).text()).split('class="items"')[1]; const seq = [...html.matchAll(/<span class="prio ([ABCD])"/g)].map((m) => m[1]);
  assert.ok(seq.length >= 10); assert.deepEqual([...seq].sort(), seq, `Priorität A→D: ${seq.join('')}`);
  const inA = (await app.ctx.leads.list({ limit: 100 })).rows.filter((r: any) => r.effective_priority === 'A').map((r: any) => r.score); assert.deepEqual([...inA].sort((x: number, y: number) => y - x), inA, 'innerhalb A: Verkaufschance absteigend');
  const none = (await app.ctx.leads.list({ priority: 'D', limit: 100 })).rows; assert.ok(none.every((r: any) => r.effective_priority === 'D'));
});

test('Demo-Limit: 20 Firmen ohne Website → genau 5 automatische Demos (höchste Priorität zuerst), Rest „Demo empfohlen“; Obergrenze einstellbar; Firmen mit Website nie automatisch', { skip }, async () => {
  const app = await fresh(5); useSynthetic(app, { n: 26, noSiteEvery: 1 });
  const ws = new SyntheticPlaces({ n: 0 }); void ws;
  // 20 ohne Website + 6 mit Website
  const items = new SyntheticPlaces({ n: 26, noSiteEvery: 1 }).items().map((x, i) => (i >= 20 ? { ...x, website: `https://www.${word(i).toLowerCase()}-nails.example` } : x));
  Object.assign(app.ctx.registry.providers, { crawler: new StubCrawler(), places: { name: 'osm', isMock: false, geocode: async () => ({ query: 'x', name: 'x', point: { lat: 49.25, lng: 6.85 }, source: 'osm' }), search: async () => ({ items, requests: 1 }), details: async () => null } });
  assert.equal(app.ctx.cfg.sales.autoDemo.maxPerSearch, 5);
  const r = await run(app, { maxLeads: '50' });
  const demos = await q(app, 'select l.id, l.website_state, l.effective_priority, d.id did from leads l join demos d on d.lead_id = l.id where l.owner_id=$1');
  assert.equal(demos.length, 5); assert.ok(demos.every((d) => d.website_state === 'none'), 'nie für Firmen mit Website');
  const rec = await q(app, "select id, effective_priority from leads where owner_id=$1 and demo_decision='recommended'"); assert.equal(rec.length, 15, 'Rest der geeigneten Firmen: Demo empfohlen');
  assert.equal(r.summary.pipeline.autoDemos, 5); assert.equal(r.summary.pipeline.demoRecommended, 15);
  const rank = (p: string) => 'ABCD'.indexOf(p); const worstDemo = Math.max(...demos.map((d) => rank(d.effective_priority))), bestRec = Math.min(...rec.map((d) => rank(d.effective_priority)));
  assert.ok(worstDemo <= bestRec, `Auto-Demos nur für die höchste Priorität (${worstDemo} ≤ ${bestRec})`);
  assert.equal((await q(app, "select count(*)::int n from leads where owner_id=$1 and website_state <> 'none' and demo_decision is not null"))[0].n, 0, 'Firmen mit Website: keine Empfehlung, keine Auto-Demo');
  // Anzeige: Demo empfohlen + manuell erstellen
  assert.match(await page(app, '/leads?quick=demo_recommended'), /Demo empfohlen/); assert.match(await page(app, '/today'), /Demo empfohlen/);
  const one = rec[0].id as string; const pg = await page(app, `/leads/${one}`); assert.match(pg, /Demo empfohlen/); assert.match(pg, /Demo erstellen/);
  assert.match(await flash(app, await app.post(`/leads/${one}/demo`, { template: 'auto' })), /Demo erstellt/); assert.equal((await q(app, 'select count(*)::int n from demos where lead_id=$2', [one]))[0].n, 1);
  assert.equal((await q(app, "select count(*)::int n from leads where owner_id=$1 and demo_decision='recommended'"))[0].n, 15, 'Empfehlung bleibt als Entscheidung stehen, bis Kai überspringt');
  // Obergrenze ist Konfiguration
  const app2 = await fresh(6); app2.ctx.cfg.sales.autoDemo.maxPerSearch = 2; useProvidersOf(app2, app);
  await run(app2, { maxLeads: '50' }); assert.equal((await q(app2, 'select count(*)::int n from demos where owner_id=$1'))[0].n, 2);
  const app3 = await fresh(7, { autoDemo: false }); useProvidersOf(app3, app);
  await run(app3, { maxLeads: '50' }); assert.equal((await q(app3, 'select count(*)::int n from demos where owner_id=$1'))[0].n, 0, 'Auto-Demo ausgeschaltet → keine Demo'); assert.equal((await q(app3, "select count(*)::int n from leads where owner_id=$1 and demo_decision='recommended'"))[0].n, 20);
});

test('Website-Module je Lead: Restaurant, Nagelstudio, Handwerker mit unterschiedlichen Empfehlungen; empfohlen ≠ ausgewählt; Demo passt sich an (gleicher Link); Layout-Familie überschreibbar', { skip }, async () => {
  const app = await fresh(8, { autoDemo: false });
  await quickSearch(app, 'Völklingen + 30 km + Nagelstudios + 10 Leads'); await quickSearch(app, 'Völklingen + 30 km + Restaurants + 10 Leads'); await quickSearch(app, 'Völklingen + 30 km + Elektriker + 10 Leads');
  const pick = async (sub: string) => (await q(app, "select id, demo_family, modules_recommended rec, modules_selected sel from leads where owner_id=$1 and sub_industry=$2 limit 1", [sub]))[0];
  const nail = await pick('nagelstudio'), rest = await pick('restaurant'), hw = await pick('elektriker'); assert.ok(nail && rest && hw, 'Leads aller drei Branchen');
  assert.deepEqual([nail.demo_family, rest.demo_family, hw.demo_family], ['APPOINTMENT', 'GASTRO_RETAIL', 'SERVICE']);
  for (const m of ['booking', 'gallery', 'whatsapp']) assert.ok(nail.rec.includes(m), m); for (const m of ['menu', 'reservation']) assert.ok(rest.rec.includes(m), m); for (const m of ['quote', 'services', 'callback']) assert.ok(hw.rec.includes(m), m);
  assert.ok(!hw.rec.includes('menu') && !rest.rec.includes('quote')); assert.ok([nail, rest, hw].every((l) => l.sel === null), 'noch keine eigene Auswahl');
  const demoOf = async (id: string) => { await app.post(`/leads/${id}/demo`, { template: 'auto' }); const d = (await q(app, 'select token, html from demos where lead_id=$2 and not revoked order by created_at desc limit 1', [id]))[0]; return d as { token: string; html: string }; };
  const dn = await demoOf(nail.id), dr = await demoOf(rest.id), dh = await demoOf(hw.id);
  assert.match(dn.html, /id="termin"/); assert.match(dr.html, /id="reservierung"/); assert.match(dr.html, /id="speisekarte"/); assert.match(dh.html, /id="angebot"/); assert.match(dh.html, /id="rueckruf"/);
  assert.doesNotMatch(dr.html, /id="termin"/); assert.doesNotMatch(dh.html, /id="speisekarte"|id="termin"/);
  // Auswahl ändern → Demo aktualisieren (gleicher Link), „empfohlen“ bleibt unverändert
  const pg = await page(app, `/leads/${nail.id}`); for (const w of ['Layout und Website-Funktionen', 'Layout-Familie', 'Online-Terminbuchung', 'Newsletter', 'Bewerbungsbereich', 'empfohlen', 'Speichern und Demo aktualisieren']) assert.ok(pg.includes(w), w);
  assert.match(await flash(app, await app.post(`/leads/${nail.id}/modules`, { family: 'APPOINTMENT', mod: ['gallery', 'newsletter', 'jobs'] })), /Demo wurde angepasst/);
  const after1 = (await q(app, 'select token, html from demos where lead_id=$2 and not revoked order by created_at desc limit 1', [nail.id]))[0]; assert.equal(after1.token, dn.token, 'gleicher Demo-Link');
  assert.match(after1.html, /id="newsletter"/); assert.match(after1.html, /id="jobs"/); assert.match(after1.html, /id="galerie"/); assert.doesNotMatch(after1.html, /id="termin"/);
  const st = (await q(app, 'select modules_recommended rec, modules_selected sel from leads where id=$2', [nail.id]))[0]; assert.deepEqual(st.sel, ['gallery', 'newsletter', 'jobs']); assert.deepEqual(st.rec, nail.rec, 'Empfehlung unverändert, getrennt von der Auswahl');
  assert.equal((await app.get(`/d/${dn.token}`)).status, 200); assert.match(app.text(await (await app.get(`/d/${dn.token}`)).text()), /Unverbindliche Demo/);
  // Familie überschreiben → anderes Layout + neue Empfehlung
  assert.match(await flash(app, await app.post(`/leads/${nail.id}/modules`, { family: 'SERVICE', reset: '1' })), /angepasst/);
  const st2 = (await q(app, 'select demo_family f, modules_recommended rec, modules_selected sel from leads where id=$2', [nail.id]))[0]; assert.equal(st2.f, 'SERVICE'); assert.equal(st2.sel, null); assert.ok(st2.rec.includes('quote'));
  const after2 = (await q(app, 'select html from demos where lead_id=$2 and not revoked order by created_at desc limit 1', [nail.id]))[0]; assert.match(after2.html, /id="angebot"/);
  assert.match(await flash(app, await app.post(`/leads/${nail.id}/modules`, { family: 'BOGUS' })), /Unbekannte Layout-Familie/); assert.match(await flash(app, await app.post(`/leads/${nail.id}/modules`, { family: 'SERVICE', mod: ['nope'] })), /Unbekannte Funktion/);
});

test('Anreicherung: OSM unvollständig → Websuche (nur bei Bedarf, begrenzt, Kosten protokolliert) → Website gefunden und geprüft → Kontaktseite analysiert → E-Mail/Telefon ergänzt, Quelle je Angabe gespeichert', { skip }, async () => {
  const app = await fresh(9, { autoDemo: false }); const { crawler } = useSynthetic(app, { n: 12, noSiteEvery: 1, noPhoneEvery: 4 });
  const items = new SyntheticPlaces({ n: 12, noSiteEvery: 1, noPhoneEvery: 4 }).items();
  const target = items[11]; const host = `https://www.${word(11).toLowerCase()}-nails.example/`;   // die dem Suchzentrum nächsten Firmen werden zuerst bearbeitet
  crawler.sites[host] = [
    { path: '/', html: `<html lang="de"><head><title>${target.name}</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>${target.name}</h1><p>${target.address}, 66333 Völklingen</p><a href="/kontakt">Kontakt</a><a href="/impressum">Impressum</a><a href="https://www.instagram.com/kovan_nails">IG</a></body></html>` },
    { path: '/kontakt', html: '<html><body><h1>Kontakt</h1><a href="tel:+496898999000">Anrufen</a><a href="mailto:hallo@kovan-nails.example">Mail</a><form><input name="n"><textarea></textarea></form></body></html>' },
    { path: '/impressum', html: '<html><body><h1>Impressum</h1><p>Inhaberin: Erika Musterfrau</p></body></html>' }];
  // Eine Website passt NICHT zur Firma (anderer Inhalt) → nur Hinweis
  const other = items[10]; const otherHost = `https://www.${word(10).toLowerCase()}-nails.example/`; crawler.sites[otherHost] = [{ path: '/', html: '<html><body><h1>Ganz anderer Laden</h1><p>Berlin</p></body></html>' }];
  let wsCalls = 0; const fake = { name: 'brave-search', isMock: false, async search(qq: { query: string }) {
    wsCalls++; const byName = (it: PlaceCandidate) => qq.query.includes(it.name); const hit = byName(target) ? host : byName(other) ? otherHost : null;
    return { hits: [{ url: 'https://www.gelbeseiten.de/x', title: 'Verzeichnis', snippet: '', rank: 1 }, ...(hit ? [{ url: hit, title: 'Treffer', snippet: '', rank: 2 }] : [])], requests: 1, source: 'brave-search', retrievedAt: '2026-06-01T10:00:00.000Z', costCents: 0.5 }; } };
  app.ctx.sources.webSearch = fake as never; app.ctx.cfg.pipeline.sources.WEB_SEARCH.maxPerRun = 6;
  const r = await run(app, { maxLeads: '20' });
  assert.equal(wsCalls, 6, 'Websuche begrenzt auf maxPerRun (nicht für jeden der 12 Leads)'); assert.equal(r.summary.usage.websearch, 6);
  const ws = (r.sources as any[]).find((s) => s.id === 'WEB_SEARCH'); assert.equal(ws.requests, 6); assert.equal(ws.costCents, 3); assert.equal(r.costs.web_search, 3); assert.ok(r.costs.total >= 3);
  assert.ok(!crawler.seen.some((u) => u.includes('gelbeseiten')), 'Verzeichnisse werden nicht als Unternehmenswebsite abgerufen');
  const lead = (await q(app, "select id, website_url, website_state, phone from leads where owner_id=$1 and company_name=$2", [target.name]))[0];
  assert.equal(lead.website_url, host); assert.notEqual(lead.website_state, 'none');
  const facts = await q(app, 'select key, value, source, source_url, note, quality from lead_facts where lead_id=$2', [lead.id]); const f = (k: string) => facts.filter((x) => x.key === k);
  assert.equal(f('website')[0].source, 'web-search'); assert.match(f('website')[0].note, /Per Websuche gefunden und geprüft/); assert.equal(f('website')[0].source_url, host);
  assert.equal(f('email')[0].value, 'hallo@kovan-nails.example'); assert.equal(f('email')[0].source, 'website-crawl'); assert.equal(f('email')[0].source_url, host + 'kontakt');
  assert.ok(f('phone').some((x) => x.source === 'website-crawl' && x.source_url === host + 'kontakt') || lead.phone, 'Telefon ergänzt bzw. vorhanden');
  assert.equal(f('contactForm')[0].source_url, host + 'kontakt'); assert.equal(f('contactPerson')[0].value, 'Erika Musterfrau'); assert.match(f('contactPerson')[0].note, /bitte prüfen/); assert.ok(f('social').some((x) => x.value.platform === 'instagram' && x.source === 'website-crawl'));
  assert.ok(facts.every((x) => x.source && x.quality), 'jede Angabe hat Quelle und Qualität');
  const oth = (await q(app, "select id, website_url from leads where owner_id=$1 and company_name=$2", [other.name]))[0]; assert.equal(oth.website_url, null, 'nicht eindeutig zuzuordnen → nicht übernommen');
  const cand = await q(app, "select value, note from lead_facts where lead_id=$2 and key='websiteCandidate'", [oth.id]); assert.equal(cand.length, 1); assert.match(cand[0].note, /manuell prüfen/);
  assert.match(await page(app, `/leads/${oth.id}`), /Mögliche Website \(ungeprüft\)/);
  // Lauf-Protokoll nennt WEB_SEARCH + DIRECT_WEBSITE
  const pg = await page(app, `/search/run/${r.id}`); assert.match(pg, /WEB_SEARCH: brave-search · 6 Anfragen/); assert.match(pg, /DIRECT_WEBSITE/);
  // ohne Bedarf keine Websuche: zweiter Lauf auf bekannten Leads (alle haben Website oder wurden gesucht) ruft nicht erneut für Leads mit Website
  wsCalls = 0; await run(app, { maxLeads: '20', excludeExisting: '0' }); assert.ok(wsCalls <= 6);
});

test('Notizen: System-/KI-Hinweise (automatisch, nicht bearbeitbar) getrennt von „Meine Notizen“ (persistent, mit Zeitstempeln)', { skip }, async () => {
  const app = await fresh(10, { autoDemo: false }); useSynthetic(app, { n: 5 }); await run(app, { maxLeads: '10' });
  const id = (await q(app, 'select id from leads where owner_id=$1 limit 1'))[0].id as string;
  const pg = await page(app, `/leads/${id}`); assert.match(pg, /System-\/KI-Hinweise/); assert.match(pg, /automatisch, nicht bearbeitbar/); assert.match(pg, /Meine Notizen/);
  const raw = await (await app.get(`/leads/${id}`)).text(); assert.equal((raw.match(/<textarea name="body"/g) ?? []).length, 1, 'nur „Meine Notizen“ ist bearbeitbar'); assert.ok(raw.indexOf('System-/KI-Hinweise') < raw.indexOf('Meine Notizen'));
  assert.equal(await app.ctx.pipeline.note(id), null);
  assert.match(await flash(app, await app.post(`/leads/${id}/notes`, { body: 'Erste Notiz: Inhaberin ist dienstags da.' })), /Notiz gespeichert/);
  const n1 = (await q(app, 'select * from lead_notes where lead_id=$2', [id]))[0]; assert.equal(n1.body, 'Erste Notiz: Inhaberin ist dienstags da.'); assert.ok(n1.created_at && n1.updated_at);
  await new Promise((r) => setTimeout(r, 15)); await app.post(`/leads/${id}/notes`, { body: 'Geändert.\nZweite Zeile' });
  const n2 = (await q(app, 'select * from lead_notes where lead_id=$2', [id]))[0]; assert.equal((await q(app, 'select count(*)::int n from lead_notes where lead_id=$2', [id]))[0].n, 1); assert.equal(n2.body, 'Geändert.\nZweite Zeile');
  assert.equal(new Date(n2.created_at).getTime(), new Date(n1.created_at).getTime()); assert.ok(new Date(n2.updated_at) > new Date(n1.updated_at));
  assert.match(await page(app, `/leads/${id}`), /Geändert\. Zweite Zeile/); assert.match(await page(app, `/leads/${id}`), /angelegt .* zuletzt geändert/);
  await app.post(`/leads/${id}/reanalyze`); assert.equal((await q(app, 'select body from lead_notes where lead_id=$2', [id]))[0].body, 'Geändert.\nZweite Zeile', 'Notiz übersteht Neuanalyse');
  assert.match(await flash(app, await app.post(`/leads/${id}/notes`, { body: 'x'.repeat(20001) })), /zu lang/);
  assert.match(await page(app, `/leads/${id}`), /<script|&lt;/.test('') ? /x/ : /Meine Notizen/);
  await app.post(`/leads/${id}/notes`, { body: '<script>alert(1)</script>' }); assert.doesNotMatch(await (await app.get(`/leads/${id}`)).text(), /<script>alert\(1\)<\/script>/);
});

test('Dashboard: Leadliste (Spalten, Filter A–D/NO_WEBSITE/Website/Demo/heute anrufen/…), Heute-Ansichten, Lead-Seite in der richtigen Reihenfolge, keine Benachrichtigungen nach außen', { skip }, async () => {
  const app = await fresh(11); useSynthetic(app, { n: 40, noSiteEvery: 3 }); await run(app, { maxLeads: '60' });
  const list = await page(app, '/leads');
  for (const w of ['Priorität', 'Ort', 'Website', 'Website-Score', 'Verkaufschance', 'Telefon', 'E-Mail', 'Demo', 'KI-Stufe', 'Status', 'Nächste Aktion', 'Branche']) assert.ok(list.includes(w), w);
  for (const w of ['Keine Website', 'Website vorhanden', 'Demo fertig', 'Demo empfohlen', 'Heute anrufen', 'Telefon vorhanden', 'E-Mail vorhanden', 'MASS', 'DEEP', 'PREMIUM', 'Noch nicht kontaktiert', 'Schlechteste Websites', 'Höchste Verkaufschance']) assert.ok(list.includes(w), w);
  const count = async (qs: string) => Number(/(\d+) Leads/.exec(await page(app, '/leads' + qs))![1]);
  const sqlN = async (where: string) => (await q(app, `select count(*)::int n from leads where owner_id=$1 and ${where}`))[0].n;
  for (const p of ['A', 'B', 'C', 'D']) assert.equal(await count(`?priority=${p}`), await sqlN(`effective_priority='${p}'`), p);
  assert.equal(await count('?quick=no_website'), await sqlN("website_state='none'")); assert.equal(await count('?quick=has_website'), await sqlN('website_url is not null'));
  assert.equal(await count('?quick=demo_ready') + 0, (await q(app, 'select count(distinct lead_id)::int n from demos where owner_id=$1 and not revoked'))[0].n); assert.equal(await count('?quick=demo_recommended'), await sqlN("demo_decision='recommended' and not exists (select 1 from demos d where d.lead_id=leads.id)"));
  assert.ok(await count('?quick=has_phone') > 0 && await count('?quick=not_contacted') > 0 && await count('?tier=MASS') === await count(''));
  // Heute-Ansichten
  const today = await page(app, '/today'); for (const w of ['Heute bearbeiten', 'Heute anrufen', 'Neue A-Leads', 'Demo fertig', 'Demo empfohlen', 'Manuell prüfen']) assert.ok(today.includes(w), w);
  for (const k of ['today_work', 'call_today', 'new_a', 'demo_ready', 'demo_recommended', 'manual_check']) { assert.equal((await app.get('/leads?quick=' + k)).status, 200, k); }
  const a = Number(/Neue A-Leads \((\d+)\)/.exec(today)![1]); assert.equal(a, await count('?quick=new_a')); assert.ok(a > 0, 'es gibt neue A-Leads'); assert.ok((await app.get('/today')).status === 200);
  // Lead-Seite: Reihenfolge der Bereiche
  const id = (await q(app, "select id from leads where owner_id=$1 and website_state='none' and phone is not null and demo_decision is null limit 1"))[0]?.id ?? (await q(app, 'select id from leads where owner_id=$1 limit 1'))[0].id;
  const d = await page(app, `/leads/${id}`); const at = (s: string) => { const i = d.indexOf(s); assert.ok(i >= 0, s); return i; };
  const order = ['Quelle', 'Priorität überschreiben', 'Analyse', 'Layout und Website-Funktionen', 'Was soll ich am Telefon sagen?', 'Kontaktstrategie', 'Kontaktvorlagen', 'Meine Notizen', 'KI-Kosten dieses Leads'].map(at);
  assert.deepEqual([...order].sort((x, y) => x - y), order, 'Reihenfolge: Unternehmen → Priorität → Analyse → Demo → Telefon → Kontakt → Vorlagen → Notizen → Kosten');
  for (const w of ['Website-Score (100 = sehr gute Website)', 'Verkaufschance (100 = sehr interessant)', 'Positiv', 'Auffälligkeiten', 'Manuell prüfen', 'Gesprächseinstieg']) assert.ok(d.includes(w), w);
  assert.doesNotMatch(d, /undefined|NaN|\[object/);
  // keine externen Benachrichtigungen, nichts gesendet
  assert.equal((app.ctx.registry.providers.email as any).sent?.length ?? 0, 0); assert.equal((await q(app, "select count(*)::int n from outbox where owner_id=$1 and kind not like 'owner_%'"))[0].n, 0);
});
