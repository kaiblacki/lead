import type { Route } from '../types.ts';
import { html, categoryBadge, prioBadge } from '../ui.ts';
import { render } from './_page.ts';
import { nextActionText } from './lead-parts.ts';
import { NA } from '../../core/enrichment.ts';

const VIEWS: { key: string; title: string; hint: string }[] = [
  { key: 'today_work', title: 'Heute bearbeiten', hint: 'A-Leads ohne Kontakt, fällige Rückrufe und Leads mit fertiger Demo' },
  { key: 'call_today', title: 'Heute anrufen', hint: 'Anruf fällig (Rückruf oder „Demo fertig – anrufen“)' },
  { key: 'new_a', title: 'Neue A-Leads', hint: 'Priorität A, in den letzten 14 Tagen gefunden, noch nicht kontaktiert' },
  { key: 'demo_ready', title: 'Demo fertig', hint: 'Demo vorhanden – Telefonnummer prüfen und anrufen' },
  { key: 'demo_recommended', title: 'Demo empfohlen', hint: 'Keine Website, genug Daten – Demo noch nicht erstellt (Obergrenze je Suchlauf)' },
  { key: 'manual_check', title: 'Manuell prüfen', hint: 'Mögliche Dubletten oder unklare Kontaktfreigabe' },
];

export const routes: Route[] = [{
  method: 'GET', path: /^\/today$/, h: async (r) => {
    const data = await Promise.all(VIEWS.map(async (v) => ({ v, res: await r.ctx.leads.list({ quick: v.key, limit: 8 }) })));
    return render(r, { title: 'Heute', nav: 'today', body: html`
      <div class="grid">${data.map(({ v, res }) => html`<a class="kpi" href="#${v.key}" style="text-decoration:none;color:inherit"><b>${res.total}</b><span>${v.title}</span></a>`)}</div>
      ${data.map(({ v, res }) => html`<div class="card" id="${v.key}"><div class="row"><h2 class="grow">${v.title} <small class="mute">(${res.total})</small></h2><a class="btn" href="/leads?quick=${v.key}">Alle anzeigen</a></div><p class="mute">${v.hint}</p>
        ${res.rows.length ? html`<ul class="items">${res.rows.map((l) => html`<li><div class="row">${prioBadge(l.priority)}<a class="grow" href="/leads/${l.id}"><b>${l.company_name}</b><br><small>${l.city ?? NA} · ${l.sub_industry ?? l.industry ?? NA}</small></a>
          <div style="text-align:right"><b>${l.score ?? NA}</b> ${categoryBadge(l.category)}</div></div>
          <small>${l.phone ? html`<a class="tel" href="tel:${String(l.phone).replace(/[^\d+]/g, '')}">${l.phone}</a>` : 'keine Telefonnummer'} · Nächste Aktion: <b>${nextActionText(l)}</b></small></li>`)}</ul>` : html`<p class="mute">Nichts offen.</p>`}</div>`)}` });
  },
}];
