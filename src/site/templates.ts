import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { norm } from '../core/text.ts';
import type { Taxonomy } from '../core/industries.ts';

export type SectionKey = 'hero' | 'services' | 'gallery' | 'booking' | 'about' | 'hours' | 'contact';
export const SECTION_KEYS: SectionKey[] = ['hero', 'services', 'gallery', 'booking', 'about', 'hours', 'contact'];

/** Branchen-Template als reine Daten: Layout, Komponenten, Farben, Textstruktur, CTA, Bildlogik, Seitenstruktur. */
export type Template = {
  key: string; label: string; keywords: string[];
  palette: { primary: string; primaryText: string; bg: string; ink: string; soft: string };
  layout: { hero: 'left' | 'centered'; cards: 'rounded' | 'flat' | 'outlined'; density: 'airy' | 'compact' };
  sections: SectionKey[];
  copy: { tagline: string; heroSub: string; cta: string; servicesTitle: string; aboutTitle: string; bookingTitle: string; bookingText: string };
  booking: boolean;
  services: { title: string; text: string }[];
  imageLogic: { mode: 'placeholder'; slots: string[]; note: string };
  cta: { primary: string; secondary: string; sticky: boolean };
  seo: { titleFormat: string; descriptionFormat: string };
  components: string[];
};

const ROOT = new URL('../../', import.meta.url).pathname;

function lum(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }

/** Prüft ein Template beim Laden: Pflichtfelder, bekannte Sektionen, Farbkontraste (WCAG AA 4,5:1). */
export function validateTemplate(t: any, file = ''): Template {
  const err = (m: string) => { throw new Error(`Template ${file || t?.key}: ${m}`); };
  if (!t || typeof t.key !== 'string' || !/^[a-z0-9-]+$/.test(t.key)) err('key fehlt oder ungültig');
  for (const k of ['label', 'copy', 'palette', 'layout', 'sections', 'services', 'imageLogic', 'cta', 'seo', 'components']) if (!t[k]) err(`${k} fehlt`);
  for (const s of t.sections) if (!SECTION_KEYS.includes(s)) err(`unbekannte Sektion ${s}`);
  if (t.sections[0] !== 'hero' || !t.sections.includes('contact')) err('Sektionen müssen mit hero beginnen und contact enthalten');
  for (const c of ['primary', 'primaryText', 'bg', 'ink', 'soft']) if (!/^#[0-9a-f]{6}$/i.test(t.palette[c])) err(`Farbe ${c} ungültig`);
  const p = t.palette;
  for (const [a, b, what] of [[p.ink, p.bg, 'Text/Hintergrund'], [p.primaryText, p.primary, 'Buttontext/Button'], [p.primary, '#ffffff', 'Button auf Weiß'], [p.ink, p.soft, 'Text/Karten']] as const) if (contrast(a, b) < 4.5) err(`Kontrast ${what} unter 4,5:1`);
  for (const k of ['tagline', 'heroSub', 'cta', 'servicesTitle', 'aboutTitle', 'bookingTitle', 'bookingText']) if (typeof t.copy[k] !== 'string' || !t.copy[k]) err(`copy.${k} fehlt`);
  if (!Array.isArray(t.services) || !t.services.length) err('services fehlen');
  if (t.imageLogic.mode !== 'placeholder') err('imageLogic.mode muss "placeholder" sein (keine fremden Bilder)');
  return t as Template;
}

let cache: Map<string, Template> | null = null;
export function loadTemplates(dir = process.env.TEMPLATES_DIR || 'templates'): Map<string, Template> {
  if (cache && !process.env.TEMPLATES_DIR) return cache;
  const abs = resolve(ROOT, dir);
  const m = new Map<string, Template>();
  for (const f of readdirSync(abs).filter((x) => x.endsWith('.json')).sort()) { const t = validateTemplate(JSON.parse(readFileSync(resolve(abs, f), 'utf8')), f); m.set(t.key, t); }
  if (!m.has('allgemein')) throw new Error('Template "allgemein" fehlt');
  if (!process.env.TEMPLATES_DIR) cache = m;
  return m;
}
export const allTemplates = () => [...loadTemplates().values()];
export const templateByKey = (key?: string | null): Template => loadTemplates().get(key ?? '') ?? loadTemplates().get('allgemein')!;

/** Vorlage wählen: Unterbranche (Taxonomie) → Stichwörter im Branchentext/Namen → Allgemein. */
export function pickTemplate(opts: { subIndustry?: string | null; industryText?: string | null; name?: string | null }, tax?: Taxonomy): Template {
  const t = loadTemplates();
  const sub = tax?.sub(opts.subIndustry ?? undefined);
  if (sub && t.has(sub.template)) return t.get(sub.template)!;
  const hay = norm(`${opts.industryText ?? ''} ${opts.name ?? ''}`);
  for (const tpl of t.values()) if (tpl.keywords.some((k) => hay.includes(norm(k)))) return tpl;
  const m = tax?.match(`${opts.industryText ?? ''} ${opts.name ?? ''}`);
  if (m && t.has(m.template)) return t.get(m.template)!;
  return t.get('allgemein')!;
}

export const fill = (s: string, v: Record<string, string | undefined>) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '').replace(/\s+in\s*$/, '').replace(/\s+[–-]\s*$/, '').replace(/,\s*$/, '').trim();
