import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appSetup, skip, enablePhone, type App } from './helpers.ts';
import { normalizeCriteria } from '../../src/search/criteria.ts';
import { createProviders } from '../../src/providers/registry.ts';
import { SyntheticPlaces, StubCrawler } from '../synthetic.ts';
import { CopilotService } from '../../src/sales/copilot-service.ts';

/** Sales Copilot: automatische Erzeugung, Cache, Overrides/Notizen, Anruf-Ergebnisse, DEEP, Seiten und Filter. Es wird nie etwas gesendet. */
const apps: App[] = []; after(async () => { for (const a of apps) await a.close(); });
const page = async (app: App, path: string) => app.text(await (await app.get(path)).text());

async function seeded(owner: string) {
  const app = await appSetup(owner, { autoDemo: false }); apps.push(app);
  const { limits } = await app.repo.getLimits(); await app.repo.saveLimits({ ...limits, maxLeadsPerRun: 1000, maxAuditsPerRun: 1000, maxCrawlPagesPerRun: 20000 }); await enablePhone(app);
  const live = createProviders({ APP_MODE: 'live' }, { baseUrl: app.base });
  Object.assign(app.ctx.registry.providers, { places: new SyntheticPlaces({ n: 12, noSiteEvery: 2, noPhoneEvery: 4 }), crawler: new StubCrawler(), directory: live.providers.directory, social: live.providers.social });
  await app.ctx.runner.start(normalizeCriteria({ location: 'Völklingen', radiusKm: '30', subIndustries: ['nagelstudio'], maxLeads: '50' }, app.ctx.cfg.taxonomy, app.ctx.cfg.pipeline.sizes)); await app.ctx.runner.idle();
  return app;
}
const rows = async (app: App) => (await app.ctx.leads.list({ limit: 100 })).rows;

test('Automatisch für interessante Leads (A/B, Verkaufschance, Demo empfohlen) – nicht für D-Leads; DATA_NEEDED → manuell recherchieren', { skip, timeout: 300_000 }, async () => {
  const app = await seeded('00000000-0000-0000-0000-000000000461');
  const all = await rows(app); assert.equal(all.length, 12);
  const have = new Set((await app.pool.query("select lead_id from sales_copilot where tier='MASS'")).rows.map((r) => r.lead_id));
  const interesting = all.filter((l) => ['A', 'B'].includes(l.priority) || l.demo_recommendation === 'DEMO_RECOMMENDED' || (l.score ?? 0) >= 60);
  assert.ok(interesting.length >= 3); for (const l of all.filter((x) => !interesting.includes(x))) assert.ok(!have.has(l.id), `kein Verkaufsassistent für uninteressanten Lead ${l.company_name} (Priorität ${l.priority})`); for (const l of interesting) assert.ok(have.has(l.id), `Verkaufsassistent für ${l.company_name}`);
  for (const l of interesting) { assert.ok(l.website_potential && l.needs_analysis_potential && l.partnership_potential && l.recommended_next_action && l.call_goal); assert.ok(['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'].includes(l.website_potential)); }
  // D-Lead ohne Verkaufschance: kein Verkaufsassistent (kostenpflichtige/unnötige Arbeit vermeiden)
  const d = all.find((l) => !have.has(l.id)) ?? all[all.length - 1];
  await app.pool.query('delete from sales_copilot where lead_id=$1', [d.id]); await app.ctx.pipeline.setManualPriority(d.id, 'D');
  await app.pool.query("update opportunities set score = 10 where lead_id=$1", [d.id]); await app.pool.query("update leads set demo_recommendation='DEMO_NOT_RECOMMENDED' where id=$1", [d.id]);
  assert.equal(await app.ctx.copilot.ensure(d.id, { onlyIfEligible: true }), null);
  assert.equal(app.ctx.copilot.isEligible({ effective_priority: 'D', opportunity: 10, demo_recommendation: 'DEMO_NOT_RECOMMENDED' }), false);
  assert.match(await page(app, `/leads/${d.id}`), /Verkaufsassistent erzeugen/);                 // manuell möglich (regelbasiert, kostenlos)
  const forced = await app.ctx.copilot.ensure(d.id, { force: true }); assert.ok(forced);
  // DATA_NEEDED
  const needed = all.find((l) => l.work_status === 'DATA_NEEDED')!; assert.ok(needed);
  const c = (await app.ctx.copilot.ensure(needed.id, { force: true }))!.copilot; assert.equal(c.nextAction.code, 'MANUAL_RESEARCH'); assert.equal(c.goal.code, 'RESEARCH');
  assert.equal((await app.pool.query('select count(*)::int n from outbox')).rows[0].n, 0, 'nichts gesendet');
});

test('Cache: gleiche Daten → kein Neuberechnen; geänderte Daten (Anruf-Ergebnis) → neu. Overrides, Notizen und Module bleiben bestehen', { skip, timeout: 300_000 }, async () => {
  const app = await seeded('00000000-0000-0000-0000-000000000462');
  const lead = (await rows(app)).find((l) => l.work_status === 'CONTACTABLE' && l.phone)!;
  const first = (await app.ctx.copilot.ensure(lead.id, { force: true }))!; assert.equal(first.cached, false);
  assert.equal((await app.ctx.copilot.ensure(lead.id))!.cached, true); assert.equal((await app.ctx.copilot.ensure(lead.id))!.cached, true);
  // Overrides/Notizen/Module
  await app.ctx.pipeline.setManualPriority(lead.id, 'C'); await app.ctx.pipeline.saveNote(lead.id, 'Frau Muster ist Mittwochs da');
  await app.ctx.pipeline.setModuleState(lead.id, { selected: ['gallery', 'whatsapp'] });
  await app.ctx.copilot.ensure(lead.id, { force: true });
  const row = (await app.pool.query('select manual_priority, effective_priority, modules_selected from leads where id=$1', [lead.id])).rows[0];
  assert.equal(row.manual_priority, 'C'); assert.equal(row.effective_priority, 'C'); assert.deepEqual(row.modules_selected, ['gallery', 'whatsapp']);
  assert.equal((await app.ctx.pipeline.note(lead.id))!.body, 'Frau Muster ist Mittwochs da');
  // Anruf-Ergebnis ändert die Datenlage → neue Fassung mit neuer nächster Aktion
  await app.ctx.calls.applyResult(lead.id, 'NEEDS_ANALYSIS', { note: 'Möchte erst über Absicherung sprechen', nextStep: 'Termin nächste Woche' });
  const after = (await app.ctx.copilot.ensure(lead.id))!; assert.equal(after.cached, false); assert.equal(after.copilot.nextAction.code, 'NEEDS_ANALYSIS'); assert.equal(after.copilot.goal.code, 'NEEDS_ANALYSIS_APPOINTMENT');
  assert.equal(after.copilot.needsAnalysis.potential, 'HIGH');
  assert.equal((await app.pool.query('select manual_priority from leads where id=$1', [lead.id])).rows[0].manual_priority, 'C', 'Override unverändert');
});

test('Anruf-Ergebnisse: Bedarfsanalyse, Kooperation, mehrere Themen – mit Notiz, Rückruf und nächstem Schritt', { skip, timeout: 300_000 }, async () => {
  const app = await seeded('00000000-0000-0000-0000-000000000463');
  const ok = (await rows(app)).filter((l) => l.work_status === 'CONTACTABLE' && l.phone); const [a, b, c, d] = ok;
  const topics = async (id: string) => (await app.pool.query('select interest_topics, next_step from leads where id=$1', [id])).rows[0];
  await app.ctx.calls.applyResult(a.id, 'NEEDS_ANALYSIS', { note: 'n', nextStep: 'Bedarfsanalyse-Termin' }); assert.deepEqual((await topics(a.id)).interest_topics, ['needs']); assert.equal((await topics(a.id)).next_step, 'Bedarfsanalyse-Termin');
  await app.ctx.calls.applyResult(b.id, 'PARTNERSHIP', {}); assert.deepEqual((await topics(b.id)).interest_topics, ['partner']);
  await assert.rejects(app.ctx.calls.applyResult(c.id, 'MULTIPLE', { topics: ['website'] }), /mindestens zwei Themen/);
  await app.ctx.calls.applyResult(c.id, 'MULTIPLE', { topics: ['website', 'needs', 'bogus'], note: 'alles interessant', nextStep: 'Demo zeigen' }); assert.deepEqual((await topics(c.id)).interest_topics.sort(), ['needs', 'website']);
  await app.ctx.calls.applyResult(d.id, 'INTERESTED', {}); assert.deepEqual((await topics(d.id)).interest_topics, ['website']);
  const h = (await app.pool.query("select result, topics, next_step, note from contact_history where lead_id=$1 and channel='PHONE'", [c.id])).rows[0]; assert.equal(h.result, 'MULTIPLE'); assert.deepEqual(h.topics.sort(), ['needs', 'website']); assert.equal(h.next_step, 'Demo zeigen'); assert.equal(h.note, 'alles interessant');
  for (const id of [a.id, b.id, c.id]) assert.equal((await app.pool.query('select status from leads where id=$1', [id])).rows[0].status, 'INTERESTED');
  // Rückruf bleibt wie gehabt Pflicht mit Datum
  await assert.rejects(app.ctx.calls.applyResult(ok[4].id, 'CALL_BACK', {}), /Datum und Uhrzeit/);
  // Filter + Ansichten
  const q = async (quick: string) => (await app.ctx.leads.list({ quick, limit: 100 })).rows;
  assert.ok((await q('needs_interesting')).some((l) => l.id === a.id)); assert.ok((await q('website_high')).every((l) => l.website_potential === 'HIGH')); assert.ok((await q('partner_high')).every((l) => l.partnership_potential === 'HIGH'));
  assert.ok((await q('demo_exists')).every((l) => l.has_demo));
  const leadPage = await page(app, `/leads/${a.id}`);
  for (const t of ['Verkaufsassistent', 'Dieser Lead in 30 Sekunden', 'Ziel dieses Gesprächs', 'Persönlicher Gesprächseinstieg', 'A · Website / Digitalisierung', 'B · Bedarfsanalyse', 'C · Kooperation', 'Fragen im Gespräch', 'Deine stärksten Argumente', 'So erklärst du die Demo', 'Mögliche Einwände', 'Empfohlener Gesprächsablauf', 'So kannst du dich vorstellen', 'Bedarfsanalyse interessant', 'Kooperation interessant', 'Mehrere Themen interessant', 'Nächster Schritt']) assert.ok(leadPage.includes(t), t);
  const list = await page(app, '/leads'); for (const t of ['🌐 Website:', '🛡 Bedarfsanalyse:', '🤝 Kooperation:', 'Website-Potenzial hoch', 'Bedarfsanalyse interessant', 'Partnerpotenzial hoch', 'Demo vorhanden']) assert.ok(list.includes(t), t);
  const today = await page(app, '/today'); assert.ok(today.includes('Verkaufsassistent öffnen') && today.includes('Gesprächsziel') && today.includes('Website-Potenzial'));
  // HTTP-Weg: Ergebnis mit nächstem Schritt
  const res = await app.post(`/leads/${ok[5].id}/call`, { result: 'PARTNERSHIP', note: 'x', next_step: 'Kaffee mit dem Inhaber' }); assert.equal(res.status, 303);
  assert.equal((await topics(ok[5].id)).next_step, 'Kaffee mit dem Inhaber');
  const calls = await page(app, '/calls'); assert.ok(calls.includes('Gesprächsziel') || calls.includes('Keine Calls offen') || calls.includes('Nächster Schritt'));
  assert.equal((await app.pool.query('select count(*)::int n from outbox')).rows[0].n, 0, 'nichts gesendet');
});

test('Verkaufsassistent vertiefen (DEEP): nur geprüfte KI-Ausgabe, Cache, Mock ohne Kosten', { skip, timeout: 300_000 }, async () => {
  const app = await seeded('00000000-0000-0000-0000-000000000464');
  const lead = (await rows(app)).find((l) => l.work_status === 'CONTACTABLE' && l.phone)!; await app.ctx.copilot.ensure(lead.id, { force: true });
  let calls = 0, reply = JSON.stringify({ opener: 'Guten Tag, hier ist Kai Schwarz. Ich habe mir einige Betriebe der Region angesehen und wollte kurz nachfragen, ob ein Online-Auftritt für Sie ein Thema ist.', summary: 'Lokaler Betrieb, telefonisch erreichbar. In den verfügbaren Quellen wurde keine eigene Website gefunden.' });
  const mk = (mock: boolean) => new CopilotService({ repo: app.repo, leads: app.ctx.leads, cfg: app.ctx.cfg, complete: async () => { calls++; return { text: reply, model: 'test-model' }; }, aiIsMock: () => mock });
  const mock = await mk(true).deepen(lead.id); assert.equal(mock.used, false); assert.match(mock.note, /Keine KI konfiguriert/); assert.equal(calls, 0);
  const svc = mk(false); const r1 = await svc.deepen(lead.id); assert.equal(r1.used, true); assert.equal(calls, 1);
  assert.match((await svc.stored(lead.id)).deep!.opener!, /Kai Schwarz/); assert.match(await page(app, `/leads/${lead.id}`), /vertieft \(DEEP\)/);
  const r2 = await svc.deepen(lead.id); assert.equal(r2.used, false); assert.equal(calls, 1, 'gleiche Grundlage → kein erneuter KI-Aufruf');
  // geänderte Grundlage + unzulässige Ausgabe (Zahlen/Rabatt) → verworfen, Regeltext bleibt
  await app.ctx.calls.applyResult(lead.id, 'INTERESTED', {}); await app.ctx.copilot.ensure(lead.id);
  reply = JSON.stringify({ opener: 'Mit unserem Website-Rabatt von 20% sparen Sie Geld, wenn Sie eine Versicherung abschließen.', summary: 'Das Unternehmen hat keine Website und 15 Mitarbeiter.' });
  const r3 = await svc.deepen(lead.id); assert.equal(r3.used, false); assert.match(r3.note, /verworfen/); assert.equal(calls, 2);
  reply = 'kein json'; assert.equal((await svc.deepen(lead.id)).used, false);
});
