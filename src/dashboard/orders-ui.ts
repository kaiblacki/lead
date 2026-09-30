import http from 'node:http';
import type { Repo } from '../db/repo.ts';
import { OrderService, type Kind, type ProjectContent } from '../orders/service.ts';
import { DeliveryService } from '../orders/delivery.ts';
import type { PaymentProvider } from '../payments/provider.ts';
import type { Deployer } from '../deploy/adapters.ts';
import type { fetchSite } from '../auditor/fetch.ts';
import { TEMPLATES, GENERIC } from '../templates/index.ts';
import { eur } from '../ai/sales.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (d: unknown) => (d ? new Date(d as string).toLocaleString('de-DE') : '–');

export type OrdersCtx = {
  repo: Repo; orders: OrderService; delivery: DeliveryService; csrf: string; baseUrl: string;
  payments?: () => PaymentProvider; deployer?: () => Deployer; fetcher?: typeof fetchSite; autoDeploy?: boolean;
};

export function createOrdersCtx(repo: Repo, o: Omit<OrdersCtx, 'repo' | 'orders' | 'delivery' | 'csrf'>, csrf: string): OrdersCtx {
  const orders = new OrderService(repo);
  return { ...o, repo, orders, delivery: new DeliveryService(orders), csrf };
}

const btn = (ctx: OrdersCtx, action: string, label: string, cls = '', extra = '') =>
  `<form method="post" action="${action}" style="display:inline"><input type="hidden" name="csrf" value="${ctx.csrf}">${extra}<button class="${cls}">${label}</button></form>`;

const servicesToText = (s: ProjectContent['services']) => s.map((x) => `${x.title} | ${x.text}`).join('\n');
const textToServices = (t: string) => t.split('\n').map((l) => l.split('|')).filter((p) => p.length >= 2).map((p) => ({ title: p[0].trim(), text: p.slice(1).join('|').trim() }));

export async function renderOrderSection(ctx: OrdersCtx, leadId: string, offer: any): Promise<string> {
  const order = await ctx.orders.orderForLead(leadId);
  if (!order) {
    return `<div class="card"><b>Bestellung</b>${offer?.status === 'SENT'
      ? `<p>Angebot wurde versendet. Wenn der Kunde zusagt, Bestellung anlegen und Anzahlungs-Link erzeugen.</p>${btn(ctx, `/lead/${leadId}/order`, 'Bestellung anlegen')}`
      : '<p><small>Erst nach versendetem Angebot möglich.</small></p>'}</div>`;
  }
  const [pays, project, build, changes, deps, checks] = await Promise.all([
    ctx.orders.payments(order.id), ctx.delivery.getProject(order.id), ctx.delivery.latestBuild(order.id), ctx.delivery.openChangeRequests(order.id),
    ctx.repo.pool.query('select * from deployments where order_id=$1 and owner_id=$2 order by created_at desc limit 3', [order.id, ctx.repo.ownerId]).then((r) => r.rows),
    ctx.repo.pool.query('select * from maintenance_checks where order_id=$1 and owner_id=$2 order by created_at desc limit 3', [order.id, ctx.repo.ownerId]).then((r) => r.rows),
  ]);
  const st = order.status as string;
  const payBtn = (kind: Kind, label: string, when: string) => (st === when ? btn(ctx, `/order/${order.id}/checkout/${kind}`, label) : '');
  const c: ProjectContent | null = project?.content ?? null;
  const field = (n: string, v: unknown, label: string) => `<label>${label}<br><input name="${n}" value="${esc(v ?? '')}" style="width:100%;box-sizing:border-box"></label>`;
  const form = project ? `<details><summary><b>Projektdaten bearbeiten</b></summary>
    <form method="post" action="/order/${order.id}/project"><input type="hidden" name="csrf" value="${ctx.csrf}">
    ${field('companyName', c!.companyName, 'Firmenname')}${field('tagline', c!.tagline, 'Überschrift (optional)')}
    ${field('phone', c!.phone, 'Telefon')}${field('email', c!.email, 'E-Mail')}${field('address', c!.address, 'Straße, Nr.')}${field('city', c!.city, 'PLZ Ort')}
    <label>Öffnungszeiten<br><textarea name="openingHours" rows="3">${esc(c!.openingHours ?? '')}</textarea></label>
    <label>Über uns (vom Kunden bestätigter Text)<br><textarea name="about" rows="4">${esc(c!.about ?? '')}</textarea></label>
    <label>Leistungen (eine pro Zeile: Titel | Text)<br><textarea name="services" rows="5">${esc(servicesToText(c!.services))}</textarea></label>
    ${field('bookingUrl', c!.bookingUrl, 'Buchungs-Link (https://…, optional)')}
    ${field('legalOwner', c!.legal.owner, 'Impressum: Inhaber/Geschäftsführer')}${field('vatId', c!.legal.vatId, 'USt-IdNr. (optional)')}${field('register', c!.legal.register, 'Registereintrag (optional)')}${field('hosting', c!.legal.hosting, 'Hosting-Anbieter (für Datenschutz)')}
    <label>Vorlage <select name="template">${[...TEMPLATES, GENERIC].map((t) => `<option value="${t.key}"${t.key === project.template ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label>
    <p><label><input type="checkbox" name="legalConfirmed" value="1"${project.legal_confirmed ? ' checked' : ''} style="min-height:auto"> Impressum und Datenschutz wurden von mir rechtlich geprüft</label></p>
    <button>Speichern</button></form></details>` : '';
  const issues: any[] = build?.qa_issues ?? [];
  return `<div class="card"><b>Bestellung</b> – <span class="badge">${esc(st)}</span>
    <table>${pays.map((p: any) => `<tr><td>${esc(p.kind)}</td><td>${eur(p.amount_cents)}</td><td>${esc(p.status)}</td><td>${p.status === 'pending' && p.checkout_url ? `<a href="${esc(p.checkout_url)}" target="_blank" rel="noopener noreferrer">Zahlungslink</a>` : ''}</td></tr>`).join('')}</table>
    <div class="row">${payBtn('deposit', 'Anzahlungs-Link erstellen', 'PAYMENT_PENDING')}${payBtn('final', 'Restzahlungs-Link erstellen', 'FINAL_PAYMENT_PENDING')}${payBtn('maintenance', 'Wartungs-Link (Abo) erstellen', 'DEPLOYED')}
    ${st === 'IN_PRODUCTION' ? btn(ctx, `/order/${order.id}/build`, 'Produzieren + QA') : ''}
    ${st === 'FULLY_PAID' ? btn(ctx, `/order/${order.id}/deploy`, 'Veröffentlichen', 'ok') : ''}
    ${st === 'DEPLOYED' || st === 'MAINTENANCE_ACTIVE' ? btn(ctx, `/order/${order.id}/maintenance-check`, 'Wartungscheck') : ''}</div>
    ${st === 'CUSTOMER_REVIEW' && order.review_token ? `<p>Kunden-Link zur Freigabe: <code>${esc(ctx.baseUrl)}/r/${esc(order.review_token)}</code></p>` : ''}
    ${changes.length ? `<div class="manual"><b>Änderungswünsche des Kunden</b><ul>${changes.map((x: any) => `<li>${esc(x.note)} <small>(${fmt(x.decided_at)})</small></li>`).join('')}</ul></div>` : ''}
    ${form}
    ${build ? `<p><b>Build v${build.version}</b> – QA ${build.qa_passed ? '<span style="color:#2f9e44">bestanden</span>' : '<span style="color:#c92a2a">nicht bestanden</span>'} · <a href="/order/${order.id}/preview/index.html" target="_blank" rel="noopener noreferrer">Vorschau</a></p>
      ${issues.length ? `<table>${issues.map((i) => `<tr><td>${i.severity === 'error' ? '⛔' : '⚠️'}</td><td>${esc(i.file)}</td><td>${esc(i.message)}</td></tr>`).join('')}</table>` : ''}` : ''}
    ${deps.map((d: any) => `<p><small>Veröffentlicht (${esc(d.adapter)}): ${esc(d.url)} · ${fmt(d.created_at)}</small></p>`).join('')}
    ${checks.map((k: any) => `<p><small>Wartungscheck ${fmt(k.created_at)}: ${k.ok ? '✅ in Ordnung' : '⚠️ Auffälligkeiten'} – ${esc(JSON.stringify(k.details))}</small></p>`).join('')}</div>`;
}

/** Verarbeitet POST-Aktionen der Bestell-Oberfläche. Gibt den Redirect-Pfad zurück oder null, wenn die Route nicht passt. */
export async function handleOrderPost(ctx: OrdersCtx, path: string, form: URLSearchParams): Promise<string | null> {
  let m = path.match(/^\/lead\/([0-9a-f-]{36})\/order$/);
  if (m) { await ctx.orders.createOrder(m[1]); return `/lead/${m[1]}`; }
  m = path.match(/^\/order\/([0-9a-f-]{36})\/(checkout\/(?:deposit|final|maintenance)|project|build|deploy|maintenance-check)$/);
  if (!m) return null;
  const [, id, act] = m;
  const order = await ctx.orders.getOrder(id);
  if (!order) throw new Error('Bestellung nicht gefunden');
  if (act.startsWith('checkout/')) {
    if (!ctx.payments) throw new Error('Stripe ist nicht konfiguriert (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET)');
    const project = await ctx.delivery.getProject(id);
    await ctx.orders.startCheckout(id, act.slice(9) as Kind, ctx.payments(), ctx.baseUrl, project?.content?.email);
  } else if (act === 'project') {
    const cur = (await ctx.delivery.getProject(id))?.content as ProjectContent | undefined;
    if (!cur) throw new Error('Projekt nicht gefunden');
    const g = (k: string) => form.get(k) ?? '';
    await ctx.delivery.saveProject(id, {
      companyName: g('companyName'), tagline: g('tagline'), phone: g('phone'), email: g('email'), address: g('address'), city: g('city'), industry: cur.industry,
      openingHours: g('openingHours'), about: g('about'), bookingUrl: g('bookingUrl'), services: textToServices(g('services')),
      legal: { owner: g('legalOwner'), vatId: g('vatId'), register: g('register'), hosting: g('hosting') },
    }, form.get('legalConfirmed') === '1', g('template') || undefined);
  } else if (act === 'build') {
    await ctx.delivery.build(id);
  } else if (act === 'deploy') {
    if (!ctx.deployer) throw new Error('Kein Deployment-Anbieter konfiguriert');
    await ctx.delivery.deploy(id, ctx.deployer());
  } else if (act === 'maintenance-check') {
    await ctx.delivery.maintenanceCheck(id, ctx.fetcher);
  }
  return `/lead/${order.lead_id}`;
}

const SITE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const MIME: Record<string, string> = { html: 'text/html; charset=utf-8', txt: 'text/plain; charset=utf-8', xml: 'application/xml' };

/** Dashboard-Vorschau des letzten Builds (nur angemeldet). */
export async function servePreview(ctx: OrdersCtx, res: http.ServerResponse, orderId: string, file: string): Promise<boolean> {
  const build = await ctx.delivery.latestBuild(orderId);
  const body = build?.files?.[file];
  if (body === undefined) return false;
  res.writeHead(200, { 'content-type': MIME[file.split('.').pop()!] ?? 'text/plain', 'content-security-policy': SITE_CSP, 'x-robots-tag': 'noindex', 'cache-control': 'no-store' });
  res.end(body);
  return true;
}

const PUBSTYLE = `body{font:16px system-ui;margin:0;background:#f5f6f8;color:#1b1f24}main{max-width:900px;margin:0 auto;padding:16px}iframe{width:100%;height:70vh;border:1px solid #ccc;border-radius:10px;background:#fff}
button{font:inherit;padding:12px 18px;border-radius:10px;border:1px solid #888;min-height:48px;cursor:pointer}.ok{background:#2f9e44;color:#fff;border-color:#2f9e44}textarea{width:100%;box-sizing:border-box;font:inherit;padding:10px;border-radius:10px}.card{background:#fff;border-radius:12px;padding:14px;margin:12px 0}`;
const shell = (title: string, body: string) => `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>${PUBSTYLE}</style><main>${body}</main></html>`;
const PUB_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; form-action 'self'; base-uri 'none'" };

/** Öffentliche Routen: Webhook und Kundenfreigabe. Gibt true zurück, wenn die Anfrage behandelt wurde. */
export async function handlePublic(ctx: OrdersCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://x');
  const readBody = async () => { let b = ''; for await (const ch of req) { b += ch; if (b.length > 200_000) throw new Error('Anfrage zu groß'); } return b; };
  const sendHtml = (status: number, html: string, h: Record<string, string> = PUB_HEADERS) => { res.writeHead(status, h); res.end(html); };

  if (req.method === 'POST' && url.pathname === '/webhooks/stripe') {
    if (!ctx.payments) { res.writeHead(503); res.end('Zahlungsanbieter nicht konfiguriert'); return true; }
    const raw = await readBody();
    try {
      const r = await ctx.orders.handleWebhook(raw, req.headers['stripe-signature'] as string | undefined, ctx.payments());
      if (r.handled === 'paid' && r.kind === 'final' && r.orderId && ctx.autoDeploy && ctx.deployer) {
        try { await ctx.delivery.deploy(r.orderId, ctx.deployer()); } catch { /* bleibt im Dashboard manuell ausführbar */ }
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ received: true, handled: r.handled }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(/Signatur/.test(msg) ? 400 : 500); res.end(msg);
    }
    return true;
  }

  const m = url.pathname.match(/^\/r\/([0-9a-f]{64})(?:\/(site\/[\w.\-]+|approve|changes))?$/);
  if (!m) {
    if (url.pathname === '/danke') { sendHtml(200, shell('Danke', '<h1>Vielen Dank!</h1><p>Ihre Zahlung wird verarbeitet. Sie erhalten eine Bestätigung von uns.</p>')); return true; }
    if (url.pathname === '/abgebrochen') { sendHtml(200, shell('Abgebrochen', '<h1>Zahlung abgebrochen</h1><p>Es wurde nichts abgebucht. Sie können den Zahlungslink erneut öffnen.</p>')); return true; }
    return false;
  }
  const [, token, sub] = m;
  const rv = await ctx.delivery.reviewByToken(token);
  if (!rv) { sendHtml(404, shell('Nicht gefunden', '<p>Dieser Link ist nicht gültig.</p>')); return true; }

  if (req.method === 'GET' && sub?.startsWith('site/')) {
    const body = rv.files[sub.slice(5)];
    if (body === undefined) { res.writeHead(404); res.end(); return true; }
    res.writeHead(200, { 'content-type': MIME[sub.split('.').pop()!] ?? 'text/plain', 'content-security-policy': SITE_CSP, 'x-robots-tag': 'noindex', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end(body); return true;
  }
  if (req.method === 'GET' && !sub) {
    const pending = rv.status === 'CUSTOMER_REVIEW' && rv.review_status === 'pending';
    sendHtml(200, shell('Ihre Website ist bereit', `<h1>Ihre Website ist bereit.</h1><p>Bitte prüfen Sie die Vorschau für <b>${esc(rv.company_name)}</b>.</p>
      <iframe src="/r/${token}/site/index.html" title="Vorschau Ihrer Website"></iframe>
      ${pending ? `<div class="card"><form method="post" action="/r/${token}/approve"><button class="ok">FREIGEBEN</button> <small>Danach folgt die Restzahlung. Erst nach Zahlung wird veröffentlicht.</small></form></div>
      <div class="card"><form method="post" action="/r/${token}/changes"><label>Änderung anfordern<br><textarea name="note" rows="4" required minlength="5" maxlength="2000" placeholder="Was soll geändert werden?"></textarea></label><p><button>ÄNDERUNG ANFORDERN</button></p></form></div>`
      : `<div class="card"><p>Status: ${rv.status === 'CUSTOMER_REVIEW' ? 'Entscheidung ausstehend' : 'Die Vorschau wurde bereits bearbeitet. Vielen Dank!'}</p></div>`}`));
    return true;
  }
  if (req.method === 'POST' && (sub === 'approve' || sub === 'changes')) {
    const origin = req.headers.origin ?? req.headers.referer;
    if (origin && new URL(origin).host !== req.headers.host) { res.writeHead(403); res.end('Ungültige Herkunft'); return true; }
    const form = new URLSearchParams(await readBody());
    try {
      const { orderId } = await ctx.delivery.decide(token, sub === 'approve' ? 'approve' : 'changes', form.get('note') ?? undefined);
      if (sub === 'approve' && ctx.payments) {
        try {
          const p = await ctx.orders.startCheckout(orderId, 'final', ctx.payments(), ctx.baseUrl);
          res.writeHead(303, { location: p.url, 'cache-control': 'no-store' }); res.end(); return true;
        } catch { /* Link wird vom Betreiber nachgereicht */ }
      }
      sendHtml(200, shell('Danke', sub === 'approve' ? '<h1>Danke für Ihre Freigabe!</h1><p>Sie erhalten die Zahlungsaufforderung für die Restzahlung von uns.</p>' : '<h1>Danke!</h1><p>Wir haben Ihren Änderungswunsch erhalten und melden uns mit einer neuen Vorschau.</p>'));
    } catch (e) {
      sendHtml(400, shell('Fehler', `<p>${esc(e instanceof Error ? e.message : String(e))}</p><p><a href="/r/${token}">Zurück</a></p>`));
    }
    return true;
  }
  res.writeHead(405); res.end(); return true;
}
