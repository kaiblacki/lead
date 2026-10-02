import type { Route } from '../types.ts';
import { UserError } from '../types.ts';
import { html, raw, eur, fmt, fmtDate, postForm } from '../ui.ts';
import { render, redirect, okFlash, uuid } from './_page.ts';
import { CRITERIA, CRITERIA_LABEL, PARTNER_LABEL, PARTNER_STATUSES, REFERRAL_CONTACT_FIELDS, REFERRAL_DEFAULT_FIELDS, REFERRAL_FIELDS, REFERRAL_FIELD_LABEL, REFERRAL_STATUS_LABEL, checkTransition, nextPartnerStatuses, type PartnerStatus, type ReferralField } from '../../partners/model.ts';

const id = uuid.source;
const wrap = async <T>(f: () => Promise<T>): Promise<T> => { try { return await f(); } catch (e) { throw new UserError(e instanceof Error ? e.message : String(e)); } };
const badge = (s: string) => html`<span class="badge ${s === 'ACTIVE_PARTNER' ? 'b-ok' : s === 'PAUSED_PARTNER' || s === 'ENDED_PARTNER' ? 'b-warn' : 'b-info'}">${PARTNER_LABEL[s as PartnerStatus] ?? s}</span>`;
const FIELDS: [string, string][] = [['company_name', 'Unternehmen'], ['contact_person', 'Ansprechpartner'], ['industry', 'Branche'], ['region', 'Region'], ['radius_km', 'Tätigkeitsradius (km)'], ['phone', 'Telefon'], ['email', 'E-Mail'], ['website', 'Website'], ['started_at', 'Startdatum (JJJJ-MM-TT)']];
const TEXTS: [string, string][] = [['services', 'Leistungen'], ['preferred_customer_types', 'Bevorzugte Kundentypen'], ['interesting_leads', 'Welche Leads sind interessant?'], ['uninteresting_leads', 'Welche Leads sind nicht interessant?'], ['referral_preferences', 'Referral-Präferenzen'], ['notes', 'Notizen']];

export const referralTable = (rows: any[], csrf: string) => rows.length ? html`<div class="scroll"><table class="tbl"><tr><th>Richtung</th><th>Lead / Firma</th><th>Von → An</th><th>Status</th><th>Ergebnis</th><th>Wert</th><th></th></tr>${rows.map((r) => html`<tr>
  <td>${r.direction === 'OUTGOING' ? 'Ausgehend' : 'Eingehend'}</td><td>${r.lead_id ? html`<a href="/leads/${r.lead_id}">${r.lead_name ?? r.company_name}</a>` : r.company_name ?? '–'}</td>
  <td>${r.source_name ?? 'Agentur'} → ${r.destination_name ?? 'Agentur'}</td><td>${REFERRAL_STATUS_LABEL[r.status] ?? r.status}</td>
  <td>${r.accepted ? 'angenommen · ' : ''}${r.contacted ? 'kontaktiert · ' : ''}${r.converted ? 'Abschluss' : '–'}</td><td>${r.estimated_value_cents ? eur(r.estimated_value_cents) : '–'}</td><td><a href="/referrals/${r.id}">öffnen</a></td></tr>`)}</table></div>` : html`<p class="mute">Noch keine Referrals.</p>`;

export const routes: Route[] = [
  { method: 'GET', path: /^\/partners$/, h: async (r) => {
    const f = r.url.searchParams.get('f') ?? ''; const status = f === 'candidates' ? ['PARTNER_CANDIDATE', 'PARTNER_DISCUSSION', 'PARTNER_APPROVED'] as PartnerStatus[] : f === 'active' ? ['ACTIVE_PARTNER'] as PartnerStatus[] : f === 'other' ? ['PAUSED_PARTNER', 'ENDED_PARTNER'] as PartnerStatus[] : undefined;
    const rows = await r.ctx.partners.list({ status, q: r.url.searchParams.get('q') || undefined });
    return render(r, { title: 'Partner', nav: 'partners', body: html`
      <div class="note">Partnerschaft ist ein <b>eigenständiges Kooperationsmodell</b> (gegenseitige Empfehlungen). Sie hängt weder von einem Versicherungsabschluss noch von einem Website-Kauf ab. Partnerbedingungen vor Verwendung rechtlich prüfen lassen.</div>
      <div class="row chips">${[['', 'Alle'], ['candidates', 'Kandidaten'], ['active', 'Aktive Partner'], ['other', 'Pausiert / beendet']].map(([k, l]) => html`<a class="btn ${f === k ? 'primary' : ''}" href="/partners${k ? `?f=${k}` : ''}">${l}</a>`)}<a class="btn" href="/referrals">Referrals</a><a class="btn" href="/community">Community</a></div>
      <div class="card">${rows.length ? html`<div class="scroll"><table class="tbl"><tr><th>Unternehmen</th><th>Branche</th><th>Region</th><th>Status</th><th>Ansprechpartner</th><th>Ausgehend</th><th>Eingehend</th></tr>${rows.map((p: any) => html`<tr><td><a href="/partners/${p.id}"><b>${p.company_name}</b></a></td><td>${p.industry ?? '–'}</td><td>${p.region ?? '–'}</td><td>${badge(p.status)}</td><td>${p.contact_person ?? '–'}</td><td>${p.outgoing}</td><td>${p.incoming}</td></tr>`)}</table></div>` : html`<p class="mute">Keine Partner in dieser Ansicht. Kandidaten entstehen aus einem Lead („Als Partner-Kandidat vormerken“ auf der Lead-Seite) oder hier manuell.</p>`}</div>
      <details class="card"><summary>Neuen Partner manuell anlegen</summary>${postForm(r.app.csrf, '/partners', html`<label>Unternehmen<input name="company_name" required maxlength="200"></label><label>Branche<input name="industry"></label><label>Region / Ort<input name="region"></label><p><button class="primary">Als Kandidat anlegen</button></p>`, { style: 'display:block' })}</details>` });
  } },
  { method: 'POST', path: /^\/partners$/, h: async (r) => { const pid = await wrap(() => r.ctx.partners.create({ company_name: r.form.get('company_name'), industry: r.form.get('industry') ?? undefined, region: r.form.get('region') ?? undefined })); return redirect(`/partners/${pid}`, okFlash('Partner-Kandidat angelegt.')); } },

  { method: 'GET', path: new RegExp(`^/partners/${id}$`), h: async (r) => {
    const p = await r.ctx.partners.get(r.params[0]); if (!p) return render(r, { title: 'Nicht gefunden', nav: 'partners', status: 404, body: html`<p>Partner nicht gefunden.</p>` });
    const [stats, refs, log] = await Promise.all([r.ctx.partners.stats(p.id), r.ctx.partners.referrals({ partnerId: p.id }), r.ctx.partners.log(p.id)]);
    const crit = p.criteria ?? {};
    return render(r, { title: p.company_name, nav: 'partners', body: html`
      <div class="card"><div class="row"><b>Status:</b> ${badge(p.status)}${p.started_at ? html`<small>seit ${fmtDate(p.started_at)}</small>` : ''}${p.lead_id ? html`<a class="btn" href="/leads/${p.lead_id}">Zum Lead</a>` : ''}<span class="grow"></span><a class="btn" href="/partners">← Partner</a></div>
        <p class="mute">Community: ${p.community_status === 'MEMBER' ? 'Mitglied' : p.community_status === 'INVITED' ? 'eingeladen' : 'kein Mitglied'}${p.status === 'ACTIVE_PARTNER' ? ' · aktive Partner zahlen keine Community-Gebühr' : ''}</p>
        <div class="grid"><div class="kpi"><b>${stats.outgoing}</b><span>Leads übermittelt</span></div><div class="kpi"><b>${stats.incoming}</b><span>Leads erhalten</span></div><div class="kpi"><b>${stats.conversations}</b><span>Gespräche</span></div><div class="kpi"><b>${stats.orders}</b><span>Aufträge</span></div><div class="kpi"><b>${eur(stats.value_cents)}</b><span>Wert (Abschlüsse)</span></div></div>
        <small class="mute">Letzte Aktivität: ${fmt(stats.last_activity)}</small></div>

      <div class="card" id="status"><h2>Partnerstatus</h2>
        ${postForm(r.app.csrf, `/partners/${p.id}/criteria`, html`<p class="mute">Kriterien einer Kooperation (nicht: Versicherungsabschluss):</p>${CRITERIA.map((c) => html`<label class="inline"><input type="checkbox" name="crit" value="${c}" ${crit[c] ? raw('checked') : ''}> ${CRITERIA_LABEL[c]}</label>`)}<p><button>Kriterien speichern</button></p>`, { style: 'display:block' })}
        <div class="row">${nextPartnerStatuses(p.status as PartnerStatus).map((to) => { const chk = checkTransition(p.status, to, crit, { contactPerson: p.contact_person }); return postForm(r.app.csrf, `/partners/${p.id}/status`, html`<input type="hidden" name="to" value="${to}"><button ${chk.ok ? raw('') : raw('disabled')} title="${chk.ok ? '' : chk.reason}">→ ${PARTNER_LABEL[to]}</button>`); })}</div>
        ${nextPartnerStatuses(p.status as PartnerStatus).some((to) => !checkTransition(p.status, to, crit, { contactPerson: p.contact_person }).ok) ? html`<small class="mute">Ausgegraute Schritte: Voraussetzung fehlt (Mauszeiger darauf). Aktiver Partner: Kooperationsvereinbarung + Ansprechpartner.</small>` : ''}</div>

      <div class="card"><h2>Profil</h2>${postForm(r.app.csrf, `/partners/${p.id}`, html`
        ${FIELDS.map(([k, l]) => html`<label>${l}<input name="${k}" value="${p[k] ? (k === 'started_at' ? String(p.started_at.toISOString?.().slice(0, 10) ?? p.started_at) : p[k]) : ''}"></label>`)}
        <label>Bevorzugte Lead-Branchen (kommagetrennt, z. B. friseur, nagelstudio – für „Passender Partner“)<input name="lead_industries" value="${(p.lead_industries ?? []).join(', ')}"></label>
        ${TEXTS.map(([k, l]) => html`<label>${l}<textarea name="${k}" rows="2" maxlength="4000">${p[k] ?? ''}</textarea></label>`)}
        <label>Community-Status<select name="community_status">${['NONE', 'INVITED', 'MEMBER'].map((c) => html`<option value="${c}" ${p.community_status === c ? raw('selected') : ''}>${c}</option>`)}</select></label>
        <p><button class="primary">Speichern</button></p>`, { style: 'display:block' })}</div>

      <div class="card"><h2>Referrals</h2>${referralTable(refs, r.app.csrf)}
        <details><summary>Empfehlung dieses Partners an uns eintragen</summary>${postForm(r.app.csrf, `/partners/${p.id}/incoming`, html`<label>Firma<input name="company" required></label><label>Notiz<textarea name="notes" rows="2"></textarea></label><label>Geschätzter Wert (€, optional)<input name="value" inputmode="decimal"></label><p><button>Eintragen</button></p>`, { style: 'display:block' })}</details></div>
      <details class="card"><summary>Verlauf</summary><ul>${log.map((l: any) => html`<li>${fmt(l.at)}: ${l.from_status ? PARTNER_LABEL[l.from_status as PartnerStatus] : '–'} → ${PARTNER_LABEL[l.to_status as PartnerStatus]}${l.reason ? ` (${l.reason})` : ''}</li>`)}</ul></details>` });
  } },
  { method: 'POST', path: new RegExp(`^/partners/${id}$`), h: async (r) => { const patch: Record<string, unknown> = {}; for (const [k] of [...FIELDS, ...TEXTS, ['lead_industries'], ['community_status']]) if (r.form.has(k)) patch[k] = r.form.get(k); await wrap(() => r.ctx.partners.update(r.params[0], patch)); return redirect(`/partners/${r.params[0]}`, okFlash('Partnerprofil gespeichert.')); } },
  { method: 'POST', path: new RegExp(`^/partners/${id}/criteria$`), h: async (r) => { const c: Record<string, boolean> = {}; for (const k of r.form.getAll('crit')) c[k] = true; await wrap(() => r.ctx.partners.setCriteria(r.params[0], c)); return redirect(`/partners/${r.params[0]}#status`, okFlash('Kriterien gespeichert.')); } },
  { method: 'POST', path: new RegExp(`^/partners/${id}/status$`), h: async (r) => { const to = r.form.get('to') as PartnerStatus; if (!PARTNER_STATUSES.includes(to)) throw new UserError('Unbekannter Partnerstatus.'); await wrap(() => r.ctx.partners.setStatus(r.params[0], to, r.form.get('reason') ?? '')); return redirect(`/partners/${r.params[0]}#status`, okFlash(`Partnerstatus: ${PARTNER_LABEL[to]}.`)); } },
  { method: 'POST', path: new RegExp(`^/partners/${id}/incoming$`), h: async (r) => { const v = (r.form.get('value') ?? '').replace(',', '.').trim(); const cents = v ? Math.round(Number(v) * 100) : null; if (v && !Number.isFinite(cents)) throw new UserError('Wert ungültig.'); await wrap(() => r.ctx.partners.recordIncoming(r.params[0], { companyName: r.form.get('company') ?? '', notes: r.form.get('notes') ?? undefined, estimatedValueCents: cents })); return redirect(`/partners/${r.params[0]}`, okFlash('Eingehende Empfehlung eingetragen.')); } },

  { method: 'GET', path: /^\/referrals$/, h: async (r) => render(r, { title: 'Referrals', nav: 'partners', body: html`<div class="note">Leads werden <b>nie automatisch</b> weitergegeben: erst Empfänger und Daten prüfen, Rechtsgrundlage dokumentieren, bestätigen – und dann selbst weitergeben.</div><div class="card">${referralTable(await r.ctx.partners.referrals(), r.app.csrf)}</div><p><a class="btn" href="/partners">← Partner</a></p>` }) },
  { method: 'GET', path: new RegExp(`^/referrals/${id}$`), h: async (r) => {
    const ref = await r.ctx.partners.referralById(r.params[0]); if (!ref) return render(r, { title: 'Nicht gefunden', nav: 'partners', status: 404, body: html`<p>Referral nicht gefunden.</p>` });
    const dest = ref.destination_partner_id ? await r.ctx.partners.get(ref.destination_partner_id) : null;
    const snap = ref.shared_fields ?? {}; const full = ref.lead_id ? await r.ctx.partners.payload(ref.lead_id, [...REFERRAL_FIELDS].filter((f) => f !== 'note') as ReferralField[]) : {};
    return render(r, { title: 'Referral', nav: 'partners', body: html`
      <div class="card"><div class="row"><b class="grow">${ref.company_name ?? 'Lead'}</b><span class="badge b-info">${REFERRAL_STATUS_LABEL[ref.status] ?? ref.status}</span></div>
        <p><b>Empfänger:</b> ${dest ? html`<a href="/partners/${dest.id}">${dest.company_name}</a> (${PARTNER_LABEL[dest.status as PartnerStatus]})` : '–'}${ref.lead_id ? html` · Lead: <a href="/leads/${ref.lead_id}">${ref.company_name}</a>` : ''}</p></div>
      ${ref.status === 'PROPOSED' ? html`<div class="card"><h2>Weitergabe prüfen und bestätigen</h2>
        <div class="warnbox">Es wird <b>nichts automatisch gesendet</b>. Personenbezogene Daten dürfen nur mit Rechtsgrundlage/Zustimmung weitergegeben werden. Kontaktwege sind standardmäßig nicht ausgewählt.</div>
        ${postForm(r.app.csrf, `/referrals/${ref.id}/confirm`, html`<p><b>Diese Angaben würden übermittelt (bitte auswählen):</b></p>
          ${REFERRAL_FIELDS.filter((f) => f !== 'note').map((f) => html`<label class="inline"><input type="checkbox" name="field" value="${f}" ${REFERRAL_DEFAULT_FIELDS.includes(f) ? raw('checked') : ''}> <b>${REFERRAL_FIELD_LABEL[f]}</b>${REFERRAL_CONTACT_FIELDS.includes(f) ? ' (Kontaktweg)' : ''}: ${(full as Record<string, string>)[f] ?? 'nicht verfügbar'}</label>`)}
          <label>Kurznotiz an den Partner (optional, wird mit übermittelt)<input name="note" maxlength="300"></label>
          <label>Rechtsgrundlage / Zustimmung (Pflicht, z. B. „Inhaber hat am … im Telefonat zugestimmt“)<textarea name="legal_basis" rows="2" required minlength="10"></textarea></label>
          <label class="inline"><input type="checkbox" name="reviewed" value="1"> Ich habe Empfänger und übermittelte Daten geprüft.</label>
          <p><button class="primary">Weitergabe bestätigen</button></p>`, { style: 'display:block' })}
        ${postForm(r.app.csrf, `/referrals/${ref.id}/cancel`, html`<button>Abbrechen</button>`)}</div>` : ''}
      ${['CONFIRMED', 'SENT', 'CLOSED'].includes(ref.status) ? html`<div class="card"><h2>Übermittelte Daten</h2><dl class="facts">${Object.entries(snap).map(([k, v]) => html`<dt>${REFERRAL_FIELD_LABEL[k as ReferralField] ?? k}</dt><dd>${String(v)}</dd>`)}</dl><p class="mute">Rechtsgrundlage: ${ref.legal_basis ?? '–'} · bestätigt ${fmt(ref.confirmed_at)}${ref.sent_at ? ` · weitergegeben ${fmt(ref.sent_at)}` : ''}</p>
        ${ref.status === 'CONFIRMED' ? html`<p>Gib die Angaben jetzt selbst an den Partner weiter (z. B. per Telefon) und markiere dann:</p>${postForm(r.app.csrf, `/referrals/${ref.id}/sent`, html`<button class="primary">Ich habe weitergegeben</button>`)}${postForm(r.app.csrf, `/referrals/${ref.id}/cancel`, html`<button>Abbrechen</button>`)}` : ''}</div>` : ''}
      ${['SENT', 'CLOSED'].includes(ref.status) || ref.direction === 'INCOMING' ? html`<div class="card"><h2>Ergebnis</h2>${postForm(r.app.csrf, `/referrals/${ref.id}/outcome`, html`
        <label class="inline"><input type="checkbox" name="accepted" value="1" ${ref.accepted ? raw('checked') : ''}> angenommen</label><label class="inline"><input type="checkbox" name="contacted" value="1" ${ref.contacted ? raw('checked') : ''}> kontaktiert</label><label class="inline"><input type="checkbox" name="converted" value="1" ${ref.converted ? raw('checked') : ''}> Abschluss</label>
        <label>Geschätzter Wert (€)<input name="value" inputmode="decimal" value="${ref.estimated_value_cents ? String(ref.estimated_value_cents / 100).replace('.', ',') : ''}"></label><label>Notizen<textarea name="notes" rows="2">${ref.notes ?? ''}</textarea></label>
        <p><button class="primary">Speichern</button></p>`, { style: 'display:block' })}${ref.status === 'SENT' ? postForm(r.app.csrf, `/referrals/${ref.id}/close`, html`<button>Referral abschließen</button>`) : ''}</div>` : ''}
      <p><a class="btn" href="/referrals">← Referrals</a></p>` });
  } },
  { method: 'POST', path: new RegExp(`^/referrals/${id}/confirm$`), h: async (r) => { const out = await wrap(() => r.ctx.partners.confirm(r.params[0], { fields: r.form.getAll('field'), legalBasis: r.form.get('legal_basis') ?? '', reviewed: r.form.get('reviewed') === '1', note: r.form.get('note') ?? undefined })); return redirect(`/referrals/${r.params[0]}`, okFlash(`Weitergabe bestätigt. ${out.containsContact ? 'Achtung: Kontaktwege sind enthalten. ' : ''}Es wurde nichts gesendet – gib die Angaben selbst weiter.`)); } },
  { method: 'POST', path: new RegExp(`^/referrals/${id}/sent$`), h: async (r) => { await wrap(() => r.ctx.partners.markSent(r.params[0])); return redirect(`/referrals/${r.params[0]}`, okFlash('Als weitergegeben markiert.')); } },
  { method: 'POST', path: new RegExp(`^/referrals/${id}/cancel$`), h: async (r) => { await wrap(() => r.ctx.partners.cancel(r.params[0])); return redirect('/referrals', okFlash('Referral abgebrochen.')); } },
  { method: 'POST', path: new RegExp(`^/referrals/${id}/close$`), h: async (r) => { await wrap(() => r.ctx.partners.close(r.params[0])); return redirect(`/referrals/${r.params[0]}`, okFlash('Referral abgeschlossen.')); } },
  { method: 'POST', path: new RegExp(`^/referrals/${id}/outcome$`), h: async (r) => { const v = (r.form.get('value') ?? '').replace(',', '.').trim(); const cents = v ? Math.round(Number(v) * 100) : null; if (v && !Number.isFinite(cents)) throw new UserError('Wert ungültig.');
    await wrap(() => r.ctx.partners.setOutcome(r.params[0], { accepted: r.form.get('accepted') === '1', contacted: r.form.get('contacted') === '1', converted: r.form.get('converted') === '1', estimatedValueCents: cents, notes: r.form.get('notes') ?? undefined })); return redirect(`/referrals/${r.params[0]}`, okFlash('Ergebnis gespeichert.')); } },
];
