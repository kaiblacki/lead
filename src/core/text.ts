export const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'site';

/** Vergleichsform: klein, ohne Umlaute/Akzente, nur Buchstaben und Ziffern. */
export const norm = (s: string) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export const digits = (s: string) => s.replace(/\D/g, '');

/** Telefonnummer auf Vergleichsform (nur Ziffern, führende Landesvorwahl 49 → 0). */
export function normPhone(p: string): string {
  let d = digits(p);
  const intl = p.trim().startsWith('+') || d.startsWith('0049') || (d.startsWith('49') && d.length > 9);
  if (intl) {
    if (d.startsWith('0049')) d = d.slice(4); else if (d.startsWith('49')) d = d.slice(2);
    return '0' + d.replace(/^0+/, '');            // „+49 (0) 681 …“ → 0681 …
  }
  return d;
}

export function hostOf(url: string): string | null {
  try { return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

export const SOCIAL_HOSTS: Record<string, string> = { 'instagram.com': 'instagram', 'facebook.com': 'facebook', 'fb.com': 'facebook', 'linkedin.com': 'linkedin', 'tiktok.com': 'tiktok', 'youtube.com': 'youtube', 'xing.com': 'xing' };
/** Liefert die Plattform, wenn die URL auf ein Social-Media-Profil zeigt. */
export function socialPlatformOf(url: string): string | null {
  const h = hostOf(url);
  if (!h) return null;
  for (const [host, name] of Object.entries(SOCIAL_HOSTS)) if (h === host || h.endsWith('.' + host)) return name;
  return null;
}

/** Findet „[Platzhalter]“ in Textwerten (nur in Strings, nicht in JSON-Klammern von Listen). */
export function findPlaceholders(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') { for (const m of v.matchAll(/\[[^\]\[]{3,}\]/g)) out.push(m[0]); }
  else if (Array.isArray(v)) v.forEach((x) => findPlaceholders(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => findPlaceholders(x, out));
  return out;
}
