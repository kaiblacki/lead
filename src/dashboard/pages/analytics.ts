import type { Route } from '../types.ts';
import { html, eur, pct } from '../ui.ts';
import { render } from './_page.ts';
import type { Range } from '../../db/analytics.ts';

export const routes: Route[] = [
  { method: 'GET', path: /^\/analytics$/, h: async (r) => {
    const range = (['7', '30', '90', 'all'].includes(r.url.searchParams.get('range') ?? '') ? r.url.searchParams.get('range') : 'all') as Range;
    const [o, buckets, usage, ai] = await Promise.all([r.ctx.analytics.overview(range, r.ctx.now()), r.ctx.learning.buckets(),
      r.ctx.repo.pool.query('select provider, sum(requests)::int n from provider_usage where owner_id=$1 group by 1 order by 2 desc', [r.ctx.repo.ownerId]).then((x) => x.rows), r.ctx.aiUsage.overview()]);
    const eur4 = (c: number | null) => (c === null ? 'nicht verfügbar' : `${(c / 100).toFixed(c < 10 ? 4 : 2).replace('.', ',')} €`);
    const max = Math.max(1, ...o.funnel.map((f) => f.count));
    const tab = (k: string, label: string) => html`<a class="btn ${range === k ? 'primary' : ''}" href="/analytics?range=${k}">${label}</a>`;
    return render(r, { title: 'Analytics', nav: 'analytics', body: html`
      <div class="row">${tab('7', '7 Tage')}${tab('30', '30 Tage')}${tab('90', '90 Tage')}${tab('all', 'Gesamt')}</div>
      <p class="mute">Kohorte: Leads, die im Zeitraum gefunden wurden. Jede Stufe zählt die Leads, die sie erreicht haben oder darüber hinaus sind – der Trichter nimmt nach unten nie zu.</p>
      <div class="grid"><div class="kpi"><b>${eur(o.revenueCents)}</b><span>Umsatz (Anzahlung + Rest)</span></div><div class="kpi"><b>${eur(o.mrrCents)}</b><span>wiederkehrend / Monat (${o.activePlans} Verträge)</span></div><div class="kpi"><b>${eur(o.arrCents)}</b><span>wiederkehrend hochgerechnet / Jahr</span></div><div class="kpi"><b>${eur(o.avgOrderCents)}</b><span>Ø Auftragswert</span></div></div>
      <div class="card"><h2>Funnel</h2><div class="scroll"><table><tr><th>Stufe</th><th></th><th>Anzahl</th></tr>${o.funnel.map((f) => html`<tr><td>${f.label}</td><td style="width:40%"><div class="bar"><i style="width:${Math.round((f.count / max) * 100)}%"></i></div></td><td><b>${f.count}</b></td></tr>`)}</table></div>
        <small class="mute">Angerufen: ${o.calls} Anrufe insgesamt.</small></div>
      <div class="card"><h2>Conversion zwischen den Stufen</h2><div class="scroll"><table><tr><th>Von → Nach</th><th>Quote</th></tr>${o.steps.map((s) => html`<tr><td>${s.from} → ${s.to}</td><td><b>${pct(s.rate)}</b> <small class="mute">(${s.toCount} von ${s.fromCount})</small></td></tr>`)}</table></div></div>
      <div class="card"><h2>Learning Loop: Score vs. Ergebnis</h2><p class="mute">Welche Scores führten zu Interesse oder Kauf? Nur Auswertung der gespeicherten Daten – kein Machine Learning.</p>
        <div class="scroll"><table class="nowrap"><tr><th>Score</th><th>Leads</th><th>Angerufen</th><th>Erreicht</th><th>Interessiert</th><th>Gewonnen</th><th>Interesse</th><th>Kauf</th></tr>
          ${buckets.map((b) => html`<tr><td><b>${b.label}</b></td><td>${b.leads}</td><td>${b.called}</td><td>${b.reached}</td><td>${b.interested}</td><td>${b.won}</td><td>${pct(b.interestedRate)}</td><td>${pct(b.wonRate)}</td></tr>`)}</table></div>
        <p><a class="btn" href="/analytics/learning.csv">Export (CSV)</a> <a class="btn" href="/analytics/learning.json">Export (JSON)</a></p><small class="mute">Export ohne Firmennamen und Kontaktdaten: Merkmale, Scores (Stand der Bewertung), Anrufe, erreichte Stufen, Ergebnis.</small></div>
      <div class="card" id="ki-kosten"><h2>KI-Kosten</h2><div class="grid"><div class="kpi"><b>${eur4(ai.totalCents)}</b><span>Gesamtkosten aller Leads (${ai.calls} Aufrufe)</span></div><div class="kpi"><b>${eur4(ai.analysisCents)}</b><span>davon Analyse</span></div><div class="kpi"><b>${eur4(ai.demoCents)}</b><span>davon Demo / Konzept</span></div>
        <div class="kpi"><b>${eur4(ai.avgPerAnalysedCents)}</b><span>Ø je analysiertem Unternehmen (${ai.analysedLeads})</span></div><div class="kpi"><b>${eur4(ai.avgPerDemoCents)}</b><span>Ø je Demo (${ai.demoLeads} Leads mit Demo)</span></div></div>
        <div class="scroll"><table class="nowrap"><tr><th>Stufe</th><th>Aufrufe</th><th>Kosten</th></tr>${ai.byTier.map((t: any) => html`<tr><td>${t.tier}</td><td>${t.calls}</td><td>${eur4(t.cents)}</td></tr>`)}</table></div>
        <small class="mute">Geschätzt aus den gemeldeten Token und den Preisen in config/ai.json. Regelbasierte (MASS-)Analysen und Mock-Aufrufe kosten nichts. Pro Aufruf gespeichert: Modell, Aufgabe, Token, Kosten, Lead, Zeitpunkt.</small></div>
      <div class="card"><h2>Provider-Nutzung</h2>${usage.length ? html`<ul>${usage.map((u) => html`<li>${u.provider}: ${u.n} Anfragen</li>`)}</ul>` : html`<p class="mute">Noch keine Nutzung.</p>`}</div>` });
  } },
  { method: 'GET', path: /^\/analytics\/learning\.csv$/, h: async (r) => ({ body: '﻿' + (await r.ctx.learning.csv()), type: 'text/csv; charset=utf-8', headers: { 'content-disposition': 'attachment; filename="learning-loop.csv"' } }) },
  { method: 'GET', path: /^\/analytics\/learning\.json$/, h: async (r) => ({ body: JSON.stringify(await r.ctx.learning.rows(), null, 1), type: 'application/json; charset=utf-8', headers: { 'content-disposition': 'attachment; filename="learning-loop.json"' } }) },
];
