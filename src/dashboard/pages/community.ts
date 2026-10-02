import type { Route } from '../types.ts';
import { UserError } from '../types.ts';
import { html, eur, fmtDate, postForm, postBtn } from '../ui.ts';
import { render, redirect, okFlash, uuid } from './_page.ts';

const id = uuid.source;
const wrap = async <T>(f: () => Promise<T>): Promise<T> => { try { return await f(); } catch (e) { throw new UserError(e instanceof Error ? e.message : String(e)); } };
const STATUS: Record<string, string> = { INVITED: 'Eingeladen', ACTIVE: 'Aktiv', ENDED: 'Beendet' };

export const routes: Route[] = [
  { method: 'GET', path: /^\/community$/, h: async (r) => {
    const [rows, st, dir, partners, customers] = await Promise.all([r.ctx.community.list(), r.ctx.community.stats(), r.ctx.community.directory(), r.ctx.partners.list({}), r.ctx.customers.list()]);
    const taken = new Set(rows.flatMap((m: any) => [m.partner_id, m.customer_id]).filter(Boolean));
    const fee = r.ctx.cfg.packages.community;
    return render(r, { title: 'Community', nav: 'community', body: html`
      <div class="note">Die Community ist ein <b>eigenständiges Angebot</b>: Beitrag ${eur(fee.monthlyCents)}/Monat oder ${eur(fee.yearlyCents)}/Jahr (Entwurfspreis), <b>für aktive Partner kostenlos</b>. Sie hängt <b>nicht</b> von Versicherungsverträgen ab. Ein Eintrag im Verzeichnis ist nur mit ausdrücklichem Opt-in möglich. Beiträge werden hier nur angezeigt – nichts wird abgebucht, nichts veröffentlicht.</div>
      <div class="grid"><div class="kpi"><b>${st.members}</b><span>aktive Mitglieder</span></div><div class="kpi"><b>${st.invited}</b><span>eingeladen</span></div><div class="kpi"><b>${st.free}</b><span>kostenlos (aktive Partner)</span></div><div class="kpi"><b>${st.paying}</b><span>zahlend</span></div><div class="kpi"><b>${eur(st.mrrCents)}</b><span>Beiträge / Monat (Soll)</span></div><div class="kpi"><b>${st.listed}</b><span>im Verzeichnis</span></div></div>
      <div class="card"><h2>Mitglieder</h2>${rows.length ? html`<ul class="items">${rows.map((m: any) => html`<li id="m-${m.id}"><div class="row"><b class="grow">${m.company_name}</b><span class="badge ${m.status === 'ACTIVE' ? 'b-ok' : 'b-info'}">${STATUS[m.status]}</span>${m.partner_status ? html`<small>Partner: ${m.partner_status}</small>` : ''}</div>
          <p class="mute">${m.industry ?? 'Branche nicht verfügbar'} · ${m.region ?? 'Region nicht verfügbar'} · Beitrag: ${m.fee.free ? html`<b>kostenlos</b> (${m.fee.reason})` : eur(m.feeCents) + (m.billing === 'YEARLY' ? '/Jahr' : '/Monat')}</p>
          <p>Opt-in: ${m.opt_in ? html`<b>ja</b> (${fmtDate(m.opt_in_at)} – ${m.opt_in_note})` : 'nein'} · Verzeichnis: ${m.listed ? 'gelistet' : 'nicht gelistet'}</p>
          <div class="row">${!m.opt_in ? postForm(r.app.csrf, `/community/${m.id}/optin`, html`<input name="note" placeholder="Wie wurde eingewilligt?" required maxlength="500"><button>Opt-in vermerken</button>`) : postBtn(r.app.csrf, `/community/${m.id}/optout`, 'Opt-in widerrufen')}
            ${m.status !== 'ACTIVE' ? postBtn(r.app.csrf, `/community/${m.id}/status`, 'Mitgliedschaft aktivieren', { cls: 'primary', hidden: { to: 'ACTIVE' } }) : postBtn(r.app.csrf, `/community/${m.id}/status`, 'Beenden', { hidden: { to: 'ENDED' } })}
            ${m.status === 'ACTIVE' && m.opt_in ? postBtn(r.app.csrf, `/community/${m.id}/listed`, m.listed ? 'Aus Verzeichnis nehmen' : 'Ins Verzeichnis aufnehmen', { hidden: { on: m.listed ? '0' : '1' } }) : ''}</div>
          <details><summary>Verzeichnisprofil bearbeiten</summary>${postForm(r.app.csrf, `/community/${m.id}/profile`, html`<label>Branche<input name="industry" value="${m.industry ?? ''}" maxlength="200"></label><label>Region<input name="region" value="${m.region ?? ''}" maxlength="200"></label><label>Angebot (öffentlich, kurz)<textarea name="offer_text" maxlength="1000">${m.offer_text ?? ''}</textarea></label><label>Öffentlicher Kontakt (nur was das Mitglied freigibt)<input name="contact_public" value="${m.contact_public ?? ''}" maxlength="300"></label>
            <label>Abrechnung<select name="billing"><option value="MONTHLY" ${m.billing === 'MONTHLY' ? 'selected' : ''}>monatlich</option><option value="YEARLY" ${m.billing === 'YEARLY' ? 'selected' : ''}>jährlich</option></select></label><button>Speichern</button>`, { style: 'display:block' })}</details></li>`)}</ul>` : html`<p class="mute">Noch keine Mitglieder.</p>`}</div>
      <div class="card"><h2>Mitglied einladen</h2><p class="mute">Einladung = nur ein Vermerk in diesem System. Es wird nichts versendet.</p>
        ${postForm(r.app.csrf, '/community/invite', html`<div class="row"><select name="partner_id"><option value="">Partner wählen …</option>${partners.filter((p: any) => !taken.has(p.id)).map((p: any) => html`<option value="${p.id}">${p.company_name} (${p.status})</option>`)}</select><button>Partner vormerken</button></div>`, { style: 'display:block' })}
        ${postForm(r.app.csrf, '/community/invite', html`<div class="row"><select name="customer_id"><option value="">Kunde wählen …</option>${customers.filter((c: any) => !taken.has(c.id)).map((c: any) => html`<option value="${c.id}">${c.company_name}</option>`)}</select><button>Kunde vormerken</button></div>`, { style: 'display:block' })}</div>
      <div class="card" id="verzeichnis"><h2>Verzeichnis-Vorschau</h2><p class="mute">So würden Einträge aussehen (nur Mitglieder mit Opt-in und Listung). Es gibt keine öffentliche Seite – Veröffentlichung wäre ein eigener, von dir bestätigter Schritt.</p>
        ${dir.length ? html`<ul>${dir.map((d: any) => html`<li><b>${d.company_name}</b> – ${d.industry ?? ''} ${d.region ? `(${d.region})` : ''}<br>${d.offer_text ?? ''} ${d.contact_public ? html`<small>Kontakt: ${d.contact_public}</small>` : ''}</li>`)}</ul>` : html`<p class="mute">Noch keine gelisteten Mitglieder.</p>`}</div>` });
  } },
  { method: 'POST', path: /^\/community\/invite$/, h: async (r) => { const pid = r.form.get('partner_id') || undefined, cid = r.form.get('customer_id') || undefined; if (!pid && !cid) throw new UserError('Bitte Partner oder Kunde wählen.'); const m = await wrap(() => r.ctx.community.invite({ partnerId: pid, customerId: cid })); return redirect(`/community#m-${m}`, okFlash('Vorgemerkt (nichts wurde gesendet).')); } },
  { method: 'POST', path: new RegExp(`^/community/${id}/optin$`), h: async (r) => { await wrap(() => r.ctx.community.recordOptIn(r.params[0], r.form.get('note'))); return redirect(`/community#m-${r.params[0]}`, okFlash('Opt-in vermerkt.')); } },
  { method: 'POST', path: new RegExp(`^/community/${id}/optout$`), h: async (r) => { await r.ctx.community.withdrawOptIn(r.params[0]); return redirect(`/community#m-${r.params[0]}`, okFlash('Opt-in widerrufen, Eintrag aus dem Verzeichnis entfernt.')); } },
  { method: 'POST', path: new RegExp(`^/community/${id}/status$`), h: async (r) => { await wrap(() => r.ctx.community.setStatus(r.params[0], r.form.get('to') ?? '')); return redirect(`/community#m-${r.params[0]}`, okFlash('Status geändert.')); } },
  { method: 'POST', path: new RegExp(`^/community/${id}/listed$`), h: async (r) => { await wrap(() => r.ctx.community.setListed(r.params[0], r.form.get('on') === '1')); return redirect(`/community#m-${r.params[0]}`, okFlash('Verzeichnis aktualisiert.')); } },
  { method: 'POST', path: new RegExp(`^/community/${id}/profile$`), h: async (r) => { await wrap(() => r.ctx.community.updateProfile(r.params[0], Object.fromEntries(r.form))); return redirect(`/community#m-${r.params[0]}`, okFlash('Profil gespeichert.')); } },
];
