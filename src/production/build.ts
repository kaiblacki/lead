import type { ProjectContent } from '../orders/service.ts';
import type { Template } from '../templates/index.ts';
import { baseCss, esc, telHref } from '../demo/render.ts';

export type SiteFiles = Record<string, string>;
export type LegalExtras = { hosting?: string };

const page = (t: Template, title: string, desc: string, body: string) => `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">
<style>${baseCss(t.palette)}
.legal{padding:32px 0}.legal h1{font-size:28px}.legal h2{font-size:20px;margin-top:24px}nav.foot a{margin-right:18px;color:var(--p);font-weight:600;display:inline-block;padding:12px 0}.legal a{display:inline-block;padding:11px 0}</style></head><body>
${body}
</body></html>`;

const footer = (c: ProjectContent) => `<footer><div class="wrap"><nav class="foot" aria-label="Rechtliches"><a href="impressum.html">Impressum</a><a href="datenschutz.html">Datenschutz</a></nav><p>© ${new Date().getFullYear()} ${esc(c.companyName)}</p></div></footer>`;

/** Baut die echte Kundenseite (statisch, ohne JavaScript, ohne externe Ressourcen) aus den Projektdaten. */
export function buildSite(c: ProjectContent, t: Template, extras: LegalExtras = {}): SiteFiles {
  const addr = [c.address, c.city].filter(Boolean).join(', ');
  const desc = `${c.companyName}${c.city ? ` in ${c.city}` : ''}${c.industry ? ` – ${c.industry}` : ''}. Kontakt, Leistungen und Öffnungszeiten.`;
  const index = page(t, `${c.companyName}${c.city ? ` – ${c.city}` : ''}`, desc, `
<header class="hero"><div class="wrap"><h1>${esc(c.tagline || t.tagline(c.companyName, c.city))}</h1>
${c.about ? `<p class="sub">${esc(c.about.split('\n')[0])}</p>` : ''}
<a class="btn" href="#kontakt">Kontakt aufnehmen</a></div></header>
<main>
<section id="leistungen"><div class="wrap"><h2>Leistungen</h2><div class="grid">${c.services.map((s) => `<div class="card"><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></div>`).join('')}</div></div></section>
${c.about ? `<section id="ueber-uns"><div class="wrap"><h2>Über uns</h2>${c.about.split('\n').filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('')}</div></section>` : ''}
${c.bookingUrl ? `<section id="termin"><div class="wrap"><h2>Online-Termin</h2><a class="btn2" href="${esc(c.bookingUrl)}" rel="noopener noreferrer">${esc(t.cta)}</a></div></section>` : ''}
<section class="contact" id="kontakt"><div class="wrap"><h2>Kontakt</h2>
<p><b>${esc(c.companyName)}</b>${addr ? `<br>${esc(addr)}` : ''}</p>
${c.phone ? `<p><a href="${esc(telHref(c.phone))}">${esc(c.phone)}</a></p>` : ''}
${c.email ? `<p><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></p>` : ''}
${c.openingHours ? `<h3>Öffnungszeiten</h3><p>${esc(c.openingHours).replace(/\n/g, '<br>')}</p>` : ''}</div></section>
</main>${footer(c)}`);

  const impressum = page(t, `Impressum – ${c.companyName}`, `Impressum von ${c.companyName}`, `<main class="wrap legal"><h1>Impressum</h1>
<h2>Angaben gemäß § 5 DDG</h2><p>${esc(c.legal.owner || c.companyName)}<br>${esc(c.companyName)}<br>${esc(addr)}</p>
<h2>Kontakt</h2><p>${c.phone ? `Telefon: ${esc(c.phone)}<br>` : ''}${c.email ? `E-Mail: ${esc(c.email)}` : ''}</p>
${c.legal.vatId ? `<h2>Umsatzsteuer-ID</h2><p>${esc(c.legal.vatId)}</p>` : ''}
${c.legal.register ? `<h2>Registereintrag</h2><p>${esc(c.legal.register)}</p>` : ''}
<p><a href="index.html">Zur Startseite</a></p></main>${footer(c)}`);

  const datenschutz = page(t, `Datenschutz – ${c.companyName}`, `Datenschutzhinweise von ${c.companyName}`, `<main class="wrap legal"><h1>Datenschutzerklärung</h1>
<h2>Verantwortlicher</h2><p>${esc(c.legal.owner || c.companyName)}, ${esc(addr)}${c.email ? `, E-Mail: ${esc(c.email)}` : ''}</p>
<h2>Hosting und Server-Logfiles</h2><p>Diese Website wird bei ${esc(extras.hosting || 'dem Hosting-Anbieter')} gehostet. Beim Aufruf werden technisch notwendige Zugriffsdaten (z. B. IP-Adresse, Datum und Uhrzeit, aufgerufene Seite) kurzzeitig in Server-Logfiles verarbeitet. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO (Betrieb und Sicherheit der Website).</p>
<h2>Cookies, Tracking und externe Dienste</h2><p>Diese Website verwendet keine Cookies, kein Tracking und lädt keine externen Schriftarten oder Skripte.</p>
<h2>Kontaktaufnahme</h2><p>Wenn Sie uns per Telefon oder E-Mail kontaktieren, verarbeiten wir Ihre Angaben zur Bearbeitung der Anfrage (Art. 6 Abs. 1 lit. b oder f DSGVO).</p>
<h2>Ihre Rechte</h2><p>Sie haben das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit und Widerspruch sowie auf Beschwerde bei einer Datenschutz-Aufsichtsbehörde.</p>
<p><a href="index.html">Zur Startseite</a></p></main>${footer(c)}`);

  return { 'index.html': index, 'impressum.html': impressum, 'datenschutz.html': datenschutz, 'robots.txt': 'User-agent: *\nAllow: /\n' };
}
