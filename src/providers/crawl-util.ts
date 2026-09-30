const PRIORITY = [/kontakt|contact/i, /impressum|imprint/i, /leistung|angebot|service|speisekarte|preise|preis/i, /termin|buchen|booking|reserv/i, /ueber|über|about|team/i];

/** Wählt interne Links der Startseite für den Audit aus (Kontakt, Impressum, Leistungen, Termin, Über uns). */
export function selectLinks(html: string, base: string, max: number): string[] {
  let baseUrl: URL;
  try { baseUrl = new URL(base); } catch { return []; }
  const found = new Map<string, number>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"'#]+)["']/gi)) {
    const href = m[1].trim();
    if (/^(mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let u: URL;
    try { u = new URL(href, baseUrl); } catch { continue; }
    if (u.host.replace(/^www\./, '') !== baseUrl.host.replace(/^www\./, '')) continue;
    if (/\.(jpg|jpeg|png|gif|svg|pdf|zip|css|js|ico|webp)$/i.test(u.pathname)) continue;
    u.hash = '';
    const key = u.toString();
    if (key === baseUrl.toString() || u.pathname === '/') continue;
    const score = PRIORITY.findIndex((re) => re.test(u.pathname + ' ' + m[0]));
    if (!found.has(key)) found.set(key, score === -1 ? 99 : score);
  }
  return [...found.entries()].sort((a, b) => a[1] - b[1]).slice(0, Math.max(0, max)).map(([u]) => u);
}
