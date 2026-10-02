import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { seededApp, skip, type App } from './helpers.ts';

/** Phase G: Handlungspriorität persistiert, Sortierung, Analytics-Ansichten (Branchen/Regionen/Strategien/Partner/Kosten). */
const apps: App[] = []; after(async () => { for (const a of apps) await a.close(); });
const page = async (app: App, path: string) => app.text(await (await app.get(path)).text());

test('Handlungspriorität wird berechnet, gespeichert, sortiert und im Dashboard angezeigt', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000601', { cfgDir: 'config.mock' }); apps.push(app);
  const n = await app.ctx.growth.refresh(); assert.ok(n >= 5);
  const rows = (await app.pool.query('select id, action_priority, growth_scores from leads order by action_priority desc nulls last')).rows;
  assert.ok(rows.every((r: any) => r.action_priority !== null && r.growth_scores.reasons.length >= 1));
  const top = rows[0]; await app.ctx.taskEngine.create({ leadId: rows[rows.length - 1].id, type: 'CALL', title: 'Rückruf', dueAt: new Date(Date.now() - 3600000), priority: 'HIGH' });
  await app.ctx.growth.refresh();
  const sorted = await app.ctx.leads.list({ sort: 'action', limit: 100 });
  const prios = sorted.rows.map((l: any) => l.action_priority ?? -1); assert.deepEqual(prios, [...prios].sort((a, b) => b - a));
  assert.match(await page(app, '/leads?sort=action'), /Handlungspriorität/);
  assert.match(await page(app, '/today'), /Handlung \d+/);
  const one = await app.ctx.growth.forLead(top.id); assert.ok(one && one.actionPriority >= 0 && one.band);
});

test('Analytics-Ansichten: Branchen, Regionen, Strategien, Partner, Kosten – ohne Fehler, ohne Versandspuren', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000602', { cfgDir: 'config.mock' }); apps.push(app);
  const lead = (await app.ctx.leads.list({ limit: 1 })).rows[0]; await app.ctx.partners.fromLead(lead.id);
  for (const [v, t] of [['industries', 'Nach Branche'], ['regions', 'Nach Region'], ['strategies', 'Gesprächsstrategie'], ['partners', 'Kooperationen sind unabhängig'], ['costs', 'je gewonnenem Kunden']] as const) {
    const res = await app.get(`/analytics?view=${v}`); assert.equal(res.status, 200, v); assert.match(await app.text(await res.text()), new RegExp(t), v);
  }
  const sl = await app.ctx.growthAnalytics.slices('industry'); assert.equal(sl.reduce((a, b) => a + b.leads, 0), (await app.pool.query('select count(*)::int n from leads where owner_id = $1', [app.ctx.repo.ownerId])).rows[0].n);
  const p = await app.ctx.growthAnalytics.partners(); assert.equal(p.partners.length, 1);
  const c = await app.ctx.growthAnalytics.costs(); assert.equal(c.customers, 0); assert.equal(c.perCustomerCents, null, 'kein Kunde → nicht verfügbar');
  assert.equal((await app.pool.query('select count(*)::int n from outbox')).rows[0].n, 0);
});
