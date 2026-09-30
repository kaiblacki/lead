import type { Route } from '../types.ts';
import { UserError } from '../types.ts';
import { html, raw, fmt, postBtn, postForm } from '../ui.ts';
import { render, redirect, okFlash, uuid } from './_page.ts';
import { DEFAULT_LIMITS, LIMIT_LABELS, type Limits } from '../../guardrails/budget.ts';
import { DIM_LABELS, type DimKey } from '../../scoring/intelligence.ts';
import { csvCell } from './_csv.ts';

const id = uuid.source;
const num = (v: string | null, d: number) => (v === null || v.trim() === '' ? d : Number(v.replace(',', '.')));

export const routes: Route[] = [
  { method: 'GET', path: /^\/settings$/, h: async (r) => {
    const { ctx } = r;
    const [settings, { limits }, scoring, sup, plan] = await Promise.all([ctx.repo.getSettings(), ctx.repo.getLimits(), ctx.repo.getScoringConfig(ctx.cfg.scoring), ctx.repo.listSuppression(), ctx.retention.plan(ctx.now())]);
    const ch = settings.channels;
    const numIn = (name: string, v: unknown, label: string, step = '1', style = 'width:100%') => html`<label>${label}<input type="number" name="${name}" value="${v}" step="${step}" min="0" style="${style}"></label>`;
    return render(r, { title: 'Einstellungen', nav: 'settings', body: html`
      <div class="card"><div class="row"><a class="btn" href="/audit">Audit-Log</a><a class="btn" href="/analytics">Analytics</a><a class="btn" href="#provider">Provider</a></div></div>
      <div class="card" id="telefon"><h2>Telefonakquise</h2>
        <p>${settings.phoneEnabled ? html`<span class="badge b-ok">freigegeben${settings.phoneAckAt ? ` am ${fmt(settings.phoneAckAt)}` : ''}</span>` : html`<span class="badge b-warn">nicht freigegeben</span>`}</p>
        <div class="note">Werbeanrufe gegenüber Unternehmen sind nur mit (mutmaßlicher) Einwilligung zulässig (UWG § 7). Das System ruft nie selbst an – es bereitet Anrufe vor, die du selbst führst. Bevor Leads als „Bereit für Anruf“ gelten, bestätigst du, dass du die Rechtsgrundlage geprüft hast.</div>
        ${postForm(r.app.csrf, '/settings/phone', html`<label class="inline"><input type="checkbox" name="enable" value="1" ${settings.phoneEnabled ? raw('checked') : ''}> Telefonakquise freigeben</label>
          <label class="inline"><input type="checkbox" name="ack" value="1"> Ich habe die rechtliche Grundlage für Kaltakquise per Telefon geprüft und trage die Verantwortung.</label>
          <div class="row"><label>Tägliches Call-Ziel<input type="number" name="dailyCallTarget" min="1" max="200" value="${settings.dailyCallTarget}" style="width:140px"></label><label class="grow">Dein Name im Gesprächseinstieg<input name="callerName" value="${settings.callerName ?? ''}" maxlength="80" placeholder="${ctx.cfg.agency.callerName}"></label></div>
          <p><button class="primary">Speichern</button></p>`, { style: 'display:block' })}</div>
      <div class="card"><h2>Nachrichten-Kanäle (E-Mail, WhatsApp)</h2><p class="mute">Standard: aus. Ein Versand ist nur möglich, wenn der Kanal aktiv ist, die Plattformregeln bestätigt sind, eine Einwilligung je Lead dokumentiert ist, der Lead nicht gesperrt ist und das Tageslimit nicht erreicht ist. Sonst: „Manuelle Kontaktaufnahme erforderlich.“ Echte Adapter sind noch nicht gebaut – aktuell Mock.</p>
        ${postForm(r.app.csrf, '/settings/channels', html`${(['email', 'whatsapp'] as const).map((k) => html`<fieldset><legend>${k === 'email' ? 'E-Mail' : 'WhatsApp'}</legend>
          <label class="inline"><input type="checkbox" name="${k}_auto" value="1" ${ch[k]?.autoSend ? raw('checked') : ''}> Versand über diesen Kanal erlauben</label>
          <label class="inline"><input type="checkbox" name="${k}_platform" value="1" ${ch[k]?.platformConfirmed ? raw('checked') : ''}> Ich habe die Plattformregeln/Anbieterbedingungen geprüft</label>
          ${numIn(`${k}_limit`, ch[k]?.dailyLimit ?? 20, 'Tageslimit', '1', 'width:140px')}</fieldset>`)}<p><button>Speichern</button></p>`, { style: 'display:block' })}</div>
      <div class="card"><h2>Budget-Limits</h2>${postForm(r.app.csrf, '/settings/limits', html`<div class="grid">${(Object.keys(limits) as (keyof Limits)[]).map((k) => numIn(k, limits[k], LIMIT_LABELS[k]))}</div><p class="mute">Bei Erreichen eines Limits stoppt der Lauf. KI- und Anbieter-Anfragen werden gezählt.</p><p><button>Speichern</button></p>`, { style: 'display:block' })}</div>
      <div class="card"><h2>Scoring</h2><p class="mute">Gewichte 0–1 (werden je Gruppe normalisiert). Schwellen: HOT > HIGH POTENTIAL > MEDIUM > LOW. Änderungen gelten für neue Analysen; der Fingerabdruck der Konfiguration wird im Learning Loop gespeichert.</p>
        ${postForm(r.app.csrf, '/settings/scoring', html`<h3>Digital Need</h3><div class="grid">${Object.entries(scoring.digitalNeedWeights).map(([k, v]) => numIn(`dn_${k}`, v, DIM_LABELS[k as DimKey] ?? k, '0.05'))}</div>
          <h3>Sales Opportunity</h3><div class="grid">${Object.entries(scoring.salesWeights).map(([k, v]) => numIn(`sw_${k}`, v, k, '0.05'))}</div>
          <h3>Schwellen</h3><div class="grid">${Object.entries(scoring.thresholds).map(([k, v]) => numIn(`th_${k}`, v, k))}</div>
          <p class="row"><button>Speichern</button><button name="reset" value="1" class="warn">Auf Standard zurücksetzen</button></p>`, { style: 'display:block' })}</div>
      <div class="card" id="sperrliste"><h2>Sperrliste (Opt-out / Do-not-contact)</h2>${postForm(r.app.csrf, '/settings/suppression', html`<div class="row"><select name="kind"><option value="phone">Telefon</option><option value="email">E-Mail</option><option value="domain">Domain</option><option value="company">Firma</option></select><input name="value" required placeholder="Wert" class="grow" maxlength="200"><input name="reason" placeholder="Grund (optional)" maxlength="300"><button>Hinzufügen</button></div>`, { style: 'display:block' })}
        ${sup.length ? html`<div class="scroll"><table>${sup.map((s: any) => html`<tr><td>${s.kind}</td><td>${s.value}</td><td>${s.reason ?? ''}</td><td><small>${fmt(s.created_at)}</small></td><td>${postBtn(r.app.csrf, `/settings/suppression/${s.id}/delete`, 'Entfernen')}</td></tr>`)}</table></div>` : html`<p class="mute">Keine Einträge.</p>`}
        <small class="mute">Einträge werden bei jeder Analyse und vor jedem Kontakt geprüft und nie automatisch gelöscht.</small></div>
      <div class="card" id="provider"><h2>Provider</h2><div class="scroll"><table><tr><th>Dienst</th><th>Aktiv</th><th>Modus</th><th>Hinweis</th></tr>${ctx.registry.status.map((s) => html`<tr><td>${s.kind}</td><td>${s.name}</td><td><span class="badge ${s.mode === 'mock' ? 'b-mock' : 'b-ok'}">${s.mode}</span></td><td>${s.note}</td></tr>`)}</table></div>
        <p class="mute">Modus: APP_MODE=${ctx.registry.mode}. Einzeln umschaltbar über PROVIDER_PLACES, PROVIDER_AI, PROVIDER_PAYMENTS, … (mock|real). Echte Keys gehören nur in die Umgebungsvariablen.</p></div>
      <div class="card" id="aufbewahrung"><h2>Datenaufbewahrung</h2><div class="scroll"><table><tr><th>Regel</th><th>Frist</th><th>Jetzt fällig</th></tr>${plan.map((p) => html`<tr><td>${p.label}</td><td>${p.days} Tage</td><td><b>${p.count}</b></td></tr>`)}</table></div>
        <p class="mute">Kunden- und Auftragsdaten sowie Sperrlisten-Einträge werden nie automatisch gelöscht.</p>
        ${postForm(r.app.csrf, '/settings/retention', html`<label class="inline"><input type="checkbox" name="confirm" value="1"> Ich möchte die fälligen Daten jetzt endgültig löschen.</label> <button class="danger">Bereinigung ausführen</button>`, { style: 'display:block' })}</div>` });
  } },

  { method: 'POST', path: /^\/settings\/phone$/, h: async (r) => {
    const enable = r.form.get('enable') === '1';
    const cur = await r.ctx.repo.getSettings();
    if (enable && !cur.phoneEnabled && r.form.get('ack') !== '1') throw new UserError('Bitte bestätige, dass du die rechtliche Grundlage geprüft hast.');
    const res = await r.ctx.repo.saveSettings({ phoneEnabled: enable, dailyCallTarget: num(r.form.get('dailyCallTarget'), cur.dailyCallTarget), callerName: (r.form.get('callerName') ?? '').trim() || null });
    const n = res.changedPhone ? await r.ctx.leads.recomputeAllContact() : 0;
    return redirect('/settings#telefon', okFlash(res.changedPhone ? `Telefonakquise ${enable ? 'freigegeben' : 'deaktiviert'} – ${n} Leads neu bewertet.` : 'Gespeichert.'));
  } },
  { method: 'POST', path: /^\/settings\/channels$/, h: async (r) => {
    const channels: Record<string, { autoSend: boolean; dailyLimit: number; platformConfirmed: boolean }> = {};
    for (const k of ['email', 'whatsapp']) channels[k] = { autoSend: r.form.get(`${k}_auto`) === '1', platformConfirmed: r.form.get(`${k}_platform`) === '1', dailyLimit: num(r.form.get(`${k}_limit`), 20) };
    await r.ctx.repo.saveSettings({ channels }); return redirect('/settings', okFlash('Kanäle gespeichert.'));
  } },
  { method: 'POST', path: /^\/settings\/limits$/, h: async (r) => {
    const cur = (await r.ctx.repo.getLimits()).limits;
    const next = Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((k) => [k, num(r.form.get(k), (cur as any)[k])])) as Limits;
    await r.ctx.repo.saveLimits(next); return redirect('/settings', okFlash('Limits gespeichert.'));
  } },
  { method: 'POST', path: /^\/settings\/scoring$/, h: async (r) => {
    if (r.form.get('reset') === '1') { await r.ctx.repo.pool.query('update scoring_configs set is_active=false where owner_id=$1', [r.ctx.repo.ownerId]); await r.ctx.repo.event(r.ctx.repo.pool, null, 'scoring_reset', { actor: 'user' }); return redirect('/settings', okFlash('Scoring auf Standard zurückgesetzt.')); }
    const base = await r.ctx.repo.getScoringConfig(r.ctx.cfg.scoring);
    const grp = (prefix: string, cur: Record<string, number>) => Object.fromEntries(Object.keys(cur).map((k) => [k, num(r.form.get(`${prefix}_${k}`), cur[k])]));
    const next = { ...base, digitalNeedWeights: grp('dn', base.digitalNeedWeights), salesWeights: grp('sw', base.salesWeights), thresholds: grp('th', base.thresholds) } as typeof base;
    for (const g of [next.digitalNeedWeights, next.salesWeights]) if (!Object.values(g as Record<string, number>).some((v) => v > 0)) throw new UserError('Mindestens ein Gewicht je Gruppe muss größer als 0 sein.');
    await r.ctx.repo.saveScoringConfig(next); return redirect('/settings', okFlash('Scoring gespeichert (gilt für neue Analysen).'));
  } },
  { method: 'POST', path: /^\/settings\/suppression$/, h: async (r) => {
    await r.ctx.repo.addSuppression(r.form.get('kind') ?? '', r.form.get('value') ?? '', (r.form.get('reason') ?? '').trim() || undefined);
    const n = await r.ctx.leads.recomputeAllContact(); return redirect('/settings#sperrliste', okFlash(`Eintrag hinzugefügt – ${n} Leads neu bewertet.`));
  } },
  { method: 'POST', path: new RegExp(`^/settings/suppression/${id}/delete$`), h: async (r) => { await r.ctx.repo.removeSuppression(r.params[0]); await r.ctx.leads.recomputeAllContact(); return redirect('/settings#sperrliste', okFlash('Eintrag entfernt.')); } },
  { method: 'POST', path: /^\/settings\/retention$/, h: async (r) => {
    if (r.form.get('confirm') !== '1') throw new UserError('Bitte die Löschung bestätigen.');
    const out = await r.ctx.retention.execute(r.ctx.now()); return redirect('/settings#aufbewahrung', okFlash(`Bereinigt: ${out.map((o) => `${o.count} ${o.label}`).join(', ')}.`));
  } },
  { method: 'POST', path: /^\/killswitch$/, h: async (r) => {
    await r.ctx.repo.setKillSwitch(r.form.get('on') === '1');
    let back = '/'; try { const ref = r.req.headers.referer; if (ref && new URL(ref).host === r.req.headers.host) { const u = new URL(ref); back = u.pathname + u.search.replace(/[?&]f=[0-9a-f]+/, ''); } } catch { /* egal */ }
    return redirect(back, okFlash(r.form.get('on') === '1' ? 'Kill Switch aktiviert – alles gestoppt.' : 'Kill Switch aufgehoben.'));
  } },

  { method: 'GET', path: /^\/audit$/, h: async (r) => {
    const q = r.url.searchParams; const g = (k: string) => q.get(k) || undefined;
    const limit = 100, offset = Math.max(0, Number(q.get('offset') ?? 0) || 0);
    const [log, types] = await Promise.all([r.ctx.repo.auditLog({ type: g('type'), actor: g('actor'), from: g('from'), to: g('to'), q: g('q'), leadId: g('lead'), limit, offset }), r.ctx.repo.eventTypes()]);
    const next = (o: number) => { const u = new URLSearchParams(q); u.set('offset', String(o)); return u.toString(); };
    return render(r, { title: 'Audit-Log', nav: 'settings', body: html`
      <form class="card" method="get" action="/audit"><div class="row"><label>Ereignis<select name="type"><option value="">alle</option>${types.map((t) => html`<option ${q.get('type') === t ? raw('selected') : ''}>${t}</option>`)}</select></label>
        <label>Akteur<select name="actor"><option value="">alle</option>${['user', 'system', 'customer'].map((a) => html`<option ${q.get('actor') === a ? raw('selected') : ''}>${a}</option>`)}</select></label>
        <label>Von<input type="date" name="from" value="${q.get('from') ?? ''}"></label><label>Bis<input type="date" name="to" value="${q.get('to') ?? ''}"></label><label class="grow">Suche<input name="q" value="${q.get('q') ?? ''}"></label><button class="primary">Filtern</button></div></form>
      <p class="mute">${log.total} Einträge · <a href="/audit.csv?${q.toString()}">CSV-Export</a> · Einträge sind nur anfügbar (keine Änderung über das Dashboard).</p>
      <div class="card"><div class="scroll"><table><tr><th>Zeit</th><th>Ereignis</th><th>Lead</th><th>Details</th></tr>${log.rows.map((e: any) => html`<tr><td><small>${fmt(e.created_at)}</small></td><td>${e.type}</td><td>${e.lead_id ? html`<a href="/leads/${e.lead_id}">${e.company_name ?? 'Lead'}</a>` : ''}</td><td><small>${e.payload?.actor ?? ''} ${e.payload?.reason ?? ''}${e.payload?.from ? ` ${e.payload.from} → ${e.payload.to}` : ''}</small></td></tr>`)}</table></div></div>
      <div class="row">${offset > 0 ? html`<a class="btn" href="/audit?${next(Math.max(0, offset - limit))}">← Neuer</a>` : ''}${offset + limit < log.total ? html`<a class="btn" href="/audit?${next(offset + limit)}">Älter →</a>` : ''}</div>` });
  } },
  { method: 'GET', path: /^\/audit\.csv$/, h: async (r) => {
    const q = r.url.searchParams; const g = (k: string) => q.get(k) || undefined;
    const log = await r.ctx.repo.auditLog({ type: g('type'), actor: g('actor'), from: g('from'), to: g('to'), q: g('q'), leadId: g('lead'), limit: 1000 });
    const rows = ['Zeit;Ereignis;Lead;Akteur;Details', ...log.rows.map((e: any) => [new Date(e.created_at).toISOString(), e.type, e.company_name ?? '', e.payload?.actor ?? '', JSON.stringify(e.payload ?? {})].map(csvCell).join(';'))];
    return { body: '﻿' + rows.join('\n'), type: 'text/csv; charset=utf-8', headers: { 'content-disposition': 'attachment; filename="audit-log.csv"' } };
  } },
];
