import type { Route } from '../types.ts';
import { UserError } from '../types.ts';
import { html, raw, esc } from '../html.ts';
import { eur } from '../ui.ts';
import { uuid } from './_page.ts';

const SITE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const PUB_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const MIME: Record<string, string> = { html: 'text/html; charset=utf-8', txt: 'text/plain; charset=utf-8', xml: 'application/xml', css: 'text/css' };
const NOINDEX = { 'x-robots-tag': 'noindex, nofollow, noarchive' };
const STYLE = `body{font:16px system-ui;margin:0;background:#f5f6f8;color:#1b1f24}main{max-width:900px;margin:0 auto;padding:16px}iframe{width:100%;height:70vh;border:1px solid #ccc;border-radius:10px;background:#fff}
button,.btn{font:inherit;padding:12px 18px;border-radius:10px;border:1px solid #888;min-height:48px;cursor:pointer;background:#fff;text-decoration:none;color:inherit;display:inline-flex;align-items:center}.ok{background:#2f9e44;color:#fff;border-color:#2f9e44}textarea{width:100%;box-sizing:border-box;font:inherit;padding:10px;border-radius:10px;min-height:96px}.card{background:#fff;border-radius:12px;padding:14px;margin:12px 0}.mock{background:#fff3cd;padding:8px 12px;border-radius:8px}`;
const shell = (title: string, body: unknown) => html`<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${title}</title><style>${raw(STYLE)}</style><main>${body}</main></html>`;
const pub = (body: unknown, status = 200) => ({ status, body: body as never, headers: { 'content-security-policy': PUB_CSP, ...NOINDEX } });

export const routes: Route[] = [
  // ---- Demo-Link
  { method: 'GET', public: true, path: /^\/d\/([0-9a-f]{64})$/, h: async (r) => {
    const body = await r.ctx.sales.getDemoByToken(r.params[0]);
    if (!body) return { status: 404, body: 'Nicht gefunden', type: 'text/plain; charset=utf-8', headers: NOINDEX };
    return { body, headers: { 'content-security-policy': SITE_CSP, ...NOINDEX, 'cache-control': 'no-store' } };
  } },

  // ---- Stripe/Mock-Webhook
  { method: 'POST', public: true, maxBody: 200_000, path: /^\/webhooks\/stripe$/, h: async (r) => {
    try {
      const out = await r.ctx.orders.handleWebhook(r.rawBody, r.req.headers['stripe-signature'] as string | undefined, r.ctx.registry.providers.payments);
      if (out.handled === 'paid' && out.kind === 'final' && out.orderId && r.app.autoDeploy) { try { await r.ctx.delivery.deploy(out.orderId, r.ctx.registry.providers.hosting); } catch { /* bleibt im Dashboard manuell ausführbar */ } }
      return { body: JSON.stringify({ received: true, handled: out.handled }), type: 'application/json' };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { status: /Signatur|signature/i.test(msg) ? 400 : 500, body: /Signatur/.test(msg) ? msg : 'Fehler', type: 'text/plain; charset=utf-8' };
    }
  } },

  // ---- Kundenfreigabe
  { method: 'GET', public: true, path: /^\/r\/([0-9a-f]{64})$/, h: async (r) => {
    const rv = await r.ctx.delivery.reviewByToken(r.params[0]);
    if (!rv) return pub(shell('Nicht gefunden', html`<p>Dieser Link ist nicht gültig.</p>`), 404);
    const t = r.params[0];
    const pending = rv.status === 'CUSTOMER_REVIEW' && rv.review_status === 'pending';
    const f = r.url.searchParams.get('msg');
    return pub(shell('Ihre Website ist bereit', html`<h1>Ihre Website ist bereit.</h1><p>Bitte prüfen Sie die Vorschau für <b>${rv.company_name}</b>.</p>
      ${f === 'changed' ? html`<div class="card" style="background:#d3f9d8">Ihre Änderung wurde umgesetzt. Bitte prüfen Sie die neue Vorschau.</div>` : f === 'received' ? html`<div class="card" style="background:#d3f9d8">Wir haben Ihren Änderungswunsch erhalten und melden uns mit einer neuen Vorschau.</div>` : ''}
      <iframe src="/r/${t}/site/index.html" title="Vorschau Ihrer Website"></iframe>
      ${pending ? html`<div class="card"><form method="post" action="/r/${t}/approve"><button class="ok">FREIGEBEN</button> <small>Danach folgt die Restzahlung. Erst nach Zahlung wird veröffentlicht.</small></form></div>
        <div class="card"><form method="post" action="/r/${t}/changes"><label>Änderung anfordern<br><textarea name="note" required minlength="5" maxlength="2000" placeholder="Was soll geändert werden?"></textarea></label><p><button>ÄNDERUNG ANFORDERN</button></p></form></div>`
        : html`<div class="card"><p>Status: ${rv.status === 'CUSTOMER_REVIEW' ? 'Entscheidung ausstehend' : 'Die Vorschau wurde bereits bearbeitet. Vielen Dank!'}</p></div>`}`));
  } },
  { method: 'GET', public: true, path: /^\/r\/([0-9a-f]{64})\/site\/([\w.\-]+)$/, h: async (r) => {
    const rv = await r.ctx.delivery.reviewByToken(r.params[0]);
    const body = rv?.files?.[r.params[1]];
    if (body === undefined) return { status: 404, body: '', type: 'text/plain' };
    return { body, type: MIME[r.params[1].split('.').pop()!] ?? 'text/plain', headers: { 'content-security-policy': SITE_CSP, ...NOINDEX, 'cache-control': 'no-store' } };
  } },
  { method: 'POST', public: true, path: /^\/r\/([0-9a-f]{64})\/approve$/, h: async (r) => {
    let res: { orderId: string };
    try { res = await r.ctx.delivery.decide(r.params[0], 'approve'); } catch (e) { return pub(shell('Fehler', html`<p>${e instanceof Error ? e.message : 'Fehler'}</p><p><a href="/r/${r.params[0]}">Zurück</a></p>`), 400); }
    try {
      const p = await r.ctx.orders.startCheckout(res.orderId, 'final', r.ctx.registry.providers.payments, r.app.baseUrl);
      return { redirect: p.url };
    } catch { return pub(shell('Danke', html`<h1>Danke für Ihre Freigabe!</h1><p>Sie erhalten die Zahlungsaufforderung für die Restzahlung von uns.</p>`)); }
  } },
  { method: 'POST', public: true, path: /^\/r\/([0-9a-f]{64})\/changes$/, h: async (r) => {
    let res: { orderId: string; reviewId: string };
    try { res = await r.ctx.delivery.decide(r.params[0], 'changes', r.form.get('note') ?? ''); } catch (e) { return pub(shell('Fehler', html`<p>${e instanceof Error ? e.message : 'Fehler'}</p><p><a href="/r/${r.params[0]}">Zurück</a></p>`), 400); }
    // Änderung speichern → Produktion zurücksetzen (passiert in decide) → KI setzt um → QA → neue Vorschau
    let applied = false;
    try {
      const gateway = { complete: (_k: string, req: Parameters<typeof r.ctx.registry.providers.ai.complete>[0]) => r.ctx.registry.providers.ai.complete(req) };
      const out = await r.ctx.delivery.processChange(res.reviewId, gateway);
      applied = out.status === 'APPLIED' && !!out.build?.passed;
    } catch { /* bleibt als offener Änderungswunsch im Dashboard */ }
    return { redirect: `/r/${r.params[0]}?msg=${applied ? 'changed' : 'received'}` };
  } },

  { method: 'GET', public: true, path: /^\/danke$/, h: async () => pub(shell('Danke', html`<h1>Vielen Dank!</h1><p>Ihre Zahlung wird verarbeitet. Sie erhalten eine Bestätigung von uns.</p>`)) },
  { method: 'GET', public: true, path: /^\/abgebrochen$/, h: async () => pub(shell('Abgebrochen', html`<h1>Zahlung abgebrochen</h1><p>Es wurde nichts abgebucht. Sie können den Zahlungslink erneut öffnen.</p>`)) },

  // ---- Mock-Zahlung (nur mit Mock-Provider)
  { method: 'GET', public: true, path: /^\/mock-pay\/(mock_cs_[0-9a-f]{24})$/, h: async (r) => {
    if (!r.ctx.registry.providers.payments.isMock) return { status: 404, body: 'Nicht gefunden', type: 'text/plain' };
    const p = (await r.ctx.repo.pool.query(`select p.id, p.kind, p.amount_cents, p.status, l.company_name from payments p join orders o on o.id=p.order_id join leads l on l.id=o.lead_id where p.provider_ref=$1 and p.owner_id=$2`, [r.params[0], r.ctx.repo.ownerId])).rows[0];
    if (!p) return pub(shell('Nicht gefunden', html`<p>Zahlung nicht gefunden.</p>`), 404);
    const label = { deposit: 'Anzahlung', final: 'Restzahlung', maintenance: 'Wartung (monatlich)' }[p.kind as 'deposit'];
    return pub(shell('Testzahlung', html`<div class="mock"><b>MOCK-CHECKOUT</b> – keine echte Zahlung. Es wird kein Geld bewegt.</div><h1>${label}: ${eur(p.amount_cents)}</h1><p>für ${p.company_name}</p>
      ${p.status === 'pending' ? html`<form method="post" action="/mock-pay/${r.params[0]}/complete"><button class="ok">Jetzt bezahlen (Simulation)</button></form>` : html`<p>Status: ${p.status}</p>`}`));
  } },
  { method: 'POST', public: true, path: /^\/mock-pay\/(mock_cs_[0-9a-f]{24})\/complete$/, h: async (r) => {
    if (!r.ctx.registry.providers.payments.isMock) return { status: 404, body: 'Nicht gefunden', type: 'text/plain' };
    const p = (await r.ctx.repo.pool.query("select id from payments where provider_ref=$1 and owner_id=$2 and status='pending'", [r.params[0], r.ctx.repo.ownerId])).rows[0];
    if (!p) throw new UserError('Keine offene Zahlung');
    const out = await r.ctx.orders.simulatePayment(p.id, r.ctx.registry.providers.payments);
    if (out.handled === 'paid' && out.kind === 'final' && r.app.autoDeploy) { try { await r.ctx.delivery.deploy(out.orderId!, r.ctx.registry.providers.hosting); } catch { /* manuell möglich */ } }
    return { redirect: '/danke' };
  } },

  // ---- Mock-Hosting: „veröffentlichte“ Seiten lokal ansehen
  { method: 'GET', public: true, path: /^\/hosted\/([a-z0-9-]+)\/?([\w.\-\/]*)$/, h: async (r) => {
    const m = r.ctx.registry.mockHosting;
    if (!m) return { status: 404, body: 'Nicht gefunden', type: 'text/plain' };
    if (m.isDown(r.params[0])) return { status: 503, body: 'Mock: Ausfall simuliert', type: 'text/plain; charset=utf-8' };
    const file = r.params[1] || 'index.html';
    const body = m.read(r.params[0], file);
    if (body === null) return { status: 404, body: 'Nicht gefunden', type: 'text/plain' };
    return { body, type: MIME[file.split('.').pop()!] ?? 'text/plain', headers: { 'content-security-policy': SITE_CSP } };
  } },
];
void uuid; void esc;
