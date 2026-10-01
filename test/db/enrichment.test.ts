import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appSetup, skip, enablePhone, type App } from './helpers.ts';
import { normalizeCriteria } from '../../src/search/criteria.ts';
import { createProviders } from '../../src/providers/registry.ts';
import { SyntheticPlaces, StubCrawler, word } from '../synthetic.ts';
import { assessContactability } from '../../src/contact/contactability.ts';

/**
 * Web-Enrichment, DATA_NEEDED, Kontaktierbarkeit, Budget, Cache, Prioritätsreihenfolge und Freigabe-Workflow (Demo nur nach Bestätigung).
 * Websuche und Website-Abruf sind Testdoubles – es gibt keinen Netzzugriff und keine Nachrichten.
 */
const apps: App[] = []; after(async () => { for (const a of apps) await a.close(); });
const owner = (n: number) => `00000000-0000-0000-0000-0000000002${String(n).padStart(2, '0')}`;
class FakeSearch {
  name = 'brave-search'; isMock = false; queries: string[] = []; hits: Record<string, string[]> = {}; amount = 0.005; currency: 'USD' | 'EUR' = 'EUR'; fail = false;
  async search(q: { query: string }) {
    this.queries.push(q.query); if (this.fail) throw new Error('HTTP 500');
    const key = Object.keys(this.hits).find((n) => q.query.includes(n));
    return { hits: [{ url: 'https://www.gelbeseiten.de/x', title: 'Verzeichnis', snippet: '', rank: 1 }, ...(key ? this.hits[key].map((u, i) => ({ url: u, title: key, snippet: '', rank: i + 2 })) : [])], requests: 1, source: this.name, retrievedAt: '2026-06-01T10:00:00.000Z', cost: { amount: this.amount, currency: this.currency } };
  }
}
const nameOf = (i: number) => `Nagelstudio ${word(i)}`; const siteOf = (i: number) => `https://www.${word(i).toLowerCase()}-nails.example/`;
const page = (name: string, o: { city?: string; plz?: string; street?: string; mail?: boolean; tel?: string; impressum?: boolean } = {}) => `<html lang="de"><head><title>${name}</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>${name}</h1>${o.city ? `<p>${o.street ?? ''} ${o.plz ?? ''} ${o.city}</p>` : o.plz ? `<p>${o.plz}</p>` : ''}${o.mail ? '<a href="mailto:hallo@salon.example">Mail</a>' : ''}<a href="/kontakt">Kontakt</a><a href="/impressum">Impressum</a></body></html>`;

async function fresh(n: number, syn: ConstructorParameters<typeof SyntheticPlaces>[0], opts: { noWs?: boolean } = {}) {
  const app = await appSetup(owner(n), { autoDemo: false }); apps.push(app);
  const { limits } = await app.repo.getLimits(); await app.repo.saveLimits({ ...limits, maxLeadsPerRun: 1000, maxAuditsPerRun: 1000, maxCrawlPagesPerRun: 20000 }); await enablePhone(app);
  const places = new SyntheticPlaces(syn), crawler = new StubCrawler(); const live = createProviders({ APP_MODE: 'live' }, { baseUrl: app.base });
  Object.assign(app.ctx.registry.providers, { places, crawler, directory: live.providers.directory, social: live.providers.social });
  const ws = new FakeSearch(); app.ctx.sources.webSearch = ws as never;
  app.ctx.cfg.pipeline = JSON.parse(JSON.stringify(app.ctx.cfg.pipeline)); app.ctx.enrichment.d.cfg = app.ctx.cfg; (app.ctx.enrichment.budget as any).cfg = app.ctx.cfg.pipeline.enrichment;
  return { app, ws, crawler, places };
}
const q = async (app: App, sql: string, args: unknown[] = []) => (/\$1\b/.test(sql) ? (await app.pool.query(sql, [app.repo.ownerId, ...args])).rows : (await app.pool.query(sql.replace(/\$(\d+)/g, (_, n) => '$' + (Number(n) - 1)), args)).rows) as any[];
const run = async (app: App, o: Record<string, unknown> = {}, enrich = false) => { const keep = app.ctx.runner.d.enrichment; if (!enrich) app.ctx.runner.d.enrichment = undefined; const c = normalizeCriteria({ location: 'Völklingen', radiusKm: '30', subIndustries: ['nagelstudio'], maxLeads: '50', ...o }, app.ctx.cfg.taxonomy, app.ctx.cfg.pipeline.sizes); const id = await app.ctx.runner.start(c); await app.ctx.runner.idle(); app.ctx.runner.d.enrichment = keep; return (await app.ctx.runs.get(id))!; };
const leadByName = async (app: App, name: string) => (await q(app, 'select * from leads where owner_id=$1 and company_name=$2', [name]))[0];
const page_ = async (app: App, path: string) => app.text(await (await app.get(path)).text());
const flash = async (app: App, r: Response) => app.text(await app.follow(r));
const setPrio = async (app: App, id: string, p: 'A' | 'B' | 'C' | 'D') => app.ctx.pipeline.setManualPriority(id, p);

test('Kontaktierbarkeit und DATA_NEEDED: keine Telefonnummer + keine E-Mail → DATA_NEEDED (getrennt von A/B/C/D); PHONE_ONLY, EMAIL_ONLY, READY, WEB_FORM_ONLY, SOCIAL_ONLY, NO_CONTACT_DATA', { skip }, async () => {
  const c = (o: object) => assessContactability({ phone: false, email: false, webForm: false, whatsapp: false, social: false, ...o });
  assert.deepEqual(c({}), { contactability: 'NO_CONTACT_DATA', preferred: null, workStatus: 'DATA_NEEDED' });
  assert.deepEqual(c({ phone: true }), { contactability: 'PHONE_ONLY', preferred: 'PHONE', workStatus: 'CONTACTABLE' });
  assert.deepEqual(c({ email: true }), { contactability: 'EMAIL_ONLY', preferred: 'EMAIL', workStatus: 'CONTACTABLE' });
  assert.deepEqual(c({ phone: true, email: true }), { contactability: 'READY', preferred: 'PHONE', workStatus: 'CONTACTABLE' });
  assert.deepEqual(c({ webForm: true }), { contactability: 'WEB_FORM_ONLY', preferred: 'WEB_FORM', workStatus: 'DATA_NEEDED' }); assert.equal(c({ social: true }).contactability, 'SOCIAL_ONLY'); assert.equal(c({ whatsapp: true }).preferred, 'WHATSAPP');
  const { app } = await fresh(1, { n: 12, noSiteEvery: 1, noPhoneEvery: 2 }); await run(app);
  const rows = await q(app, 'select id, phone, work_status, contactability, preferred_contact_channel, effective_priority from leads where owner_id=$1');
  const noPhone = rows.filter((r) => !r.phone), withPhone = rows.filter((r) => r.phone); assert.ok(noPhone.length >= 4 && withPhone.length >= 4);
  assert.ok(noPhone.every((r) => r.work_status === 'DATA_NEEDED' && r.contactability === 'NO_CONTACT_DATA' && r.preferred_contact_channel === null));
  assert.ok(withPhone.every((r) => r.work_status === 'CONTACTABLE' && r.contactability === 'PHONE_ONLY' && r.preferred_contact_channel === 'PHONE'));
  assert.ok(noPhone.every((r) => r.effective_priority), 'DATA_NEEDED ist unabhängig von der Priorität A–D (jeder Lead hat eine)');
  // E-Mail-Fakt ergänzt → EMAIL_ONLY bzw. READY
  const a = noPhone[0].id, b = withPhone[0].id;
  for (const id of [a, b]) await app.pool.query("insert into lead_facts(owner_id, lead_id, key, value, source, source_url, quality, captured_at) values ($1,$2,'email','\"info@salon.example\"','website-crawl','https://x.example/kontakt','medium',now())", [app.repo.ownerId, id]);
  await app.ctx.pipeline.recomputePriority(a); await app.ctx.pipeline.recomputePriority(b);
  const [la, lb] = [(await q(app, 'select work_status w, contactability c from leads where id=$2', [a]))[0], (await q(app, 'select work_status w, contactability c from leads where id=$2', [b]))[0]];
  assert.deepEqual([la.w, la.c, lb.w, lb.c], ['CONTACTABLE', 'EMAIL_ONLY', 'CONTACTABLE', 'READY']);
  // Dashboard: Ansicht „Daten beschaffen“
  const pg = await page_(app, '/enrichment'); for (const w of ['Daten beschaffen', 'Website bekannt?', 'Fehlende Daten', 'Letzte Prüfung', 'Nächste Aktion', 'Enrichment-Budget', 'übrig diesen Monat', 'heutige Kosten', 'Anfragen diesen Monat', 'Kosten je angereichertem Lead']) assert.ok(pg.includes(w), w);
  const n = Number(/Daten beschaffen \((\d+)\)/.exec(pg)![1]); assert.equal(n, (await q(app, "select count(*)::int n from leads where owner_id=$1 and work_status='DATA_NEEDED'"))[0].n);
  const list = await page_(app, '/leads?quick=data_needed'); assert.match(list, /DATA_NEEDED/); assert.match(list, /Contactability/); assert.match(list, /Demo Recommendation/); assert.match(list, /Work Status/);
});

test('Website-Kandidat: VERIFIED / LIKELY / UNCERTAIN / REJECTED – unsichere Domains werden nicht übernommen; nach Fund neue Bewertung (DATA_NEEDED fällt weg)', { skip }, async () => {
  const { app, ws, crawler } = await fresh(2, { n: 8, noSiteEvery: 1, noPhoneEvery: 1 }); await run(app);   // alle ohne Website UND ohne Telefon → DATA_NEEDED
  const L = async (i: number) => { const l = await leadByName(app, nameOf(i)); await setPrio(app, l.id, 'A'); return l; };
  const [v, li, u, rj] = [await L(0), await L(1), await L(2), await L(3)];
  const st = (l: any) => `${l.address.split(',')[0]}`;
  for (const [i, l] of [[0, v], [1, li], [2, u], [3, rj]] as const) ws.hits[nameOf(i)] = [siteOf(i)]; void st;
  crawler.sites[siteOf(0)] = [{ path: '/', html: page(nameOf(0), { city: 'Völklingen', plz: '66333', street: v.address }) + '<p>Impressum</p>' }, { path: '/kontakt', html: '<html><body><h1>Kontakt</h1><a href="tel:+496898123456">Anrufen</a><a href="mailto:hallo@salon.example">Mail</a><form><input name="a"><textarea></textarea></form></body></html>' }, { path: '/impressum', html: `<html><body><h1>Impressum</h1><p>${nameOf(0)}</p><p>Inhaberin: Erika Muster</p></body></html>` }];
  crawler.sites[siteOf(1)] = [{ path: '/', html: page(nameOf(1), { city: 'Völklingen', plz: '66333', mail: true }) }];
  crawler.sites[siteOf(2)] = [{ path: '/', html: page(nameOf(2), { plz: '66333' }) }];
  crawler.sites[siteOf(3)] = [{ path: '/', html: '<html><body><h1>Ganz anderer Laden</h1><p>Köln 50667</p></body></html>' }];
  assert.equal((await leadByName(app, nameOf(0))).work_status, 'DATA_NEEDED'); const prioBefore = (await leadByName(app, nameOf(0))).auto_priority;
  const r0 = await app.ctx.enrichment.enrichLead(v.id); assert.equal(r0.verification, 'VERIFIED'); assert.ok(r0.confidence! >= 75, String(r0.confidence)); assert.equal(r0.status, 'website_found');
  const l0 = await leadByName(app, nameOf(0));
  assert.deepEqual([l0.official_website_verified, l0.website_url, l0.official_website_candidate], ['VERIFIED', siteOf(0), siteOf(0)]); assert.ok(l0.official_website_confidence >= 75); assert.notEqual(l0.website_state, 'none');
  // Neubewertung: Website-Score, Kontaktdaten aus der Kontaktseite (mit Quelle), DATA_NEEDED weg, Priorität neu berechnet
  const sc = (await q(app, 'select overall_quality s from audits where lead_id=$2 order by created_at desc limit 1', [l0.id]))[0]; assert.ok(sc.s >= 0 && sc.s <= 100);
  assert.equal(l0.work_status, 'CONTACTABLE'); assert.equal(l0.contactability, 'READY'); assert.equal(l0.preferred_contact_channel, 'PHONE'); assert.equal(l0.enrichment_status, 'website_found'); assert.ok(l0.last_enrichment_at);
  const facts = await q(app, 'select key, value, source, source_url, note from lead_facts where lead_id=$2', [l0.id]); const f = (k: string) => facts.filter((x) => x.key === k);
  assert.equal(f('website')[0].source, 'web-search'); assert.match(f('website')[0].note, /verifiziert, \d+\/100/); assert.ok(f('phone').some((x) => x.source === 'website-crawl' && x.source_url === siteOf(0) + 'kontakt')); assert.ok(f('email').some((x) => x.source_url === siteOf(0) + 'kontakt'));
  assert.equal(f('contactForm')[0].source_url, siteOf(0) + 'kontakt'); assert.equal(f('contactPerson')[0].value, 'Erika Muster'); assert.ok(facts.every((x) => x.source));
  assert.ok(l0.priority_updated_at && (l0.auto_priority !== undefined), 'neu bewertet'); void prioBefore;
  assert.ok(!(await page_(app, '/enrichment')).includes(`/leads/${l0.id}"`), 'nicht mehr in „Daten beschaffen“');
  // LIKELY: übernommen, aber mit Prüfhinweis
  const r1 = await app.ctx.enrichment.enrichLead(li.id); assert.equal(r1.verification, 'LIKELY'); const l1 = await leadByName(app, nameOf(1)); assert.equal(l1.website_url, siteOf(1)); assert.match((await q(app, "select note from lead_facts where lead_id=$2 and key='website'", [l1.id]))[0].note, /bitte prüfen/);
  assert.match(await page_(app, `/leads/${l1.id}`), /Übernommen, aber bitte kurz prüfen/);
  // UNCERTAIN: NICHT als Website übernommen, manuelle Prüfung sichtbar
  const r2 = await app.ctx.enrichment.enrichLead(u.id); assert.equal(r2.verification, 'UNCERTAIN'); assert.equal(r2.status, 'uncertain'); const l2 = await leadByName(app, nameOf(2));
  assert.equal(l2.website_url, null); assert.equal(l2.website_state, 'none'); assert.equal(l2.official_website_verified, 'UNCERTAIN'); assert.equal(l2.official_website_candidate, siteOf(2)); assert.ok(l2.official_website_confidence >= 35 && l2.official_website_confidence < 55);
  assert.equal((await q(app, "select count(*)::int n from lead_facts where lead_id=$2 and key='website'", [l2.id]))[0].n, 0); assert.match((await q(app, "select note from lead_facts where lead_id=$2 and key='websiteCandidate'", [l2.id]))[0].note, /manuell prüfen/);
  const pg2 = await page_(app, `/leads/${l2.id}`); assert.match(pg2, /Manuell prüfen/); assert.match(pg2, /unsicher/); assert.match(await page_(app, '/leads?quick=manual_check'), new RegExp(nameOf(2)));
  // REJECTED
  const r3 = await app.ctx.enrichment.enrichLead(rj.id); assert.equal(r3.verification, 'REJECTED'); const l3 = await leadByName(app, nameOf(3)); assert.equal(l3.website_url, null); assert.equal(l3.official_website_verified, 'REJECTED'); assert.equal(l3.enrichment_status, 'not_found');
  assert.ok(!crawler.seen.some((x) => x.includes('gelbeseiten')), 'Verzeichnisse nie abgerufen');
});

test('Budget: Monats- und Tageslimit stoppen kostenpflichtige Abfragen; Lauf bricht nicht ab; betroffene Leads bleiben DATA_NEEDED/budget_blocked; Anzeige verbraucht/übrig/Anfragen/Kosten je Lead', { skip }, async () => {
  const { app, ws } = await fresh(3, { n: 8, noSiteEvery: 1, noPhoneEvery: 1 }); await run(app);
  const ids = (await q(app, 'select id from leads where owner_id=$1')).map((r) => r.id as string); for (const id of ids) await setPrio(app, id, 'A');
  app.ctx.cfg.pipeline.enrichment.monthly_enrichment_budget_eur = 0.03;           // 3 Cent = 6 Anfragen à 0,5 Cent; je Lead 3 Suchen
  const res = await app.ctx.enrichment.enrichBatch(ids, { limit: 100 });
  assert.equal(ws.queries.length, 6, 'nicht mehr als das Budget erlaubt'); assert.equal(res.requests, 6); assert.equal(res.costCents, 3);
  assert.equal(res.counts.not_found, 2); assert.equal(res.counts.budget_blocked, 6, JSON.stringify(res.counts));
  const blocked = await q(app, "select id, work_status, enrichment_status from leads where owner_id=$1 and enrichment_status='budget_blocked'"); assert.equal(blocked.length, 6); assert.ok(blocked.every((l) => l.work_status === 'DATA_NEEDED'));
  const b = await app.ctx.enrichment.budget.status(app.ctx.now()); assert.equal(b.monthSpentCents, 3); assert.equal(b.monthLeftCents, 0); assert.equal(b.monthRequests, 6); assert.equal(b.monthEnrichedLeads, 2); assert.equal(b.costPerEnrichedLeadCents, 1.5);
  const pg = await page_(app, '/enrichment'); assert.match(pg, /0,03 € .*verbraucht diesen Monat/); assert.match(pg, /übrig diesen Monat/); assert.match(pg, /0,0150 €/); assert.match(pg, /Budget erreicht/);
  assert.match(await flash(app, await app.post(`/leads/${blocked[0].id}/enrich`)), /Budget \(Monat\/Tag\) erreicht/); assert.equal(ws.queries.length, 6, 'auch ein Klick umgeht das Budget nicht');
  // Tageslimit: Monat frei, Tag fast leer → mittendrin stoppen
  app.ctx.cfg.pipeline.enrichment.monthly_enrichment_budget_eur = 10; app.ctx.cfg.pipeline.enrichment.daily_enrichment_budget_eur = 0.04; ws.queries.length = 0;
  const r2 = await app.ctx.enrichment.enrichLead(blocked[0].id, { ignoreCache: true }); assert.equal(r2.requests, 2, 'noch 1 Cent am Tag übrig → 2 Anfragen'); assert.match(r2.note, /Budget während der Suche erreicht/);
  assert.equal((await app.ctx.enrichment.enrichLead(blocked[1].id, { ignoreCache: true })).status, 'budget_blocked');
  // ein kompletter Suchlauf mit Limit 0: kostenlose Schritte laufen weiter, Lauf endet complete mit Hinweis
  app.ctx.cfg.pipeline.enrichment.daily_enrichment_budget_eur = 0;
  const { app: app2 } = await fresh(4, { n: 10, noSiteEvery: 1, noPhoneEvery: 1 }); app2.ctx.cfg.pipeline.enrichment.monthly_enrichment_budget_eur = 0;
  const r = await run(app2, {}, true); assert.equal(r.status, 'DONE'); assert.equal(r.phase, 'complete'); assert.equal(r.counters.analyzed, 10); assert.match(JSON.stringify(r.summary.warnings), /Enrichment-Budget erreicht/); assert.equal(r.costs.web_search, 0);
  assert.ok((await q(app2, "select count(*)::int n from leads where owner_id=$1 and enrichment_status='budget_blocked' and work_status='DATA_NEEDED'"))[0].n >= 1);
});

test('Cache: identische Suche wird nicht wiederholt (auch erfolglose); „Zwischenspeicher ignorieren“ erzwingt neue Suche; Anbieter nicht verfügbar → provider_unavailable ohne Fehlerkaskade', { skip }, async () => {
  const { app, ws } = await fresh(5, { n: 4, noSiteEvery: 1, noPhoneEvery: 1 }); await run(app);
  const l = (await q(app, 'select id from leads where owner_id=$1 limit 1'))[0]; await setPrio(app, l.id, 'A');
  const a = await app.ctx.enrichment.enrichLead(l.id); assert.equal(a.status, 'not_found'); assert.equal(a.requests, 3); assert.equal(ws.queries.length, 3, 'höchstens maxQueriesPerLead (3) Suchanfragen je Lead');
  const b = await app.ctx.enrichment.enrichLead(l.id); assert.equal(b.status, 'cached'); assert.equal(b.requests, 0); assert.equal(ws.queries.length, 3); assert.match(b.note, /nicht wiederholt/);
  assert.equal((await q(app, 'select count(*)::int n from enrichment_log where lead_id=$2', [l.id]))[0].n, 1, 'erfolglose Suche hat einen Cache-Zeitpunkt');
  const c = await app.ctx.enrichment.enrichLead(l.id, { ignoreCache: true }); assert.equal(c.status, 'not_found'); assert.equal(ws.queries.length, 6);
  app.ctx.cfg.pipeline.enrichment.maxQueriesPerLead = 1; ws.queries.length = 0; const l2 = (await q(app, 'select id from leads where owner_id=$1 and id<>$2 limit 1', [l.id]))[0]; await setPrio(app, l2.id, 'B'); await app.ctx.enrichment.enrichLead(l2.id); assert.equal(ws.queries.length, 1, 'Anzahl Anfragen je Lead ist konfigurierbar');
  // Cache-Ablauf: nach failedCacheDays wieder erlaubt
  await app.pool.query("update enrichment_log set created_at = '2026-01-01' where lead_id=$1", [l.id]); app.ctx.cfg.pipeline.enrichment.maxQueriesPerLead = 3; ws.queries.length = 0; assert.equal((await app.ctx.enrichment.enrichLead(l.id)).status, 'not_found'); assert.ok(ws.queries.length > 0);
  // Anbieter nicht verfügbar
  app.ctx.sources.webSearch = { name: 'keine-quelle', isMock: false, async search() { return { hits: [], requests: 0, source: 'keine-quelle', retrievedAt: '', costCents: 0 }; } } as never;
  const l3 = (await q(app, 'select id from leads where owner_id=$1 and id not in ($2,$3) limit 1', [l.id, l2.id]))[0]; await setPrio(app, l3.id, 'A');
  const u = await app.ctx.enrichment.enrichLead(l3.id); assert.equal(u.status, 'provider_unavailable'); assert.equal((await q(app, 'select enrichment_status s from leads where id=$2', [l3.id]))[0].s, 'provider_unavailable');
  assert.match(await flash(app, await app.post(`/leads/${l3.id}/enrich`)), /Websuche nicht verfügbar/); assert.match(await page_(app, `/leads/${l3.id}`), /provider_unavailable/);
  const batch = await app.ctx.enrichment.enrichBatch([l3.id, l.id]); assert.equal(batch.counts.provider_unavailable, 1);
  const r = await run(app, { excludeExisting: '0' }, true); assert.equal(r.phase, 'complete'); assert.match(JSON.stringify(r.summary.warnings), /Websuche nicht verfügbar/); assert.deepEqual(r.errors, []);
  assert.match(await flash(app, await app.post('/enrichment/run', { limit: '5' })), /Websuche nicht verfügbar/);
});

test('Reihenfolge und Relevanz: A vor B vor interessanten C; D wird nicht kostenpflichtig angereichert; schwache C bleiben liegen; Bestätigung des Nutzers (Klick) umgeht nur die Prioritätsschranke', { skip }, async () => {
  const { app, ws } = await fresh(6, { n: 8, noSiteEvery: 1, noPhoneEvery: 1 }); await run(app);
  const ids = (await q(app, 'select id, company_name from leads where owner_id=$1 order by company_name')).map((r) => r as { id: string; company_name: string });
  const plan: ('C' | 'A' | 'B' | 'D')[] = ['C', 'A', 'B', 'D', 'A', 'B', 'C', 'D']; for (let i = 0; i < 8; i++) await setPrio(app, ids[i].id, plan[i]);
  await app.pool.query("update opportunities set score = 40 where lead_id = $1", [ids[6].id]);          // zweites C: Verkaufschance zu gering
  const res = await app.ctx.enrichment.enrichBatch(ids.map((x) => x.id), { limit: 100 });
  const order: string[] = []; for (const query of ws.queries) { const n = ids.find((x) => query.includes(x.company_name))!; if (!order.includes(n.id)) order.push(n.id); }
  const prios = order.map((id) => plan[ids.findIndex((x) => x.id === id)]).join(''); assert.equal(prios, 'AABBC', `Reihenfolge der abgefragten Leads: ${prios}`);
  assert.equal(res.counts.skipped_priority, 3, JSON.stringify(res.counts)); assert.ok(!ws.queries.some((x) => x.includes(ids[3].company_name) || x.includes(ids[7].company_name)), 'D wird nicht angereichert');
  assert.equal((await q(app, 'select enrichment_status s from leads where id=$2', [ids[3].id]))[0].s, 'skipped_priority'); assert.equal((await q(app, 'select enrichment_status s from leads where id=$2', [ids[6].id]))[0].s, 'skipped_priority');
  // ausdrücklicher Klick auf ein D-Lead: erlaubt (Nutzerentscheidung), aber nicht im Budget vorbei
  ws.queries.length = 0; assert.match(await flash(app, await app.post(`/leads/${ids[3].id}/enrich`)), /Enrichment:/); assert.ok(ws.queries.length > 0);
  // Massen-Start aus der Ansicht „Daten beschaffen“: höchstens N Leads
  ws.queries.length = 0; await app.pool.query("update enrichment_log set created_at = '2026-01-01'"); const out = await flash(app, await app.post('/enrichment/run', { limit: '2' }));
  assert.match(out, /Enrichment: 2 Lead\(s\) abgefragt/); assert.equal(new Set(ws.queries.map((x) => ids.find((n) => x.includes(n.company_name))!.id)).size, 2);
});

test('Freigabe-Workflow: Demo wird nur EMPFOHLEN (Begründung), nie automatisch erstellt; erst Anfordern + Bestätigung baut sie; Ablehnung bleibt gespeichert; Module vorher anpassbar; bestehende Demos unberührt', { skip }, async () => {
  const { app } = await fresh(7, { n: 14, noSiteEvery: 1 }); const r = await run(app);
  assert.equal((await q(app, 'select count(*)::int n from demos where owner_id=$1'))[0].n, 0, 'keine Demo nach dem Suchlauf'); assert.equal(r.summary.pipeline.demoRecommended > 0, true);
  const rec = await q(app, "select l.id, l.demo_recommendation_reason r, a.state from leads l join approvals a on a.lead_id=l.id and a.action='DEMO_CREATE' where l.owner_id=$1 and l.demo_recommendation='DEMO_RECOMMENDED'");
  assert.ok(rec.length >= 3); assert.ok(rec.every((x) => x.state === 'RECOMMENDED' && /Keine Website gefunden, Telefonnummer vorhanden, lokale Branche: .*, Verkaufschance \d+\/100\./.test(x.r)), rec[0].r);
  assert.equal((await q(app, "select count(*)::int n from leads where owner_id=$1 and demo_recommendation='DEMO_NOT_RECOMMENDED'", []))[0].n >= 0, true);
  const filt = await page_(app, '/leads?quick=demo_recommended'); assert.equal(Number(/(\d+) Leads/.exec(filt)![1]), rec.length); assert.match(filt, /Demo empfohlen/);
  const id = rec[0].id as string; const pg = await page_(app, `/leads/${id}`); assert.match(pg, /Demo empfohlen/); assert.match(pg, /Keine Website gefunden, Telefonnummer vorhanden/); assert.match(pg, /Demo erstellen/); assert.match(pg, /wartet|empfohlen/);
  // Module wählen (Empfehlung ≠ Auswahl), Bestätigungsseite zeigt sie
  assert.match(await flash(app, await app.post(`/leads/${id}/modules`, { family: 'APPOINTMENT', mod: ['gallery', 'newsletter'] })), /Auswahl gespeichert/);
  const recMods = (await q(app, 'select modules_recommended m, modules_selected s from leads where id=$2', [id]))[0]; assert.deepEqual(recMods.s, ['gallery', 'newsletter']); assert.ok(recMods.m.length >= 3 && recMods.m.includes('booking'));
  assert.match(await flash(app, await app.post(`/leads/${id}/demo`, { template: 'auto' })), /bestätigen/); assert.equal((await q(app, 'select count(*)::int n from demos where lead_id=$2', [id]))[0].n, 0);
  const red = await app.post(`/leads/${id}/demo/request`, { template: 'auto' }); assert.equal(red.status, 303); const conf = await page_(app, `/leads/${id}/demo/confirm?template=auto`); assert.match(conf, /Demo für .* erstellen\?/); assert.match(conf, /Galerie/); assert.match(conf, /Newsletter/); assert.match(conf, /von dir gewählt/); assert.doesNotMatch(conf, /Online-Terminbuchung/);
  assert.equal((await q(app, 'select count(*)::int n from demos where lead_id=$2', [id]))[0].n, 0, 'Bestätigungsseite erstellt noch nichts');
  assert.match(await flash(app, await app.post(`/leads/${id}/demo/cancel`)), /keine Demo erstellt/); assert.equal((await q(app, "select state from approvals where lead_id=$2 order by requested_at desc limit 1", [id]))[0].state, 'RECOMMENDED');
  await app.post(`/leads/${id}/demo/request`, { template: 'auto' }); assert.match(await flash(app, await app.post(`/leads/${id}/demo`, { template: 'auto', confirm: '1' })), /Demo erstellt/);
  const d = (await q(app, 'select html from demos where lead_id=$2', [id]))[0]; assert.match(d.html, /id="galerie"/); assert.match(d.html, /id="newsletter"/); assert.doesNotMatch(d.html, /id="termin"/);
  assert.equal((await q(app, "select state from approvals where lead_id=$2 and action='DEMO_CREATE' order by requested_at desc limit 1", [id]))[0].state, 'COMPLETED'); assert.equal((await q(app, 'select demo_decision d from leads where id=$2', [id]))[0].d, null);
  await app.ctx.pipeline.recomputePriority(id); assert.equal((await q(app, 'select count(*)::int n from demos where lead_id=$2', [id]))[0].n, 1, 'Neubewertung lässt die Demo unberührt'); assert.equal((await q(app, "select count(*)::int n from approvals where lead_id=$2 and state='RECOMMENDED'", [id]))[0].n, 0);
  // Ablehnung bleibt gespeichert – auch nach Neubewertung/Enrichment
  const rid = rec[1].id as string; assert.match(await flash(app, await app.post(`/leads/${rid}/demo/skip`)), /übersprungen/);
  await app.ctx.pipeline.recomputePriority(rid); await app.ctx.pipeline.recomputePriority(rid);
  assert.equal((await q(app, "select state from approvals where lead_id=$2 order by requested_at desc limit 1", [rid]))[0].state, 'REJECTED'); assert.equal((await q(app, 'select demo_decision d from leads where id=$2', [rid]))[0].d, 'skipped');
  assert.ok(!(await page_(app, '/leads?quick=demo_recommended')).includes(`/leads/${rid}"`), 'abgelehnt ≠ empfohlen'); assert.match(await page_(app, `/leads/${rid}`), /Du hast .*Überspringen.* gewählt/);
  assert.match(await flash(app, await app.post(`/leads/${rid}/demo/skip`, { undo: '1' })), /zurückgenommen/); assert.equal((await q(app, "select state from approvals where lead_id=$2 order by requested_at desc limit 1", [rid]))[0].state, 'RECOMMENDED');
  // nichts wurde gesendet
  assert.equal((app.ctx.registry.providers.email as any).sent?.length ?? 0, 0); assert.equal((await q(app, "select count(*)::int n from outbox where owner_id=$1 and kind not like 'owner_%'"))[0].n, 0);
});

// ---------- Absicherung gegen Namensvettern und Anbieterfehler ----------
import { scoreCandidate, toEurCents, type LeadInfo } from '../../src/enrich/service.ts';
import { WebSearchError } from '../../src/sources/types.ts';
import { loadConfig } from '../../src/core/config.ts';

const VC = loadConfig().pipeline.enrichment.verify; const GEN = loadConfig().pipeline.dedupe.genericWords as string[];
const doc = (title: string, body = '') => `<html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
const ev = (pages: { url: string; html: string }[], o: object = {}) => ({ pages, host: 'salon-xyz.example', ...o });
const lead = (o: Partial<LeadInfo> = {}): LeadInfo => ({ name: 'Haarstudio Tanja', city: 'Dillingen/Saar', postalCode: '66763', address: 'Am Markt 25', subKeywords: ['friseur', 'haarstudio'], point: { lat: 49.35, lng: 6.73 }, ...o });

test('Verifikation (rein): Namensvetter in anderer Stadt, Verzeichnis-/Aggregatorseiten, nicht abrufbare Seiten, kurze Namen und weit entfernte Adressen werden nie „wahrscheinlich“; Standort am OSM-Eintrag verifiziert auch ohne Ort/PLZ', { skip }, async () => {
  const imp = (addr: string) => ({ url: 'https://salon-xyz.example/impressum', html: `<html><body><h1>Impressum</h1><p>Haarstudio Tanja</p><p>${addr}</p></body></html>` });
  const home = (title: string, body = '') => ({ url: 'https://salon-xyz.example/', html: doc(title, body + '<a href="mailto:info@salon-xyz.example">Mail</a>') });
  // richtige Firma: Name im Titel, Ort, PLZ, Adresse
  const good = scoreCandidate(ev([home('Haarstudio Tanja', '<p>Dillingen/Saar</p>'), imp('Am Markt 25, 66763 Dillingen/Saar')], { siteCity: 'Dillingen/Saar' }), lead(), GEN, VC);
  assert.equal(good.verification, 'VERIFIED'); assert.ok(good.why.includes('Straße und Hausnummer stimmen') && good.why.includes('PLZ stimmt'));
  // Namensvetter: gleicher Name, Adresse in Köln
  const twin = scoreCandidate(ev([home('Haarstudio Tanja – Köln'), imp('Hauptstraße 5, 50667 Köln')], { siteCity: 'Köln', distanceKm: 330 }), lead(), GEN, VC);
  assert.equal(twin.verification, 'REJECTED', 'Namensvetter in einer anderen Region wird abgelehnt (kein Eintrag in „Manuell prüfen“)'); assert.ok(twin.warnings.some((w) => /anderer Stadt \(Köln\)/.test(w)) && twin.warnings.some((w) => /330 km vom OSM-Standort entfernt/.test(w)));
  const gb = scoreCandidate(ev([home('Haarstudio Tanja Gengenbach'), imp('Gartenstraße 15, 77723 Gengenbach')], { siteCity: 'Gengenbach', distanceKm: 141.1 }), lead({ city: undefined, postalCode: undefined, address: undefined, cityHint: 'Saarlouis' }), GEN, VC);   // echter Fall: gleicher Name, 141 km entfernt
  assert.equal(gb.verification, 'REJECTED'); assert.ok(gb.confidence < VC.uncertainAt, String(gb.confidence));
  // Aggregator: nennt Name + Ort + Branche, aber der Name steht nicht im Seitentitel/in der Domain
  const agg = scoreCandidate({ pages: [{ url: 'https://friseur-liste.example/', html: doc('Die besten Friseure im Saarland', '<p>Haarstudio Tanja, Am Markt 25, 66763 Dillingen/Saar – Friseur</p><a href="mailto:x@y.example">k</a>') }], host: 'friseur-liste.example' }, lead(), GEN, VC);
  assert.ok(agg.verification === 'UNCERTAIN' && agg.confidence < VC.likelyAt, `${agg.verification} ${agg.confidence}`); assert.ok(agg.warnings.some((w) => /nicht im Seitentitel/.test(w)));
  // nicht abrufbar: nur Suchtreffer (Titel/Snippet) – höchstens unsicher
  const failed = scoreCandidate({ pages: [], crawlFailed: true, hit: { title: 'Haarstudio Tanja Dillingen', snippet: 'Friseur Am Markt 25 66763 Dillingen/Saar' }, host: 'salon-xyz.example' }, lead(), GEN, VC);
  assert.ok(failed.verification !== 'VERIFIED' && failed.verification !== 'LIKELY'); assert.ok(failed.warnings.some((w) => /nicht abrufbar/.test(w)));
  // OSM-Eintrag ohne Stadt/Adresse/Telefon (so sehen 44 von 47 Saarlouis-Leads aus): Name + Titel allein reicht nicht …
  const bare = lead({ city: undefined, postalCode: undefined, address: undefined, cityHint: 'Saarlouis', name: 'Coiffeur Joseph Barone' });
  const nameOnly = scoreCandidate({ pages: [{ url: 'https://barone.example/', html: doc('Coiffeur Joseph Barone', '<a href="mailto:a@b.example">m</a><p>Friseur Impressum</p>') }], host: 'barone.example' }, bare, GEN, VC);
  assert.ok(nameOnly.confidence < VC.likelyAt && nameOnly.verification === 'UNCERTAIN', `${nameOnly.verification} ${nameOnly.confidence}`);
  // … aber die Adresse der Website, am OSM-Standort geocodiert, verifiziert
  const geoPage = { pages: [{ url: 'https://barone.example/', html: doc('Coiffeur Joseph Barone', '<a href="mailto:a@b.example">m</a><p>Friseur</p>') }, imp('Silberherzstraße 3, 66740 Saarlouis')], host: 'barone.example', siteCity: 'Saarlouis' };
  assert.equal(scoreCandidate({ ...geoPage, distanceKm: 0.08 }, bare, GEN, VC).verification, 'VERIFIED');
  const near = scoreCandidate({ ...geoPage, distanceKm: 1.0 }, bare, GEN, VC); assert.ok(near.confidence > nameOnly.confidence && near.verification !== 'VERIFIED');
  const far = scoreCandidate({ ...geoPage, distanceKm: 14 }, bare, GEN, VC); assert.equal(far.verification, 'UNCERTAIN'); assert.equal(scoreCandidate({ ...geoPage, distanceKm: 40 }, bare, GEN, VC).verification, 'REJECTED', 'über 25 km: anderer Betrieb'); assert.ok(far.warnings.some((w) => /14 km vom OSM-Standort entfernt/.test(w)), 'weit entfernte Adresse: nie automatisch übernehmen (auch Filialbetriebe → manuell prüfen)');
  // sehr kurzer Name („R&H“): nie „wahrscheinlich“ ohne Telefonnummer
  const short = scoreCandidate({ pages: [{ url: 'https://rh.example/', html: doc('R&H Friseure Saarlouis', '<a href="mailto:a@b.example">m</a><p>Saarlouis 66740 Friseur Impressum</p>') }], host: 'rh.example' }, lead({ name: 'R&H', city: 'Saarlouis', postalCode: '66740', address: undefined }), GEN, VC);
  assert.ok(short.verification === 'UNCERTAIN' || short.verification === 'REJECTED'); assert.ok(short.warnings.some((w) => /sehr kurz/.test(w)));
  // Telefonnummer stimmt: starker Beleg
  const ph = scoreCandidate({ pages: [{ url: 'https://rh.example/', html: doc('R&H Friseure', '<p>Tel 06831 123456</p>') }], host: 'rh.example' }, lead({ name: 'R&H', phone: '06831 123456', city: undefined, postalCode: undefined, address: undefined }), GEN, VC); assert.ok(ph.why.includes('Telefonnummer stimmt überein'));
  assert.equal(toEurCents({ amount: 0.005, currency: 'USD' }, 0.92), 0.46);
});

test('Namensvetter im Ablauf: gleiche Qualität zweier Websites → nicht übernehmen (UNCERTAIN); Standort-Abgleich über die Adresse der Website (Geocoding) verifiziert Leads ohne Stadt; Protokoll mit Anfragen/Treffern/Begründung wird gespeichert und angezeigt', { skip }, async () => {
  const { app, ws, crawler, places } = await fresh(8, { n: 6, noSiteEvery: 1, noPhoneEvery: 1 }); await run(app);
  const L = async (i: number) => { const l = await leadByName(app, nameOf(i)); await setPrio(app, l.id, 'A'); return l; };
  const [amb, geoOk, geoFar] = [await L(0), await L(1), await L(2)];
  // 1) zwei Domains gleich gut → mehrdeutig
  ws.hits[nameOf(0)] = [siteOf(0), siteOf(0).replace('-nails', '-studio')];
  for (const u of [siteOf(0), siteOf(0).replace('-nails', '-studio')]) crawler.sites[u] = [{ path: '/', html: page(nameOf(0), { city: 'Völklingen', plz: '66333', mail: true }) }];
  const r0 = await app.ctx.enrichment.enrichLead(amb.id); assert.equal(r0.status, 'uncertain'); assert.match(r0.note, /zwei ähnlich passende Websites/); assert.equal((await leadByName(app, nameOf(0))).website_url, null);
  assert.match((await q(app, "select note from lead_facts where lead_id=$2 and key='websiteCandidate'", [amb.id]))[0].note, /manuell prüfen/);
  // 2) Lead OHNE Stadt/Adresse (nur Name + Koordinaten, wie bei den meisten OSM-Friseuren): Ortshinweis nur aus dem Suchlauf, Verifikation über den Standort
  for (const l of [geoOk, geoFar]) await app.pool.query('update leads set city = null, address = null, postal_code = null where id=$1', [l.id]);
  ws.hits[nameOf(1)] = [siteOf(1)]; ws.hits[nameOf(2)] = [siteOf(2)];
  const site = (i: number, addr: string) => [{ path: '/', html: doc(nameOf(i), '<a href="mailto:a@salon.example">Mail</a><p>Friseur</p>') }, { path: '/impressum', html: `<html><body><h1>Impressum</h1><p>${nameOf(i)}</p><p>${addr}</p></body></html>` }];
  crawler.sites[siteOf(1)] = site(1, 'Testweg 3, 66333 Völklingen'); crawler.sites[siteOf(2)] = site(2, 'Fernweg 9, 66333 Völklingen');
  const p1 = { lat: Number(geoOk.lat), lng: Number(geoOk.lng) }, p2 = { lat: Number(geoFar.lat), lng: Number(geoFar.lng) };
  (places as any).geocode = async (qq: string) => ({ query: qq, name: 'x', source: 'osm', point: qq.includes('Testweg') ? { lat: p1.lat + 0.0006, lng: p1.lng } : qq.includes('Fernweg') ? { lat: p2.lat + 0.2, lng: p2.lng } : null });
  const r1 = await app.ctx.enrichment.enrichLead(geoOk.id); assert.equal(r1.verification, 'VERIFIED', JSON.stringify(r1.trace?.candidates)); assert.ok(r1.trace!.candidates[0].why.some((x) => /am OSM-Standort/.test(x))); assert.ok(r1.trace!.candidates[0].distanceKm! < 0.1);
  assert.deepEqual(r1.trace!.place, { value: (await q(app, 'select region from lead_runs where owner_id=$1 limit 1'))[0].region, source: 'search-region' }); assert.match(r1.trace!.queries[0].query, /^"Nagelstudio .*" Völklingen/);
  const r2 = await app.ctx.enrichment.enrichLead(geoFar.id); assert.equal(r2.verification, 'UNCERTAIN'); assert.equal(r2.status, 'uncertain'); assert.ok(r2.trace!.candidates[0].warnings.some((w) => /km vom OSM-Standort entfernt/.test(w))); assert.equal((await leadByName(app, nameOf(2))).website_url, null);
  // Neubewertung ohne Netz verliert keine Quelldaten (Koordinaten, Kategorien, Karten-Link bleiben)
  const after = await leadByName(app, nameOf(1)); assert.equal(after.website_url, siteOf(1)); assert.ok(after.lat !== null && after.lng !== null, 'Koordinaten bleiben erhalten');
  const keys = (await q(app, "select distinct key from lead_facts where lead_id=$2 and source='osm'", [after.id])).map((x) => x.key); for (const k of ['name', 'point', 'mapsUrl', 'sourceCategories']) assert.ok(keys.includes(k), `Fakt ${k} aus der Quelle bleibt erhalten`);
  assert.ok((await q(app, "select count(*)::int n from lead_facts where lead_id=$2 and source='web-search' and key='website'", [after.id]))[0].n === 1);
  // Protokoll in der Datenbank und auf der Lead-Seite
  const log = (await q(app, 'select * from enrichment_log where lead_id=$2 order by created_at desc limit 1', [after.id]))[0]; assert.ok(log.found.trace.queries.length >= 1 && log.found.trace.candidates[0].confidence >= 75);
  const pg = await page_(app, `/leads/${after.id}`); for (const w of ['Enrichment-Protokoll', 'Suche:', 'Geprüfte Websites', 'verifiziert', 'Adresse auf der Website: Testweg 3, 66333 Völklingen', 'Ortsangabe für die Suche', 'nur Hinweis: Region des Suchlaufs', 'Verzeichnis/Portal (keine eigene Website)']) assert.ok(pg.includes(w), w);
  assert.match(await page_(app, `/leads/${geoFar.id}`), /Vorbehalte: .*km vom OSM-Standort entfernt/);
});

test('Anbieterfehler und Währung: fataler Fehler (Schlüssel/Kontingent) stoppt den Stapel ohne Kosten; mehrere Fehler in Folge ebenfalls; USD-Providerkosten werden mit Währung gespeichert und in EUR gebucht', { skip }, async () => {
  const { app, ws } = await fresh(9, { n: 8, noSiteEvery: 1, noPhoneEvery: 1 }); await run(app);
  const ids = (await q(app, 'select id from leads where owner_id=$1')).map((r) => r.id as string); for (const id of ids) await setPrio(app, id, 'A');
  // fatal (401): genau EIN Aufruf, danach Abbruch
  const orig = ws.search.bind(ws); let calls = 0; ws.search = async () => { calls++; throw new WebSearchError('Brave Search HTTP 401 (API-Schlüssel ungültig oder ohne Berechtigung)', { status: 401, fatal: true }); };
  const b1 = await app.ctx.enrichment.enrichBatch(ids, { limit: 100 }); assert.equal(calls, 1, 'keine Fehlerkaskade'); assert.match(b1.stoppedBy!, /401/); assert.equal(b1.costCents, 0); assert.equal(b1.counts.provider_unavailable, 1);
  assert.equal((await q(app, "select count(*)::int n from leads where owner_id=$1 and enrichment_status='provider_unavailable'"))[0].n, 1); assert.equal((await q(app, 'select count(*)::int n from enrichment_log where owner_id=$1 and cost_cents > 0'))[0].n, 0);
  assert.match(await flash(app, await app.post(`/leads/${ids[0]}/enrich`)), /Websuche fehlgeschlagen: .*401/);
  // nicht fatal: nach 3 Fehlern in Folge Abbruch
  calls = 0; ws.search = async () => { calls++; throw new WebSearchError('Brave Search HTTP 500 (Serverfehler)', { status: 500, fatal: false }); };
  const b2 = await app.ctx.enrichment.enrichBatch(ids, { limit: 100 }); assert.equal(calls, 3); assert.ok(b2.stoppedBy);
  // Fehler wird nicht gecacht: nach Behebung läuft dieselbe Suche
  ws.search = orig; const ok = await app.ctx.enrichment.enrichLead(ids[0]); assert.equal(ok.status, 'not_found'); assert.equal(ok.requests, 3);
  // USD-Providerkosten mit Währung
  ws.currency = 'USD'; ws.amount = 0.005; const lead2 = ids[3]; const o2 = await app.ctx.enrichment.enrichLead(lead2); assert.equal(o2.requests, 3);
  assert.deepEqual([o2.providerCost.currency, Math.round(o2.providerCost.amount * 1e6) / 1e6], ['USD', 0.015]); assert.equal(o2.costCents, toEurCents({ amount: 0.015, currency: 'USD' }, 0.92)); assert.equal(o2.costCents, 1.38);
  const row = (await q(app, 'select provider_cost_amount a, provider_cost_currency c, fx_eur_per_usd fx, cost_cents e from enrichment_log where lead_id=$2 and provider_cost_currency = \'USD\' and provider_cost_amount > 0 limit 1', [lead2]))[0];
  assert.deepEqual([Number(row.a), row.c, Number(row.fx), Number(row.e)], [0.015, 'USD', 0.92, 1.38]);
  const bs = await app.ctx.enrichment.budget.status(app.ctx.now()); assert.ok(bs.monthSpentCents > 1.37 && bs.monthSpentCents < 4, 'Budget wird in EUR geführt (USD umgerechnet)');
  const pg = await page_(app, '/enrichment'); assert.match(pg, /5 USD je 1\.000 Anfragen \(= 0,005 USD je Anfrage ≈ 0,0046 €/); assert.match(pg, /0,92 EUR\/USD/); assert.match(pg, /Guthaben von 5 USD\/Monat/);
  // Lauf: Kosten mit Währung im Protokoll
  const r = await run(app, { excludeExisting: '0' }, true); assert.equal(r.costs.currency, 'EUR'); assert.equal(r.costs.provider.web_search.currency, 'USD'); const src = (r.sources as any[]).find((s) => s.id === 'WEB_SEARCH'); if (src) assert.equal(src.providerCost.currency, 'USD');
});
