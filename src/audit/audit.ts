import type { CrawlResult, CrawledPage, RenderMetrics } from '../providers/types.ts';
import { CATEGORIES, type AuditCheck, type AuditReport, type CheckCategory, type CheckStatus, type Severity } from './types.ts';

const BOOKING = /termin(?:\s|-)?(?:buchen|vereinbaren|online|anfrage)|online(?:\s|-)?(?:termin|buchung|reservierung)|jetzt\s+buchen|tisch\s+reservieren|reservierung|treatwell|booksy|calendly|shore\.com|timify|planity|salonized|appointy|simplybook|doctolib|jameda|booking\.example/i;
const HOURS = /öffnungszeiten|oeffnungszeiten|sprechzeiten|geöffnet|\bmo\s*[-–]\s*(?:fr|sa|so)\b/i;
const FAQ = /\bfaq\b|häufige fragen|haeufige fragen/i;
const TRUST = /bewertung|referenz|kundenstimm|rezension|testimonial|google\s*reviews|erfahrungen/i;
const SERVICES = /leistungen|unser angebot|angebot|preise|preisliste|speisekarte|behandlungen|services|sortiment/i;
const PHONE = /(?:\+49|\b0)\s?[\d\s/()-]{7,}\d/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PLACEHOLDER = /lorem ipsum|under construction|coming soon|seite im aufbau|demnächst hier|website in arbeit/i;
const OLD_TECH = /<(?:font|center|marquee|frameset|blink)\b|swfobject|\.swf\b/i;
const SOCIAL_LINK: [string, RegExp][] = [['Instagram', /https?:\/\/(?:www\.)?instagram\.com\/[^\s"'<>]+/i], ['Facebook', /https?:\/\/(?:www\.)?facebook\.com\/[^\s"'<>]+/i], ['LinkedIn', /https?:\/\/(?:www\.)?linkedin\.com\/[^\s"'<>]+/i], ['TikTok', /https?:\/\/(?:www\.)?tiktok\.com\/[^\s"'<>]+/i]];

const textOf = (h: string) => h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

export type AuditInput = {
  websiteUrl?: string;
  lead: { companyName: string; city?: string; postalCode?: string; bookingRelevant?: boolean };
  crawl?: CrawlResult | null;
  render?: RenderMetrics | null;
  now: Date;
};

const PENALTY: Record<Severity, number> = { low: 6, medium: 14, high: 25 };

export function runAudit(input: AuditInput): AuditReport {
  const capturedAt = input.crawl?.capturedAt ?? input.now.toISOString();
  const base = { websiteUrl: input.websiteUrl, capturedAt, source: input.crawl?.source ?? 'none', renderDependent: false, notes: [] as string[] };
  const emptyQ = Object.fromEntries(CATEGORIES.map((c) => [c, null])) as AuditReport['quality'];
  if (!input.websiteUrl) return { ...base, status: 'NO_WEBSITE', pagesAnalyzed: 0, checks: [], quality: emptyQ, overallQuality: null, coverage: 0 };
  const crawl = input.crawl;
  const home = crawl?.pages[0];
  if (!crawl || !crawl.ok || !home || !home.html) {
    const why = crawl?.robotsBlocked ? 'robots.txt verbietet den Abruf' : crawl?.error ?? 'keine Antwort';
    return { ...base, status: 'UNREACHABLE', pagesAnalyzed: 0, finalUrl: crawl?.finalUrl, checks: [{ code: 'REACHABLE', category: 'technical', status: 'unknown', severity: 'high', summary: 'Website bei der Prüfung nicht erreichbar oder nicht abrufbar.', evidence: why }], quality: emptyQ, overallQuality: null, coverage: 0,
      notes: [/HTTP (401|403|429|503)\b/.test(why) ? `Website vorhanden, aber der Abruf wird blockiert (${why.replace(/^.*?(HTTP \d+).*$/, '$1')}, häufig Bot-Schutz) – nicht zuverlässig beurteilbar; später oder mit Browser-Tiefenprüfung wiederholen. Es wird nichts geraten.` : 'Nicht zuverlässig beurteilbar – Prüfung später wiederholen.'] };
  }

  const checks: AuditCheck[] = [];
  const add = (code: string, category: CheckCategory, status: CheckStatus, severity: Severity, summary: string, evidence: string) => checks.push({ code, category, status, severity, summary, evidence });
  const ok = crawl.pages.filter((p) => p.status > 0 && p.status < 400 && p.html);
  const allHtml = ok.map((p) => p.html).join('\n');
  const homeHtml = home.html, homeText = textOf(homeHtml), allText = textOf(allHtml);
  const scripts = (homeHtml.match(/<script\b/gi) ?? []).length;
  const spa = homeText.length < 250 && scripts >= 2 && /id=["'](?:root|app|__next|__nuxt)["']/i.test(homeHtml);
  const n = ok.length;
  const final = crawl.finalUrl ?? home.url;
  const pagesNote = `${n} Seite${n === 1 ? '' : 'n'} geprüft`;
  /** Textbasierte Prüfungen sind bei JS-Seiten nicht belastbar. */
  const textual = (code: string, category: CheckCategory, pass: boolean, sev: Severity, okSum: string, badSum: string, okEv: string, badEv: string, failStatus: CheckStatus = 'fail') => {
    if (spa) add(code, category, 'unknown', sev, `${badSum.replace(/\.$/, '')} – nicht zuverlässig prüfbar.`, 'Inhalt wird per JavaScript nachgeladen; ohne Browser-Rendering nicht zuverlässig ermittelbar.');
    else if (pass) add(code, category, 'pass', sev, okSum, okEv);
    else add(code, category, failStatus, sev, badSum, badEv);
  };

  // ---- Technik
  add('REACHABLE', 'technical', 'pass', 'high', 'Website erreichbar.', `HTTP ${home.status} unter ${final}`);
  if (final.startsWith('https://')) add('HTTPS', 'technical', 'pass', 'high', 'HTTPS vorhanden.', `Finale URL: ${final}`);
  else add('HTTPS', 'technical', 'fail', 'high', 'Website nicht über HTTPS erreichbar (Browser zeigen „nicht sicher“).', `Finale URL: ${final}`);
  if (home.loadMs > 0) {
    const s = home.loadMs > 6000 ? 'high' : 'medium';
    if (home.loadMs > 4000) add('LOAD_TIME', 'technical', 'fail', s, 'Startseite lädt langsam.', `HTML-Antwort nach ${home.loadMs} ms`);
    else if (home.loadMs > 2500) add('LOAD_TIME', 'technical', 'warn', 'medium', 'Startseite lädt etwas langsam.', `HTML-Antwort nach ${home.loadMs} ms`);
    else add('LOAD_TIME', 'technical', 'pass', 'medium', 'Ladezeit der Startseite unauffällig.', `HTML-Antwort nach ${home.loadMs} ms`);
  } else add('LOAD_TIME', 'technical', 'unknown', 'medium', 'Ladezeit nicht ermittelt.', 'Keine Zeitmessung vorhanden');
  const mb = home.bytes / 1_000_000;
  if (home.bytes > 0) add('PAGE_WEIGHT', 'technical', mb > 3 ? 'fail' : mb > 1.5 ? 'warn' : 'pass', 'medium', mb > 1.5 ? 'Startseite ist sehr groß (mobile Datenvolumen/Ladezeit).' : 'Seitengröße unauffällig.', `${mb.toFixed(1).replace('.', ',')} MB`);
  if (final.startsWith('https://') && /(?:src|href)=["']http:\/\/(?!www\.w3\.org)/i.test(homeHtml.replace(/<a\b[^>]*>/gi, ''))) add('MIXED_CONTENT', 'technical', 'warn', 'medium', 'Unsichere Ressourcen (http) auf einer HTTPS-Seite eingebunden.', 'src/href mit http:// gefunden');
  const broken = crawl.pages.slice(1).filter((p) => p.status >= 400 || (p.status === 0));
  if (broken.length) add('BROKEN_PAGES', 'technical', 'warn', 'medium', `Intern verlinkte Seite${broken.length > 1 ? 'n' : ''} nicht erreichbar.`, broken.map((p) => `${new URL(p.url).pathname} → ${p.status || 'Fehler'}`).join(', '));
  else if (crawl.pages.length > 1) add('BROKEN_PAGES', 'technical', 'pass', 'medium', 'Geprüfte interne Seiten erreichbar.', pagesNote);
  if (input.render) {
    if (input.render.consoleErrors.length) add('JS_ERRORS', 'technical', 'fail', 'medium', 'JavaScript-Fehler im Browser.', input.render.consoleErrors.slice(0, 2).join(' | '));
    else if (!input.render.estimated) add('JS_ERRORS', 'technical', 'pass', 'low', 'Keine JavaScript-Fehler im Browser.', 'Browser-Konsole ohne Fehler');
  }

  // ---- Mobil / responsiv
  const viewport = /<meta[^>]+name=["']viewport["']/i.test(homeHtml);
  add('VIEWPORT', 'mobile', viewport ? 'pass' : 'fail', 'high', viewport ? 'Für Smartphones ausgelegt (Viewport-Angabe vorhanden).' : 'Nicht für Smartphones ausgelegt (Viewport-Angabe fehlt).', viewport ? '<meta name="viewport"> gefunden' : 'Kein <meta name="viewport"> im HTML');
  const mediaQ = /@media[^{]*\(\s*(?:max|min)-width/i.test(homeHtml);
  const extCss = /<link[^>]+rel=["']stylesheet["']/i.test(homeHtml);
  if (mediaQ) add('RESPONSIVE_CSS', 'mobile', 'pass', 'medium', 'Responsive Gestaltung erkennbar (Media Queries).', '@media-Regeln im HTML');
  else if (extCss) add('RESPONSIVE_CSS', 'mobile', 'unknown', 'medium', 'Responsive Gestaltung nicht zuverlässig ermittelbar.', 'Stylesheet liegt extern und wurde nicht ausgewertet');
  else add('RESPONSIVE_CSS', 'mobile', viewport ? 'warn' : 'fail', 'medium', 'Keine Anzeichen für responsive Gestaltung.', 'Weder Media Queries noch Stylesheet-Dateien gefunden');
  const fixed = /body\{[^}]*\bwidth:\s*\d{3,4}px|<table[^>]+width=["']?\d{3,4}|<div[^>]+style=["'][^"']*\bwidth:\s*\d{3,4}px/i.exec(homeHtml);
  if (fixed) add('FIXED_WIDTH', 'mobile', 'fail', 'medium', 'Feste Seitenbreite – auf dem Smartphone muss seitlich gescrollt werden.', `Gefunden: ${fixed[0].slice(0, 60)}`);
  const vp375 = input.render?.viewports.find((v) => v.width === 375);
  const est = input.render?.estimated ? ' (geschätzt, kein Browsertest)' : '';
  if (vp375) {
    add('HORIZONTAL_SCROLL', 'mobile', vp375.scrollWidth > vp375.clientWidth ? 'fail' : 'pass', 'high', vp375.scrollWidth > vp375.clientWidth ? `Seite läuft auf dem Smartphone über (seitliches Scrollen)${est}.` : `Kein seitliches Scrollen auf dem Smartphone${est}.`, `375 px Breite: Inhalt ${vp375.scrollWidth} px`);
    add('MOBILE_NAV', 'mobile', vp375.hasMenuToggle ? 'pass' : 'warn', 'medium', vp375.hasMenuToggle ? `Mobile Navigation (Menü-Schaltfläche) vorhanden${est}.` : `Mobile Navigation nicht optimal: keine Menü-Schaltfläche erkannt${est}.`, vp375.hasMenuToggle ? 'Menü-Element gefunden' : 'Kein Menü-Schalter im mobilen Layout');
    if (!input.render!.estimated) {
      if (vp375.smallTapTargets > 3) add('TAP_TARGETS', 'mobile', 'warn', 'medium', 'Viele Links/Buttons sind auf dem Smartphone zu klein zum Antippen.', `${vp375.smallTapTargets} Elemente unter 40 px Höhe`);
      else add('TAP_TARGETS', 'mobile', 'pass', 'low', 'Tap-Ziele ausreichend groß.', `${vp375.smallTapTargets} kleine Elemente`);
      if (vp375.minFontPx !== null) add('FONT_SIZE', 'mobile', vp375.minFontPx < 12 ? 'warn' : 'pass', 'low', vp375.minFontPx < 12 ? 'Sehr kleine Schrift auf dem Smartphone.' : 'Schriftgrößen lesbar.', `Kleinste Schrift ${vp375.minFontPx} px`);
    }
  } else {
    const toggle = /menu-toggle|hamburger|burger|aria-label=["']Men/i.test(homeHtml);
    add('MOBILE_NAV', 'mobile', toggle ? 'pass' : 'unknown', 'medium', toggle ? 'Mobile Navigation (Menü-Schaltfläche) erkennbar.' : 'Mobile Navigation nicht zuverlässig prüfbar (ohne Browsertest).', toggle ? 'Menü-Element im HTML' : 'Kein Menü-Element im HTML; Browserprüfung nötig');
    add('HORIZONTAL_SCROLL', 'mobile', 'unknown', 'high', 'Mobile Darstellung nicht im Browser geprüft.', 'Kein Render-Ergebnis vorhanden (Tiefenprüfung starten)');
  }
  const d1280 = input.render?.viewports.find((v) => v.width === 1280);
  if (d1280) add('DESKTOP_LAYOUT', 'design', d1280.scrollWidth > d1280.clientWidth ? 'warn' : 'pass', 'low', d1280.scrollWidth > d1280.clientWidth ? `Desktop-Darstellung läuft über${est}.` : `Desktop-Darstellung ohne Überlauf${est}.`, `1280 px Breite: Inhalt ${d1280.scrollWidth} px`);

  // ---- Design / Struktur / Aktualität
  const oldTech = OLD_TECH.exec(homeHtml);
  add('OLD_TECH', 'design', oldTech ? 'fail' : 'pass', 'medium', oldTech ? 'Veraltete HTML-Technik im Einsatz (wirkt nicht zeitgemäß).' : 'Keine veraltete HTML-Technik erkannt.', oldTech ? `Gefunden: ${oldTech[0]}` : 'Keine <font>, <center>, <marquee>, Frames oder Flash');
  const h1s = (homeHtml.match(/<h1[\s>]/gi) ?? []).length, h2s = (homeHtml.match(/<h2[\s>]/gi) ?? []).length;
  if (spa) add('STRUCTURE', 'design', 'unknown', 'low', 'Struktur nicht zuverlässig prüfbar.', 'Inhalt per JavaScript geladen');
  else add('STRUCTURE', 'design', h1s === 1 && h2s >= 2 ? 'pass' : 'warn', 'low', h1s === 1 && h2s >= 2 ? 'Klare Überschriftenstruktur.' : 'Überschriftenstruktur schwach (Hierarchie nicht klar erkennbar).', `${h1s}× H1, ${h2s}× H2`);
  const navLinks = (homeHtml.match(/<nav\b[\s\S]*?<\/nav>/i)?.[0].match(/<a\b/gi) ?? []).length;
  const anyLinks = (homeHtml.match(/<a\b[^>]*href=["'](?!#|tel:|mailto:)/gi) ?? []).length;
  add('NAVIGATION', 'design', navLinks >= 3 || anyLinks >= 3 ? 'pass' : spa ? 'unknown' : 'warn', 'low', navLinks >= 3 || anyLinks >= 3 ? 'Navigation vorhanden.' : spa ? 'Navigation nicht zuverlässig prüfbar.' : 'Kaum Navigation erkennbar (wenige interne Links).', `${navLinks} Menülinks, ${anyLinks} interne Links auf der Startseite`);
  const empties = (homeHtml.match(/href=["']#["']/g) ?? []).length;
  if (empties > 2) add('EMPTY_LINKS', 'design', 'warn', 'low', 'Mehrere Links führen ins Leere (#).', `${empties} Platzhalter-Links`);
  if (PLACEHOLDER.test(allText)) add('PLACEHOLDER_TEXT', 'content', 'fail', 'high', 'Platzhalter- oder „im Aufbau“-Text sichtbar.', `Gefunden: ${PLACEHOLDER.exec(allText)![0]}`);

  // ---- Inhalt
  textual('CONTENT_AMOUNT', 'content', allText.length >= 400, 'medium', 'Ausreichend Text vorhanden.', 'Kaum Text – Leistungen sind schwer zu erfassen.', `${allText.length} Zeichen sichtbarer Text`, `${allText.length} Zeichen sichtbarer Text`);
  const serviceList = /<ul[\s\S]*?(?:<li[\s\S]*?){3,}<\/ul>/i.test(allHtml);
  textual('SERVICES_CLEAR', 'content', SERVICES.test(allText) || serviceList, 'medium', 'Leistungen erkennbar.', 'Leistungen nicht klar strukturiert (kein Leistungs-/Preisbereich erkennbar).', 'Leistungs-/Angebotsbereich gefunden', 'Kein Abschnitt „Leistungen“, „Angebot“ oder „Preise“ gefunden');
  const years = [...allHtml.matchAll(/(?:©|&copy;|copyright)[^\d]{0,30}(?:(?:19|20)\d{2}\s*[-–]\s*)?((?:19|20)\d{2})/gi)].map((m) => Number(m[1])).concat([...allText.matchAll(/\bStand:?\s*((?:19|20)\d{2})/g)].map((m) => Number(m[1])));
  if (years.length) {
    const age = input.now.getFullYear() - Math.max(...years);
    add('FRESHNESS', 'content', age >= 3 ? 'fail' : age >= 1 ? 'warn' : 'pass', 'medium', age >= 3 ? `Inhalte wirken nicht gepflegt (Jahr ${Math.max(...years)}).` : age >= 1 ? `Letzte Jahresangabe liegt ${age} Jahr${age > 1 ? 'e' : ''} zurück.` : 'Aktuelle Jahresangabe vorhanden.', `Jahresangabe ${Math.max(...years)}`);
  } else add('FRESHNESS', 'content', 'unknown', 'medium', 'Aktualität nicht ermittelbar (keine Jahres-/Datumsangabe).', 'Weder Copyright- noch „Stand“-Angabe gefunden');
  const cityRe = input.lead.city ? new RegExp(input.lead.city.split(/[\/,]/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  const plz = input.lead.postalCode ? allText.includes(input.lead.postalCode) : /\b\d{5}\s+[A-ZÄÖÜ][a-zäöüß]+/.test(allText);
  textual('LOCAL_INFO', 'content', plz || (cityRe ? cityRe.test(allText) : false), 'medium', 'Lokale Informationen (Adresse/Ort) vorhanden.', 'Adresse/Ort auf der Website nicht erkennbar.', 'Ort bzw. PLZ im Text gefunden', 'Weder Ort noch Postleitzahl im Text gefunden');
  textual('OPENING_HOURS', 'content', HOURS.test(allText), 'low', 'Öffnungszeiten erkennbar.', 'Öffnungszeiten nicht erkennbar.', 'Hinweis auf Öffnungs-/Sprechzeiten gefunden', 'Kein Hinweis auf Öffnungs- oder Sprechzeiten', 'warn');
  textual('FAQ', 'content', FAQ.test(allText), 'low', 'FAQ-Bereich vorhanden.', 'Kein FAQ-Bereich.', 'FAQ gefunden', 'Kein FAQ-Hinweis gefunden', 'warn');

  // ---- Conversion / Kontakt
  const telLink = /href=["']tel:/i.test(allHtml);
  const phoneText = PHONE.test(allText);
  if (spa) add('PHONE', 'conversion', 'unknown', 'high', 'Telefonnummer nicht zuverlässig prüfbar.', 'Inhalt per JavaScript geladen');
  else if (telLink) add('PHONE', 'conversion', 'pass', 'high', 'Telefonnummer sichtbar und per Tipp anrufbar.', 'tel:-Link gefunden');
  else if (phoneText) add('PHONE', 'conversion', 'warn', 'medium', 'Telefonnummer sichtbar, aber nicht per Tipp anrufbar.', 'Nummer im Text, kein tel:-Link');
  else add('PHONE', 'conversion', 'fail', 'high', 'Keine Telefonnummer erkennbar.', 'Weder tel:-Link noch Nummer im Text');
  const mail = /href=["']mailto:/i.test(allHtml) || EMAIL.test(allText);
  textual('EMAIL', 'conversion', mail, 'low', 'E-Mail-Adresse erkennbar.', 'Keine E-Mail-Adresse erkennbar.', 'mailto:-Link oder Adresse gefunden', 'Keine E-Mail-Adresse gefunden', 'warn');
  const form = /<form\b[\s\S]*?<(?:input|textarea)/i.test(allHtml);
  const wa = /wa\.me|api\.whatsapp\.com|whatsapp/i.test(allHtml);
  if (spa) add('CONTACT_OPTION', 'conversion', 'unknown', 'medium', 'Kontaktmöglichkeiten nicht zuverlässig prüfbar.', 'Inhalt per JavaScript geladen');
  else if (form || mail || telLink || wa) add('CONTACT_OPTION', 'conversion', 'pass', 'medium', 'Kontaktweg vorhanden.', [form && 'Formular', mail && 'E-Mail', telLink && 'Telefon', wa && 'WhatsApp'].filter(Boolean).join(', '));
  else add('CONTACT_OPTION', 'conversion', 'fail', 'high', 'Kein Kontaktweg (Formular, E-Mail, Telefon-Link, WhatsApp) erkennbar.', 'Keiner der Kontaktwege gefunden');
  if (!spa) add('CONTACT_FORM', 'conversion', form ? 'pass' : 'warn', 'low', form ? 'Kontaktformular vorhanden.' : 'Kein Kontaktformular.', form ? '<form> mit Eingabefeld gefunden' : 'Kein <form> mit Eingabefeldern');
  const cta = /<(?:a|button)\b[^>]*(?:class|id)=["'][^"']*(?:btn|button|cta)/i.test(homeHtml) || /<a\b[^>]*>\s*(?:Jetzt|Termin|Anrufen|Kontakt aufnehmen|Anfrage)[^<]*<\/a>/i.test(homeHtml);
  textual('CTA', 'conversion', cta, 'medium', 'Klare Handlungsaufforderung (Button) vorhanden.', 'Kein deutlich hervorgehobener nächster Schritt (Button) erkennbar.', 'Button/CTA-Element gefunden', 'Keine Elemente mit Button-/CTA-Klassen oder Handlungsaufforderung');
  if (input.lead.bookingRelevant !== false) {
    textual('ONLINE_BOOKING', 'conversion', BOOKING.test(allHtml), 'medium', 'Online-Terminbuchung erkennbar.', 'Keine Online-Terminbuchung erkennbar.', 'Buchungsbegriff oder -dienst gefunden', `Keine Buchungsbegriffe oder bekannten Buchungsdienste auf ${n} geprüften Seite${n === 1 ? '' : 'n'}`);
    if (!spa) add('WHATSAPP', 'conversion', wa ? 'pass' : 'warn', 'low', wa ? 'WhatsApp-Kontakt vorhanden.' : 'Keine WhatsApp-Kontaktmöglichkeit erkennbar.', wa ? 'WhatsApp-Link gefunden' : 'Kein wa.me-/WhatsApp-Link');
  }
  const contactPage = crawl.pages.slice(1).some((p) => /kontakt|contact/i.test(p.url) && p.status < 400);
  if (crawl.pages.length > 1) add('CONTACT_PAGE', 'conversion', contactPage ? 'pass' : 'warn', 'low', contactPage ? 'Eigene Kontaktseite vorhanden.' : 'Keine eigene Kontaktseite gefunden.', contactPage ? 'Kontaktseite erreichbar' : 'Keine erreichbare Seite „Kontakt“ gefunden');

  // ---- Vertrauen / Rechtliches
  textual('REVIEWS', 'trust', TRUST.test(allText), 'low', 'Bewertungen/Referenzen erkennbar.', 'Keine Bewertungen oder Referenzen erkennbar.', 'Hinweis auf Bewertungen/Referenzen', 'Keine Begriffe wie Bewertung, Referenz, Kundenstimmen', 'warn');
  const imprint = /impressum|imprint/i.test(allHtml);
  const privacy = /datenschutz|privacy/i.test(allHtml);
  add('IMPRINT', 'trust', imprint ? 'pass' : 'fail', 'medium', imprint ? 'Impressum verlinkt.' : 'Impressum nicht erkennbar (in Deutschland Pflicht).', imprint ? 'Hinweis auf Impressum gefunden' : 'Kein Impressum-Link oder -Text gefunden');
  add('PRIVACY', 'trust', privacy ? 'pass' : 'warn', 'medium', privacy ? 'Datenschutzhinweis verlinkt.' : 'Datenschutzerklärung nicht erkennbar.', privacy ? 'Hinweis auf Datenschutz gefunden' : 'Kein Datenschutz-Link oder -Text gefunden');

  // ---- SEO
  const title = /<title>([\s\S]*?)<\/title>/i.exec(homeHtml)?.[1].trim() ?? '';
  add('TITLE', 'seo', !title ? 'fail' : title.length < 10 || title.length > 70 ? 'warn' : 'pass', 'medium', !title ? 'Seitentitel fehlt.' : title.length < 10 || title.length > 70 ? 'Seitentitel ungünstig lang/kurz.' : 'Seitentitel vorhanden.', title ? `„${title.slice(0, 70)}“ (${title.length} Zeichen)` : 'Kein <title>');
  const desc = /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)/i.exec(homeHtml)?.[1] ?? /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(homeHtml)?.[1] ?? '';
  add('META_DESCRIPTION', 'seo', !desc ? 'fail' : desc.length < 50 || desc.length > 170 ? 'warn' : 'pass', 'low', !desc ? 'Meta-Beschreibung fehlt.' : desc.length < 50 || desc.length > 170 ? 'Meta-Beschreibung ungünstig lang/kurz.' : 'Meta-Beschreibung vorhanden.', desc ? `${desc.length} Zeichen` : 'Kein <meta name="description">');
  if (!spa) add('H1', 'seo', h1s === 1 ? 'pass' : 'warn', 'low', h1s === 1 ? 'Genau eine Hauptüberschrift (H1).' : h1s === 0 ? 'Keine Hauptüberschrift (H1).' : 'Mehrere H1-Überschriften.', `${h1s}× H1`);
  add('LANG', 'seo', /<html[^>]+lang=["'][a-z]{2}/i.test(homeHtml) ? 'pass' : 'warn', 'low', /<html[^>]+lang=/i.test(homeHtml) ? 'Sprache (lang) angegeben.' : 'Sprachangabe (lang) fehlt.', '<html lang="…">');
  add('CANONICAL', 'seo', /<link[^>]+rel=["']canonical["']/i.test(homeHtml) ? 'pass' : 'warn', 'low', /rel=["']canonical["']/i.test(homeHtml) ? 'Canonical-Link vorhanden.' : 'Kein Canonical-Link.', '<link rel="canonical">');
  add('STRUCTURED_DATA', 'seo', /application\/ld\+json/i.test(homeHtml) ? 'pass' : 'warn', 'low', /application\/ld\+json/i.test(homeHtml) ? 'Strukturierte Daten vorhanden.' : 'Keine strukturierten Daten für lokale Unternehmen erkennbar.', 'JSON-LD');
  add('SITEMAP', 'seo', crawl.hasSitemap === undefined ? 'unknown' : crawl.hasSitemap ? 'pass' : 'warn', 'low', crawl.hasSitemap === undefined ? 'Sitemap nicht geprüft.' : crawl.hasSitemap ? 'Sitemap vorhanden.' : 'Keine Sitemap gefunden.', '/sitemap.xml');
  const imgs = homeHtml.match(/<img\b[^>]*>/gi) ?? [];
  if (imgs.length) { const noAlt = imgs.filter((i) => !/\balt=["'][^"']+/i.test(i)).length; add('IMG_ALT', 'seo', noAlt / imgs.length > 0.5 ? 'warn' : 'pass', 'low', noAlt / imgs.length > 0.5 ? 'Viele Bilder ohne Alternativtext.' : 'Bilder haben Alternativtexte.', `${noAlt} von ${imgs.length} Bildern ohne alt`); }

  // ---- Social (Verlinkung)
  const linked = SOCIAL_LINK.filter(([, re]) => re.test(allHtml)).map(([name]) => name);
  add('SOCIAL_LINKS', 'social', linked.length ? 'pass' : 'warn', 'low', linked.length ? `Social-Media verlinkt: ${linked.join(', ')}.` : 'Website verlinkt keine Social-Media-Profile.', linked.length ? 'Links gefunden' : 'Keine Instagram-/Facebook-/LinkedIn-/TikTok-Links');

  const notes: string[] = [];
  if (spa) { base.renderDependent = true; notes.push('Die Seite lädt Inhalte per JavaScript. Textbasierte Prüfungen sind als „nicht zuverlässig“ markiert.'); }
  if (input.render?.estimated) notes.push('Mobile Werte sind aus dem HTML geschätzt (kein echter Browsertest).');
  if (!input.render) notes.push('Kein Browsertest durchgeführt – mobile Darstellung nur teilweise prüfbar.');
  if (crawl.pages.length < 2) notes.push('Nur die Startseite wurde geprüft.');

  const order: Record<CheckStatus, number> = { fail: 0, warn: 1, unknown: 2, pass: 3 };
  checks.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || order[a.status] - order[b.status]);
  const quality = {} as AuditReport['quality'];
  for (const c of CATEGORIES) {
    const known = checks.filter((k) => k.category === c && k.status !== 'unknown');
    quality[c] = known.length ? Math.max(0, 100 - known.reduce((s, k) => s + (k.status === 'fail' ? PENALTY[k.severity] : k.status === 'warn' ? PENALTY[k.severity] / 2 : 0), 0)) : null;
  }
  const weights: Record<CheckCategory, number> = { technical: 0.2, mobile: 0.25, design: 0.1, content: 0.15, conversion: 0.2, seo: 0.05, social: 0.0, trust: 0.05 };
  let wsum = 0, acc = 0;
  for (const c of CATEGORIES) if (quality[c] !== null && weights[c] > 0) { wsum += weights[c]; acc += weights[c] * quality[c]!; }
  const knownCount = checks.filter((c) => c.status !== 'unknown').length;
  return { ...base, status: 'ANALYZED', finalUrl: final, pagesAnalyzed: n, renderSource: input.render ? { name: input.render.source, estimated: input.render.estimated } : undefined, checks,
    quality, overallQuality: wsum ? Math.round(acc / wsum) : null, coverage: checks.length ? knownCount / checks.length : 0, notes };
}

/** Kurzform für Listen: nur Probleme (fail/warn). */
export const problems = (r: AuditReport) => r.checks.filter((c) => c.status === 'fail' || c.status === 'warn');
