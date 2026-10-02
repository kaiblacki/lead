import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appSetup, skip, enablePhone, type App } from './helpers.ts';
import { normalizeCriteria } from '../../src/search/criteria.ts';
import { createProviders } from '../../src/providers/registry.ts';
import { SyntheticPlaces, StubCrawler } from '../synthetic.ts';

/** Arbeitsliste: Ranking (kontaktierbar zuerst, DATA_NEEDED getrennt), Arbeitsansichten/Filter, Statusänderung und Notiz auf der Lead-Seite. */
const apps: App[] = []; after(async () => { for (const a of apps) await a.close(); });
const page = async (app: App, path: string) => app.text(await (await app.get(path)).text());

test('Ranking: kontaktierbare Leads zuerst (Priorität, dann Verkaufschance), DATA_NEEDED getrennt am Ende – auch bei hoher Verkaufschance; Override ändert die Reihenfolge; Arbeitsansichten und Filter', { skip, timeout: 300_000 }, async () => {
  const app = await appSetup('00000000-0000-0000-0000-000000000451', { autoDemo: false }); apps.push(app);
  const { limits } = await app.repo.getLimits(); await app.repo.saveLimits({ ...limits, maxLeadsPerRun: 1000, maxAuditsPerRun: 1000, maxCrawlPagesPerRun: 20000 }); await enablePhone(app);
  const live = createProviders({ APP_MODE: 'live' }, { baseUrl: app.base });
  Object.assign(app.ctx.registry.providers, { places: new SyntheticPlaces({ n: 16, noSiteEvery: 1, noPhoneEvery: 2 }), crawler: new StubCrawler(), directory: live.providers.directory, social: live.providers.social });
  const id = await app.ctx.runner.start(normalizeCriteria({ location: 'Völklingen', radiusKm: '30', subIndustries: ['nagelstudio'], maxLeads: '50' }, app.ctx.cfg.taxonomy, app.ctx.cfg.pipeline.sizes)); await app.ctx.runner.idle();
  assert.ok(id);
  const all = (await app.ctx.leads.list({ limit: 100 })).rows; assert.equal(all.length, 16);
  const needed = all.filter((l) => l.work_status === 'DATA_NEEDED'), ok = all.filter((l) => l.work_status === 'CONTACTABLE'); assert.ok(needed.length >= 6 && ok.length >= 6);
  // DATA_NEEDED-Lead mit höchster Priorität/Verkaufschance setzen: darf trotzdem nicht zwischen den kontaktierbaren Leads stehen
  await app.ctx.pipeline.setManualPriority(needed[0].id, 'A'); await app.pool.query("update opportunities set score = 99 where lead_id = $1", [needed[0].id]);
  const rows = (await app.ctx.leads.list({ limit: 100 })).rows; const firstNeeded = rows.findIndex((l) => l.work_status === 'DATA_NEEDED');
  assert.ok(rows.slice(0, firstNeeded).every((l) => l.work_status === 'CONTACTABLE') && rows.slice(firstNeeded).every((l) => l.work_status === 'DATA_NEEDED'), 'kontaktierbare zuerst, DATA_NEEDED danach');
  assert.equal(rows[firstNeeded].id, needed[0].id, 'innerhalb von DATA_NEEDED zählt die Priorität');
  const rank = (p: string | null) => ({ A: 0, B: 1, C: 2, D: 3 } as Record<string, number>)[p ?? ''] ?? 4; const head = rows.slice(0, firstNeeded);
  for (let i = 1; i < head.length; i++) assert.ok(rank(head[i - 1].priority) <= rank(head[i].priority), 'A vor B vor C vor D');
  // manuelles Override: C-Lead auf A → rückt nach oben, automatische Priorität + Begründung bleiben sichtbar
  const low = head[head.length - 1]; await app.ctx.pipeline.setManualPriority(low.id, 'A');
  const after = (await app.ctx.leads.list({ limit: 100 })).rows; assert.ok(after.findIndex((l) => l.id === low.id) <= head.findIndex((l) => l.id === low.id));
  const row = after.find((l) => l.id === low.id)!; assert.equal(row.effective_priority, 'A'); assert.equal(row.manual_priority, 'A'); assert.ok(row.auto_priority && row.priority_reason);
  // Arbeitsansichten
  const q = async (quick: string) => (await app.ctx.leads.list({ quick, limit: 100 })).rows;
  const nowWork = await q('now_work'); assert.ok(nowWork.length >= 1 && nowWork.every((l) => l.work_status === 'CONTACTABLE' && ['A', 'B'].includes(l.priority)), 'Jetzt bearbeiten: nur kontaktierbare A/B');
  assert.ok((await q('has_phone')).every((l) => l.phone) && (await q('has_phone')).length === ok.length); assert.ok((await q('data_needed')).every((l) => l.work_status === 'DATA_NEEDED'));
  assert.ok((await q('ready_contact')).every((l) => l.work_status === 'CONTACTABLE'));
  // Statusänderung + Notiz auf der Lead-Seite; Anruf-Ergebnisse füllen „angerufen / interessiert / später / kein Interesse“
  const [a, b, c] = ok.slice(0, 3);
  const call = async (leadId: string, result: string) => app.post(`/leads/${leadId}/call`, { result, note: 'Test', ...(result === 'CALL_BACK' ? { callback: '2026-12-01T10:00' } : {}) });
  await call(a.id, 'INTERESTED'); await call(b.id, 'CALL_BACK'); await call(c.id, 'NO_INTEREST');
  const ids = async (quick: string) => (await q(quick)).map((l) => l.id);
  assert.ok((await ids('called')).includes(a.id) && (await ids('called')).includes(c.id)); assert.ok((await ids('interested')).includes(a.id)); assert.ok((await ids('later')).includes(b.id)); assert.ok((await ids('no_interest')).includes(c.id));
  const note = await app.post(`/leads/${a.id}/notes`, { body: 'Rückruf Frau Muster Mittwoch' }); assert.equal(note.status, 303);
  assert.match(await page(app, `/leads/${a.id}`), /Rückruf Frau Muster Mittwoch/);
  assert.match(await page(app, '/leads'), /Jetzt bearbeiten/); assert.match(await page(app, '/leads'), /Interessiert/);
});
