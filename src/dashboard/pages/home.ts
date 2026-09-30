import type { Route } from '../types.ts';
import { html, categoryBadge, eur, fmt, prioBadge } from '../ui.ts';
import { render, hasPlaceholders } from './_page.ts';

export const routes: Route[] = [{
  method: 'GET', path: /^\/$/, h: async (r) => {
    const { ctx } = r;
    const [queue, stages, overview, runs, top, tasks, settings] = await Promise.all([
      ctx.calls.queue(), ctx.analytics.stageCounts(), ctx.analytics.overview('all', ctx.now()), ctx.analytics.recentRuns(4),
      ctx.leads.list({ status: 'QUALIFIED', readiness: 'READY_FOR_MANUAL_CALL', limit: 5 }),
      ctx.repo.pool.query("select count(*)::int n from maintenance_tasks where owner_id=$1 and status='OPEN'", [ctx.repo.ownerId]).then((x) => x.rows[0].n as number),
      ctx.repo.getSettings(),
    ]);
    const n = (s: string) => stages.get(s) ?? 0;
    const inProd = ['OFFER_ACCEPTED', 'DEPOSIT_PENDING', 'DEPOSIT_PAID', 'PRODUCTION', 'QA', 'CUSTOMER_REVIEW', 'APPROVED', 'FINAL_PAYMENT'].reduce((s, k) => s + n(k), 0);
    const todo: string[] = [];
    if (!settings.phoneEnabled) todo.push('Telefonakquise ist nicht freigegeben: Ohne Freigabe (Einstellungen) bleiben Leads auf „Manuell prüfen“ und die Anrufliste ist leer.');
    if (hasPlaceholders(ctx.cfg.agency)) todo.push('config/agency.json enthält noch Platzhalter (Agenturname, Kontakt).');
    if (hasPlaceholders(ctx.cfg.pricing.termsDraft) || hasPlaceholders(ctx.cfg.pricing.vatNote) || hasPlaceholders(ctx.cfg.pricing.offers)) todo.push('config/pricing.json enthält noch Platzhalter – Angebote lassen sich erst freigeben, wenn sie ersetzt sind.');
    return render(r, { title: 'Start', nav: 'home', body: html`
      ${todo.length ? html`<div class="warnbox"><b>Noch einzurichten</b><ul>${todo.map((t) => html`<li>${t}</li>`)}</ul></div>` : ''}
      <div class="grid">
        <a class="kpi" href="/calls" style="text-decoration:none;color:inherit"><b>${queue.done} / ${queue.target}</b><span>Calls heute erledigt</span></a>
        <a class="kpi" href="/calls" style="text-decoration:none;color:inherit"><b>${queue.open}</b><span>noch in der Anrufliste</span></a>
        <a class="kpi" href="/leads?status=QUALIFIED" style="text-decoration:none;color:inherit"><b>${n('QUALIFIED')}</b><span>qualifizierte Leads</span></a>
        <a class="kpi" href="/orders" style="text-decoration:none;color:inherit"><b>${inProd}</b><span>Aufträge in Arbeit</span></a>
        <a class="kpi" href="/maintenance" style="text-decoration:none;color:inherit"><b>${tasks}</b><span>offene Wartungsaufgaben</span></a>
        <a class="kpi" href="/analytics" style="text-decoration:none;color:inherit"><b>${eur(overview.mrrCents)}</b><span>wiederkehrend / Monat</span></a>
      </div>
      <div class="card"><div class="row"><h2 class="grow">Nächste Schritte</h2></div>
        <div class="row"><a class="btn primary" href="/search">Neue Suche</a><a class="btn" href="/calls">Meine heutigen Calls</a><a class="btn" href="/pipeline">Pipeline</a></div></div>
      <div class="card"><h2>Beste Chancen (bereit für Anruf)</h2>
        ${top.rows.length ? html`<ul class="items">${top.rows.map((l) => html`<li><div class="row">${prioBadge(l.priority)}<a class="grow" href="/leads/${l.id}"><b>${l.company_name}</b> <small>${l.city ?? ''} · ${l.sub_industry ?? ''}</small></a><b>${l.score ?? '–'}</b> ${categoryBadge(l.category)}</div></li>`)}</ul>` : html`<p class="mute">Noch keine Leads bereit. Erst suchen${settings.phoneEnabled ? '' : ' und die Telefonakquise in den Einstellungen freigeben'}.</p>`}</div>
      <div class="card"><h2>Letzte Suchläufe</h2>${runs.length ? html`<ul class="items">${runs.map((x) => html`<li><a href="/search/run/${x.id}"><b>${x.description}</b></a><br><small>${fmt(x.created_at)} · ${x.status} · ${x.counters?.matched ?? 0} Treffer von ${x.counters?.analyzed ?? 0} analysiert</small></li>`)}</ul>` : html`<p class="mute">Noch keine Suche gestartet.</p>`}</div>
      <div class="card"><h2>Systemstatus</h2><p class="mute">${ctx.registry.status.map((s) => `${s.kind}: ${s.name}${s.mode === 'mock' ? ' (Mock)' : ''}`).join(' · ')}</p></div>
` });
  },
}];
