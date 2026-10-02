import type { Route } from '../types.ts';
import { UserError } from '../types.ts';
import { html, eur, fmtDate, postForm, postBtn } from '../ui.ts';
import { render, redirect, okFlash, uuid } from './_page.ts';
import { REQUEST_LABEL, type RequestStatus } from '../../customers/service.ts';

const id = uuid.source;
const wrap = async <T>(f: () => Promise<T>): Promise<T> => { try { return await f(); } catch (e) { throw new UserError(e instanceof Error ? e.message : String(e)); } };
const eurIn = (v: string | null) => { const t = (v ?? '').trim().replace(/\./g, '').replace(',', '.'); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? Math.round(n * 100) : null; };
const NEXT_BTN: Record<string, [string, string][]> = { NEW: [['IN_REVIEW', 'In Prüfung nehmen'], ['DECLINED', 'Ablehnen']], IN_REVIEW: [['DECLINED', 'Ablehnen']], APPROVED: [['IN_PROGRESS', 'In Arbeit'], ['DECLINED', 'Ablehnen']], IN_PROGRESS: [['DONE', 'Erledigt']], DONE: [], DECLINED: [] };

export const routes: Route[] = [
  { method: 'GET', path: /^\/customers$/, h: async (r) => {
    const [rows, pending, st] = await Promise.all([r.ctx.customers.list(), r.ctx.customers.ordersWithoutProfile(), r.ctx.customers.stats()]);
    return render(r, { title: 'Kunden', nav: 'customers', body: html`
      <div class="grid"><div class="kpi"><b>${st.customers}</b><span>aktive Kunden</span></div><div class="kpi"><b>${st.newRequests}</b><span>neue Änderungswünsche</span></div></div>
      ${pending.length ? html`<div class="card"><h2>Aufträge ohne Kundenprofil</h2><ul class="items">${pending.map((p: any) => html`<li><div class="row"><b class="grow">${p.company_name}</b><small>${p.city ?? ''}</small>${postBtn(r.app.csrf, `/customers/from-order/${p.order_id}`, 'Kundenprofil anlegen', { cls: 'primary' })}</div></li>`)}</ul></div>` : ''}
      <div class="card">${rows.length ? html`<div class="scroll"><table class="tbl"><tr><th>Kunde</th><th>Paket</th><th>Wartung</th><th>Status</th><th>Offene Wünsche</th></tr>${rows.map((c: any) => html`<tr><td><a href="/customers/${c.id}"><b>${c.company_name}</b></a></td><td>${c.package ?? 'nicht verfügbar'}</td><td>${c.care ?? 'keine'}</td><td>${c.status}</td><td>${c.open_requests}</td></tr>`)}</table></div>` : html`<p class="mute">Noch keine Kunden. Ein Kundenprofil entsteht aus einem vollständig bezahlten Auftrag.</p>`}</div>` });
  } },
  { method: 'POST', path: new RegExp(`^/customers/from-order/${id}$`), h: async (r) => { const cid = await wrap(() => r.ctx.customers.createFromOrder(r.params[0])); return redirect(`/customers/${cid}`, okFlash('Kundenprofil angelegt.')); } },
  { method: 'GET', path: new RegExp(`^/customers/${id}$`), h: async (r) => {
    const c = await r.ctx.customers.get(r.params[0]); if (!c) return render(r, { title: 'Nicht gefunden', nav: 'customers', status: 404, body: html`<p>Kunde nicht gefunden.</p>` });
    const [m, reqs] = await Promise.all([r.ctx.customers.maintenance(c.id), r.ctx.customers.requests(c.id)]);
    const portal = `${r.app.baseUrl}/c/${c.portal_token}`;
    return render(r, { title: c.company_name, nav: 'customers', body: html`
      <div class="card"><div class="row"><b class="grow">${c.company_name}</b><span class="badge b-ok">${c.status}</span><a class="btn" href="/leads/${c.lead_id}">Zum Lead</a>${c.order_id ? html`<a class="btn" href="/orders/${c.order_id}">Auftrag</a>` : ''}${c.partner_id ? html`<a class="btn" href="/partners/${c.partner_id}">Partner</a>` : ''}</div>
        <dl class="facts"><dt>Kunde seit</dt><dd>${fmtDate(c.customer_since)}</dd><dt>Paket</dt><dd>${c.package ?? 'nicht verfügbar'}</dd><dt>Website</dt><dd>${c.website_url ? html`<a href="${c.website_url}" target="_blank" rel="noopener noreferrer">${c.website_url}</a>` : 'nicht verfügbar'}</dd><dt>Domain</dt><dd>${c.domain ?? 'nicht verfügbar'}</dd><dt>Hosting</dt><dd>${c.hosting_note ?? 'nicht verfügbar'}</dd></dl></div>
      <div class="card" id="wartung"><h2>Wartung</h2>${m && (m.plan || m.careLabel) ? html`<div class="grid"><div class="kpi"><b>${m.careLabel ?? 'nicht verfügbar'}</b><span>Wartungspaket</span></div><div class="kpi"><b>${m.start ? fmtDate(m.start) : 'nicht gestartet'}</b><span>Start</span></div><div class="kpi"><b>${eur(m.monthlyCents)}</b><span>pro Monat</span></div><div class="kpi"><b>${m.nextBilling ? fmtDate(m.nextBilling) : 'nicht verfügbar'}</b><span>nächste Abrechnung</span></div>
          <div class="kpi"><b>${m.includedChanges === null ? 'nicht verfügbar' : `${m.usedChanges} / ${m.includedChanges}`}</b><span>Änderungen diesen Monat (inklusive)</span></div></div>
          ${m.includes.length ? html`<p class="mute">Enthalten: ${m.includes.join(', ')}</p>` : ''}<small class="mute">Abrechnung und Zahlungseinzug laufen nicht automatisch aus dieser Seite; Preise sind Entwurfspreise (INTERNAL_DRAFT_PRICE).</small>` : html`<p class="mute">Kein Wartungsvertrag.</p>`}</div>
      <div class="card" id="aenderungen"><h2>Änderungswünsche</h2>${reqs.length ? html`<ul class="items">${reqs.map((q: any) => html`<li><div class="row"><b class="grow">${q.title}</b><span class="badge">${REQUEST_LABEL[q.status as RequestStatus]}</span><small>${q.source === 'portal' ? 'vom Kunden' : 'manuell'} · ${fmtDate(q.created_at)}</small></div>${q.detail ? html`<p>${q.detail}</p>` : ''}
          <small class="mute">${q.scope === 'IN_PLAN' ? 'im Wartungspaket enthalten' : q.scope === 'EXTRA' ? `Extra-Aufwand: ${eur(q.extra_price_cents)} (separates Angebot nötig)` : 'noch nicht zugeordnet'}</small>
          ${q.status === 'IN_REVIEW' ? postForm(r.app.csrf, `/customers/requests/${q.id}/status`, html`<input type="hidden" name="to" value="APPROVED"><div class="row"><select name="scope"><option value="IN_PLAN">Im Wartungspaket enthalten</option><option value="EXTRA">Extra-Aufwand</option></select><input name="price" placeholder="Extra-Preis € (nur bei Extra)" inputmode="decimal"><button class="primary">Freigeben</button></div>`, { style: 'display:block' }) : ''}
          <div class="row">${(NEXT_BTN[q.status] ?? []).map(([to, label]) => postBtn(r.app.csrf, `/customers/requests/${q.id}/status`, label, { hidden: { to } }))}</div></li>`)}</ul>` : html`<p class="mute">Keine Änderungswünsche.</p>`}
        ${postForm(r.app.csrf, `/customers/${c.id}/request`, html`<div class="row"><input name="title" placeholder="Neuer Änderungswunsch (z. B. Öffnungszeiten)" maxlength="200" required class="grow"><button>Anlegen</button></div>`, { style: 'display:block' })}</div>
      <div class="card" id="portal"><h2>Kundenportal (Link)</h2><p>Der Kunde sieht nur Firmenname, Website, Wartungspaket und seine eigenen Änderungswünsche. <b>Der Link wird nicht automatisch versendet</b> – du entscheidest, ob und wie du ihn weitergibst.</p>
        <p><code>${portal}</code></p><div class="row"><a class="btn" href="/c/${c.portal_token}" target="_blank" rel="noopener noreferrer">Portal ansehen</a>${postBtn(r.app.csrf, `/customers/${c.id}/portal-token`, 'Link erneuern (alter Link wird ungültig)')}</div></div>
      <div class="card"><h2>Kontakt und Notizen</h2>${postForm(r.app.csrf, `/customers/${c.id}`, html`<label>Ansprechpartner<input name="contact_name" value="${c.contact_name ?? ''}" maxlength="200"></label><label>Telefon<input name="phone" value="${c.phone ?? ''}" maxlength="60"></label><label>E-Mail<input name="email" value="${c.email ?? ''}" maxlength="200"></label><label>Domain<input name="domain" value="${c.domain ?? ''}" maxlength="200"></label><label>Hosting-Notiz<input name="hosting_note" value="${c.hosting_note ?? ''}" maxlength="500"></label>
        <label>Status<select name="status">${['ACTIVE', 'PAUSED', 'ENDED'].map((s) => html`<option value="${s}" ${c.status === s ? 'selected' : ''}>${s}</option>`)}</select></label><label>Notizen<textarea name="notes" maxlength="20000">${c.notes ?? ''}</textarea></label><button class="primary">Speichern</button>`, { style: 'display:block' })}</div>` });
  } },
  { method: 'POST', path: new RegExp(`^/customers/${id}$`), h: async (r) => { await wrap(() => r.ctx.customers.update(r.params[0], Object.fromEntries(r.form))); return redirect(`/customers/${r.params[0]}`, okFlash('Gespeichert.')); } },
  { method: 'POST', path: new RegExp(`^/customers/${id}/portal-token$`), h: async (r) => { await r.ctx.customers.rotatePortalToken(r.params[0]); return redirect(`/customers/${r.params[0]}#portal`, okFlash('Neuer Portal-Link erzeugt.')); } },
  { method: 'POST', path: new RegExp(`^/customers/${id}/request$`), h: async (r) => {
    const rid = await wrap(() => r.ctx.customers.addRequest(r.params[0], r.form.get('title'), r.form.get('detail')));
    await r.ctx.taskEngine.create({ type: 'CUSTOMER_REQUEST', title: `Änderungswunsch prüfen: ${String(r.form.get('title')).slice(0, 80)}`, dueAt: r.ctx.now(), priority: 'NORMAL', customerId: r.params[0], source: 'system' }).catch(() => null); void rid;
    return redirect(`/customers/${r.params[0]}#aenderungen`, okFlash('Änderungswunsch angelegt.')); } },
  { method: 'POST', path: new RegExp(`^/customers/requests/${id}/status$`), h: async (r) => {
    await wrap(() => r.ctx.customers.setRequestStatus(r.params[0], r.form.get('to') ?? '', { scope: r.form.get('scope') ?? undefined, extraPriceCents: eurIn(r.form.get('price')) }));
    const row = (await r.ctx.repo.pool.query('select customer_id from customer_requests where id = $1 and owner_id = $2', [r.params[0], r.ctx.repo.ownerId])).rows[0];
    return redirect(`/customers/${row.customer_id}#aenderungen`, okFlash('Status geändert (dem Kunden wird nichts gesendet).')); } },
];
