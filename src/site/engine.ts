import type { Template, SectionKey } from './templates.ts';
import { fill } from './templates.ts';

export type SiteContent = {
  companyName: string; industryLabel?: string; address?: string; city?: string; postalCode?: string; phone?: string; email?: string; openingHours?: string;
  tagline?: string; about?: string; bookingUrl?: string; services: { title: string; text: string }[];
  legal: { owner?: string; vatId?: string; register?: string; hosting?: string };
};
export type DemoHints = { bookingGap?: boolean; noWebsite?: boolean; mobileWeak?: boolean; servicesAreExamples?: boolean; sources?: string[]; hoursKnown?: boolean };
export type AgencyInfo = { name: string; contactEmail: string };
export type SiteFiles = Record<string, string>;

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const telHref = (p: string) => 'tel:' + p.replace(/[^\d+]/g, '');

/** Gemeinsames Stylesheet aller Templates. Mobile-first, Tap-Ziele ≥ 44 px, kein JavaScript. */
export const baseCss = (t: Template) => {
  const p = t.palette, l = t.layout;
  const pad = l.density === 'compact' ? 28 : 44;
  const card = l.cards === 'rounded' ? 'border-radius:16px;background:var(--soft)' : l.cards === 'outlined' ? 'border-radius:8px;border:2px solid var(--soft);background:#fff' : 'border-radius:0;background:var(--soft)';
  return `:root{--p:${p.primary};--pt:${p.primaryText};--bg:${p.bg};--ink:${p.ink};--soft:${p.soft}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;font:17px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink)}
.wrap{max-width:960px;margin:0 auto;padding:0 16px}img,svg{max-width:100%}
header.hero{background:var(--p);color:var(--pt);padding:${pad + 12}px 0 ${pad}px${l.hero === 'centered' ? ';text-align:center' : ''}}
h1{font-size:clamp(28px,7vw,44px);line-height:1.15;margin:0 0 12px;overflow-wrap:anywhere}.sub{font-size:19px;margin:0 0 24px}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:52px;min-width:44px;padding:0 24px;border-radius:12px;background:#fff;color:var(--p);font-weight:700;text-decoration:none;border:2px solid #fff;margin:0 8px 8px 0}
.btn.ghost{background:transparent;color:var(--pt);border-color:var(--pt)}
.btn2{display:inline-flex;align-items:center;justify-content:center;min-height:52px;min-width:44px;padding:0 24px;border-radius:12px;background:var(--p);color:var(--pt);font-weight:700;text-decoration:none}
section{padding:${pad}px 0}h2{font-size:26px;margin:0 0 16px}h3{margin:0 0 6px;font-size:19px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}.card{${card};padding:18px}.card p{margin:0}
.ph{height:160px;border-radius:14px;background:repeating-linear-gradient(45deg,var(--soft),var(--soft) 14px,#fff 14px,#fff 28px);display:flex;align-items:center;justify-content:center;font-size:14px;text-align:center;padding:8px}
.contact{background:var(--soft)}.contact a{color:var(--p);font-weight:700;display:inline-block;padding:11px 0;overflow-wrap:anywhere}
footer{padding:28px 0 ${t.cta.sticky ? 96 : 48}px;font-size:14px}nav.foot a{margin-right:18px;color:var(--p);font-weight:600;display:inline-block;padding:12px 0}
.legal{padding:32px 0}.legal h1{font-size:28px}.legal h2{font-size:20px;margin-top:24px}.legal a{display:inline-block;padding:11px 0;color:var(--p)}
a:focus-visible{outline:3px solid #000;outline-offset:2px}
.demo{position:sticky;top:0;z-index:5;background:#111;color:#fff;padding:10px 16px;font-size:14px;text-align:center}
.notes{background:#fff;border:1px dashed var(--p);border-radius:12px;padding:14px 16px;margin-top:18px;font-size:15px}
${t.cta.sticky ? '.stick{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid var(--soft);padding:8px 16px;display:flex;gap:8px;justify-content:center;z-index:4}.stick a{flex:1;max-width:420px}@media (min-width:900px){.stick{display:none}footer{padding-bottom:48px}}' : ''}`;
};

type Mode = 'demo' | 'production';
const vars = (c: SiteContent, t: Template) => ({ name: c.companyName, city: c.city?.replace(/^\d{5}\s*/, ''), sub: c.industryLabel ?? t.label });

function sectionHtml(s: SectionKey, c: SiteContent, t: Template, mode: Mode, h: DemoHints): string {
  const addr = [c.address, [c.postalCode, c.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const V = vars(c, t);
  switch (s) {
    case 'hero': return '';
    case 'services': {
      const examples = mode === 'demo' && h.servicesAreExamples;
      return `<section id="leistungen"><div class="wrap"><h2>${esc(t.copy.servicesTitle)}${examples ? ' <small style="font-size:14px;font-weight:400">(Beispiel-Inhalte)</small>' : ''}</h2>
<div class="grid">${c.services.map((x) => `<div class="card"><h3>${esc(x.title)}</h3>${x.text ? `<p>${esc(x.text)}</p>` : ''}</div>`).join('')}</div></div></section>`;
    }
    case 'gallery': {
      if (mode === 'production' || !t.imageLogic.slots.length) return '';
      return `<section id="eindruecke"><div class="wrap"><h2>Eindrücke</h2><div class="grid">${t.imageLogic.slots.map(() => '<div class="ph">Platzhalter – hier kommen später Ihre eigenen Fotos hin</div>').join('')}</div></div></section>`;
    }
    case 'booking': {
      if (mode === 'production' ? !c.bookingUrl : !(t.booking || h.bookingGap || c.bookingUrl)) return '';
      return `<section id="termin"><div class="wrap"><h2>${esc(t.copy.bookingTitle)}</h2>${c.bookingUrl ? `<a class="btn2" href="${esc(c.bookingUrl)}" rel="noopener noreferrer">${esc(t.copy.cta)}</a>` : `<p>${esc(t.copy.bookingText)} In dieser Demo ist sie nicht aktiv.</p><span class="btn2" aria-disabled="true">${esc(t.copy.cta)} (Demo)</span>`}</div></section>`;
    }
    case 'about': {
      if (!c.about && mode === 'production') return '';
      const text = c.about ? c.about.split('\n').filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('') : '<p>Hier steht später Ihr eigener Text über Ihr Unternehmen.</p>';
      return `<section id="ueber-uns"><div class="wrap"><h2>${esc(t.copy.aboutTitle)}</h2>${text}</div></section>`;
    }
    case 'hours': {
      if (!c.openingHours && mode === 'production') return '';
      return `<section id="oeffnungszeiten"><div class="wrap"><h2>Öffnungszeiten</h2><p>${c.openingHours ? esc(c.openingHours).replace(/\n/g, '<br>') : 'Öffnungszeiten folgen (Beispielentwurf).'}</p></div></section>`;
    }
    case 'contact': return `<section class="contact" id="kontakt"><div class="wrap"><h2>Kontakt</h2>
<p><b>${esc(c.companyName)}</b>${addr ? `<br>${esc(addr)}` : ''}</p>
${c.phone ? `<p><a href="${esc(telHref(c.phone))}">${esc(c.phone)}</a></p>` : mode === 'demo' ? '<p>Telefonnummer folgt.</p>' : ''}
${c.email ? `<p><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></p>` : ''}
${c.bookingUrl && !t.sections.includes('booking') ? `<p><a class="btn2" href="${esc(c.bookingUrl)}" rel="noopener noreferrer">${esc(t.copy.cta)}</a></p>` : ''}
${c.openingHours && !t.sections.includes('hours') ? `<p>${esc(c.openingHours).replace(/\n/g, '<br>')}</p>` : ''}</div></section>`;
  }
  void V;
}

const page = (t: Template, title: string, desc: string, body: string, demo: boolean) => `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${demo ? '<meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer">\n' : ''}<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">
<style>${baseCss(t)}</style></head><body>
${body}
</body></html>`;

const footer = (c: SiteContent) => `<footer><div class="wrap"><nav class="foot" aria-label="Rechtliches"><a href="impressum.html">Impressum</a><a href="datenschutz.html">Datenschutz</a></nav><p>© ${new Date().getFullYear()} ${esc(c.companyName)}</p></div></footer>`;
const stickyBar = (c: SiteContent, t: Template) => (t.cta.sticky && c.phone ? `<div class="stick"><a class="btn2" href="${esc(telHref(c.phone))}">${esc(t.cta.secondary)}</a></div>` : '');

function heroHtml(c: SiteContent, t: Template, mode: Mode, h: DemoHints = {}): string {
  const V = vars(c, t);
  const tagline = c.tagline || fill(t.copy.tagline, V);
  const sub = mode === 'production' && c.about ? c.about.split('\n')[0] : fill(t.copy.heroSub, V) + (mode === 'demo' ? ' – Beispielentwurf.' : '');
  return `<header class="hero"><div class="wrap"><h1>${esc(tagline)}</h1><p class="sub">${esc(sub)}</p>
<a class="btn" href="#${t.sections.includes('booking') && (mode === 'production' ? !!c.bookingUrl : t.booking || !!h.bookingGap || !!c.bookingUrl) ? 'termin' : 'kontakt'}">${esc(t.copy.cta)}</a>${c.phone && mode === 'production' ? `<a class="btn ghost" href="${esc(telHref(c.phone))}">${esc(t.cta.secondary)}</a>` : ''}</div></header>`;
}

/** Demo-Seite: klar als unverbindliches Beispiel gekennzeichnet, nur Fakten aus dem Lead, sonst Platzhalter. */
export function renderDemo(c: SiteContent, t: Template, agency: AgencyInfo, h: DemoHints = {}): string {
  const V = vars(c, t);
  const name = esc(c.companyName);
  const covers = ['Für Smartphones optimiert (mobile-first)', c.phone ? 'Direkter Anruf-Button' : 'Klarer Kontaktbereich', ...(h.bookingGap || t.booking ? ['Terminanfrage-Schaltfläche'] : []), 'Leistungen, Öffnungszeiten und Kontakt auf einen Blick'];
  const sections = t.sections.filter((s) => s !== 'hero').map((s) => sectionHtml(s, c, t, 'demo', h)).join('\n');
  const body = `<div class="demo" role="note"><b>Unverbindliche Demo / Beispiel</b> – Entwurf von ${esc(agency.name)} für ${name}. Dies ist nicht die offizielle Website des Unternehmens.</div>
${heroHtml(c, t, 'demo', h)}
<main>${sections}
<section><div class="wrap"><div class="notes"><b>Was dieser Entwurf zeigt</b><ul>${covers.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
${h.sources?.length ? `<small>Angaben zum Unternehmen stammen aus öffentlichen Quellen (${esc(h.sources.join(', '))}) und wurden nicht geprüft.</small>` : ''}</div></div></section></main>
<footer><div class="wrap">Diese Demo dient nur der Ansicht und wurde ohne Beauftragung erstellt. Texte sind Platzhalter, Bilder sind nicht enthalten. Rückfragen: ${esc(agency.contactEmail)}</div></footer>
${stickyBar(c, t)}`;
  return page(t, `Demo: ${c.companyName}`, fill(t.seo.descriptionFormat, V), body, true);
}

/** Hinweise, die vor dem Teilen der Demo behoben werden sollten. */
export function demoWarnings(html: string): string[] {
  const w: string[] = [];
  if (/\[[^\]]{3,}\]/.test(html)) w.push('Agentur-Angaben sind noch Platzhalter (config/agency.json).');
  if (html.includes('Telefonnummer folgt')) w.push('Keine Telefonnummer im Lead vorhanden.');
  return w;
}

/** Baut die echte Kundenseite (statisch, ohne JavaScript, ohne externe Ressourcen) aus den Projektdaten. */
export function buildSite(c: SiteContent, t: Template, extras: { hosting?: string } = {}): SiteFiles {
  const V = vars(c, t);
  const addr = [c.address, [c.postalCode, c.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const sections = t.sections.filter((s) => s !== 'hero').map((s) => sectionHtml(s, c, t, 'production', {})).join('\n');
  const title = fill(t.seo.titleFormat, V);
  const desc = fill(t.seo.descriptionFormat, V);
  const index = page(t, title, desc, `${heroHtml(c, t, 'production')}\n<main>${sections}</main>${footer(c)}${stickyBar(c, t)}`, false);
  const impressum = page(t, `Impressum – ${c.companyName}`, `Impressum von ${c.companyName}`, `<main class="wrap legal"><h1>Impressum</h1>
<h2>Angaben gemäß § 5 DDG</h2><p>${esc(c.legal.owner || c.companyName)}<br>${esc(c.companyName)}<br>${esc(addr)}</p>
<h2>Kontakt</h2><p>${c.phone ? `Telefon: ${esc(c.phone)}<br>` : ''}${c.email ? `E-Mail: ${esc(c.email)}` : ''}</p>
${c.legal.vatId ? `<h2>Umsatzsteuer-ID</h2><p>${esc(c.legal.vatId)}</p>` : ''}${c.legal.register ? `<h2>Registereintrag</h2><p>${esc(c.legal.register)}</p>` : ''}
<p><a href="index.html">Zur Startseite</a></p></main>${footer(c)}`, false);
  const datenschutz = page(t, `Datenschutz – ${c.companyName}`, `Datenschutzhinweise von ${c.companyName}`, `<main class="wrap legal"><h1>Datenschutzerklärung</h1>
<h2>Verantwortlicher</h2><p>${esc(c.legal.owner || c.companyName)}, ${esc(addr)}${c.email ? `, E-Mail: ${esc(c.email)}` : ''}</p>
<h2>Hosting und Server-Logfiles</h2><p>Diese Website wird bei ${esc(extras.hosting || 'dem Hosting-Anbieter')} gehostet. Beim Aufruf werden technisch notwendige Zugriffsdaten (z. B. IP-Adresse, Datum und Uhrzeit, aufgerufene Seite) kurzzeitig in Server-Logfiles verarbeitet. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO (Betrieb und Sicherheit der Website).</p>
<h2>Cookies, Tracking und externe Dienste</h2><p>Diese Website verwendet keine Cookies, kein Tracking und lädt keine externen Schriftarten oder Skripte.</p>
<h2>Kontaktaufnahme</h2><p>Wenn Sie uns per Telefon oder E-Mail kontaktieren, verarbeiten wir Ihre Angaben zur Bearbeitung der Anfrage (Art. 6 Abs. 1 lit. b oder f DSGVO).</p>
<h2>Ihre Rechte</h2><p>Sie haben das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit und Widerspruch sowie auf Beschwerde bei einer Datenschutz-Aufsichtsbehörde.</p>
<p><a href="index.html">Zur Startseite</a></p></main>${footer(c)}`, false);
  return { 'index.html': index, 'impressum.html': impressum, 'datenschutz.html': datenschutz, 'robots.txt': 'User-agent: *\nAllow: /\n' };
}
