import type { Route } from '../types.ts';
import { UserError } from '../types.ts';
import { html, categoryBadge, fmt, prioBadge } from '../ui.ts';
import { render, redirect, okFlash } from './_page.ts';
import { nextActionText } from './lead-parts.ts';
import { NA } from '../../core/enrichment.ts';
import { ENRICH_LABEL } from '../../enrich/service.ts';
import { CONTACTABILITY_LABEL } from '../../contact/contactability.ts';

const eur = (c: number) => `${(c / 100).toFixed(2).replace('.', ',')} €`;
const eur4 = (c: number) => `${(c / 100).toFixed(4).replace('.', ',')} €`;

export const routes: Route[] = [
  { method: 'GET', path: /^\/enrichment$/, h: async (r) => {
    const { ctx } = r; const b = await ctx.enrichment.budget.status(ctx.now());
    const list = await ctx.leads.list({ quick: 'data_needed', limit: 100 });
    const missing = (l: any) => [!l.phone ? 'Telefon' : '', !l.has_email ? 'E-Mail' : '', !l.website_url ? 'Website' : ''].filter(Boolean).join(', ') || '–';
    return render(r, { title: 'Daten beschaffen', nav: 'enrichment', body: html`
      <div class="card"><h2>Enrichment-Budget</h2><div class="grid">
        <div class="kpi"><b>${eur(b.monthSpentCents)}</b><span>verbraucht diesen Monat (von ${eur(b.monthlyLimitCents)})</span></div><div class="kpi"><b>${eur(b.monthLeftCents)}</b><span>übrig diesen Monat</span></div>
        <div class="kpi"><b>${eur(b.todaySpentCents)}</b><span>heutige Kosten (Limit ${eur(b.dailyLimitCents)})</span></div><div class="kpi"><b>${b.monthRequests}</b><span>Anfragen diesen Monat (heute ${b.todayRequests})</span></div>
        <div class="kpi"><b>${b.costPerEnrichedLeadCents === null ? NA : eur4(b.costPerEnrichedLeadCents)}</b><span>Kosten je angereichertem Lead (${b.monthEnrichedLeads} Leads)</span></div></div>
        <p class="mute">Preis der Websuche: ${ctx.cfg.pipeline.sources.WEB_SEARCH.pricing.usdPerThousandRequests} ${ctx.cfg.pipeline.sources.WEB_SEARCH.pricing.currency} je 1.000 Anfragen (= ${(ctx.cfg.pipeline.sources.WEB_SEARCH.pricing.usdPerThousandRequests / 1000).toFixed(3).replace('.', ',')} ${ctx.cfg.pipeline.sources.WEB_SEARCH.pricing.currency} je Anfrage ≈ ${eur4(ctx.enrichment.estEurCents())} bei ${String(ctx.cfg.ai.eurPerUsd).replace('.', ',')} EUR/USD). Das Budget oben rechnet in EUR, brutto (ohne das Anbieter-Guthaben von ${ctx.cfg.pipeline.sources.WEB_SEARCH.pricing.monthlyCreditUsd} USD/Monat).</p>
        <p class="mute">Websuche: <b>${ctx.enrichment.provider.name}</b>${ctx.enrichment.available ? '' : ' – nicht verfügbar (BRAVE_SEARCH_API_KEY fehlt), Enrichment: provider_unavailable'}. Limits in <code>config/pipeline.json</code> (monthly_enrichment_budget_eur, daily_enrichment_budget_eur). Bei erreichtem Limit läuft alles Kostenlose weiter; betroffene Leads bleiben DATA_NEEDED (budget_blocked).</p>
        <form method="post" action="/enrichment/run" class="row"><input type="hidden" name="csrf" value="${r.app.csrf}"><label>Höchstens Leads<input name="limit" type="number" min="1" max="200" value="10" style="width:100px"></label><button class="primary">Enrichment für „Daten beschaffen“ starten</button></form>
        <small class="mute">Reihenfolge: A, dann B, dann interessante C; D wird nicht kostenpflichtig angereichert. Gleiche Suchen werden nicht wiederholt.</small></div>
      <div class="card"><h2>Daten beschaffen (${list.total})</h2>${list.rows.length ? html`<ul class="items">${list.rows.map((l) => html`<li><div class="row">${prioBadge(l.priority)}<a class="grow" href="/leads/${l.id}"><b>${l.company_name}</b><br><small>${l.sub_industry ?? l.industry ?? NA} · ${l.city ?? NA}</small></a><div style="text-align:right"><b>${l.score ?? NA}</b> ${categoryBadge(l.category)}<br><small class="mute">Verkaufschance</small></div></div>
        <dl class="facts"><dt>Website bekannt?</dt><dd>${l.website_url ? 'ja' : 'nein'}</dd><dt>Fehlende Daten</dt><dd>${missing(l)}</dd><dt>Kontaktierbarkeit</dt><dd>${CONTACTABILITY_LABEL[l.contactability as keyof typeof CONTACTABILITY_LABEL] ?? NA}</dd>
          <dt>Enrichment</dt><dd>${l.enrichment_status ? ENRICH_LABEL[l.enrichment_status] ?? l.enrichment_status : 'noch nicht geprüft'}</dd><dt>Letzte Prüfung</dt><dd>${l.last_enrichment_at ? fmt(l.last_enrichment_at) : 'nie'}</dd><dt>Nächste Aktion</dt><dd><b>${nextActionText(l)}</b></dd></dl></li>`)}</ul>` : html`<p class="mute">Alle Leads haben Telefonnummer oder E-Mail.</p>`}</div>` });
  } },
  { method: 'POST', path: /^\/enrichment\/run$/, h: async (r) => {
    const limit = Math.min(200, Math.max(1, Number(r.form.get('limit')) || 10));
    const ids = (await r.ctx.leads.list({ quick: 'data_needed', limit: 500 })).rows.map((l: any) => l.id as string);
    if (!ids.length) throw new UserError('Keine Leads mit DATA_NEEDED.');
    const res = await r.ctx.enrichment.enrichBatch(ids, { limit });
    if (res.counts.provider_unavailable) return redirect('/enrichment', { kind: 'err', text: 'Websuche nicht verfügbar (BRAVE_SEARCH_API_KEY fehlt) – nichts abgefragt.' });
    return redirect('/enrichment', okFlash(`Enrichment: ${res.attempted} Lead(s) abgefragt, ${res.requests} Anfragen, ${eur4(res.costCents)}${res.providerCost.currency === 'USD' ? ` (${res.providerCost.amount.toFixed(4).replace('.', ',')} USD)` : ''}. ${Object.entries(res.counts).map(([k, v]) => `${ENRICH_LABEL[k] ?? k}: ${v}`).join(' · ')}`));
  } },
];
