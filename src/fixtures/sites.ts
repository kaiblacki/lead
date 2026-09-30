import type { FixtureBusiness } from './world.ts';
import { SUB_PROFILES } from './sub-profiles.ts';
import { slugify } from '../core/text.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tel = (p: string) => p.replace(/[^\d+]/g, '');
const SUB = (key: string) => SUB_PROFILES.find((s) => s.key === key)!;

export type FixturePage = { path: string; html: string; status: number };
export type SiteSpec = { pages: FixturePage[]; loadMs: number; bytes: number; finalScheme: 'http' | 'https'; hasSitemap: boolean; ok: boolean; error?: string };

function socialLinks(b: FixtureBusiness): string {
  const l: string[] = [];
  if (b.instagram) l.push(`<a href="https://www.instagram.com/${b.instagram.handle}">Instagram</a>`);
  if (b.facebook) l.push(`<a href="https://www.facebook.com/${b.facebook.handle}">Facebook</a>`);
  return l.join(' · ');
}
const jsonLd = (b: FixtureBusiness) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'LocalBusiness', name: b.name, address: { '@type': 'PostalAddress', streetAddress: b.address, postalCode: b.postalCode, addressLocality: b.city }, telephone: b.phone })}</script>`;
const hoursHtml = (b: FixtureBusiness) => `<section id="oeffnungszeiten"><h2>Öffnungszeiten</h2><p>${b.hours.map(esc).join('<br>')}</p></section>`;
const servicesHtml = (b: FixtureBusiness) => `<section id="leistungen"><h2>Leistungen</h2><ul>${b.services.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></section>`;

function modern(b: FixtureBusiness, year: number, opts: { booking: boolean; viewport?: boolean; mobileCss?: boolean; toggle?: boolean; cta?: boolean }): string {
  const o = { viewport: true, mobileCss: true, toggle: true, cta: true, ...opts };
  const sub = SUB(b.subKey);
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">${o.viewport ? '<meta name="viewport" content="width=device-width,initial-scale=1">' : ''}
<title>${esc(b.name)} – ${esc(b.city)}</title><meta name="description" content="${esc(b.name)} in ${esc(b.city)}: ${esc(b.services.slice(0, 3).join(', '))}. Jetzt Kontakt aufnehmen.">
<link rel="canonical" href="https://${b.domain}/">${jsonLd(b)}
<style>body{font:16px/1.5 system-ui;margin:0;${o.mobileCss ? '' : 'width:1000px;'}}nav ul{display:flex;gap:16px;list-style:none}.btn{display:inline-block;padding:14px 22px;background:#222;color:#fff;text-decoration:none}${o.mobileCss ? '@media (max-width:640px){nav ul{display:none}.menu-toggle{display:block;min-height:44px}}' : ''}</style></head><body>
<header><nav aria-label="Hauptmenü">${o.toggle ? '<button class="menu-toggle" aria-label="Menü öffnen">☰</button>' : ''}<ul><li><a href="/leistungen">Leistungen</a></li><li><a href="/kontakt">Kontakt</a></li><li><a href="/impressum">Impressum</a></li></ul></nav></header>
<main><h1>${esc(b.name)} – ${esc(SUB(b.subKey).key === 'kfz' ? 'Kfz-Meisterbetrieb' : 'Ihr Betrieb')} in ${esc(b.city)}</h1>
<p>Willkommen bei ${esc(b.name)}. ${esc(b.description)}</p>
${o.booking ? `<p><a class="btn" href="https://booking.example/${slugify(b.name)}">Online Termin buchen</a></p>` : o.cta ? '<p><a class="btn" href="/kontakt">Kontakt aufnehmen</a></p>' : ''}
${servicesHtml(b)}${hoursHtml(b)}
<section><h2>Kundenstimmen</h2><p>Lesen Sie Bewertungen unserer Kundinnen und Kunden.</p></section>
<section><h2>Häufige Fragen</h2><p>FAQ: Antworten zu Terminen und Ablauf.</p></section>
<section id="kontakt"><h2>Kontakt</h2><p>${esc(b.address)}, ${esc(b.postalCode)} ${esc(b.city)}</p>${b.phone ? `<p><a href="tel:${tel(b.phone)}">${esc(b.phone)}</a></p>` : ''}${b.email ? `<p><a href="mailto:${b.email}">${esc(b.email)}</a></p>` : ''}
<form action="/kontakt" method="post"><label>Nachricht <textarea name="m"></textarea></label><button>Senden</button></form></section></main>
<footer><p>© ${year} ${esc(b.name)} · ${socialLinks(b)} <a href="/impressum">Impressum</a> <a href="/datenschutz">Datenschutz</a></p></footer></body></html>`;
}

function outdated(b: FixtureBusiness, year: number): string {
  return `<html><head><title>${esc(b.name)}</title></head><body bgcolor="#dddddd"><center><font size="2" face="Arial"><table width="900" border="0"><tr><td>
<h2>Willkommen bei ${esc(b.name)}</h2><marquee>Neu: Jetzt auch Geschenkgutscheine!</marquee>
<p>Wir sind ${b.founded > 2000 ? 'seit ' + b.founded : 'schon lange'} in ${esc(b.city)} für Sie da. ${esc(b.services.join(', '))}.</p>
<p>${esc(b.address)}, ${esc(b.postalCode)} ${esc(b.city)}<br>${b.phone ? 'Tel.: ' + esc(b.phone) : ''}</p>
<p><a href="/kontakt">Kontakt</a> | <a href="/impressum">Impressum</a></p><p>Stand: ${year - 9}</p></td></tr></table></font></center><p align="center">© ${year - 10 + (b.founded % 3)} ${esc(b.name)}</p></body></html>`;
}

const spaShell = (b: FixtureBusiness) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(b.name)}</title></head><body><div id="root"></div><noscript>Bitte JavaScript aktivieren.</noscript><script src="/static/app.js"></script><script src="/static/vendor.js"></script></body></html>`;

const contactPage = (b: FixtureBusiness, year: number) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kontakt – ${esc(b.name)}</title></head><body><h1>Kontakt</h1><p>${esc(b.address)}, ${esc(b.postalCode)} ${esc(b.city)}</p>${b.phone ? `<p><a href="tel:${tel(b.phone)}">${esc(b.phone)}</a></p>` : ''}${b.email ? `<p><a href="mailto:${b.email}">${esc(b.email)}</a></p>` : ''}<p>© ${year}</p></body></html>`;
const impressumPage = (b: FixtureBusiness) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Impressum – ${esc(b.name)}</title></head><body><h1>Impressum</h1><p>${esc(b.name)}<br>${esc(b.address)}<br>${esc(b.postalCode)} ${esc(b.city)}</p></body></html>`;

/** Baut die Mock-Website eines Fixture-Betriebs. `now` bestimmt Copyright-Jahre. */
export function siteFor(b: FixtureBusiness, now: Date): SiteSpec | null {
  const year = now.getFullYear();
  const v = b.variant;
  if (v === 'none' || v === 'social-only') return null;
  if (v === 'unreachable') return { pages: [], loadMs: 0, bytes: 0, finalScheme: 'https', hasSitemap: false, ok: false, error: 'getaddrinfo ENOTFOUND ' + b.domain };
  const home = (html: string, extra: Partial<SiteSpec> = {}): SiteSpec => ({
    pages: [{ path: '/', html, status: 200 }, { path: '/kontakt', html: contactPage(b, year), status: 200 }, { path: '/impressum', html: impressumPage(b), status: 200 }],
    loadMs: 700 + (b.founded % 7) * 120, bytes: 180_000, finalScheme: 'https', hasSitemap: true, ok: true, ...extra,
  });
  switch (v) {
    case 'modern': return home(modern(b, year, { booking: true }));
    case 'modern-nobooking': return home(modern(b, year, { booking: false }));
    case 'nomobile': return home(modern(b, year, { booking: false, viewport: false, mobileCss: false, toggle: false }), { loadMs: 1800, hasSitemap: false });
    case 'slow': return home(modern(b, year, { booking: false }), { loadMs: 6400, bytes: 3_400_000 });
    case 'nohttps': return home(modern(b, year, { booking: false, cta: false }), { finalScheme: 'http', hasSitemap: false });
    case 'spa': return { pages: [{ path: '/', html: spaShell(b), status: 200 }], loadMs: 1500, bytes: 900_000, finalScheme: 'https', hasSitemap: false, ok: true };
    case 'outdated': return { pages: [{ path: '/', html: outdated(b, year), status: 200 }, { path: '/kontakt', html: '', status: 404 }], loadMs: 2600, bytes: 90_000, finalScheme: 'http', hasSitemap: false, ok: true };
  }
}
