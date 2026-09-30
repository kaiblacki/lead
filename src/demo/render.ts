import type { Lead } from '../core/types.ts';
import type { Template } from '../templates/index.ts';

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const telHref = (p: string) => 'tel:' + p.replace(/[^\d+]/g, '');

export type AgencyInfo = { name: string; contactEmail: string };

export const baseCss = (p: Template['palette']) => `:root{--p:${p.primary};--pt:${p.primaryText};--bg:${p.bg};--ink:${p.ink};--soft:${p.soft}}
*{box-sizing:border-box}body{margin:0;font:17px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink)}
.demo{position:sticky;top:0;z-index:5;background:#111;color:#fff;padding:10px 16px;font-size:14px;text-align:center}
.wrap{max-width:960px;margin:0 auto;padding:0 16px}
header.hero{background:var(--p);color:var(--pt);padding:56px 0 48px}
h1{font-size:clamp(28px,7vw,44px);line-height:1.15;margin:0 0 12px}
.sub{font-size:19px;margin:0 0 24px;opacity:.95}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:52px;padding:0 24px;border-radius:12px;background:#fff;color:var(--p);font-weight:700;text-decoration:none;border:2px solid #fff}
section{padding:40px 0}h2{font-size:26px;margin:0 0 16px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.card{background:var(--soft);border-radius:14px;padding:18px}.card h3{margin:0 0 6px;font-size:19px}.card p{margin:0}
.ph{height:160px;border-radius:14px;background:repeating-linear-gradient(45deg,var(--soft),var(--soft) 14px,#ffffff 14px,#ffffff 28px);display:flex;align-items:center;justify-content:center;color:var(--ink);font-size:14px;text-align:center;padding:8px}
.contact{background:var(--soft)}.contact a{color:var(--p);font-weight:700;display:inline-block;padding:11px 0}
.btn2{display:inline-flex;align-items:center;min-height:52px;padding:0 24px;border-radius:12px;background:var(--p);color:var(--pt);font-weight:700;text-decoration:none}
footer{padding:28px 0 48px;font-size:14px}
a:focus-visible{outline:3px solid #000;outline-offset:2px}`;

/**
 * Erzeugt eine eigenständige Demo-Seite (ein HTML-Dokument, kein JavaScript, keine externen Ressourcen).
 * Es werden nur Daten aus dem Lead verwendet. Alle übrigen Inhalte sind als Beispieltext gekennzeichnet.
 */
export function renderDemo(lead: Lead, t: Template, agency: AgencyInfo): string {
  const p = t.palette;
  const name = esc(lead.companyName);
  const addr = [lead.address, lead.city].filter(Boolean).join(', ');
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer">
<title>Demo: ${name}</title>
<style>
${baseCss(p)}
</style></head><body>
<div class="demo" role="note"><b>Unverbindliche Demo / Beispiel</b> – Entwurf von ${esc(agency.name)} für ${name}. Dies ist nicht die offizielle Website des Unternehmens.</div>
<header class="hero"><div class="wrap"><h1>${esc(t.tagline(lead.companyName, lead.city))}</h1><p class="sub">${esc(t.heroSub)}</p>
<a class="btn" href="#kontakt">${esc(t.cta)}</a></div></header>
<main>
<section><div class="wrap"><h2>Leistungen <small style="font-size:14px;font-weight:400">(Beispiel-Inhalte)</small></h2>
<div class="grid">${t.services.map((s) => `<div class="card"><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></div>`).join('')}</div></div></section>
<section><div class="wrap"><h2>Eindrücke</h2><div class="grid"><div class="ph">Platzhalter – hier kommen später Ihre eigenen Fotos hin</div><div class="ph">Platzhalter – hier kommen später Ihre eigenen Fotos hin</div></div></div></section>
${t.booking ? `<section><div class="wrap"><h2>Online-Termin</h2><p>So könnte die Terminanfrage aussehen. In dieser Demo ist sie nicht aktiv.</p><span class="btn2" aria-disabled="true">${esc(t.cta)} (Demo)</span></div></section>` : ''}
<section class="contact" id="kontakt"><div class="wrap"><h2>Kontakt</h2>
<p><b>${name}</b>${addr ? `<br>${esc(addr)}` : ''}</p>
${lead.phone ? `<p><a href="${esc(telHref(lead.phone))}">${esc(lead.phone)}</a></p>` : '<p>Telefonnummer folgt.</p>'}
<p>Öffnungszeiten: ${lead.openingHours ? esc(lead.openingHours) : 'folgen (Beispielentwurf)'}</p></div></section>
</main>
<footer><div class="wrap">Diese Demo dient nur der Ansicht und wurde ohne Beauftragung erstellt. Texte sind Platzhalter, Bilder sind nicht enthalten. Rückfragen: ${esc(agency.contactEmail)}</div></footer>
</body></html>`;
}

/** Hinweise, die vor dem Teilen der Demo behoben werden sollten. */
export function demoWarnings(html: string): string[] {
  const w: string[] = [];
  if (/\[[^\]]{3,}\]/.test(html)) w.push('Agentur-Angaben sind noch Platzhalter (config/agency.json).');
  if (html.includes('Telefonnummer folgt')) w.push('Keine Telefonnummer im Lead vorhanden.');
  return w;
}
