import type { Route } from '../types.ts';
import { UserError } from '../types.ts';
import { html, raw, eur, fmt, fmtDate, postBtn, postForm, PLAN_LABEL } from '../ui.ts';
import { render, redirect, okFlash, uuid } from './_page.ts';

const id = uuid.source;

export const routes: Route[] = [
  { method: 'GET', path: /^\/maintenance$/, h: async (r) => {
    const plans = await r.ctx.maintenance.list();
    const due = plans.filter((p) => p.status === 'ACTIVE' && new Date(p.next_check_at) <= r.ctx.now()).length;
    return render(r, { title: 'Wartung', nav: 'maintenance', body: html`
      <div class="card"><div class="row"><span class="grow">${plans.length} Wartungsverträge · ${due} Prüfung(en) fällig</span>${postBtn(r.app.csrf, '/maintenance/run', 'Fällige Prüfungen ausführen', { cls: 'primary' })}</div>
        <small class="mute">Geprüft werden: erreichbar, HTTPS, Ladezeit, Impressum/Datenschutz, Kontaktlinks, interne Seiten. Bei Problemen entstehen automatisch Aufgaben.</small></div>
      ${plans.length ? plans.map((p) => { const lc = p.last_check; const errs: string[] = lc && !lc.ok ? [lc.details?.error, ...(lc.details?.legalMissing ?? []), ...(lc.details?.brokenPages ?? [])].filter(Boolean) : [];
        return html`<a class="card" href="/maintenance/${p.order_id}" style="display:block;text-decoration:none;color:inherit"><div class="row"><b class="grow">${p.company_name}</b><span class="badge ${p.status === 'ACTIVE' ? 'b-ok' : 'b-warn'}">${PLAN_LABEL[p.status] ?? p.status}</span></div>
          <p class="mute">${p.site_url ?? '–'}</p>
          <div class="grid"><div class="kpi"><b>${eur(p.monthly_cents)}</b><span>pro Monat</span></div><div class="kpi"><b>${fmtDate(p.next_check_at)}</b><span>nächste Prüfung</span></div><div class="kpi"><b>${lc ? (lc.ok ? '✅' : '⚠️') : '–'}</b><span>letzte Prüfung ${lc ? fmtDate(lc.created_at) : ''}</span></div><div class="kpi"><b>${p.open_tasks}</b><span>offene Aufgaben</span></div></div>
          ${errs.length ? html`<div class="errbox">Fehler: ${errs.join(', ')}</div>` : ''}</a>`; })
        : html`<div class="card"><p class="mute">Noch keine aktiven Wartungsverträge. Sie entstehen nach der Veröffentlichung, sobald das Wartungs-Abo bezahlt ist.</p></div>`}` });
  } },
  { method: 'GET', path: new RegExp(`^/maintenance/${id}$`), h: async (r) => {
    const orderId = r.params[0];
    const d = await r.ctx.maintenance.get(orderId);
    if (!d) return render(r, { title: 'Nicht gefunden', nav: 'maintenance', status: 404, body: html`<p>Kein Wartungsplan für diesen Auftrag.</p>` });
    const rep = await r.ctx.maintenance.report(orderId, 30);
    const p = d.plan; const mock = r.ctx.registry.mockHosting;
    const slug = p.site_url?.match(/\/hosted\/([^/]+)\//)?.[1];
    return render(r, { title: `Wartung: ${p.company_name}`, nav: 'maintenance', body: html`
      <div class="card"><div class="row"><b class="grow">${p.company_name}</b><span class="badge ${p.status === 'ACTIVE' ? 'b-ok' : 'b-warn'}">${PLAN_LABEL[p.status] ?? p.status}</span></div>
        <p>${p.site_url ? html`<a href="${p.site_url}" target="_blank" rel="noopener noreferrer">${p.site_url}</a>` : '–'} · ${eur(p.monthly_cents)}/Monat · Prüfintervall ${p.interval_days} Tage</p>
        <p class="mute">Nächste Prüfung: ${fmt(p.next_check_at)} · letzte: ${fmt(p.last_check_at)}</p>
        <div class="row">${postBtn(r.app.csrf, `/maintenance/${orderId}/check`, 'Jetzt prüfen', { cls: 'primary' })}${p.status === 'ACTIVE' ? postBtn(r.app.csrf, `/maintenance/${orderId}/plan`, 'Pausieren', { hidden: { status: 'PAUSED' } }) : postBtn(r.app.csrf, `/maintenance/${orderId}/plan`, 'Aktivieren', { hidden: { status: 'ACTIVE' }, cls: 'ok' })}${postBtn(r.app.csrf, `/maintenance/${orderId}/plan`, 'Kündigen', { hidden: { status: 'CANCELED' }, cls: 'danger' })}
          <a class="btn" href="/orders/${orderId}">Auftrag</a></div></div>
      <div class="card"><h2>Monatsbericht (letzte ${rep.days} Tage)</h2><div class="grid"><div class="kpi"><b>${rep.uptimePct === null ? '–' : `${String(rep.uptimePct).replace('.', ',')} %`}</b><span>Verfügbarkeit</span></div><div class="kpi"><b>${rep.checks}</b><span>Prüfungen</span></div><div class="kpi"><b>${rep.failures}</b><span>mit Problemen</span></div><div class="kpi"><b>${rep.doneTasks.length}</b><span>Aufgaben erledigt</span></div></div></div>
      <div class="card"><h2>Offene Aufgaben</h2>${d.tasks.filter((t: any) => t.status === 'OPEN').length ? html`<ul class="items">${d.tasks.filter((t: any) => t.status === 'OPEN').map((t: any) => html`<li><div class="row"><div class="grow"><b>${t.title}</b> <span class="badge">${t.source}</span><br><small class="mute">${t.detail ?? ''} · ${fmt(t.created_at)}</small></div>${postBtn(r.app.csrf, `/maintenance/tasks/${t.id}/done`, 'Erledigt', { cls: 'ok' })}</div></li>`)}</ul>` : html`<p class="mute">Keine offenen Aufgaben.</p>`}
        ${postForm(r.app.csrf, `/maintenance/${orderId}/task`, html`<div class="row"><input name="title" placeholder="Neue Aufgabe (z. B. Öffnungszeiten ändern)" maxlength="200" required class="grow"><button>Hinzufügen</button></div>`, { style: 'display:block' })}</div>
      <div class="card"><h2>Prüfungen</h2><ul class="items">${d.checks.map((c: any) => html`<li>${c.ok ? '✅' : '⚠️'} <small>${fmt(c.created_at)}</small> ${c.details.up ? `erreichbar (${c.details.loadMs ?? '?'} ms)` : `nicht erreichbar: ${c.details.error ?? ''}`}${c.details.legalMissing?.length ? ` · fehlt: ${c.details.legalMissing.join(', ')}` : ''}${c.details.brokenPages?.length ? ` · defekt: ${c.details.brokenPages.join(', ')}` : ''}</li>`)}</ul>${!d.checks.length ? html`<p class="mute">Noch keine Prüfung.</p>` : ''}</div>
      ${mock ? html`<div class="card"><h2>Mock-Werkzeuge</h2><p class="mute">Nur im Mock-Modus: Ausfall der „veröffentlichten“ Seite und Abo-Probleme simulieren.</p>
        <div class="row">${slug ? postBtn(r.app.csrf, `/maintenance/${orderId}/mock-down`, mock.isDown(slug) ? 'Ausfall beenden' : 'Ausfall simulieren', { hidden: { slug, down: mock.isDown(slug) ? '0' : '1' } }) : ''}${postBtn(r.app.csrf, `/maintenance/${orderId}/mock-sub`, 'Abo-Zahlung fehlgeschlagen', { hidden: { reason: 'payment_failed' } })}${postBtn(r.app.csrf, `/maintenance/${orderId}/mock-sub`, 'Abo gekündigt', { hidden: { reason: 'canceled' } })}</div></div>` : ''}${raw('')}` });
  } },
  { method: 'POST', path: /^\/maintenance\/run$/, h: async (r) => { const out = await r.ctx.maintenance.runDue(); return redirect('/maintenance', okFlash(`${out.checked} Prüfung(en) ausgeführt, ${out.failed} mit Problemen.`)); } },
  { method: 'POST', path: new RegExp(`^/maintenance/${id}/check$`), h: async (r) => { const out = await r.ctx.maintenance.checkNow(r.params[0]); return redirect(`/maintenance/${r.params[0]}`, out.ok ? okFlash('Prüfung: alles in Ordnung.') : { kind: 'err', text: `Prüfung: ${out.tasks.join(', ')}` }); } },
  { method: 'POST', path: new RegExp(`^/maintenance/${id}/plan$`), h: async (r) => { const s = r.form.get('status'); if (s !== 'ACTIVE' && s !== 'PAUSED' && s !== 'CANCELED') throw new UserError('Ungültiger Status'); await r.ctx.maintenance.setPlanStatus(r.params[0], s); return redirect(`/maintenance/${r.params[0]}`, okFlash(`Wartungsplan: ${s}`)); } },
  { method: 'POST', path: new RegExp(`^/maintenance/${id}/task$`), h: async (r) => { await r.ctx.maintenance.addTask(r.params[0], r.form.get('title') ?? ''); return redirect(`/maintenance/${r.params[0]}`, okFlash('Aufgabe angelegt.')); } },
  { method: 'POST', path: new RegExp(`^/maintenance/tasks/${id}/done$`), h: async (r) => { const orderId = await r.ctx.maintenance.completeTask(r.params[0]); return redirect(`/maintenance/${orderId}`, okFlash('Aufgabe erledigt.')); } },
  { method: 'POST', path: new RegExp(`^/maintenance/${id}/mock-down$`), h: async (r) => { const m = r.ctx.registry.mockHosting; if (!m) throw new UserError('Nur im Mock-Modus.'); m.setDown(r.form.get('slug') ?? '', r.form.get('down') === '1'); return redirect(`/maintenance/${r.params[0]}`, okFlash(r.form.get('down') === '1' ? 'Ausfall simuliert – jetzt „Jetzt prüfen“.' : 'Ausfall beendet.')); } },
  { method: 'POST', path: new RegExp(`^/maintenance/${id}/mock-sub$`), h: async (r) => { const reason = r.form.get('reason'); if (reason !== 'canceled' && reason !== 'payment_failed') throw new UserError('Ungültig'); await r.ctx.orders.simulateSubscriptionProblem(r.params[0], reason, r.ctx.registry.providers.payments); return redirect(`/maintenance/${r.params[0]}`, okFlash('Abo-Ereignis simuliert.')); } },
];
