import type { Route } from '../types.ts';
import { html, raw, categoryBadge, eur, fmt, prioBadge } from '../ui.ts';
import { render, hasPlaceholders, webNotice } from './_page.ts';

export const routes: Route[] = [{
  method: 'GET', path: /^\/$/, h: async (r) => {
    const { ctx } = r;
    const [queue, stages, overview, runs, top, tasks, settings] = await Promise.all([
      ctx.calls.queue(), ctx.analytics.stageCounts(), ctx.analytics.overview('all', ctx.now()), ctx.analytics.recentRuns(4),
      ctx.leads.list({ status: 'QUALIFIED', readiness: 'READY_FOR_MANUAL_CALL', limit: 5 }),
      ctx.repo.pool.query("select count(*)::int n from maintenance_tasks where owner_id=$1 and status='OPEN'", [ctx.repo.ownerId]).then((x) => x.rows[0].n as number),
      ctx.repo.getSettings(),
    ]);
    const areas = await Promise.all(([['now_work', 'Jetzt bearbeiten'], ['ready_contact', 'Bereit zum Kontakt'], ['call_today', 'Heute anrufen'], ['data_needed', 'Daten beschaffen'], ['demo_recommended', 'Demo empfohlen'], ['manual_check', 'Manuell prüfen']] as [string, string][]).map(async ([k, l]) => ({ k, l, n: (await ctx.leads.list({ quick: k, limit: 1 })).total })));
    const runRows = (await ctx.runs.list(6)) as any[]; const sizes = ctx.cfg.pipeline.sizes as Record<string, number>;
    const phoneLeads = (await ctx.leads.list({ quick: 'has_phone', limit: 1 })).total;
    const n = (s: string) => stages.get(s) ?? 0;
    const inProd = ['OFFER_ACCEPTED', 'DEPOSIT_PENDING', 'DEPOSIT_PAID', 'PRODUCTION', 'QA', 'CUSTOMER_REVIEW', 'APPROVED', 'FINAL_PAYMENT'].reduce((s, k) => s + n(k), 0);
    const todo: string[] = [];
    if (!settings.phoneEnabled) todo.push(`Telefon-Leads vorhanden (${phoneLeads}), Telefonakquise aber noch nicht aktiviert – ohne Freigabe in den Einstellungen bleibt „Heute anrufen“ leer.`);
    if (hasPlaceholders(ctx.cfg.agency)) todo.push('config/agency.json enthält noch Platzhalter (Agenturname, Kontakt).');
    if (hasPlaceholders(ctx.cfg.pricing.termsDraft) || hasPlaceholders(ctx.cfg.pricing.vatNote) || hasPlaceholders(ctx.cfg.pricing.offers)) todo.push('config/pricing.json enthält noch Platzhalter – Angebote lassen sich erst freigeben, wenn sie ersetzt sind.');
    return render(r, { title: 'Start', nav: 'home', body: html`
      ${todo.length ? html`<div class="warnbox"><b>Noch einzurichten</b><ul>${todo.map((t) => html`<li>${t}</li>`)}</ul></div>` : ''}
      ${webNotice(r)}
      <div class="card" id="neue-suche"><h2>Neue Suche</h2>
        <form method="post" action="/search"><input type="hidden" name="csrf" value="${r.app.csrf}"><input type="hidden" name="_form" value="1">
          <div class="row"><label class="grow">Ort / Region<input name="location" value="" placeholder="z. B. Saarbrücken" required maxlength="80"></label>
            <label>Radius in km<input name="radiusKm" type="number" min="1" max="200" value="10" style="width:110px" inputmode="numeric"></label></div>
          <label>Branche (eine oder mehrere, Strg/Cmd-Klick)<select name="sub" multiple size="6">${ctx.cfg.taxonomy.industries.map((ind) => html`<optgroup label="${ind.label}">${ind.subIndustries.map((x) => html`<option value="${x.key}">${x.label}</option>`)}</optgroup>`)}</select></label>
          <fieldset><legend>Suchgröße</legend><div class="row">${Object.entries(sizes).map(([k, n]) => html`<label class="inline" style="display:flex;gap:6px;align-items:center;min-height:44px"><input type="radio" name="size" value="${k}" ${k === 'SMALL' ? raw('checked') : ''}> <span><b>${k}</b> · bis ${n} Firmen</span></label>`)}</div></fieldset>
          <p class="row"><button class="primary">Leads suchen</button><a class="btn" href="/search">Detailsuche / Schnellsuche</a></p></form></div>
      <div class="card"><h2>Arbeitsbereiche</h2><div class="grid">${areas.map((a) => html`<a class="kpi" href="/leads?quick=${a.k}" style="text-decoration:none;color:inherit"><b>${a.n}</b><span>${a.l}</span></a>`)}</div></div>
      <div class="card"><h2>Letzte Suchläufe</h2>${runRows.length ? html`<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Ort</th><th>Branche</th><th>Größe</th><th>Status</th><th>Leads</th><th>Zeitpunkt</th><th>Kosten</th></tr></thead><tbody>${runRows.map((x) => html`<tr><td><a href="/search/run/${x.id}">${x.region ?? '–'}</a></td><td>${x.search_term ?? x.industry ?? '–'}</td><td>${x.size ?? '–'}</td><td>${x.status === 'DONE' ? 'abgeschlossen' : x.status === 'RUNNING' ? 'läuft' : x.status === 'FAILED' ? html`<span title="${x.error ?? ''}">fehlgeschlagen</span>` : x.status}</td><td>${x.found_count ?? x.counters?.analyzed ?? 0}</td><td>${fmt(x.created_at)}</td><td>${eur(Math.round(Number(x.costs?.total ?? 0)))}</td></tr>`)}</tbody></table></div>` : html`<p class="mute">Noch keine Suchläufe – oben „Leads suchen“.</p>`}</div>
      <div class="card"><h2>Beste Chancen (bereit für Anruf)</h2>
        ${top.rows.length ? html`<ul class="items">${top.rows.map((l) => html`<li><div class="row">${prioBadge(l.priority)}<a class="grow" href="/leads/${l.id}"><b>${l.company_name}</b> <small>${l.city ?? ''} · ${l.sub_industry ?? ''}</small></a><b>${l.score ?? '–'}</b> ${categoryBadge(l.category)}</div></li>`)}</ul>` : html`<p class="mute">Noch keine Leads bereit. Erst suchen${settings.phoneEnabled ? '' : ' und die Telefonakquise in den Einstellungen freigeben'}.</p>`}</div>
      <div class="card"><h2>Systemstatus</h2><p class="mute">${ctx.registry.status.map((s) => `${s.kind}: ${s.name}${s.mode === 'mock' ? ' (Mock)' : ''}`).join(' · ')}</p></div>
` });
  },
}];
