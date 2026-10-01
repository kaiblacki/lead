import type { Route } from '../types.ts';
import { UserError } from '../types.ts';
import { html, raw, categoryBadge, mockBadge, prioBadge, readinessBadge, statusBadge, postForm, fmt } from '../ui.ts';
import { render, redirect, okFlash, uuid } from './_page.ts';
import { enrichment, orNA, NA, sourceLabel } from '../../core/enrichment.ts';
import * as P from './lead-parts.ts';
import { STATUSES, type Status } from '../../core/status.ts';
import { CALL_RESULTS, type CallResult } from '../../calls/service.ts';
import { reanalyzeLead } from '../../search/reanalyze.ts';
import { allTemplates } from '../../site/templates.ts';
import { pickTemplate } from '../../site/templates.ts';
import { parseBerlinLocal } from '../../core/time.ts';
import { esc } from '../html.ts';

const id = uuid.source;
const back = (leadId: string, text: string, anchor = '') => redirect(`/leads/${leadId}${anchor}`, okFlash(text));

export const routes: Route[] = [
  { method: 'GET', path: /^\/leads$/, h: async (r) => {
    const q = r.url.searchParams; const g = (k: string) => q.get(k) || undefined;
    const limit = 100, offset = Math.max(0, Number(q.get('offset') ?? 0) || 0);
    const res = await r.ctx.leads.list({ quick: g('quick'), tier: g('tier'), q: g('q'), status: g('status'), category: g('category'), readiness: g('readiness'), websiteState: g('website'), priority: g('priority'), runId: g('run'), minScore: Number(q.get('minScore')) || undefined, sort: g('sort'), limit, offset });
    const sel = (name: string, opts: [string, string][]) => html`<label>${name}<select name="${name === 'Status' ? 'status' : name === 'Kategorie' ? 'category' : name === 'Kontakt' ? 'readiness' : name === 'Website' ? 'website' : name === 'Priorität' ? 'priority' : 'sort'}">${opts.map(([v, l]) => html`<option value="${v}" ${(q.get(name === 'Status' ? 'status' : name === 'Kategorie' ? 'category' : name === 'Kontakt' ? 'readiness' : name === 'Website' ? 'website' : name === 'Priorität' ? 'priority' : 'sort') ?? '') === v ? raw('selected') : ''}>${l}</option>`)}</select></label>`;
    const nextQs = (o: number) => { const u = new URLSearchParams(q); u.set('offset', String(o)); return u.toString(); };
    return render(r, { title: 'Leads', nav: 'leads', body: html`
      <div class="row chips" style="margin:6px 0">${([['', 'Alle'], ['no_website', 'Keine Website'], ['worst_websites', 'Schlechteste Websites'], ['top', 'Höchste Verkaufschance'], ['demo_ready', 'Demo fertig'], ['demo_open', 'Demo offen'], ['not_contacted', 'Noch nicht kontaktiert'], ['call_today', 'Heute anrufen'], ['has_email', 'E-Mail vorhanden'], ['has_phone', 'Telefon vorhanden']] as [string, string][]).map(([k, label]) => html`<a class="btn ${(q.get('quick') ?? '') === k && !q.get('tier') ? 'primary' : ''}" href="/leads?${k && k !== 'top' ? `quick=${k}` : k === 'top' ? 'sort=' : ''}">${label}</a>`)}
        ${(['MASS', 'DEEP', 'PREMIUM'] as const).map((t) => html`<a class="btn ${q.get('tier') === t ? 'primary' : ''}" href="/leads?tier=${t}">${t}</a>`)}</div>
      <form class="card" method="get" action="/leads"><div class="row"><label class="grow">Suche<input name="q" value="${q.get('q') ?? ''}" placeholder="Name, Ort, Branche"></label></div>
        <div class="row">${sel('Status', [['', 'alle'], ...STATUSES.map((s) => [s, s] as [string, string])])}${sel('Kategorie', [['', 'alle'], ['HOT', 'HOT'], ['HIGH POTENTIAL', 'HIGH POTENTIAL'], ['MEDIUM', 'MEDIUM'], ['LOW', 'LOW'], ['IGNORE', 'IGNORE'], ['UNRATED', 'nicht bewertet']])}
          ${sel('Kontakt', [['', 'alle'], ['READY_FOR_MANUAL_CALL', 'Bereit für Anruf'], ['EMAIL_PERMISSION_REQUIRED', 'E-Mail: Einwilligung'], ['WHATSAPP_OPT_IN_REQUIRED', 'WhatsApp: Opt-in'], ['MANUAL_REVIEW', 'Manuell prüfen'], ['DO_NOT_CONTACT', 'Gesperrt']])}
          ${sel('Website', [['', 'alle'], ['none', 'fehlt'], ['needs_improvement', 'verbesserungswürdig'], ['fine', 'in Ordnung'], ['unknown', 'nicht prüfbar']])}${sel('Priorität', [['', 'alle'], ['A', 'A'], ['B', 'B'], ['C', 'C'], ['D', 'D']])}
          ${sel('Sortierung', [['', 'Vertrieb (Verkaufschance)'], ['website_asc', 'Schlechteste Website zuerst'], ['digital_need', 'Digital Need'], ['distance', 'Entfernung'], ['recent', 'Neueste']])}
          <label>Min. Score<input name="minScore" type="number" min="0" max="100" value="${q.get('minScore') ?? ''}" style="width:110px"></label>
          ${g('run') ? html`<input type="hidden" name="run" value="${g('run')}">` : ''}${g('quick') ? html`<input type="hidden" name="quick" value="${g('quick')}">` : ''}${g('tier') ? html`<input type="hidden" name="tier" value="${g('tier')}">` : ''}<button class="primary">Filtern</button></div></form>
      <p class="mute">${res.total} Leads${offset ? ` · ab ${offset + 1}` : ''}</p>
      <div class="card"><ul class="items">${res.rows.map((l) => { const en = enrichment(l); return html`<li><div class="row">${prioBadge(l.priority)}<a class="grow" href="/leads/${l.id}"><b>${l.company_name}</b> ${l.is_mock ? mockBadge : ''}<br><small>${l.sub_industry ?? l.industry ?? NA}</small></a>
        <div style="text-align:right"><b>${l.score ?? NA}</b> ${categoryBadge(l.category)}<br><small class="mute">Opportunity Score</small></div></div>
        <dl class="facts"><dt>Ort</dt><dd>${orNA(l.city)}${l.distance_km ? ` · ${Number(l.distance_km).toFixed(1).replace('.', ',')} km` : ''}</dd>
          <dt>Website</dt><dd>${l.website_url ? html`vorhanden · Website-Score <b>${l.website_score ?? NA}</b>` : html`<b>nicht vorhanden</b>`}${l.audit_status === 'UNREACHABLE' ? html` <span class="badge b-warn">Abruf nicht möglich</span>` : ''}</dd>
          <dt>Verkaufschance</dt><dd><b>${l.score ?? NA}</b> ${categoryBadge(l.category)}</dd>
          <dt>Telefon</dt><dd>${l.phone ? html`<a class="tel" href="tel:${String(l.phone).replace(/[^\d+]/g, '')}"><b>${l.phone}</b></a>` : NA}</dd><dt>E-Mail</dt><dd>${l.has_email ? 'vorhanden' : NA}</dd>
          <dt>Demo</dt><dd>${l.has_demo ? html`<span class="badge b-ok">vorhanden</span>` : l.demo_decision === 'skipped' ? 'übersprungen' : 'keine'}</dd><dt>KI-Stufe</dt><dd><span class="badge b-info">${l.ai_tier}</span></dd>
          <dt>Quelle</dt><dd>${sourceLabel(l.source)} · Datenqualität ${l.dq !== null && l.dq !== undefined ? `${Math.round(l.dq)}/100` : NA}</dd>
          <dt>Nächste Aktion</dt><dd><b>${P.nextActionText(l)}</b></dd></dl>
        <div class="row" style="margin-top:4px">${statusBadge(l.status)}${readinessBadge(l.contact_readiness)}${l.paused ? html`<span class="badge b-warn">pausiert</span>` : ''}${en.needed ? html`<span class="badge b-warn" title="${en.missing.join(', ')}">${en.label}</span>` : ''}${l.demo_ready_call ? html`<span class="badge b-ok">Demo fertig – anrufen</span>` : ''}</div>
        ${en.needed ? html`<small class="mute">Fehlt: ${en.missing.join(' · ')}</small>` : ''}</li>`; })}</ul>
        ${!res.rows.length ? html`<p class="mute">Keine Leads für diese Filter. <a href="/search">Neue Suche</a></p>` : ''}</div>
      <div class="row">${offset > 0 ? html`<a class="btn" href="/leads?${nextQs(Math.max(0, offset - limit))}">← Zurück</a>` : ''}${offset + limit < res.total ? html`<a class="btn" href="/leads?${nextQs(offset + limit)}">Weiter →</a>` : ''}</div>` });
  } },

  { method: 'GET', path: new RegExp(`^/leads/${id}$`), h: async (r) => {
    const { ctx } = r; const leadId = r.params[0];
    const d: any = await ctx.leads.get(leadId);
    if (!d) return render(r, { title: 'Nicht gefunden', nav: 'leads', status: 404, body: html`<p>Lead nicht gefunden.</p>` });
    d.factsT = await ctx.leads.factsOf(leadId);
    d.assessment = await ctx.leads.assess(leadId);
    const [settings, demos, offer, order, analysis, costs] = await Promise.all([ctx.repo.getSettings(), ctx.sales.listDemos(leadId), ctx.sales.latestOffer(leadId), ctx.orders.orderForLead(leadId), ctx.analysis.best(leadId), ctx.aiUsage.forLead(leadId)]);
    const liveDemo = demos.find((x: any) => !x.revoked); const demoUrl = liveDemo ? `${r.app.baseUrl}/d/${liveDemo.token}` : undefined;
    const sender = settings.callerName || ctx.cfg.agency.callerName || ctx.cfg.agency.ownerName || 'Ihr Ansprechpartner';
    const contactPerson = (d.factsT.find((f: any) => f.key === 'contactPerson')?.value as string | undefined);
    const hasEmail = !!d.lead.email || d.factsT.some((f: any) => f.key === 'email');
    const rec = pickTemplate({ subIndustry: d.lead.sub_industry, industryText: d.lead.industry, name: d.lead.company_name }, ctx.cfg.taxonomy).key;
    return render(r, { title: d.lead.company_name, nav: 'leads', body: html`
      ${P.header(d, r.app.csrf)}${P.phoneView(d, analysis, { sender, demoUrl, contactPerson, csrf: r.app.csrf, leadId })}${P.demoDecision(d, { csrf: r.app.csrf, leadId, hasDemo: !!liveDemo })}${P.analysisCard(d, analysis, { csrf: r.app.csrf, leadId, costs, demoLive: !!liveDemo })}${P.why(d)}${P.sales(d, r.app.csrf, leadId)}${P.templatesCard(d, { sender: settings.callerName || ctx.cfg.agency.callerName || undefined, demoUrl, csrf: r.app.csrf, leadId, emailStatus: ctx.contact.effective(d.lead), hasEmail })}
      ${P.contact(d, r.app.csrf, leadId, settings, r.app.mock)}${P.statusCard(d, r.app.csrf, leadId)}${P.docs(d, r.app.csrf, leadId, { demos, offer, order, templates: allTemplates().map((t) => ({ key: t.key, label: t.label })), recommended: rec, baseUrl: r.app.baseUrl })}
      ${P.dimensions(d)}${P.profile(d)}${P.audit(d)}
      <details class="card"><summary>Datenschutz (DSGVO)</summary><p class="mute">Auskunft: alle zu diesem Unternehmen gespeicherten Daten. Löschung: entfernt den Lead und setzt ihn auf die Sperrliste. Kunden mit Auftrag können nicht gelöscht werden (Aufbewahrungspflichten).</p>
        <p><a class="btn" href="/leads/${leadId}/export.json">Auskunft herunterladen (JSON)</a></p>${postForm(r.app.csrf, `/leads/${leadId}/erase`, html`<label class="inline"><input type="checkbox" name="confirm" value="1"> Endgültig löschen</label> <button class="danger">Lead löschen</button>`, { style: 'display:block' })}</details>
      <div class="card row"><b class="grow">Social Media</b><a class="btn" href="/social/${leadId}">Content-Kalender öffnen</a></div>${P.history(d)}` });
  } },

  { method: 'GET', path: new RegExp(`^/leads/${id}/export\\.json$`), h: async (r) => ({ body: JSON.stringify(await r.ctx.gdpr.export(r.params[0]), null, 1), type: 'application/json; charset=utf-8', headers: { 'content-disposition': 'attachment; filename="auskunft.json"' } }) },
  { method: 'POST', path: new RegExp(`^/leads/${id}/erase$`), h: async (r) => {
    if (r.form.get('confirm') !== '1') throw new UserError('Bitte die endgültige Löschung bestätigen.');
    await r.ctx.gdpr.erase(r.params[0]); return redirect('/leads', okFlash('Lead gelöscht und auf die Sperrliste gesetzt (kommt nicht wieder).'));
  } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/demo/skip$`), h: async (r) => { const undo = r.form.get('undo') === '1'; await r.ctx.leads.setDemoDecision(r.params[0], undo ? null : 'skipped'); return back(r.params[0], undo ? 'Entscheidung zurückgenommen.' : 'Demo übersprungen.'); } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/analysis$`), h: async (r) => {
    const tier = r.form.get('tier'); if (tier !== 'MASS' && tier !== 'DEEP' && tier !== 'PREMIUM') throw new UserError('Bitte eine KI-Stufe wählen.');
    const out = await r.ctx.analysis.run(r.params[0], tier, { force: r.form.get('force') === '1' });
    return redirect(`/leads/${r.params[0]}#analyse`, okFlash(`${tier}-Analyse: ${out.note || 'fertig'} KI-Aufrufe: ${out.aiCalls}, geschätzte Kosten ${(out.costCents / 100).toFixed(4).replace('.', ',')} €.`));
  } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/email-status$`), h: async (r) => {
    await r.ctx.contact.setEmailStatus(r.params[0], (r.form.get('to') ?? '') as never, { confirm: r.form.get('confirm') === '1' });
    return redirect(`/leads/${r.params[0]}#vorlagen`, okFlash('E-Mail-Status geändert. Es wurde nichts gesendet.'));
  } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/pause$`), h: async (r) => { await r.ctx.leads.setPaused(r.params[0], true); return back(r.params[0], 'Lead pausiert.'); } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/resume$`), h: async (r) => { await r.ctx.leads.setPaused(r.params[0], false); return back(r.params[0], 'Lead fortgesetzt.'); } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/reject$`), h: async (r) => {
    await r.ctx.leads.setStatus(r.params[0], 'IGNORED', 'Manuell abgelehnt');
    await r.ctx.repo.tx((c) => r.ctx.leads.snapshotOutcome(c, r.params[0], 'final', 'LOST', { reason: 'rejected' }));
    return back(r.params[0], 'Lead abgelehnt.');
  } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/reanalyze$`), h: async (r) => { await reanalyzeLead(r.ctx, r.params[0], { deep: r.form.get('deep') === '1' }); return back(r.params[0], r.form.get('deep') === '1' ? 'Tiefenprüfung abgeschlossen.' : 'Lead neu analysiert.'); } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/status$`), h: async (r) => {
    const to = r.form.get('to') as Status;
    if (!STATUSES.includes(to)) throw new UserError('Unbekannter Status.');
    await r.ctx.leads.setStatus(r.params[0], to, r.form.get('reason') ?? '');
    return back(r.params[0], `Status: ${to}`);
  } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/opener$`), h: async (r) => { await r.ctx.leads.editOpener(r.params[0], r.form.get('opener') ?? ''); return back(r.params[0], 'Gesprächseinstieg gespeichert – bitte erneut freigeben.'); } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/brief/approve$`), h: async (r) => { await r.ctx.leads.approveBrief(r.params[0]); return back(r.params[0], 'Gesprächseinstieg freigegeben.'); } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/call$`), h: async (r) => {
    const result = r.form.get('result') as CallResult;
    if (!CALL_RESULTS.includes(result)) throw new UserError('Bitte ein Ergebnis wählen.');
    const cb = (r.form.get('callback') ?? '').trim();
    const callbackAt = cb ? parseBerlinLocal(cb) : null;
    if (cb && !callbackAt) throw new UserError('Rückruf-Datum ungültig.');
    const out = await r.ctx.calls.applyResult(r.params[0], result, { note: r.form.get('note') ?? '', callbackAt });
    const next = r.form.get('next');
    return redirect(next === 'calls' ? '/calls' : `/leads/${r.params[0]}`, okFlash([`Ergebnis gespeichert: ${result}.`, ...out.messages, out.demoUrl ? `Demo: ${out.demoUrl}` : ''].filter(Boolean).join(' ')));
  } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/consent$`), h: async (r) => {
    const ch = r.form.get('channel'); if (ch !== 'EMAIL' && ch !== 'WHATSAPP') throw new UserError('Ungültiger Kanal.');
    await r.ctx.contact.recordConsent(r.params[0], ch, r.form.get('note') ?? ''); return back(r.params[0], 'Einwilligung dokumentiert.', '#kontakt');
  } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/send$`), h: async (r) => {
    const ch = r.form.get('channel'); if (ch !== 'EMAIL' && ch !== 'WHATSAPP') throw new UserError('Ungültiger Kanal.');
    const out = await r.ctx.contact.attemptSend(r.params[0], ch, { subject: 'Nachricht', text: r.form.get('text') ?? '' });
    return redirect(`/leads/${r.params[0]}#kontakt`, out.sent ? okFlash(`Gesendet (${r.ctx.registry.providers[ch === 'EMAIL' ? 'email' : 'whatsapp'].isMock ? 'Mock – nur protokolliert' : 'echt'}).`) : { kind: 'err', text: `Nicht gesendet: ${out.decision.allowed ? '' : out.decision.reason} ${out.decision.allowed ? '' : out.decision.action}` });
  } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/demo$`), h: async (r) => { const d = await r.ctx.docs.demoFor(r.params[0], r.form.get('template') || 'auto'); return back(r.params[0], `Demo erstellt (${d.template}). Link: ${d.url}`, '#dokumente'); } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/offer$`), h: async (r) => { const o = await r.ctx.docs.offerFor(r.params[0]); return redirect(`/leads/${r.params[0]}#dokumente`, o.warnings.length ? { kind: 'err', text: `Angebot als Entwurf angelegt. ${o.warnings[0]}` } : okFlash('Angebot erstellt.')); } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/accept$`), h: async (r) => { const orderId = await r.ctx.orders.acceptOffer(r.params[0]); return redirect(`/orders/${orderId}`, okFlash('Angebot angenommen – Bestellung angelegt. Jetzt Anzahlungs-Link erstellen.')); } },
  { method: 'POST', path: new RegExp(`^/demos/${id}/revoke$`), h: async (r) => { const leadId = await r.ctx.sales.revokeDemo(r.params[0]); return back(leadId, 'Demo-Link widerrufen.', '#dokumente'); } },
  { method: 'POST', path: new RegExp(`^/offers/${id}/approve$`), h: async (r) => { const leadId = await r.ctx.sales.approveOffer(r.params[0]); return back(leadId, 'Angebot freigegeben.', '#dokumente'); } },
  { method: 'POST', path: new RegExp(`^/offers/${id}/sent$`), h: async (r) => { const leadId = await r.ctx.sales.markOfferSent(r.params[0]); return back(leadId, 'Angebot als versendet markiert.', '#dokumente'); } },
];
void esc;
