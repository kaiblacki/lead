import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from '../../src/db/repo.ts';
import { LeadStore } from '../../src/db/leads.ts';
import { RunStore } from '../../src/db/runs.ts';
import { SearchRunner } from '../../src/search/runner.ts';
import { loadConfig } from '../../src/core/config.ts';
import { createProviders, type Registry } from '../../src/providers/registry.ts';
import { normalizeCriteria } from '../../src/search/criteria.ts';

export const NOW = new Date('2026-06-01T10:00:00Z');
export const DB_URL = process.env.TEST_DATABASE_URL;
export const skip = DB_URL ? false : 'TEST_DATABASE_URL nicht gesetzt (npm run test:db)';

export async function setup(ownerId: string, env: Record<string, string> = {}) {
  const pool = new pg.Pool({ connectionString: DB_URL });
  await pool.query('insert into auth.users values ($1) on conflict do nothing', [ownerId]);
  const repo = new Repo(pool, ownerId);
  const cfg = loadConfig();
  const reg: Registry = createProviders(env, { baseUrl: 'http://127.0.0.1:3000', now: () => NOW, hostingRoot: mkdtempSync(join(tmpdir(), 'hosting-')) });
  const leads = new LeadStore(repo), runs = new RunStore(repo);
  const runner = new SearchRunner({ repo, leads, runs, providers: reg.providers, cfg, now: () => NOW });
  const criteria = (o: Record<string, unknown>) => normalizeCriteria({ location: 'Völklingen', radiusKm: '30', subIndustries: ['nagelstudio'], maxLeads: '15', ...o }, cfg.taxonomy);
  return { pool, repo, cfg, reg, providers: reg.providers, leads, runs, runner, criteria, close: () => pool.end() };
}
export type Ctx = Awaited<ReturnType<typeof setup>>;

export async function runSearch(ctx: Ctx, o: Record<string, unknown> = {}) {
  const id = await ctx.runner.start(ctx.criteria(o));
  await ctx.runner.idle();
  return { id, run: (await ctx.runs.get(id))! };
}

// ---------- Vollständige App (HTTP) ----------
import type { AddressInfo } from 'node:net';
import { buildContext, type Context } from '../../src/context.ts';
import { createApp } from '../../src/dashboard/server.ts';

export const PASSWORD = 'test-passwort-123';
export const AUTH = { authorization: 'Basic ' + Buffer.from(`u:${PASSWORD}`).toString('base64') };

export async function appSetup(ownerId: string, o: { env?: Record<string, string>; cfgDir?: string; autoDeploy?: boolean; now?: () => Date; autoDemo?: boolean } = {}) {
  const pool = new pg.Pool({ connectionString: DB_URL });
  await pool.query('insert into auth.users values ($1) on conflict do nothing', [ownerId]);
  const repo = new Repo(pool, ownerId);
  const hostingRoot = mkdtempSync(join(tmpdir(), 'hosting-'));
  const holder: { baseUrl: string } = { baseUrl: 'http://127.0.0.1:0' };
  // Der Server braucht die Basis-URL (Port) erst nach dem Start; Mock-Hosting/Zahlung lesen sie lazy über buildContext → daher zuerst Port reservieren.
  const { createServer } = await import('node:http');
  const probe = createServer(); await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as AddressInfo).port; await new Promise<void>((r) => probe.close(() => r()));
  holder.baseUrl = `http://127.0.0.1:${port}`;
  const base0 = loadConfig(o.cfgDir ?? 'config');
  // Auto-Demo für Firmen ohne Website ist im Produkt an; die älteren Ablauf-Tests setzen QUALIFIED-Leads voraus und schalten sie ab (neue Tests: autoDemo: true).
  const cfg = { ...base0, sales: { ...base0.sales, autoDemo: { ...base0.sales.autoDemo, enabled: !!o.autoDemo } } };
  const ctx: Context = buildContext(repo, { env: o.env ?? {}, baseUrl: holder.baseUrl, now: () => NOW, providerNow: () => NOW, cfg, hostingRoot });
  const server = createApp(ctx, { password: PASSWORD, baseUrl: holder.baseUrl, autoDeploy: o.autoDeploy });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const base = holder.baseUrl;
  const get = (p: string, auth = true, redirect: RequestRedirect = 'manual') => fetch(base + p, { headers: auth ? AUTH : {}, redirect });
  let csrfCache = '';
  const csrf = async () => csrfCache || (csrfCache = /name="csrf" value="([0-9a-f]+)"/.exec(await (await get('/settings')).text())![1]);
  const post = async (p: string, data: Record<string, string | string[]> = {}, headers: Record<string, string> = {}) => {
    const body = new URLSearchParams(); body.set('csrf', await csrf());
    for (const [k, v] of Object.entries(data)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
    return fetch(base + p, { method: 'POST', headers: { ...AUTH, 'content-type': 'application/x-www-form-urlencoded', referer: base + '/', ...headers }, redirect: 'manual', body });
  };
  /** Folgt der Weiterleitung und liefert die Zielseite (inkl. Flash-Text). */
  const follow = async (res: Response) => { const loc = res.headers.get('location'); if (!loc) return res.text(); return (await get(loc)).text(); };
  const text = (s: string) => s.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
  return { pool, repo, ctx, server, base, get, post, follow, text, csrf, close: async () => { await ctx.runner.idle(); server.close(); await pool.end(); } };
}
export type App = Awaited<ReturnType<typeof appSetup>>;

/** Telefonakquise freigeben und per Schnellsuche Leads holen (Mock-Welt). */
export async function enablePhone(app: App) {
  const r = await app.post('/settings/phone', { enable: '1', ack: '1', dailyCallTarget: '30', callerName: 'Kai Test' });
  if (r.status !== 303) throw new Error('phone enable failed ' + r.status);
}
export async function quickSearch(app: App, q = 'Völklingen + 30 km + Nagelstudios') {
  const r = await app.post('/search/quick', { q });
  if (r.status !== 303) throw new Error('search failed ' + r.status);
  await app.ctx.runner.idle();
}
/** Leads des Besitzers nach Status/Bereitschaft. */
export async function leadsWhere(app: App, where = 'true', owner?: string) {
  return (await app.pool.query(`select id, company_name, status, contact_readiness, contact_blocked, phone, website_state, call_count, callback_at, paused from leads where owner_id=$1 and ${where} order by company_name`, [owner ?? app.repo.ownerId])).rows as any[];
}

/** Bringt einen Lead ohne Browser-QA bis MAINTENANCE_ACTIVE (für Tests zu Wartung/Abos/Sicherheit). */
export async function makeCustomer(app: App, leadId: string, o: { maintenance?: boolean; deploy?: boolean; stopAt?: 'review' } = {}) {
  const { ctx } = app; const pay = ctx.registry.providers.payments;
  const call = await ctx.calls.applyResult(leadId, 'BOUGHT', { note: 'Testkunde' });
  const orderId = call.orderId!;
  const dep = await ctx.orders.startCheckout(orderId, 'deposit', pay, app.base);
  const depPay = (await ctx.orders.payments(orderId)).find((p: any) => p.kind === 'deposit')!;
  await ctx.orders.simulatePayment(depPay.id, pay); void dep;
  const project = await ctx.delivery.getProject(orderId);
  const c = project.content;
  await ctx.delivery.saveProject(orderId, { ...c, phone: '0681 998877', email: 'kontakt@beispiel.example', address: 'Hauptstraße 12', postalCode: '66333', city: 'Völklingen', openingHours: 'Mo–Fr 9–18 Uhr',
    about: 'Persönliche Beratung und saubere Arbeit seit vielen Jahren.', services: [{ title: 'Maniküre', text: 'Pflege und Lack für gepflegte Hände' }, { title: 'Gelnägel', text: 'Neumodellage und Auffüllen' }], legal: { owner: 'Erika Mustermann', hosting: 'Mock-Hosting' } }, true);
  const b = await ctx.delivery.build(orderId, { browser: false });
  if (!b.passed) throw new Error('QA nicht bestanden: ' + JSON.stringify(b.issues.filter((i: any) => i.severity === 'error')));
  const token = (await ctx.orders.getOrder(orderId)).review_token as string;
  if (o.stopAt === 'review') return { orderId, token, url: undefined as string | undefined };
  await ctx.delivery.decide(token, 'approve');
  await ctx.orders.startCheckout(orderId, 'final', pay, app.base);
  const fin = (await ctx.orders.payments(orderId)).find((p: any) => p.kind === 'final')!;
  await ctx.orders.simulatePayment(fin.id, pay);
  let url: string | undefined;
  if (o.deploy !== false) { url = (await ctx.delivery.deploy(orderId, ctx.registry.providers.hosting)).url;
    if (o.maintenance !== false) { await ctx.orders.startCheckout(orderId, 'maintenance', pay, app.base); const m = (await ctx.orders.payments(orderId)).find((p: any) => p.kind === 'maintenance')!; await ctx.orders.simulatePayment(m.id, pay); } }
  return { orderId, token, url };
}

/** Test-App mit 12 synthetischen Leads (Nagelstudios, ohne/mit Website, teils ohne Telefon). `phone: false` lässt die Telefonakquise gesperrt. */
export async function seededApp(owner: string, o: { phone?: boolean; n?: number; cfgDir?: string } = {}) {
  const { SyntheticPlaces, StubCrawler } = await import('../synthetic.ts');
  const app = await appSetup(owner, { autoDemo: false, cfgDir: o.cfgDir });
  const { limits } = await app.repo.getLimits(); await app.repo.saveLimits({ ...limits, maxLeadsPerRun: 1000, maxAuditsPerRun: 1000, maxCrawlPagesPerRun: 20000 });
  if (o.phone !== false) await enablePhone(app);
  const live = createProviders({ APP_MODE: 'live' }, { baseUrl: app.base });
  Object.assign(app.ctx.registry.providers, { places: new SyntheticPlaces({ n: o.n ?? 12, noSiteEvery: 2, noPhoneEvery: 4 }), crawler: new StubCrawler(), directory: live.providers.directory, social: live.providers.social });
  await app.ctx.runner.start(normalizeCriteria({ location: 'Völklingen', radiusKm: '30', subIndustries: ['nagelstudio'], maxLeads: '50' }, app.ctx.cfg.taxonomy, app.ctx.cfg.pipeline.sizes)); await app.ctx.runner.idle();
  return app;
}
