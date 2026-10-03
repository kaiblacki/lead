import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { seededApp, skip, type App } from './helpers.ts';

/** Phase J: Navigationsgruppen, Lead-Reiter, Schnellaktionen (nur Links), Bedarfsanalyse getrennt, „Heute“ nach Handlungspriorität. */
const apps: App[] = []; after(async () => { for (const a of apps) await a.close(); });
const raw = async (app: App, path: string) => (await app.get(path)).text();

test('Navigation in Gruppen START/LEADS/SALES/PARTNER/KUNDEN/ANALYTICS/SYSTEM; alle Ziele erreichbar (200)', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000901', { cfgDir: 'config.mock' }); apps.push(app);
  const h = await raw(app, '/today'); const nav = h.slice(h.indexOf('aria-label="Hauptnavigation"'), h.indexOf('</nav>', h.indexOf('aria-label="Hauptnavigation"')));
  for (const g of ['START', 'LEADS', 'SALES', 'TEAM', 'PARTNER', 'KUNDEN', 'ANALYTICS', 'SYSTEM']) assert.ok(nav.includes(`aria-label="${g}"`), g);
  const menu = await (await app.get('/menu')).text(); const hrefs = [...new Set([...menu.matchAll(/href="(\/[^"#]*)/g)].map((m) => m[1].replace(/&amp;/g, '&')))]; assert.ok(hrefs.length >= 35, String(hrefs.length));
  for (const href of hrefs) { const res = await app.get(href); assert.equal(res.status, 200, href); }
});

test('Lead-Reiter: alle acht Bereiche + ALLE; inaktive sind hidden, Anker (:target) funktionieren; Bedarfsanalyse getrennt ohne Preise/Rabatte; Aufgabe statt Versand', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000902', { cfgDir: 'config.mock' }); apps.push(app);
  const lead = (await app.ctx.leads.list({ limit: 100 })).rows.find((l: any) => l.phone)!;
  const base = await raw(app, `/leads/${lead.id}`);
  for (const t of ['ÜBERSICHT', 'VERKAUF', 'WEBSITE', 'DEMO', 'PARTNER', 'BEDARFSANALYSE', 'ANGEBOT', 'VERLAUF']) assert.ok(base.includes(`>${t}</a>`), t);
  for (const q of ['ANRUFEN', 'E-MAIL ENTWURF', 'DEMO', 'RÜCKRUF', 'ANGEBOT', 'PARTNER']) assert.ok(base.includes(q), q);
  assert.match(base, /<section class="tabpane" data-tab="uebersicht" >/); assert.match(base, /<section class="tabpane" data-tab="angebot" hidden>/);
  const ang = await raw(app, `/leads/${lead.id}?tab=angebot`); assert.match(ang, /data-tab="angebot" >/); assert.match(ang, /data-tab="uebersicht" hidden>/);
  assert.equal((await raw(app, `/leads/${lead.id}?tab=quatsch`)).includes('data-tab="uebersicht" >'), true, 'ungültiger Reiter → Übersicht');
  const alle = await raw(app, `/leads/${lead.id}?tab=alle`); assert.equal((alle.match(/class="tabpane" data-tab="[a-z]+" >/g) ?? []).length, 8);
  const bed = await raw(app, `/leads/${lead.id}?tab=bedarf`); const card = bed.slice(bed.indexOf('id="bedarfsanalyse"')); const seg = card.slice(0, card.indexOf('</section>'));
  assert.match(seg, /getrennt von Website und Partnerschaft/); assert.doesNotMatch(seg, /€|Rabatt-Betrag|Angebot erstellen/);
  const res = await app.post(`/leads/${lead.id}/needs-task`, {}); assert.equal(res.status, 303); await app.post(`/leads/${lead.id}/needs-task`, {});
  assert.equal((await app.pool.query("select count(*)::int n from tasks where lead_id = $1 and type = 'NEEDS_ANALYSIS_APPOINTMENT'", [lead.id])).rows[0].n, 1, 'kein Duplikat');
  assert.match(await raw(app, `/leads/${lead.id}?tab=bedarf`), /Termin-Aufgabe offen/);
  assert.equal((await app.pool.query('select count(*)::int n from outbox where owner_id = $1', [app.ctx.repo.ownerId])).rows[0].n, 0);
});

test('Heute: „Als Nächstes“ nach Handlungspriorität mit Schnellaktionen; absteigend sortiert', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000903', { cfgDir: 'config.mock' }); apps.push(app);
  const h = await raw(app, '/today'); assert.match(h, /id="als-naechstes"/); const seg = h.slice(h.indexOf('id="als-naechstes"'), h.indexOf('<div class="grid">', h.indexOf('id="als-naechstes"')));
  const prios = [...seg.matchAll(/Handlung (\d+)/g)].map((m) => Number(m[1])); assert.ok(prios.length >= 1 && prios.length <= 5, String(prios.length)); assert.deepEqual(prios, [...prios].sort((a, b) => b - a));
  assert.match(seg, /ANRUFEN/); assert.match(seg, /Du entscheidest/);
});
