import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { Repo } from '../src/db/repo.ts';
import { createApp } from '../src/dashboard/app.ts';
import { leadsFromCsv } from '../src/connectors/csv.ts';
import { runPipeline } from '../src/pipeline.ts';
import { Budget, DEFAULT_LIMITS } from '../src/guardrails/budget.ts';

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'TEST_DATABASE_URL nicht gesetzt (npm run test:db)';
const OWNER = '00000000-0000-0000-0000-00000000000a';
const OTHER = '00000000-0000-0000-0000-00000000000b';
const PASSWORD = 'test-passwort-123';
const cfg = JSON.parse(readFileSync(new URL('../config/scoring.json', import.meta.url), 'utf8'));
const pricing = JSON.parse(readFileSync(new URL('../config/pricing.json', import.meta.url), 'utf8'));
const OLD = '<html><title>Salon</title><font>Hi</font><p>© 2015</p></html>';

let pool: pg.Pool, repo: Repo, other: Repo, server: ReturnType<typeof createApp>, base: string;
const auth = { authorization: 'Basic ' + Buffer.from(`u:${PASSWORD}`).toString('base64') };
const get = (p: string) => fetch(base + p, { headers: auth, redirect: 'manual' });
async function csrfToken() { const t = await (await get('/settings')).text(); return /name="csrf" value="([0-9a-f]+)"/.exec(t)![1]; }
async function post(p: string, data: Record<string, string>, token?: string) {
  return fetch(base + p, { method: 'POST', headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual', body: new URLSearchParams({ csrf: token ?? (await csrfToken()), ...data }) });
}

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: url });
  await pool.query('insert into auth.users values ($1),($2) on conflict do nothing', [OWNER, OTHER]);
  repo = new Repo(pool, OWNER); other = new Repo(pool, OTHER);
  server = createApp(repo, { password: PASSWORD, fetchSite: async (u) => u.includes('down') ? { ok: false, error: 'timeout' } : { ok: true, finalUrl: 'http://' + u, html: OLD, loadMs: 400 } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { if (skip) return; server.close(); await pool.end(); });

const csv = 'Firmenname;Stadt;Adresse;Website;Instagram\nKein Web Salon;Saarbrücken;Str 1;;\nAlter Salon;Neunkirchen;Str 2;alt.example;\nDown Salon;Homburg;Str 3;down.example;';

test('Pipeline speichert Leads, Befunde, Score, Paket und Verlauf; Re-Import erzeugt keine Duplikate', { skip }, async () => {
  const { leads } = leadsFromCsv(csv);
  const fetcher = async (u: string) => u.includes('down') ? { ok: false, error: 'timeout' } : { ok: true, finalUrl: 'http://' + u, html: OLD, loadMs: 400 };
  for (let i = 0; i < 2; i++) {
    const runId = await repo.createRun('Friseur', 'Saarland', null, 10);
    const r = await runPipeline(leads, { fetchSite: fetcher, scoring: cfg, pricing, budget: new Budget(DEFAULT_LIMITS), onReport: async (x) => { await repo.saveReport(x, runId); } });
    await repo.finishRun(runId, 'DONE', { leads: r.reports.length });
  }
  const list = await repo.listLeads();
  assert.equal(list.length, 3);
  const byName = Object.fromEntries(list.map((l) => [l.company_name, l]));
  assert.equal(byName['Kein Web Salon'].category, 'HOT');
  assert.equal(byName['Kein Web Salon'].status, 'QUALIFIED');
  assert.equal(byName['Alter Salon'].score, 65);
  assert.equal(byName['Down Salon'].status, 'RECHECK');
  assert.equal(byName['Down Salon'].score, null);
  const d = await repo.getLead(byName['Alter Salon'].id);
  assert.ok(d!.findings.length > 5 && d!.sales);
  assert.ok(d!.events.some((e: any) => e.type === 'status_change'));
});

test('Mandantentrennung: anderer Nutzer sieht und ändert nichts', { skip }, async () => {
  assert.equal((await other.listLeads()).length, 0);
  const id = (await repo.listLeads())[0].id;
  assert.equal(await other.getLead(id), null);
  await assert.rejects(() => other.setPaused(id, true), /nicht gefunden/);
  await assert.rejects(() => other.approveSales(id), /Kein Verkaufspaket/);
});

test('Dashboard: Login Pflicht, Liste, Filter, Detailseite', { skip }, async () => {
  assert.equal((await fetch(base + '/', { redirect: 'manual' })).status, 401);
  assert.equal((await fetch(base + '/', { headers: { authorization: 'Basic ' + Buffer.from('u:falsch').toString('base64') } })).status, 401);
  const html = await (await get('/')).text();
  assert.match(html, /Kein Web Salon/); assert.match(html, /Alter Salon/);
  const hot = await (await get('/?category=HOT')).text();
  assert.match(hot, /Kein Web Salon/); assert.doesNotMatch(hot, /Alter Salon/);
  const id = (await repo.listLeads({ q: 'Alter' }))[0].id;
  const detail = await (await get('/lead/' + id)).text();
  assert.match(detail, /Befunde mit Beleg/); assert.match(detail, /Manuelle Kontaktaufnahme erforderlich/);
});

test('Dashboard: POST ohne CSRF-Token wird abgelehnt', { skip }, async () => {
  const id = (await repo.listLeads())[0].id;
  const r = await fetch(base + `/lead/${id}/pause`, { method: 'POST', headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrf=falsch' });
  assert.equal(r.status, 403);
  assert.equal((await repo.getLead(id))!.lead.paused, false);
});

test('Human Override: pausieren, freigeben, bearbeiten, ablehnen, retry', { skip }, async () => {
  const id = (await repo.listLeads({ q: 'Alter' }))[0].id;
  await post(`/lead/${id}/pause`, {});
  assert.equal((await repo.getLead(id))!.lead.paused, true);
  assert.equal(await repo.isPaused('csv-import', (await repo.getLead(id))!.lead.source_ref), true);
  await post(`/lead/${id}/resume`, {});
  assert.equal((await repo.getLead(id))!.lead.paused, false);
  await post(`/lead/${id}/approve`, {});
  assert.ok((await repo.getLead(id))!.sales.approved_at);
  await post(`/lead/${id}/edit`, { opener: 'Mein eigener Gesprächseinstieg mit Bezug zum Laden.' });
  const s = (await repo.getLead(id))!.sales;
  assert.equal(s.opener_source, 'manual'); assert.equal(s.approved_at, null);
  const before = (await repo.getLead(id))!.audit.id;
  await post(`/lead/${id}/reanalyze`, {});
  assert.notEqual((await repo.getLead(id))!.audit.id, before);
  await post(`/lead/${id}/reject`, {});
  assert.equal((await repo.getLead(id))!.lead.status, 'IGNORED');
  const bad = await post(`/lead/${id}/reject`, {});
  assert.equal(bad.status, 400);
});

test('Kill Switch: stoppt Retry und Läufe, Fortsetzen hebt ihn auf', { skip }, async () => {
  const id = (await repo.listLeads({ q: 'Kein Web' }))[0].id;
  await post('/killswitch', { on: '1' });
  assert.equal((await repo.getLimits()).killSwitch, true);
  assert.match(await (await get('/')).text(), /KILL SWITCH AKTIV/);
  assert.equal((await post(`/lead/${id}/reanalyze`, {})).status, 400);
  const { leads } = leadsFromCsv(csv);
  let stopped = '';
  const r = await runPipeline(leads, { fetchSite: async () => ({ ok: false }), scoring: cfg, pricing, budget: new Budget(DEFAULT_LIMITS),
    beforeLead: async () => ((await repo.getLimits()).killSwitch ? 'stop' : undefined) });
  stopped = r.stoppedReason ?? '';
  assert.match(stopped, /Kill Switch/); assert.equal(r.reports.length, 0);
  await post('/killswitch', { on: '0' });
  assert.equal((await repo.getLimits()).killSwitch, false);
});

test('Einstellungen: Limits und Gewichte speichern, ungültige Werte abgelehnt, Sperrliste', { skip }, async () => {
  await post('/settings/limits', { maxLeadsPerRun: '5', maxAuditsPerRun: '5', maxAiRequestsPerLead: '2', maxDailyCents: '100', maxMonthlyCents: '900' });
  assert.equal((await repo.getLimits()).limits.maxLeadsPerRun, 5);
  assert.equal((await post('/settings/limits', { maxLeadsPerRun: '-1', maxAuditsPerRun: '5', maxAiRequestsPerLead: '2', maxDailyCents: '1', maxMonthlyCents: '1' })).status, 400);
  const w = Object.fromEntries(Object.keys(cfg.weights).map((k) => [k, String(cfg.weights[k])])); w.website_outdated = '0';
  await post('/settings/weights', w);
  assert.equal((await repo.getScoringConfig(cfg)).weights.website_outdated, 0);
  assert.equal((await post('/settings/weights', { ...w, website_missing: '500' })).status, 400);
  await post('/settings/suppression', { kind: 'email', value: 'Nein@Danke.de' });
  assert.equal((await repo.listSuppression())[0].value, 'nein@danke.de');
  assert.match(await (await get('/settings')).text(), /nein@danke.de/);
});

test('Events sind append-only für angemeldete Nutzer (über RLS-Rolle)', { skip }, async () => {
  const c = await pool.connect();
  try {
    await c.query('set role authenticated'); await c.query(`set request.jwt.sub = '${OWNER}'`);
    assert.ok((await c.query('select count(*)::int n from events')).rows[0].n > 0);
    await assert.rejects(() => c.query('delete from events'), /permission denied/);
  } finally { await c.query('reset role'); c.release(); }
});

test('Demo: erstellen, öffentlicher Link ohne Login, noindex, Zähler, Widerruf, Ablauf', { skip }, async () => {
  const id = (await repo.listLeads({ q: 'Kein Web' }))[0].id;
  assert.equal((await repo.getLead(id))!.lead.status, 'QUALIFIED');
  assert.equal((await post(`/lead/${id}/demo`, { template: 'friseur' })).status, 303);
  assert.equal((await repo.getLead(id))!.lead.status, 'DEMO_CREATED');
  const [d] = await repo.listDemos(id);
  assert.equal(d.token.length, 64);
  // öffentlich: ohne Authorization
  const pub = await fetch(`${base}/d/${d.token}`);
  assert.equal(pub.status, 200);
  assert.match(pub.headers.get('x-robots-tag') ?? '', /noindex/);
  assert.match(pub.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.match(await pub.text(), /Unverbindliche Demo/);
  assert.equal((await repo.listDemos(id))[0].view_count, 1);
  // Dashboard bleibt geschützt, geratene Tokens liefern 404
  assert.equal((await fetch(`${base}/`)).status, 401);
  assert.equal((await fetch(`${base}/d/${'0'.repeat(64)}`)).status, 404);
  assert.equal((await fetch(`${base}/d/kurz`)).status, 401);
  // Widerruf
  await post(`/demo/${d.id}/revoke`, {});
  assert.equal((await fetch(`${base}/d/${d.token}`)).status, 404);
  // Ablauf
  await post(`/lead/${id}/demo`, { template: 'friseur' });
  const d2 = (await repo.listDemos(id))[0];
  await pool.query("update demos set expires_at = now() - interval '1 minute' where id=$1", [d2.id]);
  assert.equal((await fetch(`${base}/d/${d2.token}`)).status, 404);
  assert.match(await (await get('/lead/' + id)).text(), /abgelaufen/);
});

test('CRM-Status: nur erlaubte Schritte, Grund Pflicht', { skip }, async () => {
  const id = (await repo.listLeads({ q: 'Kein Web' }))[0].id;
  assert.equal((await post(`/lead/${id}/status`, { to: 'DEPLOYED', reason: 'x' })).status, 400);
  for (const to of ['CONTACTED', 'REPLIED', 'INTERESTED']) assert.equal((await post(`/lead/${id}/status`, { to, reason: 'Telefonat' })).status, 303);
  assert.equal((await repo.getLead(id))!.lead.status, 'INTERESTED');
});

test('Angebot: Entwurf → Freigabe → versendet; Reihenfolge wird erzwungen', { skip }, async () => {
  const id = (await repo.listLeads({ q: 'Kein Web' }))[0].id;
  await post(`/lead/${id}/offer`, {});
  let o = await repo.latestOffer(id);
  assert.equal(o.status, 'DRAFT'); assert.equal(o.deposit_cents + o.final_cents, o.price_cents);
  assert.equal(o.content.title, 'Website Starter');
  assert.equal((await post(`/offer/${o.id}/sent`, {})).status, 400);       // nicht freigegeben
  await post(`/offer/${o.id}/approve`, {});
  assert.equal((await repo.latestOffer(id)).status, 'APPROVED');
  assert.equal((await post(`/offer/${o.id}/approve`, {})).status, 400);    // nur aus DRAFT
  await post(`/offer/${o.id}/sent`, {});
  o = await repo.latestOffer(id);
  assert.equal(o.status, 'SENT');
  assert.equal((await repo.getLead(id))!.lead.status, 'OFFER_SENT');
  assert.match(await (await get('/lead/' + id)).text(), /Es wird nichts automatisch versendet/);
  // Mandantentrennung
  assert.equal(await other.latestOffer(id), null);
  await assert.rejects(() => other.approveOffer(o.id), /nicht gefunden/);
  // DB-Regel: Summen müssen stimmen
  await assert.rejects(() => pool.query("insert into offers(owner_id, lead_id, content, price_cents, deposit_cents, final_cents, maintenance_cents) values ($1,$2,'{}',100,10,10,0)", [OWNER, id]), /check/);
});

test('Angebot ohne Verkaufsgrundlage wird abgelehnt', { skip }, async () => {
  const id = (await repo.listLeads({ q: 'Down Salon' }))[0].id;
  assert.equal((await post(`/lead/${id}/offer`, {})).status, 400);
});
