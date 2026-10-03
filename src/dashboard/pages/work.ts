import type { Req, Route } from '../types.ts';
import { UserError } from '../types.ts';
import { html, fmt, postForm, postBtn, prioBadge } from '../ui.ts';
import { render, redirect, okFlash, uuid } from './_page.ts';
import { NA } from '../../core/enrichment.ts';
import { FACT_LABELS } from '../../core/profile.ts';
import { parseBerlinLocal } from '../../core/time.ts';
import { buildEmailDraft } from '../../sales/email-draft.ts';
import { CONTACT_STATUS_LABEL, CHANNEL_LABEL, HANDOFF_LABEL, HANDOFF_REASONS, PLAYBOOKS, RESULTS, TRAINING, ASSIGNMENT_STATUS_LABEL, flowOptions, playbookById, recommendPlaybook, resultIcon, resultLabel, type ResultKey } from '../../team/rules.ts';

const id = uuid.source;
const wrap = async <T>(f: () => Promise<T>): Promise<T> => { try { return await f(); } catch (e) { throw new UserError(e instanceof Error ? e.message : String(e)); } };
const PERM_LABEL: Record<string, string> = { CALL_APPROVED: 'Anruf freigegeben', EMAIL_PERMISSION: 'E-Mail-Freigabe vorhanden', CONTACT_REVIEW_REQUIRED: 'Kontaktfreigabe prüfen', DO_NOT_CONTACT: 'Nicht kontaktieren' };
const FILTERS: [string, string][] = [['open', 'Alle offenen'], ['today', 'Heute'], ['new', 'Neu'], ['callbacks', 'Rückrufe'], ['noanswer', 'Nicht erreicht'], ['interested', 'Interessiert'], ['demo', 'Demo'], ['handoff', 'Übergabe nötig'], ['done', 'Erledigt']];
const bar = (v: number, goal: number) => html`<div class="bar" role="img" aria-label="${v} von ${goal}"><i style="width:${goal ? Math.min(100, Math.round((v / goal) * 100)) : 0}%"></i></div>`;
const guard = (r: Req) => !r.user.id ? html`<div class="note">Du bist als Administrator ohne Mitarbeiterkonto angemeldet. Der Arbeitsplatz zeigt die Leads eines Mitarbeiters – lege unter <a href="/team">Team</a> ein Konto an oder öffne die Leads eines Mitarbeiters dort.</div>` : null;
const forbidden = (r: Req) => render(r, { title: 'Kein Zugriff', nav: 'work', status: 403, crumbs: [['🏠 Mein Tag', '/work'], ['Kein Zugriff']], body: html`<p>Dieser Lead ist dir nicht zugewiesen.</p><p><a class="btn primary" href="/work">🏠 Mein Tag</a></p>` });
const berlinHour = (d: Date) => Number(d.toLocaleString('de-DE', { hour: 'numeric', hour12: false, timeZone: 'Europe/Berlin' }));
const when = (d: unknown) => fmt(d);

async function leadWorkspace(r: Req, leadId: string) {
  const { ctx, user } = r; const t = ctx.team;
  if (!(await t.mayWork(user, leadId))) return forbidden(r);
  const d: any = await ctx.leads.get(leadId); if (!d) return render(r, { title: 'Nicht gefunden', nav: 'work', status: 404, body: html`<p>Lead nicht gefunden.</p>` });
  const lead = d.lead; const lock = await t.acquireLock(leadId, user); await t.audit(user, 'LEAD_OPENED', leadId);
  const [facts, perms, attempts, phoneOn, campPb] = await Promise.all([ctx.leads.factsOf(leadId), t.permissions(leadId), t.attemptsForLead(leadId), t.phoneEnabled(), t.campaignPlaybook(leadId)]);
  await ctx.copilot.ensure(leadId); const cop = (await ctx.copilot.stored(leadId)).mass;
  const assign = await t.leadAssignmentOf(leadId);
  const pb = playbookById(campPb) ?? recommendPlaybook({ websiteState: lead.website_state, strategy: cop?.strategy?.main ?? lead.conversation_strategy ?? null });
  const q = r.url.searchParams.get('q') ?? 'start'; const flow = flowOptions(q);
  const canAct = lock.ok && perms.includes('CALL_APPROVED') && !perms.includes('DO_NOT_CONTACT');
  const growth = lead.growth_scores as { reasons?: string[]; actionPriority?: number } | null;
  const contactPerson = (facts.find((f: any) => f.key === 'contactPerson')?.value as string | undefined);
  const hasEmail = !!lead.email || facts.some((f: any) => f.key === 'email');
  const sender = (await ctx.repo.getSettings()).callerName || ctx.cfg.agency.callerName || r.user.name;
  const draft = cop && hasEmail ? buildEmailDraft(cop, { company: lead.company_name, city: lead.city, subLabel: ctx.cfg.taxonomy.sub(lead.sub_industry)?.label, contactPerson, callerName: sender }) : null;
  const branch = ctx.cfg.taxonomy.sub(lead.sub_industry)?.label ?? lead.industry ?? NA;
  const base = `/work/lead/${leadId}`; const noteField = html`<label>Notiz${RESULTS.some((x) => x.needsNote) ? html` <small class="mute">(bei Interesse Pflicht: was wurde besprochen, was soll passieren?)</small>` : ''}<textarea name="note" rows="3" maxlength="4000" placeholder="z. B. Mit Geschäftsführer gesprochen. Website grundsätzlich interessant. Rückruf Donnerstag 14 Uhr."></textarea></label>`;
  const rbtn = (k: ResultKey) => html`<button name="result" value="${k}" class="${k === 'DO_NOT_CONTACT' ? 'danger' : k === 'NO_ANSWER' || k === 'NO_INTEREST' ? '' : 'primary'}">${resultIcon(k)} ${resultLabel(k)}</button>`;
  const flowBody = !canAct ? html`<p class="warnbox">${!lock.ok ? html`<b>Wird gerade von ${lock.by} bearbeitet.</b> Du kannst den Lead ansehen, aber noch nichts speichern.` : perms.includes('DO_NOT_CONTACT') ? 'Dieser Lead ist gesperrt (Nicht kontaktieren).' : phoneOn ? 'Für diesen Lead ist noch kein Anruf freigegeben. Bitte Kai fragen.' : 'Die Telefonakquise ist noch nicht freigegeben. Bitte Kai fragen.'}</p>`
    : q === 'start' ? html`<p class="big">${flow.question}</p><div class="row"><a class="btn primary big" href="${base}?q=interest#ablauf">JA</a>
        ${postForm(r.app.csrf, `${base}/result`, html`<input type="hidden" name="result" value="NO_ANSWER"><button class="big">NEIN – NICHT ERREICHT speichern</button>`)}</div>`
    : q === 'interest' ? html`<p class="big">${flow.question}</p><div class="row">${flow.options.map((o) => html`<a class="btn ${o.label === 'JA' ? 'primary' : ''} big" href="${base}?q=${o.to}#ablauf">${o.label}</a>`)}</div>`
    : html`<p class="big">${flow.question}</p>${postForm(r.app.csrf, `${base}/result`, html`${noteField}
        ${q === 'unsure' ? html`<label>Rückruf am (bei „Rückruf“ Pflicht)<input type="datetime-local" name="callback"></label>` : ''}
        ${q === 'topic' ? html`<fieldset><legend>Nur bei „Mehrere Themen“: welche?</legend>${['website', 'needs', 'partner'].map((tp) => html`<label class="inline"><input type="checkbox" name="topic" value="${tp}"> ${tp === 'website' ? 'Website' : tp === 'needs' ? 'Bedarfsanalyse' : 'Kooperation'}</label>`)}</fieldset><label>Rückruf-Termin (optional)<input type="datetime-local" name="callback"></label>` : ''}
        <div class="resgrid">${flow.options.map((o) => (o.result ? rbtn(o.result) : ''))}</div>`, { style: 'display:block' })}
      <p><a href="${base}#ablauf">← erste Frage</a></p>`;
  const sections = html`
    <div class="card" id="ablauf"><h2>Gesprächsablauf</h2>${flowBody}
      <details><summary>Alle Ergebnisse direkt wählen</summary>${canAct ? postForm(r.app.csrf, `${base}/result`, html`${noteField}<label>Rückruf am (nur bei „Rückruf“)<input type="datetime-local" name="callback"></label><div class="resgrid">${RESULTS.filter((x) => x.key !== 'HANDOFF' && x.key !== 'REACHED').map((x) => rbtn(x.key))}</div>`, { style: 'display:block' }) : html`<p class="mute">Nicht verfügbar.</p>`}</details>
      <p><a class="btn" href="${base}/handoff">➡ AN KAI ÜBERGEBEN</a></p></div>
    <div class="card"><h2>Notiz speichern</h2>${postForm(r.app.csrf, `${base}/note`, html`<textarea name="note" rows="2" maxlength="4000" required placeholder="Eigene Notiz zum Lead (wird in der Historie gespeichert)"></textarea><button>Notiz speichern</button>`, { style: 'display:block' })}</div>`;
  const copDetails = cop ? html`<div class="card" id="leitfaden"><h2>Das soll ich sagen</h2>
      <p><b>Einstieg:</b> ${cop.opener.text}</p><p><b>Vorstellung:</b> ${cop.introduction}</p>
      <p><b>Hauptstrategie:</b> ${cop.strategy.label} – ${cop.strategy.reason}</p>
      <p><b>Nächste empfohlene Frage:</b> ${cop.questions.company[0] ?? cop.questions.online[0] ?? NA}</p>
      <details open><summary>Website-Argument</summary>${cop.website.problems.length ? html`<ul>${cop.website.problems.slice(0, 3).map((p: any) => html`<li>${p.text} <small class="mute">(${p.evidence})</small></li>`)}</ul>` : html`<p>${cop.website.reason}</p>`}</details>
      <details><summary>Partner-Argument</summary><p>${cop.partnership.reason}</p><p>${cop.partnership.question}</p></details>
      ${cop.needsAnalysis.potential !== 'LOW' ? html`<details><summary>Bedarfsanalyse (nur wenn es passt, eigenes Thema)</summary><p>${cop.needsAnalysis.reason}</p><ul>${cop.needsAnalysis.questions.map((x: string) => html`<li>${x}</li>`)}</ul><small class="mute">${cop.needsAnalysis.note}</small></details>` : ''}
      <details><summary>Einwandbehandlung</summary><ul>${cop.objections.map((o: any) => html`<li><b>${o.objection}</b><br>${o.answer}</li>`)}</ul></details></div>` : html`<div class="card"><p class="mute">Der Verkaufsassistent hat noch keine Auswertung für diesen Lead.</p></div>`;
  const history = html`<div class="card" id="historie"><h2>Kontakt-Historie</h2>${attempts.length ? html`<ul class="items">${attempts.map((a: any) => html`<li><small>${when(a.started_at)} · ${a.user_name}</small><div>${resultIcon(a.result, a.channel)} <b>${CHANNEL_LABEL[a.channel] ?? a.channel}</b> – ${resultLabel(a.result)}${a.status === 'DRAFT' ? ' (Entwurf)' : ''}${a.status === 'SENT' ? ' (versendet)' : ''}</div>${a.note ? html`<div class="note">${a.note}</div>` : ''}${a.next_action ? html`<small class="mute">Danach: ${a.next_action}${a.next_action_at ? ` (${when(a.next_action_at)})` : ''}</small>` : ''}</li>`)}</ul>` : html`<p class="mute">Noch kein Kontakt.</p>`}</div>`;
  const emailCard = html`<div class="card" id="email"><h2>E-Mail</h2><p class="mute">Das System sendet nichts. Ein Entwurf ist nur ein Entwurf – „versendet“ vermerkst du erst, wenn du die E-Mail selbst gesendet hast.</p>${draft ? html`<details><summary>Entwurf ansehen</summary><b>${draft.subject}</b><pre style="white-space:pre-wrap">${draft.body}</pre></details>
      ${postForm(r.app.csrf, `${base}/email`, html`<input type="hidden" name="mode" value="DRAFT"><button>Entwurf speichern (nicht versendet)</button>`)}
      ${postForm(r.app.csrf, `${base}/email`, html`<input type="hidden" name="mode" value="SENT"><label class="inline"><input type="checkbox" name="confirmed" value="1"> Ich habe die E-Mail selbst versendet</label> <button ${perms.includes('EMAIL_PERMISSION') ? '' : 'disabled'}>Als versendet vermerken</button>${perms.includes('EMAIL_PERMISSION') ? '' : html` <small class="mute">Keine E-Mail-Freigabe – nicht möglich.</small>`}`, { style: 'display:block' })}` : html`<p class="mute">Keine E-Mail-Adresse oder kein Entwurf verfügbar.</p>`}</div>`;
  const knows = html`<div class="card" id="wissen"><h2>Das weiß das System</h2><dl class="facts"><dt>Branche</dt><dd>${branch}</dd><dt>Ort</dt><dd>${lead.city ?? NA}</dd><dt>Adresse</dt><dd>${lead.address ?? NA}</dd><dt>Website</dt><dd>${lead.website_url ? html`<a href="${lead.website_url}" target="_blank" rel="noopener noreferrer">${lead.website_url}</a>` : lead.website_state === 'none' ? 'keine gefunden' : NA}</dd><dt>E-Mail</dt><dd>${lead.email ?? facts.find((f: any) => f.key === 'email')?.value ?? NA}</dd>
      ${facts.filter((f: any) => !['email', 'contactPerson'].includes(f.key) && (f.value === null || typeof f.value !== 'object')).slice(0, 8).map((f: any) => html`<dt>${(FACT_LABELS as Record<string, string>)[f.key] ?? f.key}</dt><dd>${f.value ?? NA}</dd>`)}<dt>Ansprechpartner</dt><dd>${contactPerson ?? NA}</dd></dl>
      <p><b>Warum dieser Lead?</b> ${lead.priority_reason ?? growth?.reasons?.[1] ?? NA}</p><p><b>Warum Kontakt?</b> ${cop?.summary30 ?? NA}</p></div>`;
  const pbCard = html`<div class="card" id="playbook"><h2>Playbook: ${pb.title}${campPb ? html` <small class="mute">(von Kai für die Kampagne vorgegeben)</small>` : ''}</h2><p><b>Ziel:</b> ${pb.goal}</p><ol>${pb.steps.map((s) => html`<li>${s}</li>`)}</ol><details><summary>Fragen und was du vermeiden sollst</summary><ul>${pb.questions.map((x) => html`<li>${x}</li>`)}</ul><b>Vermeiden</b><ul>${pb.avoid.map((x) => html`<li>${x}</li>`)}</ul></details></div>`;
  const body = html`
    ${!lock.ok ? html`<div class="warnbox"><b>Wird gerade von ${lock.by} bearbeitet.</b>${user.role !== 'SALES' ? postBtn(r.app.csrf, `/team/leads/${leadId}/unlock`, 'Sperre lösen') : ''}</div>` : ''}
    <div class="card callhead"><div class="row"><h2 class="grow" style="margin:0">${lead.company_name}</h2>${prioBadge(lead.effective_priority)}</div>
      <p>${branch} · ${lead.city ?? NA}${lead.website_url ? html` · <a href="${lead.website_url}" target="_blank" rel="noopener noreferrer">Website</a>` : lead.website_state === 'none' ? ' · keine Website' : ''}</p>
      <p>${lead.phone ? html`<a class="btn primary telbtn" href="tel:${String(lead.phone).replace(/[^\d+]/g, '')}">📞 ${lead.phone}</a>` : html`<b>Telefon: ${NA}</b>`}</p>
      <p class="row">${perms.map((p) => html`<span class="badge ${p === 'CALL_APPROVED' ? 'b-ok' : p === 'DO_NOT_CONTACT' ? 'b-warn' : 'b-info'}">${PERM_LABEL[p] ?? p}</span>`)}<span class="badge">${CONTACT_STATUS_LABEL[(lead.contact_status ?? 'NOT_CONTACTED') as keyof typeof CONTACT_STATUS_LABEL]}</span>${assign?.assignment_status ? html`<span class="badge">${ASSIGNMENT_STATUS_LABEL[assign.assignment_status]}</span>` : ''}</p>
      <p><b>Gesprächsziel:</b> ${cop?.goal.text ?? pb.goal}</p>${lead.callback_at ? html`<p><b>Rückruf fällig:</b> ${when(lead.callback_at)}</p>` : ''}${lead.next_step ? html`<p><b>Nächste Aktion:</b> ${lead.next_step}</p>` : ''}</div>
    ${sections}${copDetails}${pbCard}${knows}${emailCard}${history}
    <div class="card row"><a class="btn" href="/work/leads">← Zu meinen Leads</a><a class="btn primary" href="/work/next">Nächster Lead</a>${assign?.assigned_to_user_id === user.id ? postBtn(r.app.csrf, `${base}/return`, 'Lead zurückgeben') : ''}</div>`;
  return render(r, { title: lead.company_name, nav: 'work', crumbs: user.role === 'SALES' ? [['🏠 Mein Tag', '/work'], ['Meine Leads', '/work/leads'], [lead.company_name]] : [['Startseite', '/'], ['Team', '/team'], ['Arbeitsplatz'], [lead.company_name]], back: user.role === 'SALES' ? ['← Zurück zu meinen Leads', '/work/leads'] : ['← Zum Lead', `/leads/${leadId}`], body });
}

export const routes: Route[] = [
  { method: 'GET', path: /^\/work$/, h: async (r) => {
    const g = guard(r); const t = r.ctx.team;
    if (g) return render(r, { title: 'Mein Arbeitstag', nav: 'work', crumbs: [['🏠 Mein Tag']], body: g });
    const [day, prog, phoneOn] = await Promise.all([t.myDay(r.user.id!), t.progress(r.user.id!), t.phoneEnabled()]); const h = berlinHour(r.ctx.now());
    const hello = h < 11 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend'; const first = r.user.name.split(' ')[0];
    return render(r, { title: 'Mein Arbeitstag', nav: 'work', crumbs: [['🏠 Mein Tag']], body: html`
      <div class="card"><h2 style="margin:0">${hello} ${first}.</h2><p>Heute:</p><ul class="daylist"><li><b>${day.new_leads}</b> neue Leads</li><li><b>${day.callbacks}</b> Rückrufe</li><li><b>${day.interested}</b> interessierte Unternehmen</li><li><b>${day.demo_follow}</b> Demo nachfassen</li><li><b>${day.dueTasks}</b> fällige Aufgaben</li></ul>
        ${phoneOn ? '' : html`<p class="warnbox">Die Telefonakquise ist noch nicht freigegeben – bitte Kai fragen.</p>`}
        <a class="btn primary startbtn" href="/work/next">ARBEIT STARTEN</a></div>
      <div class="card"><h2>Mein Fortschritt heute</h2>
        <p>Anrufe: <b>${prog.calls} / ${prog.goals.calls}</b></p>${bar(prog.calls, prog.goals.calls)}<p>Erreicht: <b>${prog.reached} / ${prog.goals.reached}</b></p>${bar(prog.reached, prog.goals.reached)}
        <p>Qualifizierte Gespräche: <b>${prog.qualified} / ${prog.goals.qualified}</b></p>${bar(prog.qualified, prog.goals.qualified)}<p>Follow-ups: <b>${prog.followups} / ${prog.goals.followups}</b></p>${bar(prog.followups, prog.goals.followups)}</div>
      <div class="card"><div class="row"><a class="btn" href="/work/leads">Meine Leads (${day.open_leads})</a><a class="btn" href="/work/leads?f=callbacks">Rückrufe</a><a class="btn" href="/work/tasks">Aufgaben (${day.openTasks})</a><a class="btn" href="/work/handoffs">Übergaben</a></div></div>` });
  } },
  { method: 'GET', path: /^\/work\/leads$/, h: async (r) => {
    const g = guard(r); if (g) return render(r, { title: 'Meine Leads', nav: 'work', crumbs: [['🏠 Mein Tag', '/work'], ['Meine Leads']], body: g });
    const f = FILTERS.some(([k]) => k === r.url.searchParams.get('f')) ? r.url.searchParams.get('f')! : 'open'; const rows = await r.ctx.team.myLeads(r.user.id!, f);
    return render(r, { title: 'Meine Leads', nav: 'work', crumbs: [['🏠 Mein Tag', '/work'], ['Meine Leads']], back: ['← Zu Mein Tag', '/work'], body: html`
      <div class="row chips">${FILTERS.map(([k, l]) => html`<a class="btn ${f === k ? 'primary' : ''}" href="/work/leads?f=${k}">${l}</a>`)}</div>
      <p class="mute">${rows.length} Lead(s). Du musst nicht selbst auswählen – <a href="/work/next">Nächsten Lead öffnen</a>.</p>
      <div class="card">${rows.length ? html`<ul class="items">${rows.map((l: any) => html`<li><div class="row">${prioBadge(l.effective_priority)}<a class="grow" href="/work/lead/${l.id}"><b>${l.company_name}</b><br><small>${l.city ?? NA} · ${l.sub_industry ?? l.industry ?? NA}</small></a><div style="text-align:right"><span class="badge">${CONTACT_STATUS_LABEL[l.contact_status as keyof typeof CONTACT_STATUS_LABEL]}</span></div></div>
        <small>${l.callback_at ? `Rückruf ${when(l.callback_at)} · ` : ''}${l.next_step ? `Nächste Aktion: ${l.next_step}` : l.call_count ? `${l.call_count} Versuch(e)` : 'noch nicht kontaktiert'}${l.working_name && l.working_user_id !== r.user.id && new Date(l.lock_expires_at) > r.ctx.now() ? ` · wird gerade von ${l.working_name} bearbeitet` : ''}</small></li>`)}</ul>` : html`<p class="mute">Keine Leads in dieser Ansicht.</p>`}</div>` });
  } },
  { method: 'GET', path: /^\/work\/next$/, h: async (r) => {
    const g = guard(r); if (g) return render(r, { title: 'Nächster Lead', nav: 'work', crumbs: [['🏠 Mein Tag', '/work'], ['Nächster Lead']], body: g });
    const nid = await r.ctx.team.nextLead(r.user, r.url.searchParams.get('skip') ?? undefined);
    if (!nid) return render(r, { title: 'Nächster Lead', nav: 'work', crumbs: [['🏠 Mein Tag', '/work'], ['Nächster Lead']], back: ['← Zu Mein Tag', '/work'], body: html`<div class="card"><h2>Gerade ist nichts offen.</h2><p>Alle zugewiesenen, freigegebenen Leads sind bearbeitet oder warten auf einen Rückruf-Termin.</p><div class="row"><a class="btn primary" href="/work">🏠 Mein Tag</a><a class="btn" href="/work/leads">Meine Leads</a></div></div>` });
    return redirect(`/work/lead/${nid}`);
  } },
  { method: 'GET', path: new RegExp(`^/work/lead/${id}$`), h: async (r) => leadWorkspace(r, r.params[0]) },
  { method: 'POST', path: new RegExp(`^/work/lead/${id}/result$`), h: async (r) => {
    const key = r.form.get('result') ?? ''; const cb = (r.form.get('callback') ?? '').trim(); const callbackAt = cb ? parseBerlinLocal(cb) : null; if (cb && !callbackAt) throw new UserError('Datum/Uhrzeit des Rückrufs nicht lesbar.');
    const pb = playbookById(await r.ctx.team.campaignPlaybook(r.params[0]));
    const out = await wrap(() => r.ctx.team.recordResult(r.user, r.params[0], key, { note: r.form.get('note') ?? '', callbackAt, topics: r.form.getAll('topic'), playbook: pb?.id ?? null }));
    return redirect('/work/saved', okFlash(out.message));
  } },
  { method: 'GET', path: /^\/work\/saved$/, h: async (r) => render(r, { title: 'Gespeichert', nav: 'work', crumbs: [['🏠 Mein Tag', '/work'], ['Gespeichert']], body: html`<div class="card"><h2>Weiter geht’s</h2><div class="row"><a class="btn primary startbtn" href="/work/next">Nächsten Lead öffnen</a><a class="btn" href="/work/leads">Meine Leads</a><a class="btn" href="/work">🏠 Mein Tag</a></div></div>` }) },
  { method: 'POST', path: new RegExp(`^/work/lead/${id}/note$`), h: async (r) => { await wrap(() => r.ctx.team.addNote(r.user, r.params[0], r.form.get('note') ?? '')); return redirect(`/work/lead/${r.params[0]}#historie`, okFlash('Notiz gespeichert.')); } },
  { method: 'POST', path: new RegExp(`^/work/lead/${id}/email$`), h: async (r) => { const mode = r.form.get('mode') === 'SENT' ? 'SENT' : 'DRAFT'; await wrap(() => r.ctx.team.recordEmail(r.user, r.params[0], mode, { note: r.form.get('note') ?? '', confirmed: r.form.get('confirmed') === '1' })); return redirect(`/work/lead/${r.params[0]}#historie`, okFlash(mode === 'SENT' ? 'E-Mail als von dir versendet vermerkt.' : 'Entwurf gespeichert – nicht versendet.')); } },
  { method: 'POST', path: new RegExp(`^/work/lead/${id}/return$`), h: async (r) => { if (!(await r.ctx.team.mayWork(r.user, r.params[0]))) throw new UserError('Dieser Lead ist dir nicht zugewiesen.'); await r.ctx.team.unassign(r.params[0], r.user, 'RETURNED'); return redirect('/work/next', okFlash('Lead zurückgegeben.')); } },
  { method: 'GET', path: new RegExp(`^/work/lead/${id}/handoff$`), h: async (r) => {
    if (!(await r.ctx.team.mayWork(r.user, r.params[0]))) return forbidden(r); const l = (await r.ctx.leads.get(r.params[0])) as any; const lead = l.lead; const back = `/work/lead/${r.params[0]}`;
    return render(r, { title: 'An Kai übergeben', nav: 'work', crumbs: [['🏠 Mein Tag', '/work'], ['Meine Leads', '/work/leads'], [lead.company_name, back], ['Übergabe']], back: ['← Zurück zum Lead', back], body: html`<div class="card"><h2>${lead.company_name}</h2>
      ${postForm(r.app.csrf, `${back}/handoff`, html`<label>Grund<select name="reason" required>${HANDOFF_REASONS.map((x) => html`<option value="${x}">${HANDOFF_LABEL[x]}</option>`)}</select></label>
        <label>Notiz (Pflicht)<textarea name="note" rows="4" required maxlength="4000" placeholder="Was wurde besprochen? Wer ist der Ansprechpartner?"></textarea></label><label>Interesse<input name="interest" maxlength="300" placeholder="z. B. Demo für Website"></label>
        <label>Gewünschter Rückruf (optional)<input type="datetime-local" name="callback"></label><label>Empfohlener nächster Schritt<input name="next_step" maxlength="300"></label><button class="primary">An Kai übergeben</button>`, { style: 'display:block' })}</div>` });
  } },
  { method: 'POST', path: new RegExp(`^/work/lead/${id}/handoff$`), h: async (r) => {
    const cb = (r.form.get('callback') ?? '').trim(); const callbackAt = cb ? parseBerlinLocal(cb) : null;
    await wrap(() => r.ctx.team.recordResult(r.user, r.params[0], 'HANDOFF', { note: r.form.get('note') ?? '', callbackAt, handoff: { reason: r.form.get('reason') ?? '', interest: r.form.get('interest') ?? '', nextStep: r.form.get('next_step') ?? '' } }));
    return redirect('/work/saved', okFlash('Lead wurde an Kai übergeben.')); } },
  { method: 'GET', path: /^\/work\/tasks$/, h: async (r) => {
    const g = guard(r); if (g) return render(r, { title: 'Meine Aufgaben', nav: 'work', crumbs: [['🏠 Mein Tag', '/work'], ['Aufgaben']], body: g });
    const rows = (await r.ctx.repo.pool.query(`select t.id, t.title, t.type, t.due_at, t.priority, l.id as lead_id, l.company_name from tasks t join leads l on l.id = t.lead_id where l.owner_id = $1 and l.assigned_to_user_id = $2 and t.status = 'OPEN' and not t.for_admin order by t.due_at limit 100`, [r.ctx.repo.ownerId, r.user.id])).rows;
    return render(r, { title: 'Meine Aufgaben', nav: 'work', crumbs: [['🏠 Mein Tag', '/work'], ['Aufgaben']], back: ['← Zu Mein Tag', '/work'], body: html`<div class="card">${rows.length ? html`<ul class="items">${rows.map((t: any) => html`<li><div class="row"><a class="grow" href="/work/lead/${t.lead_id}"><b>${t.title}</b><br><small>${t.company_name} · fällig ${when(t.due_at)}${new Date(t.due_at) < r.ctx.now() ? ' · überfällig' : ''}</small></a>${postBtn(r.app.csrf, `/work/tasks/${t.id}/done`, 'Erledigt')}</div></li>`)}</ul>` : html`<p class="mute">Keine offenen Aufgaben.</p>`}</div>` });
  } },
  { method: 'POST', path: new RegExp(`^/work/tasks/${id}/done$`), h: async (r) => {
    const t = (await r.ctx.repo.pool.query('select t.lead_id, l.assigned_to_user_id from tasks t join leads l on l.id = t.lead_id where t.id = $1 and t.owner_id = $2', [r.params[0], r.ctx.repo.ownerId])).rows[0];
    if (!t || (r.user.role === 'SALES' && t.assigned_to_user_id !== r.user.id)) throw new UserError('Aufgabe nicht gefunden.'); await r.ctx.taskEngine.done(r.params[0]); await r.ctx.team.audit(r.user, 'TASK_COMPLETED', t.lead_id, {}); return redirect('/work/tasks', okFlash('Aufgabe erledigt.')); } },
  { method: 'GET', path: /^\/work\/handoffs$/, h: async (r) => {
    const g = guard(r); if (g) return render(r, { title: 'Meine Übergaben', nav: 'work', crumbs: [['🏠 Mein Tag', '/work'], ['Übergaben']], body: g });
    const rows = await r.ctx.team.handoffs({ userId: r.user.id! });
    return render(r, { title: 'Meine Übergaben', nav: 'work', crumbs: [['🏠 Mein Tag', '/work'], ['Übergaben']], back: ['← Zu Mein Tag', '/work'], body: html`<div class="card">${rows.length ? html`<ul class="items">${rows.map((h: any) => html`<li><div class="row"><b class="grow">${h.company_name}</b><span class="badge">${h.status === 'OPEN' ? 'Offen bei Kai' : h.status === 'ACCEPTED' ? 'Übernommen' : 'Erledigt'}</span></div><small>${HANDOFF_LABEL[h.reason as keyof typeof HANDOFF_LABEL]} · ${when(h.created_at)}</small><div class="note">${h.note}</div>${h.handled_note ? html`<small>Rückmeldung: ${h.handled_note}</small>` : ''}</li>`)}</ul>` : html`<p class="mute">Noch keine Übergaben.</p>`}</div>` });
  } },
  { method: 'GET', path: /^\/work\/training$/, h: async (r) => render(r, { title: 'Training', nav: 'work', crumbs: [['🏠 Mein Tag', '/work'], ['Training']], back: ['← Zu Mein Tag', '/work'], body: html`<div class="note"><b>Trainingsmodus:</b> Hier gibt es nur erfundene Firmen. Es wird kein echter Lead angezeigt oder kontaktiert, nichts wird gespeichert.</div>
      <div class="card"><ul class="items">${TRAINING.map((c) => html`<li><a class="btn" style="display:flex" href="/work/training/${c.id}">${c.company} – ${c.branch}</a></li>`)}</ul></div>
      <div class="card"><h2>Playbooks</h2><ul>${PLAYBOOKS.map((p) => html`<li><b>${p.title}</b> – ${p.goal}</li>`)}</ul></div>` }) },
  { method: 'GET', path: /^\/work\/training\/(t\d+)$/, h: async (r) => {
    const c = TRAINING.find((x) => x.id === r.params[0]); if (!c) return render(r, { title: 'Nicht gefunden', nav: 'work', status: 404, body: html`<p>Trainingsfall nicht gefunden.</p>` });
    const o = Number(r.url.searchParams.get('o') ?? -1); const ob = c.objections[o]; const pb = playbookById(c.playbook)!;
    return render(r, { title: `Training: ${c.company}`, nav: 'work', crumbs: [['🏠 Mein Tag', '/work'], ['Training', '/work/training'], [c.company]], back: ['← Zum Training', '/work/training'], body: html`<div class="note">Übung mit einer erfundenen Firma – kein echter Kontakt.</div>
      <div class="card"><p><b>Situation:</b> ${c.situation}</p><p><b>Playbook:</b> ${pb.title} – Ziel: ${pb.goal}</p><p><b>Gesprächseinstieg:</b> ${c.opener.replace('{Name}', r.user.name)}</p></div>
      <div class="card"><h2>Einwand auswählen</h2><div class="row">${c.objections.map((x, i) => html`<a class="btn ${o === i ? 'primary' : ''}" href="/work/training/${c.id}?o=${i}">${x.q}</a>`)}</div>
        ${ob ? html`<p><b>Antwort:</b> ${ob.a}</p><p><b>Nächster Schritt:</b> ${ob.next}</p>` : html`<p class="mute">Wähle einen Einwand, um die Antwort und den nächsten Schritt zu sehen.</p>`}</div>` });
  } },
];
