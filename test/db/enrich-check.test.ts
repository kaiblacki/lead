import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { appSetup, skip, enablePhone, type App } from './helpers.ts';
import { createProviders } from '../../src/providers/registry.ts';
import { SyntheticPlaces, StubCrawler, word } from '../synthetic.ts';
import { CappedWebSearch, CHECK_HARD_MAX_LEADS, ensureRun, pickLeads, renderReport, runEnrichmentCheck } from '../../src/enrich/check.ts';
import type { PlaceCandidate } from '../../src/providers/types.ts';

/**
 * Prüfskript für den kontrollierten Echttest der Anreicherung (src/enrich/check.ts): Auswahl, harte Obergrenze, Vorher/Nachher, Kosten mit Währung,
 * Sicherheitsprüfung. Websuche und Website-Abruf sind Testdoubles – kein Netz, keine Nachrichten, keine Demos.
 */
const apps: App[] = []; after(async () => { for (const a of apps) await a.close(); });
const owner = (n: number) => `00000000-0000-0000-0000-0000000003${String(n).padStart(2, '0')}`;
class FakeSearch {
  name = 'brave-search'; isMock = false; queries: string[] = []; hits: Record<string, string[]> = {};
  async search(q: { query: string }) {
    this.queries.push(q.query); const key = Object.keys(this.hits).find((n) => q.query.includes(n));
    return { hits: [{ url: 'https://www.gelbeseiten.de/x', title: 'Verzeichnis', snippet: '', rank: 1 }, ...(key ? this.hits[key].map((u, i) => ({ url: u, title: key, snippet: '', rank: i + 2 })) : [])], requests: 1, source: this.name, retrievedAt: '2026-06-01T10:00:00.000Z', cost: { amount: 0.005, currency: 'USD' as const } };
  }
}
const nameOf = (i: number) => `Nagelstudio ${word(i)}`; const siteOf = (i: number) => `https://www.${word(i).toLowerCase()}-nails.example/`;
const page = (name: string, o: { city?: string; plz?: string; street?: string; mail?: boolean } = {}) => `<html lang="de"><head><title>${name}</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>${name}</h1>${o.city ? `<p>${o.street ?? ''} ${o.plz ?? ''} ${o.city}</p>` : ''}${o.mail ? '<a href="mailto:hallo@salon.example">Mail</a>' : ''}<a href="/kontakt">Kontakt</a><a href="/impressum">Impressum</a></body></html>`;
/** OSM-typischer Lead ohne Stadt und Adresse (nur Name + Koordinaten), Koordinaten nahe dem Geocode-Ergebnis des Testdoubles. */
const NO_CITY: PlaceCandidate = { externalId: 'osm-node-9001', source: 'osm', capturedAt: '2026-06-01T10:00:00.000Z', quality: 'medium', name: 'Salon Ohneort', categories: ['beauty'], point: { lat: 49.2516, lng: 6.8466 }, mapsUrl: 'https://www.openstreetmap.org/node/9001' };

async function fresh(n: number, count = 6) {
  const app = await appSetup(owner(n), { autoDemo: false }); apps.push(app);
  const { limits } = await app.repo.getLimits(); await app.repo.saveLimits({ ...limits, maxLeadsPerRun: 1000, maxAuditsPerRun: 1000, maxCrawlPagesPerRun: 20000 }); await enablePhone(app);
  const places = new SyntheticPlaces({ n: count, noSiteEvery: 1, noPhoneEvery: 1, extra: [NO_CITY] }), crawler = new StubCrawler(); const live = createProviders({ APP_MODE: 'live' }, { baseUrl: app.base });
  Object.assign(app.ctx.registry.providers, { places, crawler, directory: live.providers.directory, social: live.providers.social });
  const ws = new FakeSearch(); app.ctx.sources.webSearch = ws as never;
  app.ctx.cfg.pipeline = JSON.parse(JSON.stringify(app.ctx.cfg.pipeline)); app.ctx.enrichment.d.cfg = app.ctx.cfg; (app.ctx.enrichment.budget as any).cfg = app.ctx.cfg.pipeline.enrichment;
  return { app, ws, crawler, places };
}
const q = async (app: App, sql: string, args: unknown[] = []) => (await app.pool.query(sql, [app.repo.ownerId, ...args])).rows as any[];

test('Prüfskript: Lauf wird kostenlos (ohne Websuche) angelegt bzw. wiederverwendet; ohne Lauf klare Meldung', { skip }, async () => {
  const { app, ws } = await fresh(1);
  await assert.rejects(ensureRun(app.ctx, { start: false }), /noch keinen Suchlauf .*Saarlouis.*SMALL.*--ensure-run/);
  const r = await ensureRun(app.ctx, { start: true });
  assert.equal(r.created, true); assert.equal(r.leads, 7); assert.equal(ws.queries.length, 0, 'beim Anlegen des Laufs keine einzige Websuche-Anfrage');
  const run = (await q(app, 'select status, sources, costs from lead_runs where owner_id=$1 and id=$2', [r.runId]))[0]; assert.equal(run.status, 'DONE'); assert.ok(!JSON.stringify(run.sources).includes('WEB_SEARCH')); assert.equal(Number(run.costs.web_search), 0);
  assert.equal((await q(app, "select count(*)::int n from leads where owner_id=$1 and enrichment_status is not null"))[0].n, 0, 'keiner der Leads wurde angereichert');
  const again = await ensureRun(app.ctx, { start: false }); assert.deepEqual([again.created, again.runId], [false, r.runId]);
});

test('Prüfskript: genannte Leads zuerst, höchstens 5, aufgefüllt nach Priorität; Obergrenze für Anfragen; Vorher → Nachher; Kosten in USD (5 USD/1000) und EUR getrennt; keine Demo, keine Nachricht, keine Freigabe', { skip }, async () => {
  const { app, ws, crawler } = await fresh(2);
  const { runId } = await ensureRun(app.ctx, { start: true });
  for (const l of await q(app, 'select id from leads where owner_id=$1')) await app.ctx.pipeline.setManualPriority(l.id, 'A');
  const L = async (n: string) => (await q(app, 'select * from leads where owner_id=$1 and company_name=$2', [n]))[0];
  const v = await L(nameOf(0)); ws.hits[nameOf(0)] = [siteOf(0)];
  crawler.sites[siteOf(0)] = [{ path: '/', html: page(nameOf(0), { city: 'Völklingen', plz: '66333', street: v.address }) }, { path: '/kontakt', html: '<html><body><h1>Kontakt</h1><a href="tel:+496898123456">Anrufen</a><a href="mailto:hallo@salon.example">Mail</a><form><input name="a"><textarea></textarea></form></body></html>' }, { path: '/impressum', html: `<html><body><h1>Impressum</h1><p>${nameOf(0)}</p><p>Inhaberin: Erika Muster</p></body></html>` }];
  ws.hits['Salon Ohneort'] = ['https://www.ohneort-salon.example/'];     // Standort stimmt nur über die Koordinaten (Testdouble-Geocode liegt am OSM-Punkt)
  crawler.sites['https://www.ohneort-salon.example/'] = [{ path: '/', html: page('Salon Ohneort', { city: 'Völklingen', plz: '66333', street: 'Testweg 3', mail: true }) + '<p>Impressum Salon Ohneort</p>' }];
  ws.hits[nameOf(2)] = [siteOf(2)]; crawler.sites[siteOf(2)] = [{ path: '/', html: '<html><head><title>Ganz anderer Laden</title></head><body><h1>Ganz anderer Laden</h1><p>Köln 50667</p></body></html>' }];   // nicht passend
  const before = { demos: (await q(app, 'select count(*)::int n from demos where owner_id=$1'))[0].n, outbox: (await q(app, 'select count(*)::int n from outbox where owner_id=$1'))[0].n };

  const names = [nameOf(0), 'Salon Ohneort', nameOf(2), nameOf(1), 'Gibt es nicht'];
  const progress: string[] = []; const rep = await runEnrichmentCheck(app.ctx, { runId, names, maxLeads: 50, maxRequests: 15, onProgress: (m) => progress.push(m) });
  assert.match(progress[0], /Prüfe 5 Lead\(s\) mit höchstens 15 Websuche-Anfragen/); assert.equal(progress.filter((x) => x.startsWith('▶')).length, 5); assert.ok(progress.some((x) => /✔ Salon Ohneort: Website gefunden \(verifiziert/.test(x)), progress.join('\n'));
  assert.equal(rep.leads.length, CHECK_HARD_MAX_LEADS, 'höchstens 5 Leads, auch wenn mehr verlangt werden'); assert.equal(rep.leads.filter((x) => x.picked === 'ausdrücklich ausgewählt').length, 4);
  assert.ok(rep.warnings.some((w) => /„Gibt es nicht“ wurde im Suchlauf nicht gefunden/.test(w))); assert.equal(rep.leads[4].picked, 'aufgefüllt: nächster DATA_NEEDED-Lead nach Priorität');
  assert.equal(app.ctx.sources.webSearch, ws as never, 'der ursprüngliche Anbieter wird nach dem Test wiederhergestellt');
  // Anfragen und Kosten: je Anfrage 0,005 USD (5 USD je 1.000) – USD und EUR werden nicht vermischt
  assert.equal(rep.requests, ws.queries.length); assert.ok(rep.requests >= 5 && rep.requests <= 15); assert.equal(rep.attempts, rep.requests);
  assert.deepEqual(rep.providerCost, { amount: Math.round(rep.requests * 0.005 * 1e6) / 1e6, currency: 'USD' }); assert.ok(Math.abs(rep.costEurCents - rep.requests * 0.005 * 0.92 * 100) < 1e-4, String(rep.costEurCents));
  const row = (await q(app, "select sum(requests)::int r, sum(provider_cost_amount)::float a, sum(cost_cents)::float c from enrichment_log where owner_id=$1 and provider_cost_currency='USD'"))[0];
  assert.equal(row.r, rep.requests); assert.ok(Math.abs(row.a - rep.providerCost.amount) < 1e-6); assert.ok(Math.abs(row.c - rep.costEurCents) < 1e-3);
  assert.equal(rep.budgetAfter.monthRequests, rep.requests); assert.ok(rep.budgetAfter.monthSpentCents > rep.budgetBefore.monthSpentCents);
  // Lead 1: Website verifiziert → Kontaktdaten direkt von der Website, neu bewertet, DATA_NEEDED fällt weg
  const a = rep.leads[0]; assert.equal(a.name, nameOf(0)); assert.equal(a.before.workStatus, 'DATA_NEEDED'); assert.equal(a.before.website, null);
  assert.equal(a.outcome!.verification, 'VERIFIED'); assert.equal(a.after!.website, siteOf(0)); assert.equal(a.after!.workStatus, 'CONTACTABLE'); assert.equal(a.after!.contactability, 'READY'); assert.equal(a.after!.websiteStatus, 'ANALYZED'); assert.ok(a.after!.websiteScore !== null);
  assert.ok(a.newFacts.some((f) => f.key === 'phone' && f.source === 'website-crawl' && f.sourceUrl === siteOf(0) + 'kontakt')); assert.ok(a.newFacts.some((f) => f.key === 'website' && f.source === 'web-search')); assert.ok(a.newFacts.every((f) => f.source));
  assert.equal(a.trace!.queries[0].hits.length, 2); assert.ok(a.trace!.candidates[0].why.length > 0);
  // Lead ohne Stadt/Adresse: nur über den Standort der Website-Adresse zugeordnet
  const nc = rep.leads[1]; assert.equal(nc.name, 'Salon Ohneort'); assert.equal(nc.before.city, null); assert.ok(['VERIFIED', 'LIKELY'].includes(nc.outcome!.verification!), String(nc.outcome!.verification)); assert.ok(nc.trace!.candidates[0].distanceKm! < 0.4);
  // Namensvetter/unpassende Seite: nicht übernommen
  const bad = rep.leads[2]; assert.equal(bad.name, nameOf(2)); assert.equal(bad.after!.website, null); assert.equal(bad.after!.workStatus, 'DATA_NEEDED'); assert.ok(['REJECTED', 'UNCERTAIN'].includes(bad.outcome!.verification!));
  // Sicherheitsprüfung: keine Demo, keine Nachricht, nichts über „empfohlen“ hinaus
  assert.equal(rep.safety.ok, true, rep.safety.violations.join('; ')); assert.equal((await q(app, 'select count(*)::int n from demos where owner_id=$1'))[0].n, before.demos); assert.equal((await q(app, 'select count(*)::int n from outbox where owner_id=$1'))[0].n, before.outbox);
  assert.equal((await q(app, "select count(*)::int n from approvals where owner_id=$1 and (action<>'DEMO_CREATE' or state in ('AWAITING_APPROVAL','APPROVED','COMPLETED'))"))[0].n, 0);
  // Bericht: Vorher/Nachher, Quellen je Angabe, Kosten mit Währung, Hochrechnung; JSON-tauglich; kein Schlüssel
  const md = renderReport(rep); for (const s of ['VORHER → NACHHER', 'direkt von der Website', 'USD', 'EUR-Cent', 'work_status', 'website_score', 'sales_opportunity', 'Demo-Empfehlung', 'Instagram', 'Facebook', 'WhatsApp', 'Hochrechnung', 'Sicherheitsprüfung', nameOf(0), 'Salon Ohneort']) assert.ok(md.includes(s), s);
  if (process.env.DUMP_CHECK_REPORT) writeFileSync(process.env.DUMP_CHECK_REPORT, md);   // nur zum Ansehen des Berichts beim Entwickeln
  assert.match(md, /Keine Demo erstellt/); assert.deepEqual(JSON.parse(JSON.stringify(rep)).leads.length, 5);
  const stillNeeded = rep.leads.filter((x) => x.after?.workStatus === 'DATA_NEEDED').length; const allNeeded = (await q(app, "select count(*)::int n from leads where owner_id=$1 and work_status='DATA_NEEDED'"))[0].n;
  assert.equal(rep.extrapolation.remaining, allNeeded - stillNeeded, 'übrige Leads = alle DATA_NEEDED minus die geprüften');
});

test('Prüfskript: harte Obergrenze (Anfragen) beendet den Ablauf – restliche Leads bleiben unberührt; Trockenlauf sendet nichts; ohne Websuche kein Echtlauf', { skip }, async () => {
  const { app, ws } = await fresh(3, 8); const { runId } = await ensureRun(app.ctx, { start: true });
  for (const l of await q(app, 'select id from leads where owner_id=$1')) await app.ctx.pipeline.setManualPriority(l.id, 'B');
  const dry = await runEnrichmentCheck(app.ctx, { runId, names: [nameOf(0), nameOf(1)], dryRun: true });
  assert.equal(ws.queries.length, 0); assert.ok(dry.leads.every((x) => x.after === null && x.outcome === null)); assert.equal(dry.requests, 0); assert.match(renderReport(dry), /Trockenlauf/); assert.match(renderReport(dry), /Zustand VORHER/);
  const rep = await runEnrichmentCheck(app.ctx, { runId, names: [nameOf(0), nameOf(1), nameOf(2), nameOf(3)], maxLeads: 4, maxRequests: 4 });
  assert.equal(ws.queries.length, 4, 'nie mehr Anfragen als die Obergrenze'); assert.equal(rep.attempts, 4); assert.match(rep.stoppedBy ?? '', /Testobergrenze von 4 Anfragen/);
  const untouched = rep.leads.filter((x) => x.skipped); assert.ok(untouched.length >= 1, 'Leads nach der Obergrenze nicht geprüft'); assert.ok(untouched.every((x) => /Ablauf vorher beendet/.test(x.skipped!)));
  for (const x of untouched) assert.equal((await q(app, 'select enrichment_status s from leads where owner_id=$1 and id=$2', [x.leadId]))[0].s, null, 'unberührt');
  assert.match(renderReport(rep), /Nicht geprüft/); assert.match(renderReport(rep), /Ablauf vorzeitig beendet/);
  // Zwischenspeicher: derselbe Test wiederholt keine Suche (0 Anfragen); nur mit ignoreCache wird erneut gesucht. Ungültige Obergrenzen (NaN, 0, negativ) bedeuten nie „unbegrenzt“
  const again = await runEnrichmentCheck(app.ctx, { runId, names: [nameOf(0), nameOf(1)], maxRequests: 15 }); assert.equal(again.requests, 3 * 0 + again.leads.reduce((n, x) => n + (x.outcome?.requests ?? 0), 0));
  const cachedOnes = again.leads.filter((x) => x.outcome?.status === 'cached'); assert.ok(cachedOnes.length >= 1 && cachedOnes.every((x) => x.outcome!.requests === 0));
  ws.queries.length = 0; const forced = await runEnrichmentCheck(app.ctx, { runId, names: [nameOf(0)], maxLeads: 1, maxRequests: Number.NaN, ignoreCache: true }); assert.equal(forced.capRequests, 3, 'NaN → Standard-Obergrenze (Leads × Anfragen je Lead)'); assert.ok(ws.queries.length >= 1 && ws.queries.length <= 3);
  assert.equal((await runEnrichmentCheck(app.ctx, { runId, names: [nameOf(0)], maxLeads: 1, maxRequests: -5, dryRun: true })).capRequests, 1); assert.equal((await runEnrichmentCheck(app.ctx, { runId, names: [nameOf(0)], maxLeads: Number.NaN, dryRun: true })).leads.length, CHECK_HARD_MAX_LEADS, 'NaN → Standard (höchstens 5, aufgefüllt)');
  // ohne Websuche (kein Schlüssel) kein Echtlauf, nichts verändert
  app.ctx.sources.webSearch = { name: 'keine-quelle', isMock: false, async search() { throw new Error('darf nicht aufgerufen werden'); } } as never;
  await assert.rejects(runEnrichmentCheck(app.ctx, { runId, names: [nameOf(5)] }), /BRAVE_SEARCH_API_KEY fehlt/);
});

test('Prüfskript: Auswahl – nur DATA_NEEDED, genannte zuerst, nie mehr als max; Zählwerk CappedWebSearch zählt auch Versuche', { skip }, async () => {
  const { app } = await fresh(4); const { runId } = await ensureRun(app.ctx, { start: true });
  const ids = await q(app, 'select id, company_name from leads where owner_id=$1 order by company_name');
  for (const l of ids) await app.ctx.pipeline.setManualPriority(l.id, 'C');
  await app.pool.query('update leads set work_status=$3 where id=$2 and owner_id=$1', [app.repo.ownerId, ids[0].id, 'CONTACTABLE']);
  const p = await pickLeads(app.ctx, runId, [ids[0].company_name, ids[1].company_name.toUpperCase(), 'Gibt es nicht'], 3);
  assert.deepEqual(p.picks.map((x) => x.name), [ids[1].company_name, ...p.picks.slice(1).map((x) => x.name)]); assert.equal(p.picks.length, 3); assert.ok(p.picks[0].explicit && !p.picks[1].explicit);
  assert.ok(p.warnings.some((w) => /nicht DATA_NEEDED/.test(w)) && p.warnings.some((w) => /nicht gefunden/.test(w))); assert.ok(!p.picks.some((x) => x.name === ids[0].company_name));
  const capped = new CappedWebSearch({ name: 'x', isMock: false, async search() { throw new Error('Netzfehler'); } }, 2);
  await assert.rejects(capped.search({ query: 'a' }), /Netzfehler/); await assert.rejects(capped.search({ query: 'b' }), /Netzfehler/);
  await assert.rejects(capped.search({ query: 'c' }), (e: any) => e.fatal === true && /Testobergrenze von 2 Anfragen/.test(e.message)); assert.equal(capped.attempts, 2);
});
