import http from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context } from '../context.ts';
import { RateLimiter } from './ratelimit.ts';
import { layout, type Flash } from './ui.ts';
import { html, esc, Safe } from './html.ts';
import { UserError, type AppInfo, type Req, type Res, type Route } from './types.ts';
import { routes as homeRoutes } from './pages/home.ts';
import { routes as todayRoutes } from './pages/today.ts';
import { routes as enrichmentRoutes } from './pages/enrichment.ts';
import { routes as searchRoutes } from './pages/search.ts';
import { routes as leadRoutes } from './pages/leads.ts';
import { routes as callRoutes } from './pages/calls.ts';
import { routes as pipelineRoutes } from './pages/pipeline.ts';
import { routes as orderRoutes } from './pages/orders.ts';
import { routes as maintenanceRoutes } from './pages/maintenance.ts';
import { routes as analyticsRoutes } from './pages/analytics.ts';
import { routes as settingsRoutes } from './pages/settings.ts';
import { routes as socialRoutes } from './pages/social.ts';
import { routes as publicRoutes } from './pages/public.ts';

export type AppOptions = { password: string; baseUrl?: string; trustProxy?: boolean; autoDeploy?: boolean };

const SECURE_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY', 'cache-control': 'no-store' };
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** Kurzlebige Hinweise (z. B. „Gespeichert“) über eine Einmal-ID in der URL – der Text selbst steht nie in der URL. */
class FlashStore {
  private m = new Map<string, { f: NonNullable<Flash>; exp: number }>();
  put(f: NonNullable<Flash>): string { const id = randomBytes(6).toString('hex'); this.m.set(id, { f, exp: Date.now() + 120_000 }); if (this.m.size > 500) for (const [k, v] of this.m) if (v.exp < Date.now()) this.m.delete(k); return id; }
  take(id: string | null): Flash { if (!id) return null; const e = this.m.get(id); this.m.delete(id); return e && e.exp > Date.now() ? e.f : null; }
}

export function createApp(ctx: Context, opts: AppOptions): http.Server {
  const csrf = createHmac('sha256', opts.password).update('csrf-v2').digest('hex');
  const app: AppInfo = { baseUrl: (opts.baseUrl ?? ctx.baseUrl).replace(/\/$/, ''), csrf, mock: ctx.registry.status.some((s) => s.mode === 'mock'), autoDeploy: !!opts.autoDeploy };
  const flashes = new FlashStore();
  const publicLimit = new RateLimiter(120, 60_000), postLimit = new RateLimiter(240, 60_000), authFails = new RateLimiter(10, 15 * 60_000);
  const hsts: Record<string, string> = app.baseUrl.startsWith('https://') ? { 'strict-transport-security': 'max-age=31536000' } : {};
  const all: Route[] = [...publicRoutes, ...homeRoutes, ...todayRoutes, ...enrichmentRoutes, ...searchRoutes, ...leadRoutes, ...callRoutes, ...pipelineRoutes, ...orderRoutes, ...maintenanceRoutes, ...analyticsRoutes, ...settingsRoutes, ...socialRoutes];

  const clientIp = (req: http.IncomingMessage) => (opts.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim() : '') || req.socket.remoteAddress || 'unknown';
  const authOk = (req: http.IncomingMessage) => {
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Basic ')) return false;
    const given = Buffer.from(Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':'));
    const want = Buffer.from(opts.password);
    return given.length === want.length && timingSafeEqual(given, want);
  };
  const readBody = async (req: http.IncomingMessage, max: number) => { let b = ''; for await (const ch of req) { b += ch; if (b.length > max) throw Object.assign(new UserError('Anfrage zu groß'), { status: 413 }); } return b; };
  const csrfOk = (form: URLSearchParams) => { const g = Buffer.from(form.get('csrf') ?? ''), w = Buffer.from(csrf); return g.length === w.length && timingSafeEqual(g, w); };
  /**
   * Herkunftsprüfung für Formulare. Browser senden bei „Referrer-Policy: no-referrer“ für Formulare `Origin: null` – das ist kein Angriff, sondern
   * „unbekannt“; dann entscheidet der Referer, und fehlt auch der, schützt das geheime CSRF-Token (Basic-Auth wird vom Browser sonst automatisch mitgeschickt).
   */
  const baseHost = (() => { try { return opts.baseUrl ? new URL(opts.baseUrl).host : null; } catch { return null; } })();
  const sameOrigin = (req: http.IncomingMessage) => {
    const hostOf = (v: string) => { try { return new URL(v).host; } catch { return null; } };
    // Hinter einem Proxy/Port-Forwarding (Codespaces, Tunnel, Caddy) unterscheidet sich der Host von der Browser-Adresse: Host, X-Forwarded-Host und PUBLIC_BASE_URL gelten alle.
    const ok = new Set([req.headers.host, String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim(), baseHost].filter(Boolean) as string[]);
    const origin = req.headers.origin, referer = req.headers.referer;
    if (origin && origin !== 'null') return ok.has(hostOf(origin) ?? '');
    if (referer) return ok.has(hostOf(referer) ?? '');
    return true;
  };


  const send = (res: http.ServerResponse, r: Res, isPublic: boolean, killSwitch: boolean, flashKind?: Flash) => {
    void killSwitch; void flashKind;
    if (r.redirect) {
      let loc = r.redirect;
      if (r.flash) {
        // Der Hinweis gehört vor den Anker (#…), sonst sendet der Browser ihn nie an den Server.
        const h = loc.indexOf('#'); const hash = h >= 0 ? loc.slice(h) : ''; const base = h >= 0 ? loc.slice(0, h) : loc;
        loc = base + (base.includes('?') ? '&' : '?') + 'f=' + flashes.put(r.flash) + hash;
      }
      res.writeHead(303, { location: loc, ...SECURE_HEADERS }); return void res.end();
    }
    const body = r.body instanceof Safe ? r.body.s : r.body ?? '';
    res.writeHead(r.status ?? 200, { 'content-type': r.type ?? 'text/html; charset=utf-8', ...SECURE_HEADERS, ...(isPublic ? {} : { 'content-security-policy': PAGE_CSP }), ...hsts, ...(r.headers ?? {}) });
    res.end(body);
  };
  const errorPage = (req: Req | null, status: number, msg: string, nav = '' as const) => html`<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fehler</title><body style="font:16px system-ui;margin:16px"><h1>${status === 404 ? 'Nicht gefunden' : 'Hinweis'}</h1><p>${msg}</p><p><a href="/">Zur Startseite</a></p></body></html>`;

  return http.createServer(async (req, res) => {
    const ip = clientIp(req);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = (req.method ?? 'GET') as 'GET' | 'POST';
    try {
      if (url.pathname === '/healthz' && method === 'GET') {
        try { await ctx.repo.pool.query('select 1'); res.writeHead(200, { 'content-type': 'text/plain', ...SECURE_HEADERS }); return void res.end('ok'); } catch { res.writeHead(503, { 'content-type': 'text/plain', ...SECURE_HEADERS }); return void res.end('db'); }
      }
      if (method !== 'GET' && method !== 'POST') { res.writeHead(405, { allow: 'GET, POST', ...SECURE_HEADERS }); return void res.end(); }
      const route = all.map((r) => ({ r, m: r.method === method ? r.path.exec(url.pathname) : null })).find((x) => x.m);
      if (!route) {
        if (!authOk(req)) { res.writeHead(401, { 'www-authenticate': 'Basic realm="Agency OS"' }); return void res.end('Anmeldung erforderlich'); }
        return send(res, { status: 404, body: errorPage(null, 404, 'Seite nicht gefunden.') }, false, false);
      }
      const isPublic = !!route.r.public;
      for (const [k, v] of Object.entries(hsts)) res.setHeader(k, v);
      if (isPublic) {
        if (!publicLimit.hit(ip)) { res.writeHead(429, { 'retry-after': '60' }); return void res.end('Zu viele Anfragen'); }
      } else {
        if (authFails.blocked(ip)) { res.writeHead(429, { 'retry-after': '900' }); return void res.end('Zu viele Fehlversuche. Bitte später erneut versuchen.'); }
        if (!authOk(req)) { if (req.headers.authorization) authFails.hit(ip); res.writeHead(401, { 'www-authenticate': 'Basic realm="Agency OS"' }); return void res.end('Anmeldung erforderlich'); }
        if (method === 'POST' && !postLimit.hit(ip)) { res.writeHead(429, { 'retry-after': '60' }); return void res.end('Zu viele Anfragen'); }
      }
      let form = new URLSearchParams(); let rawBody = '';
      if (method === 'POST') {
        rawBody = await readBody(req, route.r.maxBody ?? 200_000);
        form = new URLSearchParams(rawBody);
        if (!isPublic && !csrfOk(form)) return send(res, { status: 403, body: errorPage(null, 403, 'Ungültiges Formular-Token. Bitte die Seite neu laden.') }, false, false);
        if (!sameOrigin(req)) { res.writeHead(403); return void res.end('Ungültige Herkunft'); }
      }
      const killSwitch = isPublic ? false : (await ctx.repo.getLimits()).killSwitch;
      const flash = flashes.take(url.searchParams.get('f'));
      const r: Req = { ctx, app, req, res, url, params: route.m!.slice(1), form, rawBody, killSwitch, flash, ip };
      try {
        const out = await route.r.h(r);
        if (!res.writableEnded) send(res, out, isPublic, killSwitch);
      } catch (e) {
        if (res.writableEnded) return;
        const msg = e instanceof Error ? e.message : String(e);
        const dbErr = typeof (e as { code?: unknown })?.code === 'string' && /^[0-9A-Z]{5}$/.test((e as { code: string }).code);
        if (dbErr) console.error('DB-Fehler:', msg);
        const text = dbErr ? 'Datenbankfehler – bitte erneut versuchen.' : e instanceof UserError || e instanceof Error ? msg : 'Unbekannter Fehler';
        if (method === 'POST' && !isPublic) {
          let back = '/';
          try { const ref = req.headers.referer; if (ref && new URL(ref).host === req.headers.host) { const u = new URL(ref); u.searchParams.delete('f'); back = u.pathname + (u.search || ''); } } catch { /* egal */ }
          return send(res, { redirect: back, flash: { kind: 'err', text } }, false, killSwitch);
        }
        return send(res, { status: 400, body: isPublic ? html`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><p style="font:16px system-ui;margin:16px">${text}</p>` : layout({ title: 'Hinweis', nav: '', csrf, killSwitch, mock: app.mock, body: html`<div class="errbox">${text}</div><p><a class="btn" href="/">Zur Startseite</a></p>` }) }, isPublic, killSwitch);
      }
    } catch (e) {
      if (!res.headersSent) { const st = (e as { status?: number }).status ?? (e instanceof UserError ? 400 : 500); res.writeHead(st, { 'content-type': 'text/plain; charset=utf-8', ...(st === 413 ? { connection: 'close' } : {}) }); res.end(e instanceof UserError ? e.message : 'Interner Fehler'); }
      if (!(e instanceof UserError)) console.error(e);
    }
    void esc;
  });
}
