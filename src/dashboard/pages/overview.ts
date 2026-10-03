import type { Route } from '../types.ts';
import { html, eur, fmtDate, ORDER_LABEL } from '../ui.ts';
import { render } from './_page.ts';
import { OFFER_LABEL, type OfferStatus } from '../../offers/flow.ts';
import { REQUEST_LABEL, type RequestStatus } from '../../customers/service.ts';
import { ADMIN_NAV, navFor } from '../nav.ts';
import { referralTable } from './partners.ts';

/** Übersichtslisten, die in der Navigation verlinkt sind (Angebote, Referrals, Produktion, Änderungswünsche) und die Seitenübersicht. */
export const routes: Route[] = [
  { method: 'GET', path: /^\/offers$/, h: async (r) => {
    const rows = (await r.ctx.repo.pool.query(`select o.id, o.status, o.price_cents, o.created_at, o.lead_id, l.company_name from offers o join leads l on l.id = o.lead_id where o.owner_id = $1 order by o.created_at desc limit 200`, [r.ctx.repo.ownerId])).rows;
    return render(r, { title: 'Angebote', nav: 'sales', body: html`<div class="card">${rows.length ? html`<div class="scroll"><table class="tbl"><tr><th>Firma</th><th>Status</th><th>Preis</th><th>Erstellt</th></tr>${rows.map((o: any) => html`<tr><td><a href="/offers/${o.id}">${o.company_name}</a></td><td>${OFFER_LABEL[o.status as OfferStatus] ?? o.status}</td><td>${eur(o.price_cents)}</td><td>${fmtDate(o.created_at)}</td></tr>`)}</table></div>` : html`<p class="mute">Noch keine Angebote. Angebote entstehen auf der Lead-Seite im Reiter ANGEBOT.</p>`}</div>` });
  } },
  { method: 'GET', path: /^\/referrals$/, h: async (r) => {
    const rows = await r.ctx.partners.referrals({}); return render(r, { title: 'Referrals', nav: 'partners', body: html`<div class="note">Empfehlungen werden nie automatisch weitergegeben: Datenprüfung, Rechtsgrundlage und deine Bestätigung sind Pflicht.</div><div class="card">${referralTable(rows, r.app.csrf)}</div>` });
  } },
  { method: 'GET', path: /^\/production$/, h: async (r) => {
    const rows = (await r.ctx.repo.pool.query(`select o.id, o.status, o.lead_id, l.company_name, l.city from orders o join leads l on l.id = o.lead_id where o.owner_id = $1 and o.status in ('PAYMENT_PENDING','DEPOSIT_PAID','IN_PRODUCTION','QA','CUSTOMER_REVIEW','APPROVED','FINAL_PAYMENT_PENDING','FULLY_PAID') order by o.created_at desc`, [r.ctx.repo.ownerId])).rows;
    return render(r, { title: 'Produktion', nav: 'customers', body: html`<div class="card">${rows.length ? html`<ul class="items">${rows.map((o: any) => html`<li><div class="row"><a class="grow" href="/orders/${o.id}"><b>${o.company_name}</b> <small>${o.city ?? ''}</small></a><span class="badge">${ORDER_LABEL[o.status] ?? o.status}</span></div></li>`)}</ul>` : html`<p class="mute">Keine Aufträge in Produktion.</p>`}</div>` });
  } },
  { method: 'GET', path: /^\/customers\/requests$/, h: async (r) => {
    const rows = (await r.ctx.repo.pool.query(`select q.*, c.company_name from customer_requests q join customers c on c.id = q.customer_id where q.owner_id = $1 order by (q.status in ('NEW','IN_REVIEW')) desc, q.created_at desc limit 200`, [r.ctx.repo.ownerId])).rows;
    return render(r, { title: 'Änderungswünsche', nav: 'customers', body: html`<div class="card">${rows.length ? html`<ul class="items">${rows.map((q: any) => html`<li><div class="row"><a class="grow" href="/customers/${q.customer_id}#aenderungen"><b>${q.company_name}</b>: ${q.title}</a><span class="badge">${REQUEST_LABEL[q.status as RequestStatus]}</span></div></li>`)}</ul>` : html`<p class="mute">Keine Änderungswünsche.</p>`}</div>` });
  } },
  { method: 'GET', path: /^\/menu$/, h: async (r) => {
    const { groups, flat } = navFor(r.user.role);
    return render(r, { title: 'Alle Seiten', nav: 'menu', body: html`<p class="mute">Alle Bereiche auf einen Blick.</p>${(flat ? [{ group: 'MEIN ARBEITSPLATZ', items: flat }] : groups).map((g: any) => html`<div class="card"><h2>${g.group}</h2><ul class="items">${g.items.map((i: any) => html`<li><a class="btn" href="${i.href}" style="display:flex">${i.label}</a></li>`)}</ul></div>`)}` });
  } },
];
void ADMIN_NAV;
