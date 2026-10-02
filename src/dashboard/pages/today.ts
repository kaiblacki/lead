import type { Route } from '../types.ts';
import { html, categoryBadge, prioBadge } from '../ui.ts';
import { render } from './_page.ts';
import { nextActionText } from './lead-parts.ts';
import { NA } from '../../core/enrichment.ts';
import { DEMO_STAGE_LABEL, effectiveDemoStage } from '../../demo/stage.ts';
import { taskList } from './tasks.ts';
import { NEXT_ACTION_LABEL, POTENTIAL_LABEL, type NextAction, type Potential } from '../../sales/copilot.ts';

const VIEWS: { key: string; title: string; hint: string }[] = [
  { key: 'today_work', title: 'Heute bearbeiten', hint: 'A-Leads ohne Kontakt, fällige Rückrufe und Leads mit fertiger Demo' },
  { key: 'data_needed', title: 'Daten beschaffen', hint: 'Weder Telefonnummer noch E-Mail bekannt – erst Daten beschaffen (Enrichment)' },
  { key: 'ready_contact', title: 'Bereit zum Kontakt', hint: 'Kontaktmöglichkeit vorhanden und Priorität A/B' },
  { key: 'call_today', title: 'Heute anrufen', hint: 'Anruf fällig (Rückruf oder „Demo fertig – anrufen“)' },
  { key: 'new_a', title: 'Neue A-Leads', hint: 'Priorität A, in den letzten 14 Tagen gefunden, noch nicht kontaktiert' },
  { key: 'demo_ready', title: 'Demo fertig', hint: 'Demo vorhanden – Telefonnummer prüfen und anrufen' },
  { key: 'demo_recommended', title: 'Demo empfohlen', hint: 'Keine Website, genug Daten – Demo noch nicht erstellt (Obergrenze je Suchlauf)' },
  { key: 'manual_check', title: 'Manuell prüfen', hint: 'Mögliche Dubletten oder unklare Kontaktfreigabe' },
];

export const routes: Route[] = [{
  method: 'GET', path: /^\/today$/, h: async (r) => {
    await r.ctx.growth.refresh();
    const tg = await r.ctx.taskEngine.groups();
    const top = (await r.ctx.leads.list({ sort: 'action', limit: 5 })).rows.filter((l: any) => (l.action_priority ?? 0) > 0);
    const data = await Promise.all(VIEWS.map(async (v) => ({ v, res: await r.ctx.leads.list({ quick: v.key, limit: 8, sort: 'action' }) })));
    return render(r, { title: 'Heute', nav: 'today', body: html`
      <div class="card" id="aufgaben"><div class="row"><h2 class="grow">Aufgaben</h2><a class="btn" href="/tasks">Alle Aufgaben</a></div><b>Überfällig (${tg.OVERDUE.length})</b>${taskList(tg.OVERDUE, r.app.csrf, { empty: 'Nichts überfällig.', back: '/today' })}<b>Heute (${tg.TODAY.length})</b>${taskList(tg.TODAY, r.app.csrf, { empty: 'Heute nichts fällig.', back: '/today' })}</div>
      <div class="card" id="als-naechstes"><h2>Als Nächstes (nach Handlungspriorität)</h2><p class="mute">Regelbasiert aus Verkaufschance, Digitalbedarf, Kontaktierbarkeit, Datensicherheit, Partnerpotenzial und Engagement – plus fällige Aufgaben und Rückrufe. Du entscheidest, was du tust.</p>
        ${top.length ? html`<ol class="items">${top.map((l: any) => html`<li><div class="row"><b class="grow"><a href="/leads/${l.id}">${l.company_name}</a></b><span class="badge ${l.action_priority >= 70 ? 'b-ok' : 'b-info'}">Handlung ${l.action_priority}</span></div>
          <small>${l.city ?? NA} · ${l.growth_scores?.reasons?.slice(1).join(' · ') || 'Basiswerte'}</small>
          <div class="quick">${l.phone ? html`<a class="btn primary" href="tel:${String(l.phone).replace(/[^\d+]/g, '')}">ANRUFEN</a>` : ''}<a class="btn" href="/leads/${l.id}?tab=demo#demo-stufe">DEMO</a><a class="btn" href="/leads/${l.id}?tab=angebot#angebot">ANGEBOT</a><a class="btn" href="/leads/${l.id}?tab=partner#partner">PARTNER</a></div></li>`)}</ol>` : html`<p class="mute">Nichts mit Handlungsbedarf.</p>`}</div>
      <div class="grid">${data.map(({ v, res }) => html`<a class="kpi" href="#${v.key}" style="text-decoration:none;color:inherit"><b>${res.total}</b><span>${v.title}</span></a>`)}</div>
      ${data.map(({ v, res }) => html`<div class="card" id="${v.key}"><div class="row"><h2 class="grow">${v.title} <small class="mute">(${res.total})</small></h2><a class="btn" href="/leads?quick=${v.key}">Alle anzeigen</a></div><p class="mute">${v.hint}</p>
        ${res.rows.length ? html`<ul class="items">${res.rows.map((l) => html`<li><div class="row">${prioBadge(l.priority)}<a class="grow" href="/leads/${l.id}"><b>${l.company_name}</b><br><small>${l.city ?? NA} · ${l.sub_industry ?? l.industry ?? NA}</small></a>
          <div style="text-align:right"><b>${l.score ?? NA}</b> ${categoryBadge(l.category)}<br><small title="Handlungspriorität">Handlung ${l.action_priority ?? NA}</small></div></div>
          <small>${l.phone ? html`<a class="tel" href="tel:${String(l.phone).replace(/[^\d+]/g, '')}">${l.phone}</a>` : 'keine Telefonnummer'} · Nächste Aktion: <b>${l.recommended_next_action ? NEXT_ACTION_LABEL[l.recommended_next_action as NextAction] : nextActionText(l)}</b></small>
          <dl class="facts"><dt>Website-Potenzial</dt><dd>${l.website_potential ? POTENTIAL_LABEL[l.website_potential as Potential] : NA}</dd><dt>Demo</dt><dd>${DEMO_STAGE_LABEL[effectiveDemoStage({ ...l, demo_recommendation: l.demo_decision === 'recommended' ? 'DEMO_RECOMMENDED' : l.demo_recommendation, demo_decision: l.demo_decision === 'skipped' ? 'skipped' : null }, !!l.has_demo)]}</dd><dt>Gesprächsziel</dt><dd>${l.call_goal ?? NA}</dd></dl>
          <a class="btn" href="/leads/${l.id}#verkaufsassistent">Verkaufsassistent öffnen</a></li>`)}</ul>` : html`<p class="mute">Nichts offen.</p>`}</div>`)}` });
  },
}];
