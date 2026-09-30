import type { Finding, FetchResult, AuditResult, Lead, Scores } from '../core/types.ts';

const BOOKING_HINTS = /termin(?:\s|-)?(?:buchen|vereinbaren|online)|online(?:\s|-)?(?:termin|buchung)|jetzt\s+buchen|treatwell|booksy|calendly|shore\.com|timify|planity|salonized|appointy|simplybook|doctolib|jameda/i;
const HOURS_HINTS = /öffnungszeiten|oeffnungszeiten|sprechzeiten|geöffnet|mo\s*[-–]\s*fr/i;
const FAQ_HINTS = /\bfaq\b|häufige fragen|haeufige fragen/i;
const TRUST_HINTS = /bewertung|referenz|kundenstimm|rezension|testimonial|google\s*reviews/i;
const PHONE_PATTERN = /(?:\+49|0)[\s\d\/()-]{7,}\d/;
const OLD_TECH = /<(?:font|center|marquee|frameset|blink)\b|swfobject|\.swf\b/i;
const SOCIALS: [string, RegExp][] = [
  ['instagram', /https?:\/\/(?:www\.)?instagram\.com\/[^\s"'<>]+/i],
  ['facebook', /https?:\/\/(?:www\.)?facebook\.com\/[^\s"'<>]+/i],
  ['linkedin', /https?:\/\/(?:www\.)?linkedin\.com\/[^\s"'<>]+/i],
];

function has(html: string, re: RegExp): boolean { return re.test(html); }
function text(html: string): string {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function analyzeHtml(fetched: FetchResult, now = new Date()): Finding[] {
  const f: Finding[] = [];
  const html = fetched.html ?? '';
  const plain = text(html);
  const url = fetched.finalUrl ?? '';

  if (!url.startsWith('https://')) {
    f.push({ code: 'NO_HTTPS', category: 'technical', severity: 'high', summary: 'Die Website wird nicht über HTTPS ausgeliefert.', evidence: `Finale URL: ${url}` });
  }
  if (typeof fetched.loadMs === 'number' && fetched.loadMs > 3000) {
    f.push({ code: 'SLOW_LOAD', category: 'technical', severity: fetched.loadMs > 6000 ? 'high' : 'medium', summary: 'Die Startseite lädt langsam.', evidence: `HTML-Antwort nach ${fetched.loadMs} ms` });
  }
  if (!has(html, /<meta[^>]+name=["']viewport["']/i)) {
    f.push({ code: 'NO_VIEWPORT', category: 'mobile', severity: 'high', summary: 'Die Seite ist nicht für Smartphones ausgelegt (kein Viewport-Meta-Tag).', evidence: 'Kein <meta name="viewport"> im HTML gefunden' });
  }
  if (has(html, OLD_TECH)) {
    f.push({ code: 'OLD_TECH', category: 'design', severity: 'medium', summary: 'Die Seite nutzt veraltete HTML-Techniken.', evidence: 'Veraltete Elemente wie <font>, <center>, <marquee>, <frameset> oder Flash gefunden' });
  }
  const years = [...html.matchAll(/(?:©|&copy;|copyright)[^\d]{0,20}(?:(?:19|20)\d{2}\s*[-–]\s*)?((?:19|20)\d{2})/gi)].map((m) => Number(m[1]));
  if (years.length) {
    const latest = Math.max(...years);
    if (now.getFullYear() - latest >= 3) {
      f.push({ code: 'STALE_COPYRIGHT', category: 'content', severity: 'medium', summary: `Der Copyright-Hinweis nennt ${latest}, die Inhalte wirken nicht gepflegt.`, evidence: `Copyright-Jahr ${latest}` });
    }
  }
  if (!has(html, /<title>\s*\S/i) || !has(html, /<meta[^>]+name=["']description["']/i)) {
    f.push({ code: 'WEAK_SEO_BASICS', category: 'content', severity: 'low', summary: 'Seitentitel oder Meta-Beschreibung fehlen.', evidence: 'title oder meta description nicht gefunden' });
  }
  if (plain.length < 400) {
    f.push({ code: 'THIN_CONTENT', category: 'content', severity: 'medium', summary: 'Die Startseite enthält kaum Text, Leistungen sind schwer zu erfassen.', evidence: `${plain.length} Zeichen sichtbarer Text` });
  }
  if (!has(html, /href=["']tel:/i) && !PHONE_PATTERN.test(plain)) {
    f.push({ code: 'NO_PHONE', category: 'conversion', severity: 'high', summary: 'Auf der Startseite ist keine Telefonnummer erkennbar.', evidence: 'Weder tel:-Link noch Telefonnummer im Text' });
  } else if (!has(html, /href=["']tel:/i)) {
    f.push({ code: 'PHONE_NOT_CLICKABLE', category: 'conversion', severity: 'low', summary: 'Die Telefonnummer ist nicht per Tipp anrufbar.', evidence: 'Kein tel:-Link vorhanden' });
  }
  if (!has(html, /<form\b/i) && !has(html, /href=["']mailto:/i) && !has(html, /wa\.me|api\.whatsapp\.com/i)) {
    f.push({ code: 'NO_CONTACT_OPTION', category: 'conversion', severity: 'medium', summary: 'Es gibt kein Kontaktformular, keine E-Mail- und keine WhatsApp-Verknüpfung.', evidence: 'Kein <form>, mailto: oder WhatsApp-Link gefunden' });
  }
  if (!has(html, BOOKING_HINTS)) {
    f.push({ code: 'NO_ONLINE_BOOKING', category: 'conversion', severity: 'medium', summary: 'Eine Online-Terminbuchung ist nicht erkennbar.', evidence: 'Keine Buchungsbegriffe oder bekannten Buchungsdienste im HTML gefunden' });
  }
  if (!has(plain, HOURS_HINTS)) {
    f.push({ code: 'NO_OPENING_HOURS', category: 'content', severity: 'low', summary: 'Öffnungszeiten sind auf der Startseite nicht erkennbar.', evidence: 'Kein Hinweis auf Öffnungs- oder Sprechzeiten im Text' });
  }
  if (!has(html, /<(?:button|a)\b[^>]*(?:class|id)=["'][^"']*(?:btn|button|cta)/i)) {
    f.push({ code: 'NO_CLEAR_CTA', category: 'conversion', severity: 'medium', summary: 'Ein deutlich hervorgehobener nächster Schritt (Button) ist nicht erkennbar.', evidence: 'Keine Elemente mit Button-/CTA-Klassen gefunden' });
  }
  if (!has(plain, TRUST_HINTS)) {
    f.push({ code: 'NO_TRUST_SIGNALS', category: 'trust', severity: 'low', summary: 'Bewertungen oder Referenzen sind nicht erkennbar.', evidence: 'Keine Begriffe wie Bewertung, Referenz oder Kundenstimmen gefunden' });
  }
  if (!has(plain, FAQ_HINTS)) {
    f.push({ code: 'NO_FAQ', category: 'content', severity: 'low', summary: 'Es gibt keinen FAQ-Bereich.', evidence: 'Kein FAQ-Hinweis gefunden' });
  }
  const linked = SOCIALS.filter(([, re]) => re.test(html)).map(([n]) => n);
  if (!linked.length) {
    f.push({ code: 'NO_SOCIAL_LINKS', category: 'social', severity: 'low', summary: 'Die Website verlinkt keine Social-Media-Profile.', evidence: 'Keine Instagram-, Facebook- oder LinkedIn-Links gefunden' });
  }
  return f;
}

const PENALTY = { low: 6, medium: 12, high: 22 } as const;

/** Teilwerte 0–100, höher = besser. Rein aus Befunden abgeleitet. */
export function scoreFindings(findings: Finding[]): Scores {
  const cat = (c: Finding['category']) => Math.max(0, 100 - findings.filter((x) => x.category === c).reduce((s, x) => s + PENALTY[x.severity], 0));
  const scores = {
    technical: cat('technical'), mobile: cat('mobile'), design: cat('design'), content: cat('content'),
    conversion: cat('conversion'), trust: cat('trust'), social: cat('social'),
  };
  const website = Math.round(Object.values(scores).reduce((a, b) => a + b, 0) / 7);
  return { ...scores, website };
}

export function buildAudit(lead: Lead, fetched: FetchResult | null, now = new Date()): AuditResult {
  const auditedAt = now.toISOString();
  if (!lead.websiteUrl) return { leadId: lead.id, status: 'NO_WEBSITE', findings: [], scores: null, auditedAt };
  if (!fetched || !fetched.ok || !fetched.html) {
    return { leadId: lead.id, status: 'UNREACHABLE', scores: null, auditedAt, findings: [{
      code: 'UNREACHABLE', category: 'technical', severity: 'high', summary: 'Die Website war bei der Prüfung nicht erreichbar.',
      evidence: fetched?.error ?? `HTTP ${fetched?.status ?? 'unbekannt'}`,
    }] };
  }
  const findings = analyzeHtml(fetched, now);
  return { leadId: lead.id, status: 'ANALYZED', findings, scores: scoreFindings(findings), auditedAt };
}
