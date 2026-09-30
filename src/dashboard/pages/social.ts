import type { Route } from '../types.ts';
import { UserError } from '../types.ts';
import { html, raw, postBtn, postForm } from '../ui.ts';
import { render, redirect, okFlash, uuid } from './_page.ts';
import { PROFILES, GENERAL, profileByKey } from '../../social/profiles.ts';
import { generatePlan, validateItem, toCsv, type Business, type Item } from '../../social/generate.ts';
import { pickTemplate } from '../../site/templates.ts';
import { bestFact } from '../../core/profile.ts';

const id = uuid.source;

export const routes: Route[] = [
  { method: 'GET', path: new RegExp(`^/social/${id}$`), h: async (r) => {
    const leadId = r.params[0];
    const d = await r.ctx.leads.get(leadId);
    if (!d) return render(r, { title: 'Nicht gefunden', nav: 'leads', status: 404, body: html`<p>Lead nicht gefunden.</p>` });
    const items = await r.ctx.social.list(leadId);
    const facts = await r.ctx.leads.factsOf(leadId);
    const l = d.lead;
    const tpl = pickTemplate({ subIndustry: l.sub_industry, industryText: l.industry, name: l.company_name }, r.ctx.cfg.taxonomy);
    const defProfile = profileByKey(tpl.key).key;
    const known = (bestFact(facts, 'services')?.value as string[] | undefined) ?? [];
    const hours = ((bestFact(facts, 'openingHours')?.value as string[] | undefined) ?? []).join('\n');
    const website = (bestFact(facts, 'website')?.value as string | undefined) ?? '';
    return render(r, { title: 'Social Media', nav: 'leads', body: html`<div class="card"><h2>${l.company_name}</h2>
      <p class="mute">Alle Einträge sind Entwürfe. Es wird nichts automatisch veröffentlicht. Leistungen, Angebote und Öffnungszeiten nennt die Engine nur, wenn sie hier stehen. Die Engine ist für alle Branchen dieselbe – nur Profil (Zielgruppe, Ton, Themen, Plattformen) wechselt.</p>
      ${postForm(r.app.csrf, `/social/${leadId}`, html`<div class="row"><label>Branchenprofil<select name="profile">${[...PROFILES, GENERAL].map((p) => html`<option value="${p.key}" ${p.key === defProfile ? raw('selected') : ''}>${p.label}</option>`)}</select></label><label>Wochen<input type="number" name="weeks" min="1" max="12" value="4" style="width:90px"></label></div>
        <label>Zielgruppe (optional, überschreibt das Profil)<input name="audience" maxlength="120"></label><label>Ton/Style (optional)<input name="tone" maxlength="120"></label>
        <label>Leistungen (eine pro Zeile)<textarea name="services" rows="3">${known.join('\n')}</textarea></label><label>Öffnungszeiten<textarea name="openingHours" rows="2">${hours}</textarea></label>
        <label>Aktuelles Angebot (optional)<input name="offer" maxlength="200"></label><label>Website (optional)<input name="website" value="${website}" maxlength="200"></label>
        <p class="row"><button class="primary">Kalender erzeugen</button><a class="btn" href="/leads/${leadId}">Zurück zum Lead</a><a class="btn" href="/social/${leadId}/export.csv">Freigegebene als CSV</a></p>`, { style: 'display:block' })}</div>
      ${items.map((i: any) => { const errs = validateItem(i); const when = new Date(i.scheduled_for).toISOString().slice(0, 10); return html`<div class="card"><div class="row"><b>${when}</b><span class="badge">${i.platform}</span><small>${i.format}</small><span class="grow"></span><small>${i.status}</small></div>
        ${postForm(r.app.csrf, `/social/items/${i.id}/edit`, html`<input name="title" value="${i.title}" maxlength="200"><textarea name="body" rows="4">${i.body}</textarea><p><button>Speichern (erfordert neue Freigabe)</button></p>`, { style: 'display:block' })}
        ${(i.notes as string[]).map((n) => html`<p><small>ℹ️ ${n}</small></p>`)}${errs.map((e) => html`<div class="errbox">${e}</div>`)}
        <div class="row">${i.status !== 'APPROVED' && !errs.length ? postBtn(r.app.csrf, `/social/items/${i.id}/approve`, 'Freigeben', { cls: 'ok' }) : ''}${i.status !== 'REJECTED' ? postBtn(r.app.csrf, `/social/items/${i.id}/reject`, 'Ablehnen', { cls: 'danger' }) : ''}</div></div>`; })}
      ${!items.length ? html`<p class="mute">Noch kein Kalender.</p>` : ''}` });
  } },
  { method: 'GET', path: new RegExp(`^/social/${id}/export\\.csv$`), h: async (r) => {
    const items = (await r.ctx.social.list(r.params[0])).filter((i: any) => i.status === 'APPROVED').map((i: any): Item => ({ date: new Date(i.scheduled_for).toISOString().slice(0, 10), platform: i.platform, format: i.format, title: i.title, body: i.body, hashtags: i.hashtags, notes: i.notes }));
    return { body: '﻿' + toCsv(items), type: 'text/csv; charset=utf-8', headers: { 'content-disposition': 'attachment; filename="content-kalender.csv"' } };
  } },
  { method: 'POST', path: new RegExp(`^/social/${id}$`), h: async (r) => {
    const d = await r.ctx.leads.get(r.params[0]); if (!d) throw new UserError('Lead nicht gefunden');
    const lines = (k: string) => (r.form.get(k) ?? '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 10);
    const biz: Business = { name: d.lead.company_name, city: d.lead.city ?? undefined, phone: d.lead.phone ?? undefined, openingHours: lines('openingHours').join('\n') || undefined, services: lines('services'),
      offer: (r.form.get('offer') ?? '').trim() || undefined, website: (r.form.get('website') ?? '').trim() || undefined, audience: (r.form.get('audience') ?? '').trim() || undefined, tone: (r.form.get('tone') ?? '').trim() || undefined };
    const weeks = Number(r.form.get('weeks') ?? 4);
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 12) throw new UserError('Wochen: 1 bis 12');
    const prof = profileByKey(r.form.get('profile') ?? '');
    await r.ctx.social.createPlan(r.params[0], prof.key, generatePlan(biz, prof, { weeks, start: r.ctx.now() }));
    return redirect(`/social/${r.params[0]}`, okFlash('Kalender erzeugt.'));
  } },
  { method: 'POST', path: new RegExp(`^/social/items/${id}/(approve|reject|edit)$`), h: async (r) => {
    const leadId = r.params[1] === 'edit' ? await r.ctx.social.edit(r.params[0], r.form.get('title') ?? '', r.form.get('body') ?? '') : await r.ctx.social.setStatus(r.params[0], r.params[1] === 'approve' ? 'APPROVED' : 'REJECTED');
    return redirect(`/social/${leadId}`);
  } },
];
