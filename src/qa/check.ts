import type { SiteContent as ProjectContent, SiteFiles } from '../site/engine.ts';

export type Issue = { code: string; severity: 'error' | 'warn'; file: string; message: string };
export type QaContext = { content: ProjectContent; legalConfirmed: boolean };

const PLACEHOLDER = /\[[^\]]{3,}\]|beispieltext|platzhalter|lorem ipsum|\btodo\b|folgt\b|beispielentwurf|unverbindliche demo/i;
const htmlFiles = (f: SiteFiles) => Object.keys(f).filter((k) => k.endsWith('.html'));
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** Sichtbarer Text einer Seite (Tags entfernt, HTML-Entities zurückübersetzt – sonst fände „Linh's“ / „Müller & Söhne“ nie eine Übereinstimmung). */
const textOf = (h: string) => h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec, hex, name) => (dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ENTITIES[String(name).toLowerCase()] ?? m)).replace(/\s+/g, ' ');

export function staticQa(files: SiteFiles, ctx: QaContext): Issue[] {
  const out: Issue[] = [];
  const add = (code: string, file: string, message: string, severity: Issue['severity'] = 'error') => out.push({ code, severity, file, message });
  const c = ctx.content;

  const missing = (['phone', 'email', 'address', 'city', 'openingHours', 'about'] as const).filter((k) => !c[k]?.trim());
  if (missing.length) add('CONTENT_MISSING', 'project', `Pflichtangaben fehlen: ${missing.join(', ')}`);
  if (!ctx.legalConfirmed) add('LEGAL_NOT_CONFIRMED', 'project', 'Impressum und Datenschutz wurden noch nicht als geprüft bestätigt.');
  if (!files['index.html']) add('NO_INDEX', 'index.html', 'index.html fehlt');

  for (const f of htmlFiles(files)) {
    const h = files[f];
    if (!/<html[^>]+lang=["'][a-z]{2}/i.test(h)) add('MISSING_LANG', f, 'lang-Attribut fehlt');
    if (!/<meta[^>]+name=["']viewport["']/i.test(h)) add('MISSING_VIEWPORT', f, 'Viewport-Meta fehlt');
    if (!/<title>\s*\S/i.test(h)) add('MISSING_TITLE', f, 'Titel fehlt');
    if (!/<meta[^>]+name=["']description["'][^>]+content=["'][^"']+/i.test(h)) add('MISSING_META_DESCRIPTION', f, 'Meta-Beschreibung fehlt');
    const h1 = (h.match(/<h1[\s>]/gi) ?? []).length;
    if (h1 !== 1) add('H1_COUNT', f, `Es muss genau eine H1 geben (gefunden: ${h1})`);
    if (PLACEHOLDER.test(textOf(h))) add('PLACEHOLDER', f, `Platzhalter- oder Beispieltext gefunden: "${(PLACEHOLDER.exec(textOf(h)) ?? [''])[0]}"`);
    if (/<script\b/i.test(h)) add('SCRIPT', f, 'Enthält JavaScript (nicht vorgesehen)', 'warn');
    for (const m of h.matchAll(/<img\b[^>]*>/gi)) if (!/\balt=/.test(m[0])) add('IMG_ALT', f, 'Bild ohne alt-Attribut');
    for (const m of h.matchAll(/<(a|button)\b[^>]*>([\s\S]*?)<\/\1>/gi)) if (!textOf(m[2]).trim() && !/aria-label=/.test(m[0])) add('EMPTY_LINK', f, 'Link/Button ohne Text');
    const ids = new Set([...h.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]));
    for (const m of h.matchAll(/<a\b[^>]*\bhref=["']([^"']*)["']/gi)) {
      const href = m[1];
      if (href.startsWith('tel:')) { if (!/^tel:\+?\d{6,}$/.test(href)) add('BAD_TEL', f, `Ungültiger tel:-Link: ${href}`); }
      else if (href.startsWith('mailto:')) { if (!/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(href)) add('BAD_MAILTO', f, `Ungültiger mailto:-Link: ${href}`); }
      else if (/^https?:\/\//.test(href)) { if (href !== c.bookingUrl) add('EXTERNAL_LINK', f, `Unerwarteter externer Link: ${href}`, 'warn'); }
      else if (href.startsWith('#')) { if (href.length > 1 && !ids.has(href.slice(1))) add('BROKEN_LINK', f, `Anker ${href} existiert nicht`); }
      else { const target = href.split('#')[0]; if (target && !files[target]) add('BROKEN_LINK', f, `Link auf fehlende Datei: ${href}`); }
    }
    if (/\b(?:src|srcset)=["']https?:|<link[^>]+href=["']https?:|@import|url\(https?:/i.test(h)) add('EXTERNAL_RESOURCE', f, 'Lädt externe Ressourcen (Datenschutz)');
  }

  const idx = files['index.html'] ?? '';
  if (c.phone && !idx.includes('href="tel:')) add('PHONE_MISSING', 'index.html', 'Telefonnummer fehlt oder ist nicht anrufbar');
  if (c.email && !idx.includes(`mailto:${c.email}`)) add('EMAIL_MISSING', 'index.html', 'E-Mail-Adresse fehlt auf der Startseite');
  if (!/href=["']impressum\.html/.test(idx) || !/href=["']datenschutz\.html/.test(idx)) add('LEGAL_LINKS', 'index.html', 'Links auf Impressum/Datenschutz fehlen');
  const imp = textOf(files['impressum.html'] ?? '');
  if (!imp.includes(c.companyName) || (c.address && !imp.includes(c.address))) add('IMPRINT_INCOMPLETE', 'impressum.html', 'Impressum enthält nicht Name und Anschrift');
  return out;
}

const FIXERS: Record<string, (html: string, ctx: QaContext) => string> = {
  MISSING_LANG: (h) => h.replace(/<html\b(?![^>]*\blang=)/i, '<html lang="de"'),
  MISSING_VIEWPORT: (h) => h.replace(/<head>/i, '<head><meta name="viewport" content="width=device-width,initial-scale=1">'),
  MISSING_META_DESCRIPTION: (h, ctx) => h.replace(/<\/title>/i, `</title><meta name="description" content="${ctx.content.companyName}${ctx.content.city ? ` in ${ctx.content.city}` : ''}.">`),
  IMG_ALT: (h) => h.replace(/<img\b(?![^>]*\balt=)/gi, '<img alt=""'),
};

/** Prüft, korrigiert automatisch behebbare Fehler und prüft erneut (max. 2 Runden). Inhaltliche Fehler bleiben offen. */
export function qaLoop(files: SiteFiles, ctx: QaContext, rounds = 2): { files: SiteFiles; issues: Issue[]; fixed: string[] } {
  let cur = { ...files };
  const fixed: string[] = [];
  let issues = staticQa(cur, ctx);
  for (let r = 0; r < rounds; r++) {
    const fixable = issues.filter((i) => FIXERS[i.code] && i.file.endsWith('.html'));
    if (!fixable.length) break;
    for (const i of fixable) { cur[i.file] = FIXERS[i.code](cur[i.file], ctx); fixed.push(`${i.code}@${i.file}`); }
    issues = staticQa(cur, ctx);
  }
  return { files: cur, issues, fixed };
}
