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
import { FAMILIES, effectiveModules, familyFor, moduleDefs, moduleKeys, recommendModules, type Family } from '../../site/modules.ts';

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
      <div class="row chips" style="margin:6px 0">${(['A', 'B', 'C', 'D'] as const).map((pr) => html`<a class="btn ${q.get('priority') === pr ? 'primary' : ''}" href="/leads?priority=${pr}" title="Priorität ${pr}">${prioBadge(pr)}</a>`)}
        ${([['', 'Alle'], ['no_website', 'Keine Website'], ['has_website', 'Website vorhanden'], ['worst_websites', 'Schlechteste Websites'], ['top', 'Höchste Verkaufschance'], ['demo_ready', 'Demo fertig'], ['demo_recommended', 'Demo empfohlen'], ['demo_open', 'Demo offen'], ['data_needed', 'Daten beschaffen'], ['ready_contact', 'Bereit zum Kontakt'], ['not_contacted', 'Noch nicht kontaktiert'], ['call_today', 'Heute anrufen'], ['manual_check', 'Manuell prüfen'], ['has_email', 'E-Mail vorhanden'], ['has_phone', 'Telefon vorhanden']] as [string, string][]).map(([k, label]) => html`<a class="btn ${(q.get('quick') ?? '') === k && !q.get('tier') && !q.get('priority') && (k !== 'top' || q.get('sort') === 'score') && (k === 'top' || q.get('sort') !== 'score') ? 'primary' : ''}" href="/leads?${k && k !== 'top' ? `quick=${k}` : k === 'top' ? 'sort=score' : ''}">${label}</a>`)}
        ${(['MASS', 'DEEP', 'PREMIUM'] as const).map((t) => html`<a class="btn ${q.get('tier') === t ? 'primary' : ''}" href="/leads?tier=${t}">${t}</a>`)}</div>
      <form class="card" method="get" action="/leads"><div class="row"><label class="grow">Suche<input name="q" value="${q.get('q') ?? ''}" placeholder="Name, Ort, Branche"></label></div>
        <div class="row">${sel('Status', [['', 'alle'], ...STATUSES.map((s) => [s, s] as [string, string])])}${sel('Kategorie', [['', 'alle'], ['HOT', 'HOT'], ['HIGH POTENTIAL', 'HIGH POTENTIAL'], ['MEDIUM', 'MEDIUM'], ['LOW', 'LOW'], ['IGNORE', 'IGNORE'], ['UNRATED', 'nicht bewertet']])}
          ${sel('Kontakt', [['', 'alle'], ['READY_FOR_MANUAL_CALL', 'Bereit für Anruf'], ['EMAIL_PERMISSION_REQUIRED', 'E-Mail: Einwilligung'], ['WHATSAPP_OPT_IN_REQUIRED', 'WhatsApp: Opt-in'], ['MANUAL_REVIEW', 'Manuell prüfen'], ['DO_NOT_CONTACT', 'Gesperrt']])}
          ${sel('Website', [['', 'alle'], ['none', 'fehlt'], ['needs_improvement', 'verbesserungswürdig'], ['fine', 'in Ordnung'], ['unknown', 'nicht prüfbar']])}${sel('Priorität', [['', 'alle'], ['A', 'A'], ['B', 'B'], ['C', 'C'], ['D', 'D']])}
          ${sel('Sortierung', [['', 'Vertrieb (Priorität, Verkaufschance)'], ['score', 'Nur Verkaufschance'], ['website_asc', 'Schlechteste Website zuerst'], ['digital_need', 'Digital Need'], ['distance', 'Entfernung'], ['recent', 'Neueste']])}
          <label>Min. Score<input name="minScore" type="number" min="0" max="100" value="${q.get('minScore') ?? ''}" style="width:110px"></label>
          ${g('run') ? html`<input type="hidden" name="run" value="${g('run')}">` : ''}${g('quick') ? html`<input type="hidden" name="quick" value="${g('quick')}">` : ''}${g('tier') ? html`<input type="hidden" name="tier" value="${g('tier')}">` : ''}<button class="primary">Filtern</button></div></form>
      <p class="mute">${res.total} Leads${offset ? ` · ab ${offset + 1}` : ''}</p>
      <div class="card"><ul class="items">${res.rows.map((l) => { const en = enrichment(l); return html`<li><div class="row"><span title="${l.priority_reason ?? ''}">${prioBadge(l.priority)}</span><a class="grow" href="/leads/${l.id}"><b>${l.company_name}</b> ${l.is_mock ? mockBadge : ''}<br><small>${l.sub_industry ?? l.industry ?? NA}</small></a>
        <div style="text-align:right"><b>${l.score ?? NA}</b> ${categoryBadge(l.category)}<br><small class="mute">Opportunity Score</small></div></div>
        <dl class="facts"><dt>Priorität</dt><dd><b>${l.priority ?? NA}</b>${l.manual_priority ? ' (manuell)' : ''}</dd><dt>Work Status</dt><dd>${l.work_status === 'DATA_NEEDED' ? html`<span class="badge b-warn">DATA_NEEDED</span>` : 'kontaktierbar'}</dd><dt>Contactability</dt><dd>${l.contactability ?? NA}</dd><dt>Demo Recommendation</dt><dd>${l.demo_recommendation === 'DEMO_RECOMMENDED' ? html`<span class="badge b-ok">DEMO_RECOMMENDED</span>` : l.demo_recommendation === 'DEMO_NOT_RECOMMENDED' ? 'nicht empfohlen' : NA}</dd><dt>Status</dt><dd>${statusBadge(l.status)}</dd><dt>Branche</dt><dd>${l.sub_industry ?? l.industry ?? NA}</dd><dt>Ort</dt><dd>${orNA(l.city)}${l.distance_km ? ` · ${Number(l.distance_km).toFixed(1).replace('.', ',')} km` : ''}</dd>
          <dt>Website</dt><dd>${l.website_url ? html`vorhanden · Website-Score <b>${l.website_score ?? NA}</b>` : html`<b>nicht vorhanden</b>`}${l.audit_status === 'UNREACHABLE' ? html` <span class="badge b-warn">Abruf nicht möglich</span>` : ''}</dd>
          <dt>Verkaufschance</dt><dd><b>${l.score ?? NA}</b> ${categoryBadge(l.category)}</dd>
          <dt>Telefon</dt><dd>${l.phone ? html`<a class="tel" href="tel:${String(l.phone).replace(/[^\d+]/g, '')}"><b>${l.phone}</b></a>` : NA}</dd><dt>E-Mail</dt><dd>${l.has_email ? 'vorhanden' : NA}</dd>
          <dt>Demo</dt><dd>${l.has_demo ? html`<span class="badge b-ok">vorhanden</span>` : l.demo_decision === 'skipped' ? 'übersprungen' : l.demo_decision === 'recommended' ? html`<span class="badge b-info">Demo empfohlen</span>` : 'keine'}</dd><dt>KI-Stufe</dt><dd><span class="badge b-info">${l.ai_tier}</span></dd>
          <dt>Quelle</dt><dd>${sourceLabel(l.source)} · Datenqualität ${l.dq !== null && l.dq !== undefined ? `${Math.round(l.dq)}/100` : NA}</dd>
          <dt>Nächste Aktion</dt><dd><b>${P.nextActionText(l)}</b></dd></dl>
        <div class="row" style="margin-top:4px">${statusBadge(l.status)}${readinessBadge(l.contact_readiness)}${l.paused ? html`<span class="badge b-warn">pausiert</span>` : ''}${l.review_flag ? html`<span class="badge b-warn">mögliche Dublette</span>` : ''}${en.needed ? html`<span class="badge b-warn" title="${en.missing.join(', ')}">${en.label}</span>` : ''}${l.demo_ready_call ? html`<span class="badge b-ok">Demo fertig – anrufen</span>` : ''}</div>
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
    const [settings, demos, offer, order, analysis, costs, note, dupes] = await Promise.all([ctx.repo.getSettings(), ctx.sales.listDemos(leadId), ctx.sales.latestOffer(leadId), ctx.orders.orderForLead(leadId), ctx.analysis.best(leadId), ctx.aiUsage.forLead(leadId), ctx.pipeline.note(leadId), ctx.pipeline.candidatesOf(leadId)]);
    const [approval, bstat] = await Promise.all([ctx.pipeline.approvals.stateOf(leadId, 'DEMO_CREATE'), ctx.enrichment.budget.status(ctx.now())]);
    const liveDemo = demos.find((x: any) => !x.revoked); const demoUrl = liveDemo ? `${r.app.baseUrl}/d/${liveDemo.token}` : undefined;
    const sender = settings.callerName || ctx.cfg.agency.callerName || ctx.cfg.agency.ownerName || 'Ihr Ansprechpartner';
    const contactPerson = (d.factsT.find((f: any) => f.key === 'contactPerson')?.value as string | undefined);
    const hasEmail = !!d.lead.email || d.factsT.some((f: any) => f.key === 'email');
    const rec = pickTemplate({ subIndustry: d.lead.sub_industry, industryText: d.lead.industry, name: d.lead.company_name }, ctx.cfg.taxonomy).key;
    const fam = (d.lead.demo_family as string | null) ?? familyFor(ctx.cfg, { subIndustry: d.lead.sub_industry, industry: d.lead.industry });
    const autoFam = familyFor(ctx.cfg, { subIndustry: d.lead.sub_industry, industry: d.lead.industry });
    const recMods: string[] = (d.lead.modules_recommended as string[])?.length ? d.lead.modules_recommended : recommendModules(ctx.cfg, { family: fam as Family, subIndustry: d.lead.sub_industry });
    const modView = { family: fam, autoFamily: autoFam, families: FAMILIES.map((k) => ({ key: k, label: ctx.cfg.pipeline.demo.families[k].label as string })), modules: Object.entries(moduleDefs(ctx.cfg)).map(([k, v]) => ({ key: k, label: v.label })), recommended: recMods, selected: d.lead.modules_selected as string[] | null, hasDemo: !!liveDemo, demoUrl };
    const en = enrichment(d.lead);
    const hints = [d.lead.priority_reason, en.needed ? `${en.label}: ${en.missing.join(', ')}` : '', analysis?.recommended_contact_angle ? `Empfohlener Ansatz: ${analysis.recommended_contact_angle}` : '',
      ...((analysis?.manual_checks ?? []) as string[]).slice(0, 4).map((m) => `Manuell prüfen: ${m}`), ...d.factsT.filter((f: any) => f.key === 'websiteCandidate').map((f: any) => `Mögliche Website (ungeprüft): ${f.value} – ${f.note ?? ''}`),
      dupes.length ? `${dupes.length} mögliche Dublette(n) – bitte prüfen.` : ''].filter(Boolean) as string[];
    return render(r, { title: d.lead.company_name, nav: 'leads', body: html`
      ${P.header(d, r.app.csrf)}${P.duplicatesCard(dupes, { csrf: r.app.csrf, leadId })}${P.profile(d)}${P.priorityCard(d, { csrf: r.app.csrf, leadId })}${P.enrichmentCard(d, { csrf: r.app.csrf, leadId, facts: d.factsT, budgetLeftCents: Math.min(bstat.monthLeftCents, bstat.todayLeftCents), available: ctx.enrichment.available })}${P.analysisCard(d, analysis, { csrf: r.app.csrf, leadId, costs, demoLive: !!liveDemo })}${P.demoDecision(d, { csrf: r.app.csrf, leadId, hasDemo: !!liveDemo, approval })}${P.modulesCard(d, { csrf: r.app.csrf, leadId, v: modView })}${P.phoneView(d, analysis, { sender, demoUrl, contactPerson, csrf: r.app.csrf, leadId })}
      ${P.contact(d, r.app.csrf, leadId, settings, r.app.mock)}${P.templatesCard(d, { sender: settings.callerName || ctx.cfg.agency.callerName || undefined, demoUrl, csrf: r.app.csrf, leadId, emailStatus: ctx.contact.effective(d.lead), hasEmail })}${P.notesCard(d, note, { csrf: r.app.csrf, leadId, hints })}${P.costsCard(costs)}
      ${P.why(d)}${P.sales(d, r.app.csrf, leadId)}${P.statusCard(d, r.app.csrf, leadId)}${P.docs(d, r.app.csrf, leadId, { demos, offer, order, templates: allTemplates().map((t) => ({ key: t.key, label: t.label })), recommended: rec, baseUrl: r.app.baseUrl })}
      ${P.dimensions(d)}${P.audit(d)}
      <details class="card"><summary>Datenschutz (DSGVO)</summary><p class="mute">Auskunft: alle zu diesem Unternehmen gespeicherten Daten. Löschung: entfernt den Lead und setzt ihn auf die Sperrliste. Kunden mit Auftrag können nicht gelöscht werden (Aufbewahrungspflichten).</p>
        <p><a class="btn" href="/leads/${leadId}/export.json">Auskunft herunterladen (JSON)</a></p>${postForm(r.app.csrf, `/leads/${leadId}/erase`, html`<label class="inline"><input type="checkbox" name="confirm" value="1"> Endgültig löschen</label> <button class="danger">Lead löschen</button>`, { style: 'display:block' })}</details>
      <div class="card row"><b class="grow">Social Media</b><a class="btn" href="/social/${leadId}">Content-Kalender öffnen</a></div>${P.history(d)}` });
  } },

  { method: 'GET', path: new RegExp(`^/leads/${id}/export\\.json$`), h: async (r) => ({ body: JSON.stringify(await r.ctx.gdpr.export(r.params[0]), null, 1), type: 'application/json; charset=utf-8', headers: { 'content-disposition': 'attachment; filename="auskunft.json"' } }) },
  { method: 'POST', path: new RegExp(`^/leads/${id}/erase$`), h: async (r) => {
    if (r.form.get('confirm') !== '1') throw new UserError('Bitte die endgültige Löschung bestätigen.');
    await r.ctx.gdpr.erase(r.params[0]); return redirect('/leads', okFlash('Lead gelöscht und auf die Sperrliste gesetzt (kommt nicht wieder).'));
  } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/demo/skip$`), h: async (r) => {
    const leadId = r.params[0]; const undo = r.form.get('undo') === '1';
    if (undo) await r.ctx.pipeline.approvals.reopen(leadId, 'DEMO_CREATE'); else await r.ctx.pipeline.approvals.reject(leadId, 'DEMO_CREATE', 'user', 'Vom Nutzer übersprungen');
    await r.ctx.pipeline.recomputePriority(leadId);
    return back(leadId, undo ? 'Entscheidung zurückgenommen.' : 'Demo übersprungen.');
  } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/demo/request$`), h: async (r) => {
    const leadId = r.params[0]; if (!(await r.ctx.leads.rowToEntry(leadId))) throw new UserError('Lead nicht gefunden.');
    await r.ctx.pipeline.approvals.request(leadId, 'DEMO_CREATE');
    return redirect(`/leads/${leadId}/demo/confirm?template=${encodeURIComponent(r.form.get('template') || 'auto')}`);
  } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/demo/cancel$`), h: async (r) => { await r.ctx.pipeline.approvals.cancel(r.params[0], 'DEMO_CREATE'); return back(r.params[0], 'Abgebrochen – es wurde keine Demo erstellt.'); } },
  { method: 'GET', path: new RegExp(`^/leads/${id}/demo/confirm$`), h: async (r) => {
    const { ctx } = r; const leadId = r.params[0]; const d: any = await ctx.leads.get(leadId);
    if (!d) return render(r, { title: 'Nicht gefunden', nav: 'leads', status: 404, body: html`<p>Lead nicht gefunden.</p>` });
    if ((await ctx.pipeline.approvals.stateOf(leadId, 'DEMO_CREATE')) !== 'AWAITING_APPROVAL') return redirect(`/leads/${leadId}`, { kind: 'err', text: 'Keine offene Anforderung – bitte „Demo erstellen“ erneut wählen.' });
    const fam = (d.lead.demo_family as string | null) ?? familyFor(ctx.cfg, { subIndustry: d.lead.sub_industry, industry: d.lead.industry });
    const rec: string[] = (d.lead.modules_recommended as string[])?.length ? d.lead.modules_recommended : recommendModules(ctx.cfg, { family: fam as Family, subIndustry: d.lead.sub_industry });
    const mods = effectiveModules(ctx.cfg, { recommended: rec, selected: d.lead.modules_selected as string[] | null });
    const defs = moduleDefs(ctx.cfg);
    return render(r, { title: 'Demo bestätigen', nav: 'leads', body: P.demoConfirm(d, { csrf: r.app.csrf, leadId, template: r.url.searchParams.get('template') || 'auto', family: ctx.cfg.pipeline.demo.families[fam]?.label ?? fam, modules: mods.map((m) => ({ key: m, label: defs[m].label, recommended: rec.includes(m) })), reason: d.lead.demo_recommendation_reason ?? '' }) });
  } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/enrich$`), h: async (r) => {
    const leadId = r.params[0];
    const o = await r.ctx.enrichment.enrichLead(leadId, { force: true, ignoreCache: r.form.get('ignoreCache') === '1' });
    return redirect(`/leads/${leadId}#enrichment`, o.status === 'budget_blocked' || o.status === 'provider_unavailable' ? { kind: 'err', text: `Enrichment: ${o.note}` } : okFlash(`Enrichment: ${o.note} Anfragen: ${o.requests}, Kosten ${(o.costCents / 100).toFixed(4).replace('.', ',')} €.`));
  } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/analysis$`), h: async (r) => {
    const tier = r.form.get('tier'); if (tier !== 'MASS' && tier !== 'DEEP' && tier !== 'PREMIUM') throw new UserError('Bitte eine KI-Stufe wählen.');
    const out = await r.ctx.analysis.run(r.params[0], tier, { force: r.form.get('force') === '1' });
    return redirect(`/leads/${r.params[0]}#analyse`, okFlash(`${tier}-Analyse: ${out.note || 'fertig'} KI-Aufrufe: ${out.aiCalls}, geschätzte Kosten ${(out.costCents / 100).toFixed(4).replace('.', ',')} €.`));
  } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/email-status$`), h: async (r) => {
    await r.ctx.contact.setEmailStatus(r.params[0], (r.form.get('to') ?? '') as never, { confirm: r.form.get('confirm') === '1' });
    return redirect(`/leads/${r.params[0]}#vorlagen`, okFlash('E-Mail-Status geändert. Es wurde nichts gesendet.'));
  } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/priority$`), h: async (r) => {
    const v = (r.form.get('priority') ?? '').trim();
    if (v && !['A', 'B', 'C', 'D'].includes(v)) throw new UserError('Priorität muss A, B, C oder D sein.');
    await r.ctx.pipeline.setManualPriority(r.params[0], (v || null) as never);
    return back(r.params[0], v ? `Priorität manuell auf ${v} gesetzt.` : 'Automatische Priorität gilt wieder.', '#prioritaet');
  } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/notes$`), h: async (r) => {
    const body = (r.form.get('body') ?? '').replace(/\r\n/g, '\n'); if (body.length > 20000) throw new UserError('Notiz ist zu lang (max. 20.000 Zeichen).');
    await r.ctx.pipeline.saveNote(r.params[0], body); return back(r.params[0], 'Notiz gespeichert.', '#notizen');
  } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/modules$`), h: async (r) => {
    const { ctx } = r; const leadId = r.params[0];
    const family = r.form.get('family') ?? ''; if (family && !(FAMILIES as string[]).includes(family)) throw new UserError('Unbekannte Layout-Familie.');
    const known = new Set(moduleKeys(ctx.cfg)); const mods = r.form.getAll('mod'); for (const m of mods) if (!known.has(m)) throw new UserError(`Unbekannte Funktion: ${m.slice(0, 30)}`);
    await ctx.pipeline.setModuleState(leadId, { family: family || null, ...(r.form.get('reset') === '1' ? { selected: null } : { selected: mods }) });
    if (family) { const l = await ctx.leads.rowToEntry(leadId); if (l) await ctx.pipeline.setModuleState(leadId, { recommended: recommendModules(ctx.cfg, { family: family as Family, subIndustry: l.sub_industry }) }); }
    const updated = await ctx.docs.refreshDemo(leadId);
    return back(leadId, updated ? 'Auswahl gespeichert – die Demo wurde angepasst.' : 'Auswahl gespeichert.', '#module');
  } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/merge$`), h: async (r) => {
    const other = r.form.get('other') ?? ''; if (!uuid.test(other)) throw new UserError('Ungültiger Lead.');
    try { await r.ctx.pipeline.mergeLeads(r.params[0], other); } catch (e) { throw new UserError(e instanceof Error ? e.message : String(e)); }
    await r.ctx.pipeline.recomputePriority(r.params[0]); return back(r.params[0], 'Leads zusammengeführt (Fakten und Quellen bleiben erhalten).');
  } },
  { method: 'POST', path: new RegExp(`^/dupes/${id}/dismiss$`), h: async (r) => { const leadId = await r.ctx.pipeline.dismissCandidate(r.params[0]); return back(leadId, 'Als „kein Duplikat“ markiert.'); } },
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
  { method: 'POST', path: new RegExp(`^/leads/${id}/demo$`), h: async (r) => {
    // Nur nach ausdrücklicher Bestätigung (Bestätigungsseite): Freigabe-Zustand AWAITING_APPROVAL → APPROVED → Demo bauen → COMPLETED
    const leadId = r.params[0];
    if (r.form.get('confirm') !== '1') throw new UserError('Bitte die Demo-Erstellung bestätigen („Demo erstellen“ wählen und bestätigen).');
    const ap = r.ctx.pipeline.approvals; await ap.request(leadId, 'DEMO_CREATE'); await ap.approve(leadId, 'DEMO_CREATE', 'user');
    const d = await r.ctx.docs.demoFor(leadId, r.form.get('template') || 'auto'); return back(leadId, `Demo erstellt (${d.template}). Link: ${d.url}`, '#dokumente');
  } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/offer$`), h: async (r) => { const o = await r.ctx.docs.offerFor(r.params[0]); return redirect(`/leads/${r.params[0]}#dokumente`, o.warnings.length ? { kind: 'err', text: `Angebot als Entwurf angelegt. ${o.warnings[0]}` } : okFlash('Angebot erstellt.')); } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/accept$`), h: async (r) => { const orderId = await r.ctx.orders.acceptOffer(r.params[0]); return redirect(`/orders/${orderId}`, okFlash('Angebot angenommen – Bestellung angelegt. Jetzt Anzahlungs-Link erstellen.')); } },
  { method: 'POST', path: new RegExp(`^/demos/${id}/revoke$`), h: async (r) => { const leadId = await r.ctx.sales.revokeDemo(r.params[0]); return back(leadId, 'Demo-Link widerrufen.', '#dokumente'); } },
  { method: 'POST', path: new RegExp(`^/offers/${id}/approve$`), h: async (r) => { const leadId = await r.ctx.sales.approveOffer(r.params[0]); return back(leadId, 'Angebot freigegeben.', '#dokumente'); } },
  { method: 'POST', path: new RegExp(`^/offers/${id}/sent$`), h: async (r) => { const leadId = await r.ctx.sales.markOfferSent(r.params[0]); return back(leadId, 'Angebot als versendet markiert.', '#dokumente'); } },
];
void esc;
