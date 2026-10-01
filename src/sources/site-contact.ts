import type { Fact } from '../core/profile.ts';
import { normPhone, socialPlatformOf } from '../core/text.ts';

/**
 * DIRECT_WEBSITE: liest öffentlich sichtbare Unternehmensangaben aus den geprüften Seiten – und merkt sich je Angabe die Seite, auf der sie stand.
 * Es wird nur gelesen, was dort ohne Anmeldung sichtbar ist. Nichts wird geraten; Unklares bleibt weg.
 */
export type Page = { url: string; html: string };
const SOURCE = 'website-crawl';
const strip = (h: string) => h.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const BAD_MAIL = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster)@|@(example\.(com|org|net)|domain\.(com|de)|email\.com|sentry\.io|[\w.-]*wixpress\.com|[\w.-]*sentry[\w.-]*)$|(^|[^a-z])(name|vorname\.nachname|ihre-?mail|ihre\.?email)@|\.(png|jpe?g|gif|svg|webp)$|@\d+x?\./i;
const goodMail = (m: string) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(m) && !BAD_MAIL.test(m);
const DAYS = /\b(?:Mo(?:ntag)?|Di(?:enstag)?|Mi(?:ttwoch)?|Do(?:nnerstag)?|Fr(?:eitag)?|Sa(?:mstag)?|So(?:nntag)?)\b\.?/;

const jsonLd = (html: string): any[] => {
  const out: any[] = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const j = JSON.parse(m[1]); const arr = Array.isArray(j) ? j : j['@graph'] ?? [j]; for (const x of arr) out.push(x); } catch { /* ungültiges JSON-LD ignorieren */ }
  }
  return out;
};

export function extractContactFacts(pages: Page[], capturedAt: string): Fact[] {
  const out: Fact[] = [];
  const seen = new Set<string>();
  const add = (key: Fact['key'], value: unknown, url: string, quality: Fact['quality'], note?: string) => {
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) return;
    const k = `${key}|${JSON.stringify(value)}`; if (seen.has(k)) return; seen.add(k);
    out.push({ key, value, source: SOURCE, capturedAt, quality, url, ...(note ? { note } : {}) });
  };
  let person = false;
  for (const p of pages) {
    const html = p.html; if (!html) continue; const text = strip(html);
    // Telefon: tel:-Link (sicher) oder ausdrücklich beschriftete Nummer
    for (const m of html.matchAll(/href=["']tel:([+\d\s()/.-]+)["']/gi)) { const n = m[1].trim(); if (normPhone(n).length >= 6) add('phone', n, p.url, 'medium'); }
    for (const m of text.matchAll(/(?:Tel(?:efon)?\.?|Fon|Mobil|Phone)\s*[:.]?\s*(\+?\d[\d\s()/.-]{6,18}\d)/gi)) if (normPhone(m[1]).length >= 6 && normPhone(m[1]).length <= 14) add('phone', m[1].trim(), p.url, 'medium');
    for (const m of html.matchAll(/href=["']mailto:([^"'?\s]+)/gi)) { const e = decodeURIComponent(m[1]).trim(); if (goodMail(e)) add('email', e, p.url, 'medium'); }
    if (/impressum|kontakt|contact|imprint/i.test(p.url)) for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g)) if (goodMail(m[0])) add('email', m[0], p.url, 'medium');
    // strukturierte Daten (schema.org LocalBusiness)
    for (const j of jsonLd(html)) {
      if (!j || typeof j !== 'object') continue;
      if (j.telephone) add('phone', String(j.telephone), p.url, 'medium'); if (j.email && goodMail(String(j.email))) add('email', String(j.email), p.url, 'medium');
      const a = j.address; if (a && typeof a === 'object') { if (a.streetAddress) add('address', String(a.streetAddress), p.url, 'low', 'Aus strukturierten Daten der Website'); if (a.postalCode) add('postalCode', String(a.postalCode), p.url, 'low'); if (a.addressLocality) add('city', String(a.addressLocality), p.url, 'low'); }
      const oh = j.openingHours; if (oh) add('openingHours', (Array.isArray(oh) ? oh : [oh]).map(String).slice(0, 14), p.url, 'low', 'Aus strukturierten Daten der Website');
      for (const u of ([] as string[]).concat(j.sameAs ?? [])) { const pf = socialPlatformOf(String(u)); if (pf) add('social', { platform: pf, url: String(u) }, p.url, 'medium', 'Auf der Website verlinkt'); }
    }
    // Adresse (nur aus Impressum/Kontakt, Muster „Straße 12, 66333 Ort“)
    if (/impressum|kontakt|contact|imprint/i.test(p.url)) {
      const m = /([A-ZÄÖÜ][A-Za-zäöüßÄÖÜ.\- ]{2,40}?(?:str(?:aße|\.)?|weg|platz|allee|gasse|ring|damm|ufer)\s*\d+\s?[a-z]?)\s*,?\s*(\d{5})\s+([A-ZÄÖÜ][A-Za-zäöüßÄÖÜ\- ]{2,30})/.exec(text);
      if (m) { add('address', m[1].trim(), p.url, 'low', 'Aus Impressum/Kontaktseite gelesen – bitte prüfen'); add('postalCode', m[2], p.url, 'low'); add('city', m[3].trim().split(/\s{2,}|Tel|E-Mail|Telefon/)[0], p.url, 'low'); }
    }
    // Öffnungszeiten: Abschnitt nach „Öffnungszeiten“ mit Wochentagen
    const oi = text.search(/Öffnungszeiten|Sprechzeiten|Geschäftszeiten/i);
    if (oi >= 0) { const seg = text.slice(oi + 14, oi + 360); const lines = seg.split(/(?=\b(?:Mo|Di|Mi|Do|Fr|Sa|So)\b[a-z]*\.?\s*[:\-–]?\s*\d)/).map((x) => x.trim()).filter((x) => DAYS.test(x) && /\d{1,2}[:.]?\d{0,2}\s*(?:[-–]|bis)\s*\d{1,2}/.test(x) && x.length < 60); if (lines.length >= 2) add('openingHours', lines.slice(0, 7), p.url, 'low', 'Aus dem Text der Website gelesen – bitte prüfen'); }
    // Kontaktformular, WhatsApp, Social
    if (/<form\b[\s\S]*?<(?:input|textarea)/i.test(html) && /kontakt|contact|anfrage|termin/i.test(p.url + html.slice(0, 20000))) add('contactForm', true, p.url, 'medium');
    const wa = /https?:\/\/(?:wa\.me\/\d+|api\.whatsapp\.com\/send[^\s"'<>]*)/i.exec(html)?.[0]; if (wa) add('whatsapp', wa, p.url, 'medium');
    for (const m of html.matchAll(/https?:\/\/(?:www\.)?(?:instagram\.com\/(?!p\/|explore|share)[\w.]+|facebook\.com\/(?!sharer|share|tr\?|plugins)[\w.\-/]+|tiktok\.com\/@[\w.]+|youtube\.com\/(?:@|channel\/|c\/)[\w.\-]+|linkedin\.com\/company\/[\w.\-]+)/gi)) {
      const pf = socialPlatformOf(m[0]); if (pf) add('social', { platform: pf, url: m[0].replace(/[.,;)]+$/, '') }, p.url, 'medium', 'Auf der Website verlinkt');
    }
    // Ansprechpartner nur aus dem (gesetzlich öffentlichen) Impressum
    if (!person && /impressum|imprint/i.test(p.url)) {
      const pm = /(?:Inhaber(?:in)?|Geschäftsführer(?:in)?|Geschäftsführung|Vertretungsberechtigt\w*)\s*:?\s*((?:Dr\.\s+)?[A-ZÄÖÜ][a-zäöüß]+(?:\s+[A-ZÄÖÜ][a-zäöüß-]+){1,2})/.exec(text);
      if (pm) {
        // Impressumstext ist oft ohne Zeilenumbruch: ein angehängtes drittes Wort, das nach Straße/Ort klingt, gehört nicht zum Namen
        const w = pm[1].split(/\s+/); if (w.length === 3 && !/^Dr\.$/.test(w[0]) && /(str|weg|platz|allee|gasse|ring|damm|ufer|straße|hof|markt)/i.test(w[2])) w.pop();
        person = true; add('contactPerson', w.join(' '), p.url, 'low', 'Aus dem Impressum gelesen – bitte prüfen');
      }
    }
    // Leistungen (Listen unter Überschriften)
    const services: string[] = [];
    for (const m of html.matchAll(/<h[23][^>]*>\s*(?:Leistungen|Unser Angebot|Angebot|Preise|Speisekarte)[^<]*<\/h[23]>\s*(?:<p[^>]*>[^<]*<\/p>\s*)?<ul[^>]*>([\s\S]*?)<\/ul>/gi))
      for (const li of m[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) { const t = li[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); if (t && t.length < 80) services.push(t); }
    if (services.length) add('services', [...new Set(services)].slice(0, 8), p.url, 'medium', 'Aus Überschriften/Listen der Website gelesen');
  }
  return out;
}
