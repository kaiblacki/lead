import type { Template } from './templates.ts';
import { fill } from './templates.ts';
import { esc, telHref, type AgencyInfo, type DemoHints, type SiteContent } from './engine.ts';
import type { Family } from './modules.ts';

/**
 * Demo-Seite (Version 2): moderne, responsive Basis mit Layout-Familie und wählbaren Modulen.
 * Regeln: Nur echte Angaben (mit Quelle) oder klar als „Beispiel“ gekennzeichnete Inhalte; keine erfundenen Bewertungen, Preise, Mitarbeiter oder Referenzen.
 * Funktionen (Formulare, Terminwahl …) sind Darstellungen – sie senden nichts und sind als „Demo-Funktion“ markiert.
 */
export type DemoPlan = { family: Family; modules: string[]; moduleLabels: Record<string, string> };
export type DemoExtras = { social?: { platform: string; url: string }[]; whatsapp?: string };

const ORDER: Record<Family, string[]> = {
  SERVICE: ['services', 'quote', 'callback', 'price_list', 'gallery', 'contact_form', 'jobs', 'booking', 'reservation', 'menu', 'whatsapp', 'newsletter', 'social', 'map'],
  APPOINTMENT: ['booking', 'services', 'price_list', 'gallery', 'whatsapp', 'contact_form', 'callback', 'social', 'newsletter', 'quote', 'reservation', 'menu', 'jobs', 'map'],
  GASTRO_RETAIL: ['menu', 'reservation', 'gallery', 'services', 'price_list', 'contact_form', 'callback', 'social', 'newsletter', 'whatsapp', 'booking', 'quote', 'jobs', 'map'],
};
const ANCHOR: Record<string, string> = { services: 'leistungen', quote: 'angebot', callback: 'rueckruf', price_list: 'preise', gallery: 'galerie', contact_form: 'nachricht', jobs: 'jobs', booking: 'termin', reservation: 'reservierung', menu: 'speisekarte', whatsapp: 'whatsapp', newsletter: 'newsletter', social: 'social', map: 'standort' };
const NAVLABEL: Record<string, string> = { services: 'Leistungen', quote: 'Angebot', callback: 'Rückruf', price_list: 'Preise', gallery: 'Galerie', contact_form: 'Nachricht', jobs: 'Jobs', booking: 'Termin', reservation: 'Reservieren', menu: 'Speisekarte', whatsapp: 'WhatsApp', newsletter: 'Newsletter', social: 'Social', map: 'Standort' };
const BADGE = '<span class="badge">Demo-Funktion</span>';
const EX = '<span class="badge ex">Beispiel</span>';

const css = (t: Template, family: Family, sticky: boolean) => {
  const p = t.palette;
  const heading = family === 'GASTRO_RETAIL' ? 'Georgia,"Times New Roman",serif' : 'inherit';
  const radius = family === 'SERVICE' ? '6px' : family === 'APPOINTMENT' ? '20px' : '12px';
  const heroAlign = family === 'APPOINTMENT' ? 'center' : 'left';
  return `:root{--p:${p.primary};--pt:${p.primaryText};--bg:${p.bg};--ink:${p.ink};--soft:${p.soft};--r:${radius}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}body{margin:0;font:17px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink)}
.wrap{max-width:1080px;margin:0 auto;padding:0 16px}h1,h2,h3{font-family:${heading};overflow-wrap:anywhere}img,svg{max-width:100%}
.demo{position:sticky;top:0;z-index:20;background:#111;color:#fff;padding:10px 16px;font-size:14px;text-align:center}
.top{background:#fff;border-bottom:1px solid var(--soft)}.top .wrap{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 18px;padding-top:6px;padding-bottom:6px}
.brand{font-weight:800;font-size:19px;color:var(--p);text-decoration:none;padding:10px 0;overflow-wrap:anywhere}
.top nav{display:flex;flex-wrap:wrap;gap:0 4px}.top nav a{display:inline-flex;align-items:center;min-height:44px;padding:0 10px;color:var(--ink);text-decoration:none;font-weight:600;font-size:15px;border-radius:8px}.top nav a:hover{background:var(--soft)}
.hero{background:linear-gradient(135deg,var(--p),${p.primary}e6 55%,${p.primary}cc);color:var(--pt);padding:56px 0 52px;text-align:${heroAlign};position:relative;overflow:hidden}
.hero:after{content:"";position:absolute;right:-80px;top:-80px;width:320px;height:320px;border-radius:50%;background:rgba(255,255,255,.08)}
.hero .wrap{position:relative;z-index:1;${family === 'APPOINTMENT' ? 'max-width:760px' : ''}}
h1{font-size:clamp(30px,6.5vw,52px);line-height:1.1;margin:0 0 14px}.lead{font-size:clamp(17px,2.4vw,21px);margin:0 0 26px;max-width:640px;${family === 'APPOINTMENT' ? 'margin-left:auto;margin-right:auto;' : ''}opacity:.95}
.btn,.btn2{display:inline-flex;align-items:center;justify-content:center;min-height:52px;min-width:44px;padding:0 26px;border-radius:var(--r);font-weight:700;text-decoration:none;margin:0 10px 10px 0;border:2px solid transparent;font-size:17px;font-family:inherit;cursor:pointer}
.btn{background:#fff;color:var(--p);border-color:#fff}.btn.ghost{background:transparent;color:var(--pt);border-color:var(--pt)}.btn2{background:var(--p);color:var(--pt)}
.btn[aria-disabled=true],.btn2[aria-disabled=true]{cursor:not-allowed}
.facts{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin-top:-28px;position:relative;z-index:2}
.fact{background:#fff;border-radius:var(--r);padding:16px 18px;box-shadow:0 6px 24px rgba(0,0,0,.08);border:1px solid var(--soft)}.fact small{display:block;opacity:.75;font-size:13px;text-transform:uppercase;letter-spacing:.04em}.fact b,.fact a{font-size:18px;color:var(--ink);text-decoration:none;display:inline-block;padding:4px 0;overflow-wrap:anywhere}.fact a{display:inline-flex;align-items:center;min-height:44px}
section{padding:46px 0}section.alt{background:var(--soft)}h2{font-size:clamp(24px,4vw,32px);margin:0 0 18px;line-height:1.2}h3{margin:0 0 6px;font-size:19px}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}.card{background:#fff;border-radius:var(--r);padding:20px;border:1px solid var(--soft)}section.alt .card{border-color:transparent}.card p{margin:0}
.badge{display:inline-block;font-size:12px;font-weight:700;padding:2px 9px;border-radius:99px;background:#111;color:#fff;margin-left:8px;vertical-align:middle;letter-spacing:.02em}.badge.ex{background:#fff;color:#111;border:1px solid #111}
.ph{min-height:150px;border-radius:var(--r);background:repeating-linear-gradient(45deg,var(--soft),var(--soft) 14px,#fff 14px,#fff 28px);display:flex;align-items:center;justify-content:center;text-align:center;font-size:14px;padding:10px;border:1px dashed var(--p)}
div.demo-form{display:grid;gap:12px;max-width:560px}.demo-form label{display:grid;gap:4px;font-weight:600;font-size:15px}.demo-form input,.demo-form select,.demo-form textarea{font:inherit;min-height:48px;padding:10px 12px;border:1px solid #888;border-radius:8px;background:#fff;color:#111;width:100%}.demo-form textarea{min-height:110px}
.slots{display:flex;flex-wrap:wrap;gap:10px}.slot{min-height:48px;min-width:72px;padding:0 14px;border:2px solid var(--p);border-radius:var(--r);display:inline-flex;align-items:center;justify-content:center;font-weight:700;color:var(--p);background:#fff}
.menu{display:grid;gap:10px;max-width:640px}.menu div{display:flex;justify-content:space-between;gap:12px;border-bottom:1px dotted #999;padding:8px 0}
.cta{background:var(--p);color:var(--pt);padding:42px 0;text-align:center}.cta h2{margin-bottom:10px}
.contact a{color:var(--p);font-weight:700;display:inline-block;padding:11px 0;overflow-wrap:anywhere}.links a{display:inline-flex;align-items:center;min-height:44px;padding:0 16px;margin:0 10px 10px 0;border:2px solid var(--p);border-radius:var(--r);color:var(--p);font-weight:700;text-decoration:none;background:#fff}
.notes{background:#fff;border:1px dashed var(--p);border-radius:12px;padding:14px 16px;font-size:15px}
footer{padding:28px 0 ${sticky ? 96 : 40}px;font-size:14px;background:#111;color:#eee}footer a{color:#fff}
${sticky ? '.stick{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid var(--soft);padding:8px 16px;display:flex;gap:8px;justify-content:center;z-index:15}.stick a{flex:1;max-width:420px;margin:0}@media (min-width:900px){.stick{display:none}footer{padding-bottom:40px}}' : ''}
a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid #000;outline-offset:2px}
@media (max-width:640px){.hero{padding:40px 0 44px}.top .wrap{justify-content:center}.btn,.btn2{width:100%;margin-right:0}section{padding:34px 0}}
@media (min-width:641px) and (max-width:960px){.grid{grid-template-columns:repeat(2,1fr)}}`;
};

export function renderDemoV2(c: SiteContent, t: Template, agency: AgencyInfo, h: DemoHints, plan: DemoPlan, x: DemoExtras = {}): string {
  const name = esc(c.companyName);
  const city = c.city?.replace(/^\d{5}\s*/, '');
  const addr = [c.address, [c.postalCode, c.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const has = new Set(plan.modules);
  const sel = ORDER[plan.family].filter((m) => has.has(m));
  const vars = { name: c.companyName, city, sub: c.industryLabel ?? t.label };
  const primaryAction = has.has('booking') ? { label: 'Termin anfragen', to: 'termin' } : has.has('reservation') ? { label: 'Tisch reservieren', to: 'reservierung' } : has.has('quote') ? { label: 'Angebot anfragen', to: 'angebot' } : has.has('callback') ? { label: 'Rückruf anfordern', to: 'rueckruf' } : { label: t.copy.cta, to: 'kontakt' };
  const tagline = c.tagline || fill(t.copy.tagline, vars);
  const sub = fill(t.copy.heroSub, vars) + ' – Beispielentwurf.';
  const demoOnly = (label: string) => `<button type="button" class="btn2" aria-disabled="true" title="Nur Demo – es wird nichts gesendet">${esc(label)}</button>`;
  const field = (l: string, type = 'text', ph = '') => `<label>${esc(l)}<input type="${type}" placeholder="${esc(ph)}" autocomplete="off"></label>`;
  const sec = (id: string, title: string, inner: string, alt = false, tag = '') => `<section id="${id}"${alt ? ' class="alt"' : ''}><div class="wrap"><h2>${esc(title)}${tag}</h2>${inner}</div></section>`;
  const parts: Record<string, () => string> = {
    services: () => sec('leistungen', t.copy.servicesTitle, `<div class="grid">${c.services.map((s) => `<div class="card"><h3>${esc(s.title)}</h3>${s.text ? `<p>${esc(s.text)}</p>` : ''}</div>`).join('')}</div>`, true, h.servicesAreExamples ? EX : ''),
    quote: () => sec('angebot', 'Angebot anfragen', `<div class="demo-form" role="group" aria-label="Beispielformular (Demo)">${field('Ihr Anliegen')}${field('PLZ / Einsatzort')}${field('Telefon oder E-Mail')}${demoOnly('Anfrage senden (Demo)')}</div><p><small>Formular nur zur Ansicht – es wird nichts gesendet.</small></p>`, false, BADGE),
    callback: () => sec('rueckruf', 'Rückruf anfordern', `<div class="demo-form" role="group" aria-label="Beispielformular (Demo)">${field('Telefonnummer', 'tel')}<label>Wunschzeit<select><option>Vormittags</option><option>Nachmittags</option></select></label>${demoOnly('Rückruf anfordern (Demo)')}</div>`, true, BADGE),
    price_list: () => sec('preise', 'Preise & Leistungen', `<div class="menu">${c.services.slice(0, 6).map((s) => `<div><span>${esc(s.title)}</span><span>Preis folgt</span></div>`).join('')}</div><p><small>Beispielstruktur – Preise trägt das Unternehmen selbst ein; hier sind keine Preise erfunden.</small></p>`, false, EX),
    gallery: () => sec('galerie', 'Eindrücke', `<div class="grid">${[1, 2, 3, 4, 5, 6].map((n) => `<div class="ph">Platzhalter ${n} – hier kommen später eigene Fotos hin</div>`).join('')}</div>`, true, EX),
    contact_form: () => sec('nachricht', 'Nachricht schreiben', `<div class="demo-form" role="group" aria-label="Beispielformular (Demo)">${field('Name')}${field('E-Mail', 'email')}<label>Nachricht<textarea autocomplete="off"></textarea></label>${demoOnly('Absenden (Demo)')}</div>`, false, BADGE),
    jobs: () => sec('jobs', 'Jobs & Bewerbung', `<div class="card"><p>Hier könnte das Unternehmen offene Stellen zeigen und Bewerbungen entgegennehmen.</p></div><p>${demoOnly('Jetzt bewerben (Demo)')}</p>`, true, BADGE + EX),
    booking: () => sec('termin', t.copy.bookingTitle, `<p>${esc(t.copy.bookingText)}</p><div class="slots" aria-label="Beispiel-Terminauswahl">${['Mo 10:00', 'Mo 14:30', 'Di 11:00', 'Mi 16:00'].map((s) => `<span class="slot">${s}</span>`).join('')}</div><p><small>Beispiel-Termine – keine echte Buchung.</small></p><p>${demoOnly(t.copy.cta + ' (Demo)')}</p>`, true, BADGE),
    reservation: () => sec('reservierung', 'Tisch reservieren', `<div class="demo-form" role="group" aria-label="Beispielformular (Demo)">${field('Datum', 'date')}${field('Uhrzeit', 'time')}${field('Personen', 'number', '2')}${demoOnly('Reservierung anfragen (Demo)')}</div>`, true, BADGE),
    menu: () => sec('speisekarte', 'Speisekarte', c.services.length && !h.servicesAreExamples ? `<div class="menu">${c.services.map((s) => `<div><span>${esc(s.title)}</span></div>`).join('')}</div>` : `<div class="menu"><div><span>Beispiel: Tagesgericht</span><span>–</span></div><div><span>Beispiel: Vorspeise</span><span>–</span></div><div><span>Beispiel: Getränke</span><span>–</span></div></div><p><small>Beispielstruktur – die echte Karte liefert das Unternehmen.</small></p>`, false, h.servicesAreExamples || !c.services.length ? EX : ''),
    whatsapp: () => sec('whatsapp', 'Per WhatsApp schreiben', `<p>${x.whatsapp ? `<a class="btn2" href="${esc(x.whatsapp)}" rel="noopener noreferrer">WhatsApp öffnen</a>` : demoOnly('WhatsApp-Nachricht (Demo)')}</p>${x.whatsapp ? '' : '<p><small>Der WhatsApp-Link wird später mit der echten Nummer des Unternehmens eingetragen.</small></p>'}`, true, x.whatsapp ? '' : BADGE),
    newsletter: () => sec('newsletter', 'Newsletter', `<div class="demo-form" role="group" aria-label="Beispielformular (Demo)">${field('E-Mail', 'email')}${demoOnly('Anmelden (Demo)')}</div>`, false, BADGE),
    social: () => sec('social', 'Social Media', `<div class="links">${x.social?.length ? x.social.map((s) => `<a href="${esc(s.url)}" rel="noopener noreferrer">${esc(s.platform[0].toUpperCase() + s.platform.slice(1))}</a>`).join('') : '<a href="#" aria-disabled="true">Instagram (Beispiel)</a><a href="#" aria-disabled="true">Facebook (Beispiel)</a>'}</div>`, true, x.social?.length ? '' : EX),
    map: () => sec('standort', 'Standort', addr ? `<p>${esc(addr)}</p><p class="links"><a href="https://www.openstreetmap.org/search?query=${encodeURIComponent(addr)}" rel="noopener noreferrer">In OpenStreetMap öffnen</a></p>` : '<div class="ph">Karte / Anfahrt – Adresse folgt</div>', false, addr ? '' : EX),
  };
  const about = `<section id="ueber-uns"><div class="wrap"><h2>${esc(t.copy.aboutTitle)}${c.about ? '' : EX}</h2>${c.about ? c.about.split('\n').filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('') : '<p>Hier steht später Ihr eigener Text über Ihr Unternehmen.</p>'}</div></section>`;
  const hours = `<section id="oeffnungszeiten" class="alt"><div class="wrap"><h2>Öffnungszeiten${c.openingHours ? '' : EX}</h2><p>${c.openingHours ? esc(c.openingHours).replace(/\n/g, '<br>') : 'Öffnungszeiten folgen (Beispielentwurf).'}</p></div></section>`;
  const cta = `<section class="cta"><div class="wrap"><h2>${esc(primaryAction.label)}?</h2><p>${c.phone ? 'Rufen Sie an oder schreiben Sie uns.' : 'Nehmen Sie Kontakt auf.'}</p><a class="btn" href="#${primaryAction.to}">${esc(primaryAction.label)}</a>${c.phone ? `<a class="btn ghost" href="${esc(telHref(c.phone))}">${esc(c.phone)}</a>` : ''}</div></section>`;
  const contact = `<section class="contact" id="kontakt"><div class="wrap"><h2>Kontakt</h2><p><b>${name}</b>${addr ? `<br>${esc(addr)}` : ''}</p>${c.phone ? `<p><a href="${esc(telHref(c.phone))}">${esc(c.phone)}</a></p>` : '<p>Telefonnummer folgt.</p>'}${c.email ? `<p><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></p>` : ''}</div></section>`;
  const nav = [...sel.map((m) => [ANCHOR[m], NAVLABEL[m]]), ['ueber-uns', 'Über uns'], ['kontakt', 'Kontakt']].slice(0, 7);
  const strip = [c.phone ? `<div class="fact"><small>Telefon</small><a href="${esc(telHref(c.phone))}">${esc(c.phone)}</a></div>` : '', addr ? `<div class="fact"><small>Adresse</small><b>${esc(addr)}</b></div>` : '', c.openingHours ? `<div class="fact"><small>Öffnungszeiten</small><b>${esc(c.openingHours).replace(/\n/g, '<br>')}</b></div>` : ''].filter(Boolean).join('');
  const covers = ['Auf Smartphone, Tablet und Desktop gut lesbar', c.phone ? 'Direkter Anruf-Button' : 'Klarer Kontaktbereich', ...sel.map((m) => plan.moduleLabels[m]).filter(Boolean).map((l) => `Baustein: ${l}`)];
  const sources = h.sources?.length ? `<small>Angaben zum Unternehmen stammen aus öffentlichen Quellen (${esc(h.sources.map((s) => (s === 'osm' ? 'OpenStreetMap-Mitwirkende, ODbL' : s)).join(', '))}) und wurden nicht geprüft.</small>` : '';
  const sticky = !!(t.cta.sticky && c.phone);
  const body = `<div class="demo" role="note"><b>Unverbindliche Demo / Beispiel</b> – Entwurf von ${esc(agency.name)} für ${name}. Dies ist nicht die offizielle Website des Unternehmens.</div>
<div class="top"><div class="wrap"><a class="brand" href="#top">${name}</a><nav aria-label="Navigation">${nav.map(([a, l]) => `<a href="#${a}">${esc(l)}</a>`).join('')}</nav></div></div>
<header class="hero" id="top"><div class="wrap"><h1>${esc(tagline)}</h1><p class="lead">${esc(sub)}</p><a class="btn" href="#${primaryAction.to}">${esc(primaryAction.label)}</a>${c.phone ? `<a class="btn ghost" href="${esc(telHref(c.phone))}">${esc(t.cta.secondary)}</a>` : ''}</div></header>
${strip ? `<div class="wrap"><div class="facts">${strip}</div></div>` : ''}
<main>${sel.slice(0, Math.ceil(sel.length / 2)).map((m) => parts[m]()).join('\n')}
${about}
${sel.slice(Math.ceil(sel.length / 2)).map((m) => parts[m]()).join('\n')}
${hours}${cta}${contact}
<section><div class="wrap"><div class="notes"><b>Was dieser Entwurf zeigt</b><ul>${covers.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>${sources}<p><small>Mit „Demo-Funktion“ markierte Elemente sind nur eine Darstellung; „Beispiel“ kennzeichnet Platzhalter-Inhalte. Es werden keine Daten gesendet.</small></p></div></div></section></main>
<footer><div class="wrap">Diese Demo dient nur der Ansicht und wurde ohne Beauftragung erstellt. Texte sind Platzhalter, Bilder sind nicht enthalten. Rückfragen: ${esc(agency.contactEmail)}</div></footer>
${sticky ? `<div class="stick"><a class="btn2" href="${esc(telHref(c.phone!))}">${esc(t.cta.secondary)}</a></div>` : ''}`;
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer">
<title>${esc(`Demo: ${c.companyName}`)}</title><meta name="description" content="${esc(fill(t.seo.descriptionFormat, vars))}">
<style>${css(t, plan.family, sticky)}</style></head><body>
${body}
</body></html>`;
}
