import type { Route } from '../types.ts';
import { html, raw, categoryBadge, eur, fmt, mockBadge, prioBadge, postForm } from '../ui.ts';
import { render } from './_page.ts';
import { CALL_LABEL, CALL_RESULTS } from '../../calls/service.ts';
import { LEGAL } from '../../contact/strategy.ts';
import { webStateText } from './lead-parts.ts';
import { callExtras, potentialBadges } from './copilot.ts';
import { NEXT_ACTION_LABEL, type NextAction } from '../../sales/copilot.ts';
import { NA, orNA, sourceLabel } from '../../core/enrichment.ts';

const KIND: Record<string, [string, string]> = { demo_ready: ['b-ok', 'Demo fertig – anrufen'], callback: ['b-warn', 'Rückruf fällig'], new: ['b-info', 'Neu'], follow_up: ['b-ok', 'Nachfassen'] };

export const routes: Route[] = [{
  method: 'GET', path: /^\/calls$/, h: async (r) => {
    const q = await r.ctx.calls.queue();
    const pct = Math.min(100, Math.round((q.done / q.target) * 100));
    return render(r, { title: 'Heute anrufen', nav: 'calls', body: html`
      <div class="card"><div class="row"><b class="grow">${q.done} von ${q.target} Leads bearbeitet</b><small>${q.calls} Anrufe · ${q.open} offen</small></div><div class="bar" role="img" aria-label="${pct} Prozent"><i style="width:${pct}%"></i></div></div>
      ${!q.phoneEnabled ? html`<div class="warnbox"><b>Telefon-Leads vorhanden, Telefonakquise aber noch nicht aktiviert.</b> Ohne bewusste Freigabe erscheinen keine Leads in dieser Liste (es wird nie automatisch gewählt). <a class="btn" href="/settings#telefon">Einstellungen öffnen</a></div>` : ''}
      <div class="note">${LEGAL.phone}</div>
      ${q.items.length ? q.items.map((it, i) => {
        const b = it.brief; const [kc, kl] = KIND[it.kind];
        return html`<details class="card" ${i === 0 ? raw('open') : ''}>
          <summary><span class="row" style="width:100%">${prioBadge(it.priority)}<span class="grow"><b>${it.company_name}</b> ${it.is_mock ? mockBadge : ''}<br><small class="mute">${it.city ?? ''} · ${it.sub_industry ?? ''}</small></span><span class="badge ${kc}">${kl}</span></span></summary>
          <div class="stack">
            <p><a class="tel" href="tel:${String(it.phone).replace(/[^\d+]/g, '')}">${it.phone}</a></p>
            <div class="row"><b>${it.score ?? '–'}</b> ${categoryBadge(it.category)} <span class="badge">${webStateText(it.website_state)}</span>${it.distance_km ? html`<small>${Number(it.distance_km).toFixed(1).replace('.', ',')} km</small>` : ''}${it.callback_at ? html`<small>Rückruf: ${fmt(it.callback_at)}</small>` : ''}</div>
            <dl class="facts"><dt>Website</dt><dd>${it.website_url ? html`<code>${it.website_url}</code>` : NA}</dd><dt>Adresse</dt><dd>${orNA(it.address)}</dd><dt>Quelle</dt><dd>${sourceLabel(it.source)}</dd><dt>Datenqualität</dt><dd>${it.dq !== null && it.dq !== undefined ? `${Math.round(it.dq)}/100` : NA}</dd>
              <dt>Empfohlene Leistung</dt><dd>${b?.service?.name ?? NA}</dd><dt>Opportunity Score</dt><dd>${it.score ?? NA}</dd></dl>
            ${it.contact_reason ? html`<p><small class="mute">${it.contact_reason}</small></p>` : ''}
            ${potentialBadges(it)}<p>${it.call_goal ? html`<b>Gesprächsziel:</b> ${it.call_goal}${it.recommended_next_action ? html` · <span class="badge b-info">${NEXT_ACTION_LABEL[it.recommended_next_action as NextAction] ?? it.recommended_next_action}</span>` : ''} ` : ''}<a href="/leads/${it.id}#verkaufsassistent">Verkaufsassistent öffnen</a></p>
            <div><b>Die wichtigsten Verkaufsgründe</b><ol>${(b?.reasons ?? []).slice(0, 3).map((x: any) => html`<li>${x.text}</li>`)}</ol></div>
            ${b ? html`<div class="note"><b>Gesprächseinstieg</b><br>${it.opener ?? b.opener}</div>
              <p><small>Schätzung möglicher Auftragswert: ${eur(b.valueRange.lowCents)} – ${eur(b.valueRange.highCents)} (unverbindlich)</small></p>
              <details><summary>Mögliche Einwände</summary><ul>${b.objections.map((o: any) => html`<li><b>${o.objection}</b><br>${o.response}</li>`)}</ul></details>` : ''}
            ${it.last_note ? html`<p class="mute"><small>Letzte Notiz: ${it.last_note}${it.last_result ? ` (${CALL_LABEL[it.last_result as keyof typeof CALL_LABEL] ?? it.last_result})` : ''}</small></p>` : ''}
            ${postForm(r.app.csrf, `/leads/${it.id}/call`, html`<input type="hidden" name="next" value="calls">
              <label>Notizen<textarea name="note" rows="2" maxlength="4000" placeholder="Was wurde besprochen?"></textarea></label>
              <label>Rückruf am (nur bei „Rückruf“)<input type="datetime-local" name="callback"></label>${callExtras()}
              <div class="resgrid" style="margin-top:8px">${CALL_RESULTS.map((x) => html`<button name="result" value="${x}" class="${x === 'DO_NOT_CONTACT' ? 'danger' : x === 'BOUGHT' ? 'ok' : ['INTERESTED', 'DEMO', 'OFFER', 'NEEDS_ANALYSIS', 'PARTNERSHIP', 'MULTIPLE'].includes(x) ? 'primary' : ''}">${CALL_LABEL[x]}</button>`)}</div>`, { style: 'display:block' })}
            <p><a href="/leads/${it.id}">Lead-Details öffnen</a></p></div></details>`;
      }) : html`<div class="card"><p>${q.done >= q.target ? 'Tagesziel erreicht. Gut gemacht!' : 'Keine Calls offen. Neue Leads per Suche holen oder Filter lockern.'}</p><a class="btn primary" href="/search">Neue Suche</a></div>`}` });
  },
}];
