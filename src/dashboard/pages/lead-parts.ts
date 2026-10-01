import { enrichment, orNA, NA, sourceLabel } from '../../core/enrichment.ts';
import { html, raw, type Safe, categoryBadge, eur, fmt, fmtDate, mockBadge, postBtn, postForm, prioBadge, readinessBadge, scoreBar, statusBadge, STATE_TEXT } from '../ui.ts';
import { FACT_LABELS, FACT_ORDER, findConflicts, type Fact, type FactKey } from '../../core/profile.ts';
import { DIM_LABELS, DIM_ORDER } from '../../scoring/intelligence.ts';
import { STATUSES, nextStatuses, type Status } from '../../core/status.ts';
import { CALL_LABEL, CALL_RESULTS } from '../../calls/service.ts';
import { STATUS_ICON, type CheckCategory } from '../../audit/types.ts';

const CAT_LABEL: Record<string, string> = { technical: 'Technik', mobile: 'Mobil & responsiv', design: 'Design & Struktur', content: 'Inhalt', conversion: 'Kontakt & Conversion', seo: 'SEO-Grundlagen', social: 'Social Links', trust: 'Vertrauen & Rechtliches' };
const QUALITY_TEXT: Record<string, string> = { high: 'hoch', medium: 'mittel', low: 'niedrig' };
const WEB_STATE: Record<string, string> = { none: 'Website fehlt', exists: 'Website vorhanden', needs_improvement: 'Website verbesserungswürdig', fine: 'Website in Ordnung', unknown: 'Website nicht prüfbar' };
const CHANNEL_TEXT: Record<string, string> = { PHONE: 'Telefon', EMAIL: 'E-Mail', WHATSAPP: 'WhatsApp', MANUAL: 'Manuell', DO_NOT_CONTACT: 'Nicht kontaktieren' };

/** Einklappbarer Abschnitt – hält die Detailseite auf dem Smartphone übersichtlich. */
const fold = (title: string, body: Safe, open = false, id?: string) => html`<details class="card" ${id ? raw(`id="${id}"`) : ''} ${open ? raw('open') : ''}><summary><h2 style="margin:0">${title}</h2></summary>${body}</details>`;

export const webStateText = (s: string | null | undefined) => WEB_STATE[s ?? ''] ?? '–';

export function header(d: any, csrf: string): Safe {
  const l = d.lead, o = d.opportunity;
  return html`<div class="card">
    <div class="row"><h2 class="grow" style="margin:0">${l.company_name}</h2>${l.is_mock ? mockBadge : ''}</div>
    <p>${l.address && l.postal_code && String(l.address).includes(l.postal_code) ? l.address : [l.address, [l.postal_code, l.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')} ${l.distance_km ? html`<small>· ${Number(l.distance_km).toFixed(1).replace('.', ',')} km</small>` : ''}</p>
    <div class="row">${categoryBadge(o?.category)}${statusBadge(l.status)}${readinessBadge(l.contact_readiness)}<span class="badge">${webStateText(l.website_state)}</span>${l.paused ? html`<span class="badge b-warn">pausiert</span>` : ''}</div>
    <div class="grid" style="margin-top:10px"><div class="kpi"><b>${o?.score ?? '–'}</b><span>Sales Opportunity</span></div><div class="kpi"><b>${o?.digital_need ?? '–'}</b><span>Digital Need</span></div>
      <div class="kpi"><b>${d.sales?.brief?.priority ?? '–'}</b><span>Priorität</span></div><div class="kpi"><b>${l.call_count}</b><span>Anrufe</span></div></div>
    ${(() => { const en = enrichment(l); const dq = o?.dimensions?.dataQuality?.value; return html`<dl class="facts"><dt>Telefon</dt><dd>${l.phone ? html`<a class="tel" href="tel:${String(l.phone).replace(/[^\d+]/g, '')}">${l.phone}</a>` : NA}</dd>
      <dt>Website</dt><dd>${l.website_url ? html`<code>${l.website_url}</code>` : NA}</dd><dt>E-Mail</dt><dd>${orNA(l.email)}</dd><dt>Branche</dt><dd>${orNA(l.sub_industry ?? l.industry)}</dd>
      <dt>Quelle</dt><dd>${sourceLabel(l.source)}</dd><dt>Datenqualität</dt><dd>${dq !== undefined && dq !== null ? `${Math.round(dq)}/100` : NA}</dd></dl>
      ${en.needed ? html`<div class="warnbox"><b>${en.label}</b> – fehlt: ${en.missing.join(' · ')}.<br><small>Der Lead bleibt gespeichert. Weitere zulässige Quellen können die Lücken später füllen; bis dahin wird nichts geraten.</small></div>` : ''}`; })()}
    <div class="row">${l.paused ? postBtn(csrf, `/leads/${l.id}/resume`, 'Fortsetzen', { cls: 'ok' }) : postBtn(csrf, `/leads/${l.id}/pause`, 'Pausieren')}
      ${postBtn(csrf, `/leads/${l.id}/reanalyze`, 'Neu analysieren (Retry)')}${postBtn(csrf, `/leads/${l.id}/reanalyze`, 'Tiefenprüfung (Browser)', { hidden: { deep: '1' } })}${postBtn(csrf, `/leads/${l.id}/reject`, 'Ablehnen', { cls: 'danger' })}</div></div>`;
}

export function why(d: any): Safe {
  const o = d.opportunity;
  if (!o) return html`<div class="card"><h2>Warum ist dieser Lead interessant?</h2><p class="mute">Noch nicht analysiert.</p></div>`;
  const why = (o.factors ?? []) as { text: string; points?: number }[];
  const contrib = o.contributions ?? {};
  const missing = (o.missing ?? []) as string[];
  const row = (c: any) => html`<tr><td>${c.label}${c.state === 'unreliable' ? html` <small>(halbes Gewicht, nicht zuverlässig)</small>` : ''}</td><td>${Math.round(c.value)}</td><td>${Math.round(c.weight * 100) / 100}</td><td><b>+${c.points}</b></td></tr>`;
  return html`<div class="card"><h2>Warum ist dieser Lead interessant?</h2>
    ${o.note ? html`<p class="note">${o.note}</p>` : ''}
    ${why.length ? html`<ol>${why.map((w) => html`<li>${w.text} ${w.points ? html`<b>(+${w.points})</b>` : ''}</li>`)}</ol>` : html`<p class="mute">Keine Begründung verfügbar (Lead nicht bewertbar).</p>`}
    ${missing.length ? html`<details><summary>Nicht verfügbar / nicht zuverlässig ermittelbar (${missing.length})</summary><ul>${missing.map((m) => html`<li>${m}</li>`)}</ul></details>` : ''}
    <details><summary>So entsteht der Score</summary>
      <h3>Digital Need ${o.digital_need ?? '–'}</h3><div class="scroll"><table><tr><th>Dimension</th><th>Wert</th><th>Gewicht</th><th>Beitrag</th></tr>${(contrib.digitalNeed?.contributions ?? []).map(row)}</table></div>
      <h3>Sales Opportunity ${o.score ?? '–'}</h3><div class="scroll"><table><tr><th>Baustein</th><th>Wert</th><th>Gewicht</th><th>Beitrag</th></tr>${(contrib.sales ?? []).map(row)}</table></div>
      <p class="mute">Datenqualitätsfaktor ${String(o.data_quality_factor ?? '–').replace('.', ',')} (Lücken in den Daten senken den Score leicht). Gewichte und Schwellen sind in den Einstellungen änderbar.</p></details></div>`;
}

export function dimensions(d: any): Safe {
  const dims = d.opportunity?.dimensions;
  if (!dims) return html``;
  return fold('Bewertungsdimensionen (11)', html`<ul class="items">${DIM_ORDER.map((k) => { const x = dims[k]; if (!x) return html``; return html`<li><details><summary><span class="grow">${DIM_LABELS[k]}</span> <b>${x.value ?? '–'}</b> <small class="mute" style="margin-left:8px">${STATE_TEXT[x.state]}</small></summary>${scoreBar(x.value)}<ul>${(x.reasons ?? []).map((r: any) => html`<li>${r.text} ${r.points ? html`<small>(${r.points > 0 ? '+' : ''}${r.points})</small>` : ''}</li>`)}</ul></details></li>`; })}</ul>`);
}

export function sales(d: any, csrf: string, id: string): Safe {
  const s = d.sales, b = s?.brief;
  if (!b) return html`<div class="card"><h2>Verkaufsgrundlage</h2><p class="mute">Noch keine Verkaufsgrundlage (Lead nicht bewertbar oder noch nicht analysiert).</p></div>`;
  const v = b.valueRange;
  return html`<div class="card"><div class="row"><h2 class="grow">Verkaufsgrundlage</h2>${prioBadge(b.priority)}</div><p><b>${b.priorityLabel}</b></p>
    <h3>Die wichtigsten Verkaufsgründe</h3><ol>${b.reasons.map((r: any) => html`<li>${r.text}<br><small class="mute">Beleg: ${r.evidence}</small></li>`)}</ol>
    <h3>Mögliche Leistung</h3><p><b>${b.service.name}</b> – ${eur(b.service.priceCents)} einmalig (laut Preisliste)</p>
    ${b.service.upsells.length ? html`<ul>${b.service.upsells.map((u: any) => html`<li>Zusatz: ${u.label} <small class="mute">(${u.reason})</small></li>`)}</ul>` : ''}
    <div class="note"><b>Möglicher Auftragswert: ${eur(v.lowCents)} – ${eur(v.highCents)}</b> <span class="badge b-warn">${v.label}</span>
      <details><summary>Wie geschätzt?</summary><ul>${v.breakdown.map((x: string) => html`<li>${x}</li>`)}</ul><small>Nur eine Schätzung auf Basis der Preisliste, kein Angebot.</small></details></div>
    <h3>Gesprächseinstieg ${s.opener_source === 'ai' ? html`<span class="badge b-info">KI-formuliert (nur belegte Fakten)</span>` : s.opener_source === 'manual' ? html`<span class="badge b-info">von dir bearbeitet</span>` : html`<span class="badge">Regeltext</span>`}
      ${s.approved_at ? html`<span class="badge b-ok">freigegeben ${fmtDate(s.approved_at)}</span>` : html`<span class="badge b-warn">nicht freigegeben</span>`}</h3>
    ${postForm(csrf, `/leads/${id}/opener`, html`<textarea name="opener" rows="5" maxlength="1500">${s.opener}</textarea><div class="row"><button>Speichern (erfordert neue Freigabe)</button></div>`, { style: 'display:block' })}
    ${s.approved_at ? '' : postBtn(csrf, `/leads/${id}/brief/approve`, 'Einstieg freigeben', { cls: 'ok' })}
    <h3>Mögliche Einwände</h3><ul>${b.objections.map((o: any) => html`<li><b>${o.objection}</b><br>${o.response}</li>`)}</ul>
    <h3>Passende nächste Aktion</h3><p>${b.nextAction.text}</p></div>`;
}

export function contact(d: any, csrf: string, id: string, settings: { phoneEnabled: boolean }, mockMode: boolean): Safe {
  const l = d.lead;
  const history = d.history as any[];
  const a = d.assessment as any;
  return html`<div class="card" id="kontakt"><h2>Kontaktstrategie</h2>
    <div class="row"><span class="badge b-info">Empfehlung: ${CHANNEL_TEXT[l.contact_channel] ?? '–'}</span>${readinessBadge(l.contact_readiness)}</div>
    <p><b>Grund:</b> ${l.contact_reason ?? '–'}</p>
    ${a?.warnings?.length ? a.warnings.map((w: string) => html`<div class="warnbox">${w}</div>`) : ''}
    ${a?.channels?.length ? html`<ul class="items">${a.channels.map((c: any) => html`<li><div class="row"><b>${CHANNEL_TEXT[c.channel]}</b>${readinessBadge(c.readiness)}</div><small class="mute">${c.reason}</small></li>`)}</ul>` : ''}
    ${a?.legal?.length ? html`<details><summary>Rechtliche Hinweise</summary><ul>${a.legal.map((t: string) => html`<li>${t}</li>`)}</ul><small>Keine Rechtsberatung. Es wird nichts automatisch gesendet.</small></details>` : ''}
    ${!settings.phoneEnabled ? html`<div class="warnbox">Telefonakquise ist noch nicht freigegeben – <a href="/settings#telefon">Einstellungen</a>.</div>` : ''}
    ${l.contact_readiness === 'DO_NOT_CONTACT' ? html`<p class="errbox">Gesperrt. Anruf-Ergebnisse und Nachrichten sind deaktiviert.</p>` : html`
      <h3>Anruf-Ergebnis erfassen</h3>
      ${postForm(csrf, `/leads/${id}/call`, html`<label>Notiz<textarea name="note" rows="2" maxlength="4000" placeholder="Kurze Notiz zum Gespräch"></textarea></label>
        <label>Rückruf am (nur bei „Rückruf“)<input type="datetime-local" name="callback"></label>
        <div class="resgrid" style="margin-top:8px">${CALL_RESULTS.map((r) => html`<button name="result" value="${r}" class="${r === 'DO_NOT_CONTACT' ? 'danger' : r === 'BOUGHT' ? 'ok' : r === 'INTERESTED' || r === 'DEMO' || r === 'OFFER' ? 'primary' : ''}">${CALL_LABEL[r]}</button>`)}</div>`, { style: 'display:block' })}`}
    <h3>Nachricht (nur wenn zulässig)</h3>
    <p class="mute">Nachrichten werden nur gesendet, wenn der Kanal aktiviert, eine Einwilligung dokumentiert und kein Sperrvermerk vorhanden ist. Sonst: „Manuelle Kontaktaufnahme erforderlich.“</p>
    <div class="row">${['EMAIL', 'WHATSAPP'].map((ch) => html`${postForm(csrf, `/leads/${id}/consent`, html`<input type="hidden" name="channel" value="${ch}"><input name="note" placeholder="Einwilligung ${ch === 'EMAIL' ? 'E-Mail' : 'WhatsApp'}: Nachweis" maxlength="500" required><button>Einwilligung erfasst</button>`, { style: 'display:block;width:100%' })}`)}</div>
    ${postForm(csrf, `/leads/${id}/send`, html`<div class="row"><select name="channel"><option value="EMAIL">E-Mail</option><option value="WHATSAPP">WhatsApp</option></select><input name="text" placeholder="Nachricht" maxlength="2000" required class="grow"><button>Senden (Prüfung)${mockMode ? ' – Mock' : ''}</button></div>`, { style: 'display:block' })}
    <h3>Kontakt-Historie</h3>${history.length ? html`<ul class="items">${history.map((h) => html`<li><small>${fmt(h.at)} · ${h.channel}${h.direction === 'outbound' ? ' ↗' : ''}</small><br><b>${CALL_LABEL[h.result as keyof typeof CALL_LABEL] ?? h.result ?? ''}</b> ${h.note ?? ''}${h.callback_at ? html`<br><small>Rückruf: ${fmt(h.callback_at)}</small>` : ''}</li>`)}</ul>` : html`<p class="mute">Noch kein Kontakt.</p>`}
</div>`;
}

export function profile(d: any): Safe {
  const facts = d.factsT as Fact[];
  const conflicts = findConflicts(facts);
  const byKey = new Map<FactKey, Fact[]>();
  for (const f of facts) { const a = byKey.get(f.key) ?? []; a.push(f); byKey.set(f.key, a); }
  const val = (f: Fact) => {
    const v = f.value as any;
    if (f.key === 'social') return `${v.platform}: ${v.url}${v.lastPostAt ? ` (letzter Beitrag ${fmtDate(v.lastPostAt)})` : ''}${v.followers ? `, ${v.followers} Follower` : ''}`;
    if (f.key === 'point') return `${v.lat}, ${v.lng}`;
    if (f.key === 'distanceKm') return `${String(v).replace('.', ',')} km`;
    if (f.key === 'isChain') return v ? 'ja' : 'nein';
    if (f.key === 'rating') return `${String(v).replace('.', ',')} von 5`;
    if (Array.isArray(v)) return v.join(' · ');
    return String(v);
  };
  const missing = (['phone', 'email', 'website', 'employeeBucket', 'locationsCount', 'rating', 'openingHours', 'services'] as FactKey[]).filter((k) => !byKey.has(k) && !(k === 'website' && byKey.has('social')));
  return fold('Unternehmensprofil mit Quellen', html`
    ${conflicts.length ? html`<div class="warnbox"><b>Quellen widersprechen sich</b><ul>${conflicts.map((c) => html`<li>${FACT_LABELS[c.key]}: ${c.values.map((x) => `${Array.isArray(x.value) ? (x.value as string[]).join(' · ') : x.value} (${x.source})`).join(' ≠ ')}</li>`)}</ul></div>` : ''}
    <div class="scroll"><table><tr><th>Angabe</th><th>Wert</th><th>Quelle</th><th>Erfasst</th><th>Qualität</th></tr>
      ${FACT_ORDER.filter((k) => byKey.has(k)).flatMap((k) => byKey.get(k)!.map((f, i) => html`<tr><td>${i === 0 ? FACT_LABELS[k] : ''}</td><td>${val(f)}${f.note ? html`<br><small class="mute">${f.note}</small>` : ''}</td><td>${f.source}</td><td>${fmtDate(f.capturedAt)}</td><td>${QUALITY_TEXT[f.quality]}</td></tr>`))}
      ${missing.map((k) => html`<tr><td>${FACT_LABELS[k]}</td><td colspan="4" class="mute">nicht verfügbar</td></tr>`)}</table></div>
    <p class="mute">Externe Angaben stammen aus den genannten Quellen und wurden nicht geprüft. Es werden keine Werte geschätzt oder erfunden.</p>`);
}

export function audit(d: any): Safe {
  const a = d.audit, checks = (d.checks ?? []) as any[];
  if (!a) return fold('Website-Audit', html`<p class="mute">Noch nicht geprüft.</p>`);
  const q = (a.quality ?? {}) as Record<string, number | null>;
  const cats = ['technical', 'mobile', 'design', 'content', 'conversion', 'seo', 'trust', 'social'] as CheckCategory[];
  return fold('Website-Audit', html`
    <p>${a.status === 'NO_WEBSITE' ? 'Keine Website hinterlegt – es gibt nichts zu prüfen.' : a.status === 'UNREACHABLE' ? 'Die Website war bei der Prüfung nicht erreichbar.' : html`Geprüft: ${a.pages_analyzed} Seite(n) · ${a.final_url ?? ''} · Abdeckung ${Math.round(Number(a.coverage ?? 0) * 100)} % · Gesamtqualität ${a.overall_quality ?? '–'}/100`}
      <br><small class="mute">Stand ${fmt(a.captured_at)} · Quelle ${a.source ?? '–'}${a.render_source ? ` · Browser: ${a.render_source.name}${a.render_source.estimated ? ' (geschätzt)' : ''}` : ''}</small></p>
    ${(a.notes ?? []).map((n: string) => html`<div class="note">${n}</div>`)}
    ${cats.map((c) => { const items = checks.filter((x) => x.category === c); if (!items.length) return html``; return html`<details ${items.some((x) => x.status === 'fail') ? raw('open') : ''}><summary><span class="grow">${CAT_LABEL[c]}</span><small class="mute">${q[c] === null || q[c] === undefined ? 'nicht prüfbar' : `${q[c]}/100`}</small></summary>
      <ul class="items">${items.map((x) => html`<li>${STATUS_ICON[x.status as keyof typeof STATUS_ICON]} <b>${x.summary}</b><br><small class="mute">Beleg: ${x.evidence}</small></li>`)}</ul></details>`; })}`);
}

export function docs(d: any, csrf: string, id: string, o: { demos: any[]; offer: any; order: any; templates: { key: string; label: string }[]; recommended: string; baseUrl: string }): Safe {
  const { demos, offer, order } = o;
  const off = offer?.content;
  const live = demos.filter((x) => !x.revoked && new Date(x.expires_at) > new Date());
  return fold('Demo, Angebot, Auftrag', html`
    <h3>Demo-Website</h3>
    ${postForm(csrf, `/leads/${id}/demo`, html`<div class="row"><select name="template"><option value="auto">Automatisch (${o.templates.find((t) => t.key === o.recommended)?.label ?? o.recommended})</option>${o.templates.map((t) => html`<option value="${t.key}">${t.label}</option>`)}</select><button class="primary">DEMO ERSTELLEN</button></div>`, { style: 'display:block' })}
    ${demos.length ? html`<ul class="items">${demos.map((x) => { const dead = x.revoked || new Date(x.expires_at) < new Date(); return html`<li>${dead ? html`<s>${x.template}</s> <small>(${x.revoked ? 'widerrufen' : 'abgelaufen'})</small>` : html`<a href="/d/${x.token}" target="_blank" rel="noopener noreferrer">${x.template} ansehen</a> <small>bis ${fmtDate(x.expires_at)} · ${x.view_count}× gesehen</small><br><small class="mute">Link: <code>${o.baseUrl}/d/${x.token}</code></small> ${postBtn(csrf, `/demos/${x.id}/revoke`, 'Widerrufen')}`}</li>`; })}</ul>` : ''}
    <p class="mute">Die Demo ist als „Unverbindliche Demo / Beispiel“ gekennzeichnet, nutzt nur Daten aus dem Lead und keine fremden Bilder.</p>
    <h3>Angebot</h3>
    ${postForm(csrf, `/leads/${id}/offer`, html`<button class="primary">ANGEBOT ERSTELLEN</button> ${live.length ? html`<small class="mute">verknüpft mit der aktuellen Demo</small>` : ''}`, { style: 'display:block' })}
    ${offer ? html`<div class="card flat"><div class="row"><b class="grow">${off.title}</b><span class="badge ${offer.status === 'DRAFT' ? 'b-warn' : 'b-ok'}">${offer.status}</span></div>
      <p>Kunde: <b>${off.customer?.name ?? ''}</b>${off.customer?.address ? html` · ${off.customer.address}` : ''}</p>
      <ul>${off.scope.map((x: string) => html`<li>${x}</li>`)}</ul>
      <table><tr><td>Preis</td><td><b>${eur(offer.price_cents)}</b></td></tr><tr><td>Anzahlung</td><td>${eur(offer.deposit_cents)}</td></tr><tr><td>Restzahlung (nach Freigabe)</td><td>${eur(offer.final_cents)}</td></tr><tr><td>Wartung (optional)</td><td>${eur(offer.maintenance_cents)}/Monat</td></tr></table>
      <p><small>Wartung: ${off.maintenanceScope.join(', ')} · Änderungsumfang: ${off.revisionRounds} Korrekturrunden · ${off.deliveryNote} · gültig bis ${off.validUntil} · ${off.vatNote}</small></p>
      ${off.optional?.length ? html`<p><small>Optional (nicht enthalten): ${off.optional.map((u: any) => `${u.label}${u.oneTimeCents ? ` ${eur(u.oneTimeCents)}` : ''}${u.monthlyCents ? ` ${eur(u.monthlyCents)}/Monat` : ''}`).join(' · ')}</small></p>` : ''}
      <p><small>${off.terms.join(' ')}</small></p>${off.warnings.map((w: string) => html`<div class="errbox">${w}</div>`)}
      <div class="row">${offer.status === 'DRAFT' ? postBtn(csrf, `/offers/${offer.id}/approve`, 'Freigeben', { cls: 'ok' }) : ''}${offer.status === 'APPROVED' ? postBtn(csrf, `/offers/${offer.id}/sent`, 'Als von mir versendet markieren') : ''}
        ${offer.status === 'SENT' ? postBtn(csrf, `/leads/${id}/accept`, 'Angebot angenommen → Bestellung', { cls: 'primary' }) : ''}</div>
      <small class="mute">Es wird nichts automatisch versendet. Versand und Vertragstexte liegen bei dir.</small></div>` : ''}
    ${order ? html`<h3>Auftrag</h3><p><a class="btn primary" href="/orders/${order.id}">Auftrag öffnen</a> <span class="badge b-info">${order.status}</span></p>` : ''}`, true, 'dokumente');
}

export function statusCard(d: any, csrf: string, id: string): Safe {
  const from = d.lead.status as Status;
  const done = new Set<string>(((d.events as any[]) ?? []).filter((e) => e.type === 'status_change').map((e) => e.payload?.to));
  const order: Status[] = ['QUALIFIED', 'DEMO_CREATED', 'CONTACTED', 'INTERESTED', 'OFFER_SENT', 'OFFER_ACCEPTED', 'DEPOSIT_PENDING', 'DEPOSIT_PAID', 'PRODUCTION', 'QA', 'CUSTOMER_REVIEW', 'APPROVED', 'FINAL_PAYMENT', 'DEPLOYED', 'MAINTENANCE'];
  const steps = nextStatuses(from);
  return fold('Pipeline-Status', html`<div class="stepper">${order.map((s) => html`<span class="step ${s === from ? 'now' : done.has(s) ? 'done' : ''}">${s.replace(/_/g, ' ')}</span>`)}</div>
    ${postForm(csrf, `/leads/${id}/status`, html`<div class="row"><select name="to">${steps.map((s) => html`<option>${s}</option>`)}${steps.length ? '' : html`<option disabled>keine weiteren Schritte</option>`}</select><input name="reason" placeholder="Grund / Notiz" required class="grow" maxlength="300"><button ${steps.length ? '' : raw('disabled')}>Status setzen</button></div>`, { style: 'display:block' })}<small class="mute">Nur erlaubte Übergänge. ${STATUSES.length} Stufen.</small>`, false);
}

export function history(d: any): Safe {
  const ev = d.events as any[];
  return fold('Verlauf (Audit-Log)', html`<div class="scroll"><table>${ev.map((e) => html`<tr><td><small>${fmt(e.created_at)}</small></td><td>${e.type}</td><td><small>${e.payload?.reason ?? e.payload?.actor ?? ''}${e.payload?.from ? ` (${e.payload.from} → ${e.payload.to})` : ''}</small></td></tr>`)}</table></div>`);
}
export { CAT_LABEL };

export const analysisText = (state: string | null | undefined) => state === 'none' ? 'ohne Website bewertet (NO_WEBSITE)' : state === 'unknown' ? 'Website nicht prüfbar' : state ? 'Website analysiert' : 'Analysestand unbekannt';
