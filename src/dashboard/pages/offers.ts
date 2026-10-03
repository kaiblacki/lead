import type { Route } from '../types.ts';
import { UserError } from '../types.ts';
import { html, raw, eur, fmt, fmtDate, postForm, postBtn, type Safe } from '../ui.ts';
import { render, redirect, okFlash, uuid } from './_page.ts';
import { OFFER_LABEL, OFFER_STATUSES, type OfferStatus } from '../../offers/flow.ts';
import { suggestAddons, type Quote, type QuoteSelection } from '../../pricing/quote.ts';
import { PARTNER_LABEL, type PartnerStatus } from '../../partners/model.ts';
import type { OfferV2 } from '../../offers/from-quote.ts';

const id = uuid.source;
const wrap = async <T>(f: () => Promise<T>): Promise<T> => { try { return await f(); } catch (e) { throw new UserError(e instanceof Error ? e.message : String(e)); } };
/** „1.490,50“ / „745“ / „39,9“ → Cent. Leer → null. */
export function parseEuro(s: string | null | undefined): number | null {
  const t = String(s ?? '').replace(/[€\s]/g, ''); if (!t) return null;
  const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t); if (!Number.isFinite(n) || n < 0) throw new UserError(`„${s}“ ist kein gültiger Betrag.`);
  return Math.round(n * 100);
}
const eurIn = (c: number | null | undefined) => (c == null ? '' : String(c / 100).replace('.', ','));

export function quoteSummary(q: Quote): Safe {
  const pd = q.partner_discount;
  return html`<div class="scroll"><table class="tbl"><tr><th>Position</th><th style="text-align:right">Betrag</th></tr>
    ${q.lines.map((l) => html`<tr><td>${l.label}${l.overridden ? html` <span class="badge b-warn">Preis geändert</span>` : ''}${l.note ? html`<br><small class="mute">${l.note}</small>` : ''}</td><td style="text-align:right">${eur(l.cents)}${l.monthly ? ' / Monat' : ''}</td></tr>`)}</table></div>
    <dl class="facts"><dt>Normalpreis (Paket)</dt><dd>${eur(q.normalPriceCents)}</dd>
      <dt>partner_discount</dt><dd>${pd.applied ? html`<b>− ${eur(pd.cents)}</b> (${pd.percent} % auf ${eur(pd.baseCents)}) · Grund: <code>${pd.reason}</code>` : html`kein Partner-Rabatt${pd.note ? html` <small class="mute">– ${pd.note}</small>` : ''}`}</dd>
      <dt>Add-ons</dt><dd>${eur(q.addonsCents)}</dd><dt>Einmalpreis</dt><dd><b>${eur(q.oneTimeCents)}</b> netto <small class="mute">(Anzahlung ${eur(q.depositCents)} · Rest ${eur(q.finalCents)})</small></dd>
      <dt>Monatlich (Wartung)</dt><dd><b>${eur(q.monthlyCents)}</b>${q.thirdPartyMonthlyCents ? html` + Drittanbieter ${eur(q.thirdPartyMonthlyCents)}` : ''}</dd>
      <dt>Drittanbieter (einmalig)</dt><dd>${eur(q.thirdPartyOneTimeCents)}</dd><dt>Gesamt (einmalig inkl. Fremdkosten)</dt><dd><b>${eur(q.totalCents)}</b></dd></dl>
    ${q.warnings.map((w) => html`<div class="warnbox">${w}</div>`)}`;
}

/** Preis-Konfigurator + Angebot auf der Lead-Seite (alles editierbar; Preise zentral in config/packages.json). */
export function quoteCard(o: { csrf: string; leadId: string; cfg: any; quote: any | null; partnerStatus: PartnerStatus; modules: string[]; offers: any[]; offerRequested: boolean }): Safe {
  const P = o.cfg.packages; const sel: QuoteSelection = o.quote?.selection ?? { package: 'BUSINESS' }; const q: Quote | null = o.quote?.computed ?? null;
  const picked = new Map((sel.addons ?? []).map((a) => [a.key, a])); const tp = sel.thirdParty ?? []; const sugg = new Set(suggestAddons(o.cfg, sel.package, o.modules));
  const mr = P.marketReference;
  return html`<div class="card" id="angebot"><div class="row"><h2 class="grow" style="margin:0">Angebot und Preis-Konfigurator</h2><span class="badge b-warn" title="${P.statusNote}">${P.status}</span></div>
    <p class="mute">Preise stehen zentral in <code>config/packages.json</code> und sind hier je Position überschreibbar. Partnerstatus des Leads: <b>${PARTNER_LABEL[o.partnerStatus]}</b>${o.offerRequested ? ' · Angebot wurde im Gespräch gewünscht.' : ''}</p>
    ${postForm(o.csrf, `/leads/${o.leadId}/quote`, html`
      <div class="stack"><b>Paket</b>${Object.entries(P.packages).map(([k, p]: [string, any]) => html`<label class="inline"><input type="radio" name="package" value="${k}" ${sel.package === k ? raw('checked') : ''}> <b>${p.label}</b> ${eur(p.priceCents)} <small class="mute">${p.pages} – ${p.suitableFor}</small></label>`)}
        <label>Paketpreis überschreiben (€, leer = Standard)<input name="package_price" inputmode="decimal" value="${eurIn(sel.packagePriceOverrideCents)}"></label></div>
      <details ${picked.size ? raw('open') : ''}><summary>Add-ons (${picked.size} gewählt)</summary><div class="scroll"><table class="tbl"><tr><th></th><th>Add-on</th><th>Menge</th><th>Preis (€)</th></tr>
        ${Object.entries(P.addons).map(([k, a]: [string, any]) => { const s = picked.get(k); const inc = a.includedIn?.includes(sel.package); return html`<tr><td><input type="checkbox" name="addon" value="${k}" ${s ? raw('checked') : ''}></td><td>${a.label}${inc ? html` <small class="mute">(im Paket enthalten)</small>` : ''}${sugg.has(k) ? html` <span class="badge b-info" title="Baustein ist in der Demo empfohlen">empfohlen</span>` : ''}${a.thirdParty ? html` <small class="mute">· Drittanbieter ggf. separat</small>` : ''}</td>
          <td><input name="qty_${k}" type="number" min="1" max="50" value="${s?.quantity ?? 1}" style="width:70px"></td><td><input name="price_${k}" inputmode="decimal" placeholder="${eurIn(a.priceCents)}" value="${eurIn(s?.priceOverrideCents)}" style="width:100px"></td></tr>`; })}</table></div></details>
      <label>Wartung<select name="care"><option value="">keine</option>${Object.entries(P.care).map(([k, c]: [string, any]) => html`<option value="${k}" ${sel.care === k ? raw('selected') : ''}>${c.label} – ${eur(c.monthlyCents)}/Monat</option>`)}</select></label>
      <label>Wartungspreis überschreiben (€/Monat)<input name="care_price" inputmode="decimal" value="${eurIn(sel.carePriceOverrideCents)}"></label>
      <details ${tp.length ? raw('open') : ''}><summary>Drittanbieter-/Fremdkosten (nicht rabattiert)</summary><p class="mute">${P.thirdPartyNote}</p>${[0, 1, 2].map((i) => html`<div class="row"><input name="tp_label_${i}" placeholder="Bezeichnung (z. B. Domain)" value="${tp[i]?.label ?? ''}"><input name="tp_amount_${i}" inputmode="decimal" placeholder="€" value="${eurIn(tp[i]?.cents)}" style="width:100px"><label class="inline"><input type="checkbox" name="tp_monthly_${i}" value="1" ${tp[i]?.monthly ? raw('checked') : ''}> monatlich</label></div>`)}</details>
      <div class="note"><b>Partnerpreis</b> (${P.partnerDiscount.percent} % nur auf den Basispreis; Grund <code>${P.partnerDiscount.reason}</code> – nie Versicherung)<br>
        ${o.partnerStatus === 'ACTIVE_PARTNER' ? html`<label class="inline"><input type="checkbox" name="partner_approved" value="1" ${o.quote?.partner_discount_approved ? raw('checked') : ''}> Partnerpreis manuell freigeben</label>` : html`<small class="mute">Nur für aktive Partner (aktuell: ${PARTNER_LABEL[o.partnerStatus]}).</small>`}
        <details><summary>Manueller Rabatt (Kai)</summary><div class="row"><input name="manual_percent" type="number" min="0" max="100" placeholder="%" style="width:80px" value="${sel.manualDiscount?.percent ?? ''}"><input name="manual_reason" placeholder="Begründung (Pflicht)" class="grow" value="${sel.manualDiscount?.reason ?? ''}"></div></details></div>
      <p><button class="primary">Konfiguration speichern und berechnen</button></p>`, { style: 'display:block' })}
    ${q ? html`<h3>Ergebnis</h3>${quoteSummary(q)}` : html`<p class="mute">Noch keine Konfiguration gespeichert.</p>`}
    <details><summary>Interne Vertriebsorientierung (nicht für Kunden)</summary><div class="note"><b>${mr.label}:</b> ${mr.pages}: ca. ${eur(mr.medianCents)} Median (${mr.sample}); ${mr.rangeNote}<br><small class="mute">${mr.note}</small></div></details>
    <div class="row">${q ? postBtn(o.csrf, `/leads/${o.leadId}/offer/create`, 'Angebot erstellen', { cls: 'primary' }) : ''}</div>
    ${o.offers.length ? html`<b>Angebote</b><ul class="items">${o.offers.map((f) => html`<li><a href="/offers/${f.id}"><b>${OFFER_LABEL[f.status as OfferStatus] ?? f.status}</b> · ${eur(f.price_cents)} einmalig${f.maintenance_cents ? ` + ${eur(f.maintenance_cents)}/Monat` : ''}</a> <small class="mute">${fmt(f.created_at)}${f.partner_discount_cents ? ` · Partner-Rabatt ${eur(f.partner_discount_cents)}` : ''}</small></li>`)}</ul>` : ''}
  </div>`;
}

const CHAIN: OfferStatus[] = ['DRAFT', 'READY_FOR_REVIEW', 'APPROVED', 'SENT', 'ACCEPTED'];
export const routes: Route[] = [
  { method: 'POST', path: new RegExp(`^/leads/${id}/quote$`), h: async (r) => {
    const f = r.form; const P = r.ctx.cfg.packages; const leadId = r.params[0];
    const addons = f.getAll('addon').map((k) => ({ key: k, quantity: Number(f.get(`qty_${k}`) || 1), priceOverrideCents: parseEuro(f.get(`price_${k}`)) }));
    const thirdParty = [0, 1, 2].map((i) => ({ label: (f.get(`tp_label_${i}`) ?? '').trim(), cents: parseEuro(f.get(`tp_amount_${i}`)) ?? 0, monthly: f.get(`tp_monthly_${i}`) === '1' })).filter((t) => t.label || t.cents);
    const mp = f.get('manual_percent'); const manualDiscount = mp !== null && mp !== '' ? { percent: Number(mp), reason: f.get('manual_reason') ?? '' } : null;
    if (!P.packages[f.get('package') ?? '']) throw new UserError('Bitte ein Paket wählen.');
    await wrap(() => r.ctx.quotes.save(leadId, { package: f.get('package')!, packagePriceOverrideCents: parseEuro(f.get('package_price')), addons, care: f.get('care') || null, carePriceOverrideCents: parseEuro(f.get('care_price')), thirdParty, manualDiscount, partnerDiscountApproved: f.get('partner_approved') === '1' }));
    return redirect(`/leads/${leadId}#angebot`, okFlash('Konfiguration gespeichert und berechnet.'));
  } },
  { method: 'POST', path: new RegExp(`^/leads/${id}/offer/create$`), h: async (r) => {
    const out = await wrap(() => r.ctx.offerFlow.createFromQuote(r.params[0]));
    return redirect(`/offers/${out.offerId}`, okFlash(out.warnings.length ? `Angebotsentwurf erstellt (nicht gesendet). ${out.warnings[0]}` : 'Angebotsentwurf erstellt – nicht gesendet. Bitte prüfen.'));
  } },
  { method: 'GET', path: new RegExp(`^/offers/${id}$`), h: async (r) => {
    await r.ctx.offerFlow.expireDue(); const o = await r.ctx.offerFlow.get(r.params[0]);
    if (!o) return render(r, { title: 'Nicht gefunden', nav: 'leads', status: 404, body: html`<p>Angebot nicht gefunden.</p>` });
    const c = o.content as OfferV2; const st = o.status as OfferStatus; const v2 = c.quoteBased;
    return render(r, { title: `Angebot – ${o.company_name}`, nav: 'sales', crumbs: [['Startseite', '/'], ['Sales'], ['Angebote', '/offers'], [`Angebot – ${o.company_name}`]], back: ['← Zum Lead', `/leads/${o.lead_id}?tab=angebot`], body: html`
      <div class="card"><div class="stepper">${CHAIN.map((s) => html`<span class="step ${s === st ? 'now' : CHAIN.indexOf(s) < CHAIN.indexOf(st) ? 'done' : ''}">${OFFER_LABEL[s]}</span>`)}${st === 'DECLINED' || st === 'EXPIRED' ? html`<span class="step now">${OFFER_LABEL[st]}</span>` : ''}</div>
        <p class="mute">Entwurf – nichts wurde gesendet. Gültig bis ${fmtDate(o.valid_until ?? c.validUntil)}. <a href="/leads/${o.lead_id}#angebot">← Lead</a></p>
        ${(c.warnings ?? []).map((w) => html`<div class="warnbox">${w}</div>`)}${c.internalDraft ? html`<div class="warnbox"><b>INTERNAL_DRAFT_PRICE</b> – Die Preise sind noch nicht final bestätigt; die Freigabe verlangt deine Bestätigung.</div>` : ''}
        <div class="row">${st === 'DRAFT' ? postBtn(r.app.csrf, `/offers/${o.id}/ready`, 'Zur Prüfung', { cls: 'primary' }) : ''}
          ${['DRAFT', 'READY_FOR_REVIEW'].includes(st) ? postForm(r.app.csrf, `/offers/${o.id}/approve`, html`${c.internalDraft ? html`<label class="inline"><input type="checkbox" name="confirm_prices" value="1"> Preise bestätigt</label>` : ''}<button class="ok">Freigeben</button>`) : ''}
          ${st === 'APPROVED' ? postBtn(r.app.csrf, `/offers/${o.id}/sent`, 'Als versendet markieren (ich habe es selbst gesendet)', { cls: 'primary' }) : ''}
          ${st === 'SENT' ? postBtn(r.app.csrf, `/leads/${o.lead_id}/accept`, 'Angenommen – Auftrag anlegen', { cls: 'ok' }) : ''}${['SENT', 'APPROVED'].includes(st) ? postBtn(r.app.csrf, `/offers/${o.id}/decline`, 'Abgelehnt') : ''}</div></div>
      <div class="card"><h2>${c.title}</h2><p><b>${c.customer?.name}</b>${c.customer?.address ? ` · ${c.customer.address}` : ''}</p>
        <h3>Leistungsumfang</h3><ul>${(c.scope ?? []).map((x) => html`<li>${x}</li>`)}</ul>
        ${v2 ? html`<h3>Preise</h3><div class="scroll"><table class="tbl">${c.lines.map((l) => html`<tr><td>${l.label}${l.note ? html`<br><small class="mute">${l.note}</small>` : ''}</td><td style="text-align:right">${eur(l.cents)}${l.monthly ? ' / Monat' : ''}</td></tr>`)}</table></div>
          ${c.partnerDiscount ? html`<p><b>Partnerpreis:</b> ${c.partnerDiscount.percent} % auf den Basispreis (${eur(c.partnerDiscount.baseCents)}) = − ${eur(c.partnerDiscount.cents)}</p>` : ''}
          <dl class="facts"><dt>Einmalpreis (netto)</dt><dd><b>${eur(c.priceCents)}</b></dd><dt>Laufend</dt><dd>${c.maintenanceCentsPerMonth ? `${eur(c.maintenanceCentsPerMonth)} / Monat` : 'keine Wartung gebucht'}</dd>
            <dt>Zahlungsplan</dt><dd>Anzahlung ${eur(c.paymentPlan.depositCents)} (${c.paymentPlan.depositPercent} %), Restzahlung ${eur(c.paymentPlan.finalCents)} nach Kundenfreigabe</dd></dl>
          ${c.thirdParty.length ? html`<h3>Fremdkosten</h3><ul>${c.thirdParty.map((t) => html`<li>${t.label}: ${eur(t.cents)}${t.monthly ? ' / Monat' : ''}</li>`)}</ul><small class="mute">${c.thirdPartyNote}</small>` : html`<small class="mute">${c.thirdPartyNote}</small>`}
          <h3>Projektablauf</h3><ol>${c.process.map((x) => html`<li>${x}</li>`)}</ol><h3>Voraussetzungen</h3><ul>${c.prerequisites.map((x) => html`<li>${x}</li>`)}</ul>
          <h3>Korrekturschleifen</h3><p>${c.revisionRounds} Korrekturrunde(n) enthalten.</p><h3>Laufzeiten und Lieferung</h3><p>${c.deliveryNote}<br>Wartung: ${c.maintenanceTerm}</p>`
          : html`<dl class="facts"><dt>Einmalpreis</dt><dd><b>${eur(c.priceCents)}</b></dd><dt>Wartung</dt><dd>${eur(c.maintenanceCentsPerMonth)} / Monat</dd></dl>`}
        <h3>Hinweise</h3><p>${c.vatNote}</p><ul>${(c.terms ?? []).map((x) => html`<li>${x}</li>`)}</ul>${c.demoUrl ? html`<p>Demo: <a href="${c.demoUrl}" target="_blank" rel="noopener noreferrer">${c.demoUrl}</a></p>` : ''}</div>
      <p><a class="btn" href="/leads/${o.lead_id}#angebot">← Zum Lead</a></p>` });
  } },
  { method: 'POST', path: new RegExp(`^/offers/${id}/ready$`), h: async (r) => { await wrap(() => r.ctx.offerFlow.markReady(r.params[0])); return redirect(`/offers/${r.params[0]}`, okFlash('Zur Prüfung gestellt.')); } },
  { method: 'POST', path: new RegExp(`^/offers/${id}/decline$`), h: async (r) => { await wrap(() => r.ctx.offerFlow.decline(r.params[0])); return redirect(`/offers/${r.params[0]}`, okFlash('Angebot als abgelehnt markiert.')); } },
];
void OFFER_STATUSES;
