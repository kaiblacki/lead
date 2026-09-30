import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Repo } from '../db/repo.ts';
import type { Lead } from '../core/types.ts';
import type { Status } from '../core/status.ts';
import { fetchSite } from '../auditor/fetch.ts';
import { runPipeline } from '../pipeline.ts';
import { Budget } from '../guardrails/budget.ts';
import { eur } from '../ai/sales.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (d: unknown) => (d ? new Date(d as string).toLocaleString('de-DE') : '–');
const cfgJson = (n: string) => JSON.parse(readFileSync(new URL(`../../config/${n}`, import.meta.url), 'utf8'));

export type AppOptions = { password: string; fetchSite?: typeof fetchSite };

const STYLE = `body{font:15px system-ui;margin:0;background:#f5f6f8;color:#1b1f24}main{max-width:960px;margin:0 auto;padding:16px}
nav{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:12px}nav a{color:#0b5cad}
.card{background:#fff;border-radius:10px;padding:12px 14px;margin:8px 0;box-shadow:0 1px 2px #0002}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.row a.t{font-weight:600;color:inherit;text-decoration:none}.grow{flex:1}
.badge{font-size:11px;font-weight:700;padding:3px 8px;border-radius:99px;background:#ddd}.HOT{background:#e5484d;color:#fff}.HIGH-POTENTIAL{background:#f76b15;color:#fff}.MEDIUM{background:#ffc53d}
button,select,input,textarea{font:inherit;padding:8px 10px;border-radius:8px;border:1px solid #bbb;background:#fff}button{cursor:pointer;min-height:40px}
button.danger{background:#e5484d;color:#fff;border-color:#e5484d}button.ok{background:#2f9e44;color:#fff;border-color:#2f9e44}
textarea{width:100%;box-sizing:border-box}.kill{background:#ffe3e3;padding:8px 12px;border-radius:8px}.manual{background:#fff4d6;padding:8px;border-radius:6px}
table{border-collapse:collapse}td,th{padding:4px 10px;border-bottom:1px solid #eee;text-align:left}small{color:#666}.err{background:#ffe3e3;padding:10px;border-radius:8px}`;

export function createApp(repo: Repo, opts: AppOptions): http.Server {
  const csrf = createHmac('sha256', opts.password).update('csrf-v1').digest('hex');
  const fetcher = opts.fetchSite ?? fetchSite;

  const authOk = (req: http.IncomingMessage) => {
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Basic ')) return false;
    const given = Buffer.from(Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':'));
    const want = Buffer.from(opts.password);
    return given.length === want.length && timingSafeEqual(given, want);
  };

  const page = (title: string, body: string, killOn: boolean) => `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style><main>
<nav><b>Agency OS</b><a href="/">Leads</a><a href="/settings">Einstellungen</a><span class="grow"></span>
${killOn ? '<span class="kill"><b>KILL SWITCH AKTIV</b></span>' : ''}
<form method="post" action="/killswitch"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="on" value="${killOn ? '0' : '1'}">
<button class="${killOn ? 'ok' : 'danger'}">${killOn ? 'Fortsetzen' : 'STOP alles'}</button></form></nav>${body}</main></html>`;

  const post = (action: string, label: string, extra = '', cls = '') =>
    `<form method="post" action="${action}" style="display:inline"><input type="hidden" name="csrf" value="${csrf}">${extra}<button class="${cls}">${label}</button></form>`;

  async function rowToLead(id: string): Promise<Lead> {
    const d = await repo.getLead(id);
    if (!d) throw new Error('Lead nicht gefunden');
    const l = d.lead;
    return { id: l.source_ref, companyName: l.company_name, industry: l.industry ?? undefined, address: l.address ?? undefined, city: l.city ?? undefined,
      region: l.region ?? undefined, phone: l.phone ?? undefined, websiteUrl: l.website_url ?? undefined, socials: l.socials, source: l.source, mapsUrl: l.google_maps_url ?? undefined };
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL, form: URLSearchParams) {
    const { killSwitch } = await repo.getLimits();
    const send = (status: number, html: string) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'" }); res.end(html); };
    const back = (to: string) => { res.writeHead(303, { location: to }); res.end(); };
    const path = url.pathname;

    if (req.method === 'GET') {
      if (path === '/') {
        const leads = await repo.listLeads({ category: url.searchParams.get('category') || undefined, status: url.searchParams.get('status') || undefined, q: url.searchParams.get('q') || undefined });
        const opt = (v: string, cur: string | null) => `<option value="${esc(v)}"${cur === v ? ' selected' : ''}>${esc(v || 'alle')}</option>`;
        const cat = url.searchParams.get('category'), st = url.searchParams.get('status');
        return send(200, page('Leads', `<form class="row card" method="get">
          <input name="q" placeholder="Suche Name/Ort" value="${esc(url.searchParams.get('q') ?? '')}">
          <select name="category">${['', 'HOT', 'HIGH POTENTIAL', 'MEDIUM', 'LOW', 'IGNORE', 'RECHECK'].map((v) => opt(v, cat)).join('')}</select>
          <select name="status">${['', 'NEW', 'QUALIFIED', 'IGNORED', 'RECHECK', 'CONTACTED', 'INTERESTED'].map((v) => opt(v, st)).join('')}</select>
          <button>Filtern</button><span class="grow"></span><small>${leads.length} Leads</small></form>
          ${leads.map((l) => `<div class="card row"><span class="badge ${esc(String(l.category ?? '').replace(' ', '-'))}">${esc(l.category ?? '–')}</span>
            <a class="t" href="/lead/${esc(l.id)}">${esc(l.company_name)}</a><small>${esc(l.city ?? '')}</small>
            <span class="grow"></span>${l.paused ? '<small>⏸ pausiert</small>' : ''}<small>${esc(l.status)}</small><b>${l.score ?? '–'}</b></div>`).join('') || '<p>Noch keine Leads. Import per CLI: <code>node src/cli.ts analyze datei.csv --save</code></p>'}`, killSwitch));
      }
      const m = path.match(/^\/lead\/([0-9a-f-]{36})$/);
      if (m) {
        const d = await repo.getLead(m[1]);
        if (!d) return send(404, page('Nicht gefunden', '<p>Lead nicht gefunden.</p>', killSwitch));
        const { lead: l, opportunity: o, findings, sales: s, events } = d;
        return send(200, page(l.company_name, `<div class="card"><div class="row"><h2 style="margin:0">${esc(l.company_name)}</h2><span class="badge ${esc(String(o?.category ?? '').replace(' ', '-'))}">${esc(o?.category ?? '–')}</span><b>${o?.score ?? '–'}</b><span class="grow"></span><small>${esc(l.status)}${l.paused ? ' · ⏸ pausiert' : ''}</small></div>
          <p><small>${esc(l.address ?? '')} ${esc(l.city ?? '')} · Tel ${esc(l.phone ?? '–')} · Web ${esc(l.website_url ?? '–')} · Quelle ${esc(l.source)} · zuletzt analysiert ${fmt(l.last_analyzed_at)}</small></p>
          <div class="row">${l.paused ? post(`/lead/${l.id}/resume`, 'Fortsetzen', '', 'ok') : post(`/lead/${l.id}/pause`, 'Pausieren')}
          ${post(`/lead/${l.id}/reanalyze`, 'Neu analysieren (Retry)')}${post(`/lead/${l.id}/reject`, 'Ablehnen', '', 'danger')}</div></div>
          <div class="card"><b>Warum interessant?</b><p>${esc(o?.why ?? 'Noch nicht bewertet.')}</p>
          ${o?.factors?.length ? `<table>${o.factors.map((f: any) => `<tr><td>${esc(f.reason)}</td><td>+${f.points}</td></tr>`).join('')}</table>` : ''}</div>
          ${findings.length ? `<div class="card"><b>Befunde mit Beleg</b><ul>${findings.map((f: any) => `<li>${esc(f.summary)}<br><small>Beleg: ${esc(f.evidence)}</small></li>`).join('')}</ul></div>` : ''}
          ${s ? `<div class="card"><b>Verkaufsgrundlage</b><p>${esc(s.chance)}<br>Angebot: <b>${esc(s.offer_name)}</b>, ${eur(s.price_cents)}</p>
            <form method="post" action="/lead/${l.id}/edit"><input type="hidden" name="csrf" value="${csrf}">
            <p><b>Gesprächseinstieg</b> (${esc(s.opener_source)}) – ${s.approved_at ? `<span style="color:#2f9e44">freigegeben ${fmt(s.approved_at)}</span>` : '<span style="color:#b25e09">noch nicht freigegeben</span>'}</p>
            <textarea name="opener" rows="4">${esc(s.opener)}</textarea><p><button>Änderung speichern (erfordert neue Freigabe)</button></p></form>
            ${s.approved_at ? '' : post(`/lead/${l.id}/approve`, 'Freigeben', '', 'ok')}
            <p class="manual">Manuelle Kontaktaufnahme erforderlich – es wird nichts automatisch gesendet.</p></div>` : ''}
          <div class="card"><b>Verlauf</b><table>${events.map((e: any) => `<tr><td><small>${fmt(e.created_at)}</small></td><td>${esc(e.type)}</td><td><small>${esc(e.payload?.reason ?? e.payload?.actor ?? '')}</small></td></tr>`).join('')}</table></div>`, killSwitch));
      }
      if (path === '/settings') {
        const [{ limits }, scoring, sup, evs] = await Promise.all([repo.getLimits(), repo.getScoringConfig(cfgJson('scoring.json')), repo.listSuppression(), repo.recentEvents()]);
        const num = (n: string, v: number) => `<label>${n}<br><input type="number" min="0" name="${n}" value="${v}"></label>`;
        return send(200, page('Einstellungen', `<div class="card"><b>Budget-Limits</b><form method="post" action="/settings/limits"><input type="hidden" name="csrf" value="${csrf}">
          <div class="row">${Object.entries(limits).map(([k, v]) => num(k, v)).join('')}</div><p><small>Tages-/Monatsbudget in Cent.</small></p><button>Speichern</button></form></div>
          <div class="card"><b>Score-Gewichte</b><form method="post" action="/settings/weights"><input type="hidden" name="csrf" value="${csrf}">
          <div class="row">${Object.entries(scoring.weights).map(([k, v]) => num(k, v as number)).join('')}</div><p><button>Speichern</button></p></form></div>
          <div class="card"><b>Sperrliste (Opt-out)</b><form class="row" method="post" action="/settings/suppression"><input type="hidden" name="csrf" value="${csrf}">
          <select name="kind"><option>email</option><option>phone</option><option>domain</option><option>company</option></select><input name="value" required placeholder="Wert"><button>Hinzufügen</button></form>
          <table>${sup.map((s: any) => `<tr><td>${esc(s.kind)}</td><td>${esc(s.value)}</td></tr>`).join('')}</table></div>
          <div class="card"><b>Letzte Ereignisse</b><table>${evs.map((e: any) => `<tr><td><small>${fmt(e.created_at)}</small></td><td>${esc(e.type)}</td><td>${esc(e.company_name ?? '')}</td></tr>`).join('')}</table></div>`, killSwitch));
      }
      return send(404, page('Nicht gefunden', '<p>Seite nicht gefunden.</p>', killSwitch));
    }

    if (req.method === 'POST') {
      const given = Buffer.from(form.get('csrf') ?? ''), want = Buffer.from(csrf);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return send(403, page('Verboten', '<p class="err">Ungültiges Formular-Token.</p>', killSwitch));
      if (path === '/killswitch') { await repo.setKillSwitch(form.get('on') === '1'); return back(req.headers.referer && new URL(req.headers.referer).host === req.headers.host ? new URL(req.headers.referer).pathname : '/'); }
      if (path === '/settings/limits') {
        const cur = (await repo.getLimits()).limits;
        const next = Object.fromEntries(Object.keys(cur).map((k) => [k, Number(form.get(k))])) as typeof cur;
        await repo.saveLimits(next); return back('/settings');
      }
      if (path === '/settings/weights') {
        const base = await repo.getScoringConfig(cfgJson('scoring.json'));
        const weights = Object.fromEntries(Object.keys(base.weights).map((k) => [k, Number(form.get(k))]));
        await repo.saveScoringConfig({ ...base, weights }); return back('/settings');
      }
      if (path === '/settings/suppression') {
        const kind = form.get('kind') ?? '', value = form.get('value') ?? '';
        if (!['email', 'phone', 'domain', 'company'].includes(kind) || !value.trim()) throw new Error('Ungültiger Eintrag');
        await repo.addSuppression(kind, value); return back('/settings');
      }
      const m = path.match(/^\/lead\/([0-9a-f-]{36})\/(pause|resume|reject|reanalyze|approve|edit)$/);
      if (m) {
        const [, id, act] = m;
        if (act === 'pause') await repo.setPaused(id, true);
        else if (act === 'resume') await repo.setPaused(id, false);
        else if (act === 'reject') await repo.setStatus(id, 'IGNORED' as Status, 'Manuell abgelehnt');
        else if (act === 'approve') await repo.approveSales(id);
        else if (act === 'edit') await repo.editOpener(id, form.get('opener') ?? '');
        else if (act === 'reanalyze') {
          if (killSwitch) throw new Error('Kill Switch ist aktiv');
          const lead = await rowToLead(id);
          const { limits } = await repo.getLimits();
          const out = await runPipeline([lead], { fetchSite: fetcher, scoring: await repo.getScoringConfig(cfgJson('scoring.json')), pricing: cfgJson('pricing.json'), budget: new Budget(limits),
            onReport: async (r) => { await repo.saveReport(r, null); } });
          if (out.stoppedReason) throw new Error(out.stoppedReason);
        }
        return back(`/lead/${id}`);
      }
      return send(404, page('Nicht gefunden', '<p>Unbekannte Aktion.</p>', killSwitch));
    }
    res.writeHead(405); res.end();
  }

  return http.createServer(async (req, res) => {
    if (!authOk(req)) { res.writeHead(401, { 'www-authenticate': 'Basic realm="Agency OS"' }); return void res.end('Anmeldung erforderlich'); }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let body = '';
      if (req.method === 'POST') { for await (const chunk of req) { body += chunk; if (body.length > 100_000) throw new Error('Anfrage zu groß'); } }
      await handle(req, res, url, new URLSearchParams(body));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) { res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${STYLE}</style><main><p class="err">${esc(msg)}</p><p><a href="javascript:history.back()">Zurück</a></p></main>`); }
    }
  });
}
