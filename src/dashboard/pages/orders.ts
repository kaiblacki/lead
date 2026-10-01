import type { Route } from '../types.ts';
import { UserError } from '../types.ts';
import { html, raw, eur, fmt, fmtDate, postBtn, postForm, statusBadge, ORDER_LABEL, PLAN_LABEL, PAY_STATE_LABEL } from '../ui.ts';
import { render, redirect, okFlash, uuid } from './_page.ts';
import { allTemplates } from '../../site/templates.ts';
import { STAGE_LABEL, type Status } from '../../core/status.ts';
import type { Kind } from '../../orders/service.ts';
import type { ProjectContent } from '../../orders/service.ts';
import { loadConfig } from '../../core/config.ts';

const id = uuid.source;
const FLOW: Status[] = ['OFFER_ACCEPTED', 'DEPOSIT_PENDING', 'DEPOSIT_PAID', 'PRODUCTION', 'QA', 'CUSTOMER_REVIEW', 'APPROVED', 'FINAL_PAYMENT', 'DEPLOYED', 'MAINTENANCE'];
const PAY_LABEL: Record<string, string> = { deposit: 'Anzahlung', final: 'Restzahlung', maintenance: 'Wartung (Abo)' };
const servicesToText = (s: ProjectContent['services']) => s.map((x) => `${x.title} | ${x.text}`).join('\n');
const textToServices = (t: string) => t.split('\n').map((l) => l.split('|')).filter((p) => p.length >= 2).map((p) => ({ title: p[0].trim(), text: p.slice(1).join('|').trim() }));

export const routes: Route[] = [
  { method: 'GET', path: /^\/orders$/, h: async (r) => {
    const rows = (await r.ctx.repo.pool.query(`select o.id, o.status, o.deposit_cents, o.final_cents, o.maintenance_cents, o.created_at, l.id as lead_id, l.company_name, l.status as lead_status,
        (select coalesce(sum(amount_cents),0)::int from payments p where p.order_id=o.id and p.status='paid' and p.kind in ('deposit','final')) as paid
      from orders o join leads l on l.id=o.lead_id where o.owner_id=$1 order by o.created_at desc limit 200`, [r.ctx.repo.ownerId])).rows;
    return render(r, { title: 'Aufträge', nav: 'orders', body: html`
      <div class="card">${rows.length ? html`<ul class="items">${rows.map((o) => html`<li><div class="row"><a class="grow" href="/orders/${o.id}"><b>${o.company_name}</b><br><small>${fmtDate(o.created_at)} · ${eur(o.deposit_cents + o.final_cents)} einmalig · bezahlt ${eur(o.paid)}</small></a>${statusBadge(o.lead_status)}</div><small class="mute">Auftragsstatus: ${ORDER_LABEL[o.status] ?? o.status}</small></li>`)}</ul>` : html`<p class="mute">Noch keine Aufträge. Sie entstehen, wenn ein Angebot angenommen wird (Anruf-Ergebnis „Gekauft“ oder Schaltfläche am Lead).</p>`}</div>` });
  } },

  { method: 'GET', path: new RegExp(`^/orders/${id}$`), h: async (r) => {
    const { ctx } = r; const orderId = r.params[0];
    const order = await ctx.orders.getOrder(orderId);
    if (!order) return render(r, { title: 'Nicht gefunden', nav: 'orders', status: 404, body: html`<p>Auftrag nicht gefunden.</p>` });
    const [lead, pays, project, build, changes, deps, plan] = await Promise.all([
      ctx.leads.rowToEntry(order.lead_id), ctx.orders.payments(orderId), ctx.delivery.getProject(orderId), ctx.delivery.latestBuild(orderId), ctx.delivery.openChangeRequests(orderId),
      ctx.repo.pool.query('select * from deployments where order_id=$1 and owner_id=$2 order by created_at desc limit 3', [orderId, ctx.repo.ownerId]).then((x) => x.rows), ctx.maintenance.planFor(orderId),
    ]);
    const st = order.status as string, leadSt = lead.status as Status;
    const idx = FLOW.indexOf(leadSt);
    const c: ProjectContent | null = project?.content ?? null;
    const isMockPay = ctx.registry.providers.payments.isMock;
    const f = (n: string, v: unknown, label: string, extra = '') => html`<label>${label}<input name="${n}" value="${v ?? ''}" ${raw(extra)}></label>`;
    const issues: any[] = build?.qa_issues ?? [];
    const payBtn = (kind: Kind, label: string, when: string) => (st === when ? postBtn(r.app.csrf, `/orders/${orderId}/checkout/${kind}`, label) : '');
    return render(r, { title: `Auftrag: ${lead.company_name}`, nav: 'orders', body: html`
      <div class="card"><div class="row"><a href="/leads/${lead.id}" class="grow"><b>${lead.company_name}</b></a>${statusBadge(leadSt)}<span class="badge">Auftrag: ${ORDER_LABEL[st] ?? st}</span></div>
        <div class="stepper">${FLOW.map((s, i) => html`<span class="step ${s === leadSt ? 'now' : i < idx ? 'done' : ''}">${STAGE_LABEL[s]}</span>`)}</div>
        <p>${eur(order.deposit_cents)} Anzahlung + ${eur(order.final_cents)} Restzahlung · Wartung ${eur(order.maintenance_cents)}/Monat</p></div>

      <div class="card"><h2>Zahlungen</h2>
        ${pays.length ? html`<table>${pays.map((p: any) => html`<tr><td>${PAY_LABEL[p.kind]}</td><td>${eur(p.amount_cents)}</td><td><span class="badge ${p.status === 'paid' ? 'b-ok' : p.status === 'pending' ? 'b-warn' : 'b-bad'}">${PAY_STATE_LABEL[p.status] ?? p.status}</span></td>
          <td>${p.status === 'pending' && p.checkout_url ? html`<a href="${p.checkout_url}" target="_blank" rel="noopener noreferrer">Zahlungslink</a>` : ''}${p.status === 'pending' && isMockPay ? postBtn(r.app.csrf, `/payments/${p.id}/simulate`, `${PAY_LABEL[p.kind]} bezahlt (Simulation)`, { cls: 'warn' }) : ''}</td></tr>`)}</table>` : html`<p class="mute">Noch keine Zahlungslinks.</p>`}
        <div class="row">${payBtn('deposit', 'Anzahlungs-Link erstellen', 'PAYMENT_PENDING')}${payBtn('final', 'Restzahlungs-Link erstellen', 'FINAL_PAYMENT_PENDING')}${payBtn('maintenance', 'Wartungs-Abo-Link erstellen', 'DEPLOYED')}</div>
        <small class="mute">${isMockPay ? 'Mock-Zahlung: Der Link führt auf eine lokale Testseite. „Bezahlt (Simulation)“ löst denselben Ablauf aus wie ein echter Stripe-Webhook.' : 'Zahlungen laufen über Stripe; Bestätigung per Webhook.'} Reihenfolge ist erzwungen: keine Produktion ohne Anzahlung, keine Veröffentlichung ohne Restzahlung.</small></div>

      ${project ? html`<div class="card"><h2>Projektdaten</h2>
        <details ${st === 'IN_PRODUCTION' ? raw('open') : ''}><summary>Inhalte bearbeiten</summary>
        <form method="post" action="/orders/${orderId}/project"><input type="hidden" name="csrf" value="${r.app.csrf}">
          ${f('companyName', c!.companyName, 'Firmenname')}${f('tagline', c!.tagline, 'Überschrift (optional)')}${f('phone', c!.phone, 'Telefon')}${f('email', c!.email, 'E-Mail')}${f('address', c!.address, 'Straße, Nr.')}${f('postalCode', c!.postalCode, 'PLZ')}${f('city', c!.city, 'Ort')}
          <label>Öffnungszeiten<textarea name="openingHours" rows="3">${c!.openingHours ?? ''}</textarea></label>
          <label>Über uns (vom Kunden bestätigter Text)<textarea name="about" rows="4">${c!.about ?? ''}</textarea></label>
          <label>Leistungen (eine pro Zeile: Titel | Text)<textarea name="services" rows="5">${servicesToText(c!.services)}</textarea></label>
          ${f('bookingUrl', c!.bookingUrl, 'Buchungs-Link (https://…, optional)')}
          ${f('legalOwner', c!.legal.owner, 'Impressum: Inhaber/Geschäftsführer')}${f('vatId', c!.legal.vatId, 'USt-IdNr. (optional)')}${f('register', c!.legal.register, 'Registereintrag (optional)')}${f('hosting', c!.legal.hosting, 'Hosting-Anbieter (für Datenschutz)')}
          <label>Vorlage<select name="template">${allTemplates().map((t) => html`<option value="${t.key}" ${t.key === project.template ? raw('selected') : ''}>${t.label}</option>`)}</select></label>
          <label class="inline"><input type="checkbox" name="legalConfirmed" value="1" ${project.legal_confirmed ? raw('checked') : ''}> Impressum und Datenschutz wurden von mir rechtlich geprüft</label>
          <p><button class="primary">Speichern</button></p></form></details>
        <small class="mute">Beispieltexte aus der Vorlage bleiben als „Beispiel“ erkennbar – die QA lässt die Seite erst durch, wenn echte Inhalte eingetragen sind.</small></div>` : ''}

      <div class="card"><h2>Produktion und QA</h2>
        <div class="row">${st === 'IN_PRODUCTION' || st === 'QA' ? postBtn(r.app.csrf, `/orders/${orderId}/build`, 'Produzieren + QA', { cls: 'primary' }) : ''}${build ? html`<a class="btn" href="/orders/${orderId}/preview/index.html" target="_blank" rel="noopener noreferrer">Vorschau öffnen</a>` : ''}</div>
        ${build ? html`<p><b>Build v${build.version}</b> – QA ${build.qa_passed ? html`<span class="badge b-ok">bestanden</span>` : html`<span class="badge b-bad">nicht bestanden</span>`} · ${fmt(build.created_at)}</p>
          ${issues.length ? html`<div class="scroll"><table>${issues.map((i) => html`<tr><td>${i.severity === 'error' ? '⛔' : '⚠️'}</td><td>${i.file}</td><td>${i.message}</td></tr>`)}</table></div>` : ''}` : html`<p class="mute">Noch nicht gebaut.</p>`}
        ${st === 'CUSTOMER_REVIEW' && order.review_token ? html`<div class="note"><b>Kunden-Link zur Freigabe</b><br><code>${r.app.baseUrl}/r/${order.review_token}</code><br><a href="/r/${order.review_token}" target="_blank" rel="noopener noreferrer">Kundenansicht öffnen</a></div>` : ''}
        ${changes.length ? html`<h3>Änderungswünsche des Kunden</h3><ul class="items">${changes.map((x: any) => html`<li>${x.note} <small>(${fmt(x.decided_at)})</small><br><span class="badge ${x.change_status === 'APPLIED' ? 'b-ok' : x.change_status === 'MANUAL' ? 'b-warn' : 'b-info'}">${x.change_status === 'APPLIED' ? 'umgesetzt' : x.change_status === 'MANUAL' ? 'manuell nötig' : 'offen'}</span>
          ${(x.change_unclear ?? []).length ? html`<small class="mute"> Unklar: ${(x.change_unclear as string[]).join(' | ')}</small>` : ''}
          ${x.change_status !== 'APPLIED' && st === 'IN_PRODUCTION' ? postBtn(r.app.csrf, `/reviews/${x.id}/process`, 'Automatisch umsetzen (KI)') : ''}</li>`)}</ul>` : ''}</div>

      <div class="card"><h2>E-Mail an den Kunden</h2>
        ${postForm(r.app.csrf, `/orders/${orderId}/mail`, html`<div class="row"><label>Was senden?<select name="what"><option value="deposit">Anzahlungs-Link</option><option value="final">Restzahlungs-Link</option><option value="maintenance">Wartungs-Abo-Link</option><option value="review">Freigabe-Link (Vorschau)</option><option value="deployed">Seite ist online</option></select></label>
          <label class="grow">An<input type="email" name="to" value="${c?.email ?? ''}" maxlength="200" placeholder="kunde@beispiel.de" required></label></div>
          <p class="row"><button class="primary">${isMockPay && ctx.registry.providers.email.isMock ? 'In Postausgang legen (Mock)' : 'E-Mail senden'}</button><a class="btn" href="/outbox">Postausgang</a></p>`, { style: 'display:block' })}
        <small class="mute">Wird nur gesendet, wenn du auf den Knopf drückst. Adressen auf der Sperrliste werden abgelehnt.</small></div>

      <div class="card"><h2>Veröffentlichung und Wartung</h2>
        ${st === 'FULLY_PAID' ? postBtn(r.app.csrf, `/orders/${orderId}/deploy`, 'Veröffentlichen', { cls: 'ok' }) : html`<p class="mute">Veröffentlichung erst nach bestätigter Restzahlung.${r.app.autoDeploy ? ' (Auto-Deploy aktiv)' : ''}</p>`}
        ${deps.map((d: any) => html`<p>Veröffentlicht (${d.adapter}): ${/^https?:/.test(d.url) ? html`<a href="${d.url}" target="_blank" rel="noopener noreferrer">${d.url}</a>` : d.url} <small>${fmt(d.created_at)}</small></p>`)}
        ${plan ? html`<p><a class="btn" href="/maintenance/${orderId}">Wartung öffnen</a> <span class="badge ${plan.status === 'ACTIVE' ? 'b-ok' : 'b-warn'}">${PLAN_LABEL[plan.status] ?? plan.status}</span></p>` : ''}</div>` });
  } },

  { method: 'POST', path: new RegExp(`^/orders/${id}/checkout/(deposit|final|maintenance)$`), h: async (r) => {
    const project = await r.ctx.delivery.getProject(r.params[0]);
    const res = await r.ctx.orders.startCheckout(r.params[0], r.params[1] as Kind, r.ctx.registry.providers.payments, r.app.baseUrl, project?.content?.email);
    return redirect(`/orders/${r.params[0]}`, okFlash(`${PAY_LABEL[r.params[1]]}-Link ${res.reused ? 'wiederverwendet' : 'erstellt'}: ${res.url}`));
  } },
  { method: 'POST', path: new RegExp(`^/payments/${id}/simulate$`), h: async (r) => {
    const p = (await r.ctx.repo.pool.query('select order_id, kind from payments where id=$1 and owner_id=$2', [r.params[0], r.ctx.repo.ownerId])).rows[0];
    if (!p) throw new UserError('Zahlung nicht gefunden');
    const out = await r.ctx.orders.simulatePayment(r.params[0], r.ctx.registry.providers.payments);
    if (out.handled === 'paid' && out.kind === 'final' && r.app.autoDeploy) { try { await r.ctx.delivery.deploy(out.orderId!, r.ctx.registry.providers.hosting); } catch { /* manuell möglich */ } }
    return redirect(`/orders/${p.order_id}`, okFlash(`${PAY_LABEL[p.kind]} bezahlt (Simulation) – Ablauf läuft weiter.`));
  } },
  { method: 'POST', path: new RegExp(`^/orders/${id}/mail$`), h: async (r) => {
    const what = r.form.get('what') as 'deposit' | 'final' | 'maintenance' | 'review' | 'deployed';
    if (!['deposit', 'final', 'maintenance', 'review', 'deployed'].includes(what)) throw new UserError('Bitte auswählen, was gesendet werden soll.');
    const res = await r.ctx.notifier.sendOrderMail(r.params[0], what, r.form.get('to') ?? '');
    return redirect(`/orders/${r.params[0]}`, res.ok ? okFlash(res.status === 'sent' ? 'E-Mail wurde gesendet.' : 'Mock-Modus: E-Mail im Postausgang aufgezeichnet (nicht verschickt).') : { kind: 'err', text: `Senden fehlgeschlagen: ${res.error}` });
  } },
  { method: 'POST', path: new RegExp(`^/orders/${id}/project$`), h: async (r) => {
    const cur = (await r.ctx.delivery.getProject(r.params[0]))?.content as ProjectContent | undefined;
    if (!cur) throw new UserError('Projekt nicht gefunden (Anzahlung noch nicht eingegangen?)');
    const g = (k: string) => r.form.get(k) ?? '';
    await r.ctx.delivery.saveProject(r.params[0], { companyName: g('companyName'), tagline: g('tagline'), phone: g('phone'), email: g('email'), address: g('address'), postalCode: g('postalCode'), city: g('city'), industryLabel: cur.industryLabel,
      openingHours: g('openingHours'), about: g('about'), bookingUrl: g('bookingUrl'), services: textToServices(g('services')), legal: { owner: g('legalOwner'), vatId: g('vatId'), register: g('register'), hosting: g('hosting') } }, r.form.get('legalConfirmed') === '1', g('template') || undefined);
    return redirect(`/orders/${r.params[0]}`, okFlash('Projektdaten gespeichert.'));
  } },
  { method: 'POST', path: new RegExp(`^/orders/${id}/build$`), h: async (r) => {
    const out = await r.ctx.delivery.build(r.params[0], { actor: 'user' });
    return redirect(`/orders/${r.params[0]}`, out.passed ? okFlash(`Build v${out.version}: QA bestanden – Kundenfreigabe bereit.${out.fixed.length ? ` (${out.fixed.length} Fehler automatisch korrigiert)` : ''}`) : { kind: 'err', text: `Build v${out.version}: QA nicht bestanden (${out.issues.filter((i) => i.severity === 'error').length} Fehler). Details unten.` });
  } },
  { method: 'POST', path: new RegExp(`^/reviews/${id}/process$`), h: async (r) => {
    const rv = (await r.ctx.repo.pool.query('select order_id from reviews where id=$1 and owner_id=$2', [r.params[0], r.ctx.repo.ownerId])).rows[0];
    if (!rv) throw new UserError('Änderungswunsch nicht gefunden');
    const gateway = { complete: (leadKey: string, req: Parameters<typeof r.ctx.registry.providers.ai.complete>[0]) => r.ctx.registry.providers.ai.complete(req) };
    const out = await r.ctx.delivery.processChange(r.params[0], gateway);
    return redirect(`/orders/${rv.order_id}`, out.status === 'APPLIED' ? okFlash(`Änderung umgesetzt. ${out.build?.passed ? 'Neue Vorschau ist bereit.' : 'QA nicht bestanden – bitte Fehler prüfen.'}`) : { kind: 'err', text: `Nicht automatisch umsetzbar: ${out.unclear.join(' | ')}` });
  } },
  { method: 'POST', path: new RegExp(`^/orders/${id}/deploy$`), h: async (r) => {
    const out = await r.ctx.delivery.deploy(r.params[0], r.ctx.registry.providers.hosting);
    return redirect(`/orders/${r.params[0]}`, okFlash(`Veröffentlicht: ${out.url}`));
  } },
  { method: 'GET', path: new RegExp(`^/orders/${id}/preview/([\\w.\\-]+)$`), h: async (r) => {
    const build = await r.ctx.delivery.latestBuild(r.params[0]);
    const body = build?.files?.[r.params[1]];
    if (body === undefined) return { status: 404, body: 'Keine Vorschau vorhanden', type: 'text/plain; charset=utf-8' };
    return { body, type: r.params[1].endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8', headers: { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'", 'x-robots-tag': 'noindex' } };
  } },
];
void loadConfig;
