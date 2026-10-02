import type { Route } from '../types.ts';
import { UserError } from '../types.ts';
import { html, raw, categoryBadge, fmt, prioBadge, readinessBadge, mockBadge, postBtn, postForm } from '../ui.ts';
import { render, redirect, okFlash, uuid, webNotice } from './_page.ts';
import { EXAMPLE_SEARCHES } from '../../search/examples.ts';
import { CriteriaError, EMPLOYEE_BUCKETS, READINESS, SORTS, WEBSITE_FILTERS, WEBSITE_LABEL, criteriaFromForm, normalizeCriteria, parseQuickSearch } from '../../search/criteria.ts';
import { leadsFromCsv } from '../../connectors/csv.ts';

const PHASE_LABEL: Record<string, string> = { queued: 'queued – wartet', discovering: 'discovering – Firmen werden gesucht', enriching: 'enriching – Daten werden ergänzt', analyzing: 'analyzing – Analyse läuft', complete: 'complete – abgeschlossen', partial: 'partial – teilweise (gestoppt)', failed: 'failed – fehlgeschlagen' };
const SIZE_LABEL: Record<string, string> = { SMALL: 'SMALL', MEDIUM: 'MEDIUM', LARGE: 'LARGE' };
const cents = (c: unknown) => `${(Number(c ?? 0) / 100).toFixed(2).replace('.', ',')} €`;
const SORT_LABEL: Record<string, string> = { sales_opportunity: 'Sales Opportunity', digital_need: 'Digital Need', distance: 'Entfernung', reviews: 'Bewertungen' };
const READY_LABEL: Record<string, string> = { READY_FOR_MANUAL_CALL: 'Bereit für Anruf', EMAIL_PERMISSION_REQUIRED: 'E-Mail: Einwilligung nötig', WHATSAPP_OPT_IN_REQUIRED: 'WhatsApp: Opt-in nötig', MANUAL_REVIEW: 'Manuell prüfen', DO_NOT_CONTACT: 'Nicht kontaktieren' };

const sizePicker = (sizes: Record<string, number>, cur: string) => html`<fieldset><legend>Suchgröße</legend><div class="row">${Object.entries(sizes).map(([k, n]) => html`<label class="inline" style="display:flex;gap:6px;align-items:center;min-height:44px"><input type="radio" name="size" value="${k}" ${cur === k ? raw('checked') : ''}> <span><b>${k}</b> · ${n} Firmen</span></label>`)}</div></fieldset>`;

export const routes: Route[] = [
  { method: 'GET', path: /^\/search$/, h: async (r) => {
    const { ctx } = r; const q = r.url.searchParams;
    const v = (k: string, d = '') => q.get(k) ?? d;
    const chosenSubs = new Set(q.has('location') ? q.getAll('sub') : ['nagelstudio']);
    const chosenWeb = new Set(q.has('location') ? q.getAll('website') : ['none', 'needs_improvement']);
    const chosenEmp = new Set(q.getAll('emp')), chosenReady = new Set(q.getAll('readiness'));
    const runs = await ctx.runs.list(8);
    const chk = (name: string, val: string, set: Set<string>, label: string) => html`<label class="inline"><input type="checkbox" name="${name}" value="${val}" ${set.has(val) ? raw('checked') : ''}> ${label}</label>`;
    const tri = (name: string, label: string) => html`<label>${label}<select name="${name}"><option value="any">egal</option><option value="yes" ${v(name) === 'yes' ? raw('selected') : ''}>ja</option><option value="no" ${v(name) === 'no' ? raw('selected') : ''}>nein</option></select></label>`;
    const cb = (name: string, label: string, on: boolean) => html`<label class="inline"><input type="checkbox" name="${name}" value="1" ${on ? raw('checked') : ''}> ${label}</label>`;
    const formMode = q.has('location');
    return render(r, { title: 'Lead-Suche', nav: 'search', body: html`
      ${webNotice(r)}
      <div class="card"><h2>Schnellsuche</h2>
        ${postForm(r.app.csrf, '/search/quick', html`<label>Suchsatz, Teile mit „+“ trennen<input name="q" value="${v('qs')}" placeholder="Völklingen + 30 km + Nagelstudios + Website fehlt oder verbesserungswürdig" maxlength="300" required></label>
        ${sizePicker(ctx.cfg.pipeline.sizes, 'SMALL')}
        <p class="row"><button class="primary">Suche starten</button></p>`, { style: 'display:block' })}
        <p class="row">${EXAMPLE_SEARCHES.map((q) => postForm(r.app.csrf, '/search/quick', html`<input type="hidden" name="q" value="${q}"><button title="${q}">${q.split(' + ').slice(0, 3).join(' · ')}</button>`, { style: 'display:inline' }))}</p>
        <small>Erkannt werden: Ort, „30 km“, Branche, „Website fehlt / verbesserungswürdig“, „mobile Probleme“, „keine Terminbuchung“, „Instagram aktiv“, „Score ab 60“, „20 Leads“, „1-4 Mitarbeiter“.</small></div>
      <div class="card"><h2>Detailsuche</h2>
        <form method="post" action="/search"><input type="hidden" name="csrf" value="${r.app.csrf}"><input type="hidden" name="_form" value="1">
          <fieldset><legend>Wo und was</legend>
            <label>Ort<input name="location" value="${formMode ? v('location') : 'Völklingen'}" required maxlength="80"></label>
            <label>Radius in km<input name="radiusKm" type="number" min="1" max="200" value="${formMode ? v('radiusKm', '30') : '30'}" inputmode="numeric"></label>
            ${ctx.cfg.taxonomy.industries.map((ind) => html`<details ${ind.subIndustries.some((s) => chosenSubs.has(s.key)) ? raw('open') : ''}><summary>${ind.label}</summary><div>${ind.subIndustries.map((s) => chk('sub', s.key, chosenSubs, s.label))}</div></details>`)}
            <label>Weitere Stichwörter (Komma)<input name="keywords" value="${v('keywords')}" maxlength="200"></label></fieldset>
          <fieldset><legend>Website</legend>${WEBSITE_FILTERS.map((w) => chk('website', w, chosenWeb, WEBSITE_LABEL[w]))}
            ${cb('mobileProblems', 'Mobile Probleme', q.get('mobileProblems') === '1')}${cb('noBooking', 'Keine Online-Terminbuchung', q.get('noBooking') === '1')}</fieldset>
          <fieldset><legend>Social Media</legend><div class="row">${tri('socialPresent', 'Vorhanden')}${tri('socialActive', 'Aktiv (letzte 90 Tage)')}</div></fieldset>
          <fieldset><legend>Größe und Qualität</legend>
            <div>${EMPLOYEE_BUCKETS.map((b) => chk('emp', b, chosenEmp, `${b} Mitarbeiter`))}</div>${cb('includeUnknownSize', 'Unbekannte Größe einbeziehen', !formMode || q.get('includeUnknownSize') === '1')}
            <div class="row"><label>Bewertung ab<input name="minRating" type="number" step="0.1" min="0" max="5" value="${v('minRating')}" style="width:110px"></label><label>bis<input name="maxRating" type="number" step="0.1" min="0" max="5" value="${v('maxRating')}" style="width:110px"></label><label>Min. Bewertungen<input name="minReviews" type="number" min="0" value="${v('minReviews')}" style="width:130px"></label></div>
            ${cb('requirePhone', 'Telefonnummer nötig', q.get('requirePhone') === '1')}${cb('requireEmail', 'E-Mail nötig', q.get('requireEmail') === '1')}${cb('excludeChains', 'Filialbetriebe/Ketten ausschließen', q.get('excludeChains') === '1')}${cb('excludeExisting', 'Bereits vorhandene Leads ausschließen', !formMode || q.get('excludeExisting') === '1')}</fieldset>
          <fieldset><legend>Ergebnis</legend><div class="row">
            ${sizePicker(ctx.cfg.pipeline.sizes, v('size', 'SMALL'))}<label>Mindestanzahl<input name="minLeads" type="number" min="0" value="${v('minLeads', '0')}" style="width:120px"></label>
            <label>Min. Opportunity-Score<input name="minOpportunity" type="number" min="0" max="100" value="${v('minOpportunity', '0')}" style="width:150px"></label><label>Min. Digital Need<input name="minDigitalNeed" type="number" min="0" max="100" value="${v('minDigitalNeed', '0')}" style="width:150px"></label></div>
            <label>Sortierung<select name="sort">${SORTS.map((s) => html`<option value="${s}" ${v('sort', 'sales_opportunity') === s ? raw('selected') : ''}>${SORT_LABEL[s]}</option>`)}</select></label>
            <div>${READINESS.map((x) => chk('readiness', x, chosenReady, READY_LABEL[x]))}</div></fieldset>
          <p class="row"><button class="primary">Suche starten</button></p></form></div>
      <div class="card"><h2>Eigene Liste importieren (CSV)</h2>
        ${postForm(r.app.csrf, '/search/import', html`<label>CSV-Inhalt einfügen (Kopfzeile: Firmenname;Branche;Adresse;Stadt;Telefon;Website;E-Mail;Instagram)<textarea name="csv" rows="5" maxlength="1000000" placeholder="Firmenname;Stadt;Telefon;Website"></textarea></label><p><button>Importieren und analysieren</button></p>`, { style: 'display:block' })}</div>
      <div class="card"><h2>Quellen</h2><ul class="items">${ctx.sources.status.map((x) => html`<li><b>${x.id}</b> <span class="badge ${x.enabled ? (x.isMock ? 'b-mock' : 'b-ok') : ''}">${x.mode}</span> <small>${x.provider} · ${x.note}</small></li>`)}</ul>
        <small class="mute">Die Lead-Logik kennt die Quelle nicht – jede Angabe wird mit Quelle und Zeitpunkt gespeichert. Öffentliche OSM-Server sind nur für Demo und kleine Läufe gedacht (Einstellung OSM_MODE).</small></div>
      <div class="card"><h2>Letzte Läufe</h2>${runs.length ? html`<ul class="items">${runs.map((x) => html`<li><a href="/search/run/${x.id}"><b>${x.description}</b></a><br><small>${fmt(x.created_at)} · <span class="badge">${PHASE_LABEL[x.phase] ?? x.status}</span>${x.size ? html` · ${x.size}` : ''} · ${x.counters?.matched ?? 0} Treffer / ${x.counters?.analyzed ?? 0} analysiert${x.requested_count ? ` (gewünscht ${x.requested_count})` : ''}${x.costs?.total !== undefined ? ` · Kosten ${cents(x.costs.total)}` : ''}${x.error ? ` · ${x.error}` : ''}</small></li>`)}</ul>` : html`<p class="mute">Noch keine Läufe.</p>`}</div>` });
  } },

  { method: 'POST', path: /^\/search$/, h: async (r) => {
    let c; try { c = normalizeCriteria(criteriaFromForm(r.form), r.ctx.cfg.taxonomy, r.ctx.cfg.pipeline.sizes); } catch (e) { if (e instanceof CriteriaError) throw new UserError(e.errors.join(' · ')); throw e; }
    const id = await r.ctx.runner.start(c);
    return redirect(`/search/run/${id}`, okFlash('Suche gestartet.'));
  } },

  { method: 'POST', path: /^\/search\/quick$/, h: async (r) => {
    const text = (r.form.get('q') ?? '').trim();
    if (!text) throw new UserError('Bitte einen Suchsatz eingeben.');
    const p = parseQuickSearch(text, r.ctx.cfg.taxonomy);
    if (p.unmatched.length) throw new UserError(`Nicht verstanden: ${p.unmatched.join(', ')}. Bitte umformulieren oder die Detailsuche nutzen.`);
    const formSize = (r.form.get('size') ?? '').toUpperCase();
    if (formSize && p.criteria.size === undefined && p.criteria.maxLeads === undefined) p.criteria.size = formSize;
    let c; try { c = normalizeCriteria(p.criteria, r.ctx.cfg.taxonomy, r.ctx.cfg.pipeline.sizes); } catch (e) { if (e instanceof CriteriaError) throw new UserError(e.errors.join(' · ')); throw e; }
    const id = await r.ctx.runner.start(c);
    return redirect(`/search/run/${id}`, okFlash(`Verstanden: ${p.understood.join(' · ')}`));
  } },

  { method: 'POST', path: /^\/search\/import$/, maxBody: 1_200_000, h: async (r) => {
    const { leads, skipped } = leadsFromCsv(r.form.get('csv') ?? '');
    const id = await r.ctx.runner.startImport(leads, `CSV-Import (${leads.length} Zeilen${skipped.length ? `, ${skipped.length} übersprungen` : ''})`);
    return redirect(`/search/run/${id}`, okFlash(`Import gestartet: ${leads.length} Zeilen.`));
  } },

  { method: 'GET', path: new RegExp(`^/search/run/${uuid.source}$`), h: async (r) => {
    const { ctx } = r;
    const run = await ctx.runs.get(r.params[0]);
    if (!run) return render(r, { title: 'Nicht gefunden', nav: 'search', status: 404, body: html`<p>Lauf nicht gefunden.</p>` });
    const matched = await ctx.leads.list({ runId: run.id, matchedOnly: true, limit: 200 });
    const others = (await ctx.repo.pool.query("select l.id, l.company_name, l.city, rr.fail_reasons, rr.sales_opportunity from run_results rr join leads l on l.id = rr.lead_id where rr.run_id=$1 and rr.owner_id=$2 and not rr.matched order by rr.sales_opportunity desc nulls last limit 50", [run.id, ctx.repo.ownerId])).rows;
    const c = run.counters ?? {}, s = run.summary ?? {};
    const running = run.status === 'RUNNING';
    const body = html`${running ? raw('<meta http-equiv="refresh" content="3">') : ''}
      <div class="card"><div class="row"><span class="badge ${run.status === 'DONE' ? 'b-ok' : run.status === 'RUNNING' ? 'b-info' : 'b-bad'}">${run.status === 'RUNNING' ? (PHASE_LABEL[run.phase] ?? 'läuft …') : (PHASE_LABEL[run.phase] ?? run.status)}</span><b class="grow">${run.description}</b></div>
        <p class="mute">${fmt(run.created_at)}${run.finished_at ? ` – ${fmt(run.finished_at)}` : ''}</p>
        <div class="grid"><div class="kpi"><b>${c.found ?? 0}</b><span>Kandidaten gefunden</span></div><div class="kpi"><b>${c.prefiltered ?? 0}</b><span>vorab aussortiert</span></div><div class="kpi"><b>${c.analyzed ?? 0}</b><span>analysiert</span></div><div class="kpi"><b>${c.matched ?? 0}</b><span>Treffer</span></div></div>
        ${(() => { const L = matched.rows as any[]; const n = (f: (l: any) => boolean) => L.filter(f).length; return html`<div class="note"><b>${c.analyzed ?? 0} Leads analysiert</b><ul><li>A-Leads: ${n((l) => l.priority === 'A')} · B-Leads: ${n((l) => l.priority === 'B')}</li><li>Telefonnummer vorhanden: ${n((l) => l.phone)} · E-Mail vorhanden: ${n((l) => l.has_email)}</li><li>Keine Website gefunden: ${n((l) => !l.website_url)} · Demo empfohlen: ${n((l) => l.demo_recommendation === 'DEMO_RECOMMENDED')} · Daten beschaffen: ${n((l) => l.work_status === 'DATA_NEEDED')}</li></ul>${ctx.enrichment.available ? '' : html`<small>Web-Anreicherung ist nicht aktiviert: „Keine Website gefunden“ bedeutet nur, dass in den aktuell verfügbaren Daten (OpenStreetMap) keine hinterlegt ist – nicht, dass der Betrieb keine besitzt.</small>`}</div>`; })()}
        <details open><summary>Lauf-Protokoll</summary><dl class="facts">
          <dt>Suche-ID</dt><dd><code>${run.id}</code></dd><dt>Status</dt><dd><b>${PHASE_LABEL[run.phase] ?? run.status}</b></dd>
          <dt>Branche / Suchbegriff</dt><dd>${run.search_term ?? run.industry ?? '–'}</dd><dt>Ort · Radius</dt><dd>${run.region} · ${run.radius_km ?? '–'} km</dd>
          <dt>Suchgröße</dt><dd>${run.size ?? 'eigene Anzahl'} · gewünscht ${run.requested_count ?? run.run_limit ?? '–'}</dd>
          <dt>Gefunden</dt><dd>${run.raw_count ?? '–'} Roh-Treffer → ${c.found ?? 0} nach Dedupe${s.pipeline?.dedupe ? html` (${s.pipeline.dedupe.merged} zusammengeführt, ${s.pipeline.dedupe.possible} mögliche Dubletten)` : ''} → ${run.found_count ?? c.analyzed ?? 0} gespeichert/analysiert</dd>
          <dt>Start / Ende</dt><dd>${fmt(run.started_at ?? run.created_at)} / ${run.finished_at ? fmt(run.finished_at) : 'läuft noch'}</dd>
          <dt>Quellen</dt><dd>${(run.sources ?? []).length ? (run.sources as any[]).map((x) => html`<span class="badge">${x.id}: ${x.provider} · ${x.requests} Anfragen · ${cents(x.costCents)}${x.providerCost && x.providerCost.currency === 'USD' ? ` (${Number(x.providerCost.amount).toFixed(4).replace('.', ',')} USD)` : ''}</span> `) : '–'}</dd>
          <dt>Kosten</dt><dd>OSM ${cents(run.costs?.osm)} · Websuche ${cents(run.costs?.web_search)} · KI ${cents(run.costs?.ai)} · Demo ${cents(run.costs?.demo)} · <b>Gesamt ${cents(run.costs?.total)}</b></dd>
          <dt>Demo-Empfehlungen</dt><dd>${s.pipeline ? `${s.pipeline.demoRecommended} empfohlen – erstellt wird nichts automatisch (du bestätigst je Lead)` : '–'}</dd>
          <dt>Web-Enrichment</dt><dd>${s.pipeline?.enrichment?.attempted !== undefined ? `${s.pipeline.enrichment.attempted} Leads abgefragt · ${s.pipeline.enrichment.requests ?? 0} Anfragen${s.pipeline.enrichment.counts ? ' · ' + Object.entries(s.pipeline.enrichment.counts).map(([k, v]) => `${k}: ${v}`).join(', ') : ''}` : '–'}</dd>
          <dt>Fehler</dt><dd>${(run.errors ?? []).length ? html`<ul>${(run.errors as string[]).map((e) => html`<li>${e}</li>`)}</ul>` : 'keine'}</dd></dl></details>
        ${run.error ? html`<div class="errbox">${run.error}</div>` : ''}${s.stoppedReason ? html`<div class="warnbox">Lauf gestoppt: ${s.stoppedReason}. Bereits analysierte Leads sind gespeichert.</div>` : ''}
        ${(s.warnings ?? []).filter((w: string) => !/^Web-Enrichment (übersprungen|vorzeitig)/.test(w)).map((w: string) => html`<div class="warnbox">${w}</div>`)}${(s.warnings ?? []).some((w: string) => /^Web-Enrichment (übersprungen|vorzeitig)/.test(w)) ? webNotice(r) : ''}${c.errors ? html`<div class="errbox">${c.errors} Fehler: ${(s.errorSamples ?? []).join(' | ')}</div>` : ''}
        ${Object.keys(s.skipped ?? {}).length ? html`<details><summary>Vorab aussortiert (${c.prefiltered})</summary><ul>${Object.entries(s.skipped).map(([k, n]) => html`<li>${k}: ${n as number}</li>`)}</ul></details>` : ''}</div>
      <div class="card"><h2>Qualifizierte Leadliste (${matched.total}) – nach Sales Opportunity sortiert</h2>
        ${matched.rows.length ? html`<ul class="items">${matched.rows.map((l, i) => html`<li><div class="row"><b>${i + 1}.</b>${prioBadge(l.priority)}<a class="grow" href="/leads/${l.id}"><b>${l.company_name}</b> ${l.is_mock ? mockBadge : ''}<br><small>${l.city ?? ''} · ${l.distance_km ? `${Number(l.distance_km).toFixed(1).replace('.', ',')} km · ` : ''}Website: ${({ none: 'fehlt', needs_improvement: 'verbesserungswürdig', fine: 'in Ordnung', unknown: 'nicht prüfbar', exists: 'vorhanden' } as Record<string, string>)[l.website_state] ?? '–'}</small></a>
          <div><b>${l.score ?? '–'}</b> ${categoryBadge(l.category)}<br><small>Need ${l.digital_need ?? '–'}</small></div></div><div class="row">${readinessBadge(l.contact_readiness)}</div></li>`)}</ul>` : html`<p class="mute">${running ? 'Wird gesucht …' : 'Keine Treffer für diese Kriterien.'}</p>`}</div>
      ${others.length ? html`<details class="card"><summary>Analysiert, aber nicht passend (${others.length}${others.length === 50 ? '+' : ''})</summary><ul class="items">${others.map((o) => html`<li><a href="/leads/${o.id}">${o.company_name}</a> <small>${o.city ?? ''} · Score ${o.sales_opportunity ?? '–'}</small><br><small class="mute">${(o.fail_reasons as string[]).join(' · ')}</small></li>`)}</ul></details>` : ''}
      <p><a class="btn" href="/search">Neue Suche</a> <a class="btn" href="/leads?run=${run.id}">Alle Leads dieses Laufs</a></p>`;
    return render(r, { title: 'Suchlauf', nav: 'search', body });
  } },
];
void postBtn;
