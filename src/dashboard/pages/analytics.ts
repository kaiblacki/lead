import type { Route } from '../types.ts';
import { html, eur, pct } from '../ui.ts';
import { render } from './_page.ts';
import type { Slice } from '../../db/growth-analytics.ts';
import type { Range } from '../../db/analytics.ts';

const VIEW_TABS: [string, string][] = [['funnel', 'Funnel & Umsatz'], ['industries', 'Branchen'], ['regions', 'Regionen'], ['strategies', 'Strategien'], ['team', 'Mitarbeiter'], ['partners', 'Partner'], ['revenue', 'Umsatz'], ['costs', 'Kosten']];
const viewTabs = (cur: string) => html`<div class="row" role="tablist" aria-label="Analytics-Ansichten">${VIEW_TABS.map(([k, l]) => html`<a class="btn ${cur === k ? 'primary' : ''}" href="/analytics?view=${k}">${l}</a>`)}</div>`;
const sliceTable = (rows: Slice[], label: string) => html`<div class="scroll"><table class="nowrap"><tr><th>${label}</th><th>Leads</th><th>Analysiert</th><th>Angerufen</th><th>Interessiert</th><th>Demos</th><th>Angebote</th><th>Gewonnen</th><th>Ø Handlungspriorität</th></tr>
  ${rows.map((x) => html`<tr><td><b>${x.key}</b></td><td>${x.leads}</td><td>${x.analyzed}</td><td>${x.called}</td><td>${x.interested}</td><td>${x.demos}</td><td>${x.offers}</td><td>${x.won}</td><td>${x.avgAction ?? 'nicht verfügbar'}</td></tr>`)}</table></div>`;
const STRATEGY_TEXT: Record<string, string> = { WEBSITE_FIRST: 'Website zuerst', PARTNER_FIRST: 'Partnerschaft zuerst', NEEDS_ANALYSIS_FIRST: 'Bedarfsanalyse zuerst', WEBSITE_AND_PARTNER: 'Website + Partner', GENERAL_DISCOVERY: 'Allgemeines Kennenlernen', FOLLOW_UP: 'Nachfassen', NO_ACTION: 'Keine Aktion' };

async function growthView(r: import('../types.ts').Req, view: string) {
  const ga = r.ctx.growthAnalytics; await r.ctx.growth.refresh();
  let body;
  if (view === 'industries') body = html`<div class="card"><h2>Nach Branche</h2><p class="mute">Erfahrungswerte aus den gespeicherten Daten – keine Prognose.</p>${sliceTable(await ga.slices('industry'), 'Branche')}</div>`;
  else if (view === 'team') {
    const { teamTable, periodOf } = await import('./team.ts'); const p = periodOf(r.url, r.ctx.now());
    const qs = (e: Record<string, string> = {}) => new URLSearchParams({ range: p.range, ...e }).toString();
    body = html`<div class="card"><h2>Mitarbeiter</h2><div class="row">${[['today', 'Heute'], ['week', 'Woche'], ['month', 'Monat']].map(([k, l]) => html`<a class="btn ${p.range === k ? 'primary' : ''}" href="/analytics?view=team&range=${k}">${l}</a>`)}</div>${await teamTable(r, { from: p.from, to: p.to }, qs, '/team/activity')}<small class="mute">Nur Admin/Teamleitung. Keine Rangliste – Details und fairer Vergleich unter <a href="/team/activity">Team-Aktivität</a>.</small></div>`;
  }
  else if (view === 'regions') body = html`<div class="card"><h2>Nach Region / Ort</h2>${sliceTable(await ga.slices('region'), 'Ort')}</div>`;
  else if (view === 'strategies') {
    const [a, b] = await Promise.all([ga.slices('strategy'), ga.slices('contact')]);
    body = html`<div class="card"><h2>Gesprächsstrategie</h2>${sliceTable(a.map((x) => ({ ...x, key: STRATEGY_TEXT[x.key] ?? x.key })), 'Strategie')}</div><div class="card"><h2>Kontaktstrategie</h2>${sliceTable(b, 'Kontaktstrategie')}</div>`;
  } else if (view === 'partners') {
    const p = await ga.partners();
    body = html`<div class="card"><h2>Partner</h2><p class="mute">Kooperationen sind unabhängig von Website-Projekten und Versicherungsverträgen. Der Wert ist eine Schätzung, die du bei der Weiterleitung selbst einträgst.</p>
      <div class="row">${p.byStatus.map((s: any) => html`<span class="badge">${s.status}: ${s.n}</span>`)}</div>
      ${p.partners.length ? html`<div class="scroll"><table class="nowrap"><tr><th>Partner</th><th>Status</th><th>Ausgehend</th><th>Eingehend</th><th>Angenommen</th><th>Umgewandelt</th><th>Geschätzter Wert</th></tr>
        ${p.partners.map((x: any) => html`<tr><td><a href="/partners/${x.id}">${x.company_name}</a></td><td>${x.status}</td><td>${x.outgoing}</td><td>${x.incoming}</td><td>${x.accepted}</td><td>${x.converted}</td><td>${eur(x.value_cents)}</td></tr>`)}</table></div>` : html`<p class="mute">Noch keine Partner.</p>`}</div>`;
  } else if (view === 'revenue') {
    const rev = await ga.revenueByMonth(); const o = await r.ctx.analytics.overview('all', r.ctx.now());
    body = html`<div class="card"><h2>Umsatz</h2><div class="grid"><div class="kpi"><b>${eur(o.revenueCents)}</b><span>bezahlt (Anzahlung + Rest)</span></div><div class="kpi"><b>${eur(o.mrrCents)}</b><span>wiederkehrend / Monat</span></div><div class="kpi"><b>${eur(o.avgOrderCents)}</b><span>Ø Auftragswert</span></div></div>${rev.length ? html`<table><tr><th>Monat</th><th>Zahlungen</th><th>Betrag</th></tr>${rev.map((m) => html`<tr><td>${m.month}</td><td>${m.n}</td><td>${eur(m.cents)}</td></tr>`)}</table>` : html`<p class="mute">Noch keine bezahlten Zahlungen.</p>`}</div>`;
  } else {
    const [c, rev] = await Promise.all([ga.costs(), ga.revenueByMonth()]);
    const e = (v: number | null) => (v === null ? 'nicht verfügbar' : `${(v / 100).toFixed(2).replace('.', ',')} €`);
    body = html`<div class="card"><h2>Kosten</h2><div class="grid"><div class="kpi"><b>${e(c.totalCents)}</b><span>Gesamt (KI-Schätzung + Web-Anreicherung)</span></div><div class="kpi"><b>${e(c.perLeadCents)}</b><span>je Lead (${c.leads})</span></div><div class="kpi"><b>${e(c.perCustomerCents)}</b><span>je gewonnenem Kunden (${c.customers})</span></div></div>
      <small class="mute">Nur erfasste Kosten; nicht erfasste werden nicht geschätzt. KI: ${e(c.aiCents)}, Web-Anreicherung: ${e(c.enrichCents)}.</small></div>
      <div class="card"><h2>Umsatz je Monat (bezahlt)</h2>${rev.length ? html`<table><tr><th>Monat</th><th>Zahlungen</th><th>Betrag</th></tr>${rev.map((m) => html`<tr><td>${m.month}</td><td>${m.n}</td><td>${eur(m.cents)}</td></tr>`)}</table>` : html`<p class="mute">Noch keine bezahlten Zahlungen.</p>`}</div>`;
  }
  return render(r, { title: 'Analytics', nav: 'analytics', body: html`${viewTabs(view)}${body}` });
}

export const routes: Route[] = [
  { method: 'GET', path: /^\/analytics$/, h: async (r) => {
    const view = r.url.searchParams.get('view') ?? 'funnel';
    if (view !== 'funnel') return growthView(r, view);
    const range = (['7', '30', '90', 'all'].includes(r.url.searchParams.get('range') ?? '') ? r.url.searchParams.get('range') : 'all') as Range;
    const [o, buckets, usage, ai] = await Promise.all([r.ctx.analytics.overview(range, r.ctx.now()), r.ctx.learning.buckets(),
      r.ctx.repo.pool.query('select provider, sum(requests)::int n from provider_usage where owner_id=$1 group by 1 order by 2 desc', [r.ctx.repo.ownerId]).then((x) => x.rows), r.ctx.aiUsage.overview()]);
    const eur4 = (c: number | null) => (c === null ? 'nicht verfügbar' : `${(c / 100).toFixed(c < 10 ? 4 : 2).replace('.', ',')} €`);
    const max = Math.max(1, ...o.funnel.map((f) => f.count));
    const tab = (k: string, label: string) => html`<a class="btn ${range === k ? 'primary' : ''}" href="/analytics?range=${k}">${label}</a>`;
    return render(r, { title: 'Analytics', nav: 'analytics', body: html`
      ${viewTabs('funnel')}
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
