import type { Route } from '../types.ts';
import { html, categoryBadge, mockBadge, readinessBadge } from '../ui.ts';
import { render } from './_page.ts';
import { STATUSES, STAGE_LABEL, type Status } from '../../core/status.ts';

export const routes: Route[] = [{
  method: 'GET', path: /^\/pipeline$/, h: async (r) => {
    const [counts, rows] = await Promise.all([r.ctx.analytics.stageCounts(), r.ctx.leads.byStage(12)]);
    const only = r.url.searchParams.get('stage');
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const stages = STATUSES.filter((s) => !only || s === only);
    const max = Math.max(1, ...counts.values());
    return render(r, { title: 'Pipeline', nav: 'pipeline', body: html`
      <div class="card"><p class="mute">${total} Leads. Jede Stufe ist sichtbar; Klick auf eine Stufe zeigt nur diese.</p>
        <div class="scroll"><table>${STATUSES.map((s) => html`<tr><td><a href="/pipeline?stage=${s}" ${only === s ? 'style="font-weight:700"' : ''}>${STAGE_LABEL[s as Status]}</a></td><td style="width:45%"><div class="bar"><i style="width:${Math.round(((counts.get(s) ?? 0) / max) * 100)}%"></i></div></td><td style="white-space:nowrap;text-align:right"><b>${counts.get(s) ?? 0}</b></td></tr>`)}</table></div>
        ${only ? html`<a class="btn" href="/pipeline">Alle Stufen</a>` : ''}</div>
      ${stages.map((s) => { const items = rows.filter((x) => x.status === s); if (!items.length) return html``; return html`<details class="card" ${only ? 'open' : ''}><summary><span class="grow">${STAGE_LABEL[s as Status]}</span><b>${counts.get(s) ?? 0}</b></summary>
        <ul class="items">${items.map((l) => html`<li><div class="row"><a class="grow" href="/leads/${l.id}"><b>${l.company_name}</b> ${l.is_mock ? mockBadge : ''} <small>${l.city ?? ''}</small></a><b>${l.score ?? '–'}</b> ${categoryBadge(l.category)}</div><div class="row">${readinessBadge(l.contact_readiness)}${l.paused ? html`<span class="badge b-warn">pausiert</span>` : ''}</div></li>`)}</ul>
        ${(counts.get(s) ?? 0) > items.length ? html`<a href="/leads?status=${s}">Alle ${counts.get(s)} anzeigen</a>` : ''}</details>`; })}` });
  },
}];
