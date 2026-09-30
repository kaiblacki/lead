import type { Route } from '../types.ts';
import { html, raw, categoryBadge, eur, fmt, mockBadge, prioBadge, postForm } from '../ui.ts';
import { render } from './_page.ts';
import { CALL_LABEL, CALL_RESULTS } from '../../calls/service.ts';
import { LEGAL } from '../../contact/strategy.ts';
import { webStateText } from './lead-parts.ts';

const KIND: Record<string, [string, string]> = { callback: ['b-warn', 'Rückruf fällig'], new: ['b-info', 'Neu'], follow_up: ['b-ok', 'Nachfassen'] };

export const routes: Route[] = [{
  method: 'GET', path: /^\/calls$/, h: async (r) => {
    const q = await r.ctx.calls.queue();
    const pct = Math.min(100, Math.round((q.done / q.target) * 100));
    return render(r, { title: 'Meine heutigen Calls', nav: 'calls', body: html`
      <div class="card"><div class="row"><b class="grow">${q.done} von ${q.target} Leads bearbeitet</b><small>${q.calls} Anrufe · ${q.open} offen</small></div><div class="bar" role="img" aria-label="${pct} Prozent"><i style="width:${pct}%"></i></div></div>
      ${!q.phoneEnabled ? html`<div class="warnbox"><b>Telefonakquise nicht freigegeben.</b> Ohne Freigabe erscheinen keine Leads in dieser Liste. <a class="btn" href="/settings#telefon">Einstellungen öffnen</a></div>` : ''}
      <div class="note">${LEGAL.phone}</div>
      ${q.items.length ? q.items.map((it, i) => {
        const b = it.brief; const [kc, kl] = KIND[it.kind];
        return html`<details class="card" ${i === 0 ? raw('open') : ''}>
          <summary><span class="row" style="width:100%">${prioBadge(it.priority)}<span class="grow"><b>${it.company_name}</b> ${it.is_mock ? mockBadge : ''}<br><small class="mute">${it.city ?? ''} · ${it.sub_industry ?? ''}</small></span><span class="badge ${kc}">${kl}</span></span></summary>
          <div class="stack">
            <p><a class="tel" href="tel:${String(it.phone).replace(/[^\d+]/g, '')}">${it.phone}</a></p>
            <div class="row"><b>${it.score ?? '–'}</b> ${categoryBadge(it.category)} <span class="badge">${webStateText(it.website_state)}</span>${it.distance_km ? html`<small>${Number(it.distance_km).toFixed(1).replace('.', ',')} km</small>` : ''}${it.callback_at ? html`<small>Rückruf: ${fmt(it.callback_at)}</small>` : ''}</div>
            ${it.website_url ? html`<p><small>Website: <code>${it.website_url}</code></small></p>` : ''}
            ${it.contact_reason ? html`<p><small class="mute">${it.contact_reason}</small></p>` : ''}
            <div><b>Die wichtigsten Verkaufsgründe</b><ol>${(b?.reasons ?? []).slice(0, 3).map((x: any) => html`<li>${x.text}</li>`)}</ol></div>
            ${b ? html`<div class="note"><b>Gesprächseinstieg</b><br>${it.opener ?? b.opener}</div>
              <p><small>Schätzung möglicher Auftragswert: ${eur(b.valueRange.lowCents)} – ${eur(b.valueRange.highCents)} (unverbindlich)</small></p>
              <details><summary>Mögliche Einwände</summary><ul>${b.objections.map((o: any) => html`<li><b>${o.objection}</b><br>${o.response}</li>`)}</ul></details>` : ''}
            ${it.last_note ? html`<p class="mute"><small>Letzte Notiz: ${it.last_note}${it.last_result ? ` (${CALL_LABEL[it.last_result as keyof typeof CALL_LABEL] ?? it.last_result})` : ''}</small></p>` : ''}
            ${postForm(r.app.csrf, `/leads/${it.id}/call`, html`<input type="hidden" name="next" value="calls">
              <label>Notizen<textarea name="note" rows="2" maxlength="4000" placeholder="Was wurde besprochen?"></textarea></label>
              <label>Rückruf am (nur bei „Rückruf“)<input type="datetime-local" name="callback"></label>
              <div class="resgrid" style="margin-top:8px">${CALL_RESULTS.map((x) => html`<button name="result" value="${x}" class="${x === 'DO_NOT_CONTACT' ? 'danger' : x === 'BOUGHT' ? 'ok' : ['INTERESTED', 'DEMO', 'OFFER'].includes(x) ? 'primary' : ''}">${CALL_LABEL[x]}</button>`)}</div>`, { style: 'display:block' })}
            <p><a href="/leads/${it.id}">Lead-Details öffnen</a></p></div></details>`;
      }) : html`<div class="card"><p>${q.done >= q.target ? 'Tagesziel erreicht. Gut gemacht!' : 'Keine Calls offen. Neue Leads per Suche holen oder Filter lockern.'}</p><a class="btn primary" href="/search">Neue Suche</a></div>`}` });
  },
}];
