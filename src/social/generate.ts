import type { Profile } from './profiles.ts';

export type Business = {
  name: string; city?: string; phone?: string; openingHours?: string;
  services?: string[];       // vom Betreiber gelieferte Leistungen
  audience?: string; tone?: string;   // überschreiben Zielgruppe/Ton des Branchenprofils
  offer?: string;            // aktuelles Angebot, nur wenn gesetzt
  website?: string;
};
export type Platform = 'instagram' | 'facebook' | 'linkedin' | 'blog' | 'newsletter';
export type Format = 'post' | 'story' | 'reel' | 'artikel' | 'newsletter';
export type Item = { date: string; platform: Platform; format: Format; title: string; body: string; hashtags: string[]; notes: string[] };

export const LIMITS: Record<Platform, number> = { instagram: 2200, facebook: 3000, linkedin: 3000, blog: 20000, newsletter: 20000 };
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]/g, '');
const pick = <T>(a: T[], i: number): T => a[i % a.length];

type Idea = { kind: string; needs?: (keyof Business)[]; make: (b: Business, p: Profile, i: number) => { title: string; body: string; notes?: string[] } };

/** Post-Ideen. Ideen, die Fakten brauchen, werden nur verwendet, wenn der Betreiber diese Fakten geliefert hat. */
const IDEAS: Idea[] = [
  { kind: 'intro', needs: ['services'], make: (b) => ({ title: 'Wir stellen uns vor', body: `Wir sind ${b.name}${b.city ? ` in ${b.city}` : ''}. Das bieten wir an: ${b.services!.slice(0, 5).join(', ')}.` }) },
  { kind: 'hours', needs: ['openingHours'], make: (b) => ({ title: 'Öffnungszeiten', body: `Ihr findet uns zu diesen Zeiten: ${b.openingHours!.replace(/\n/g, ' · ')}.${b.phone ? ` Anruf genügt: ${b.phone}.` : ''}` }) },
  { kind: 'offer', needs: ['offer'], make: (b) => ({ title: 'Aktuelles Angebot', body: `${b.offer}${b.phone ? ` Fragen? Ruft uns an: ${b.phone}.` : ''}`, notes: ['Gültigkeit und Preis vor Veröffentlichung prüfen.'] }) },
  { kind: 'question', make: (b, p, i) => ({ title: 'Frage an die Community', body: `${pick(p.topics.map((t) => `Was wünscht ihr euch bei uns zum Thema ${t}?`), i)} Schreibt es in die Kommentare.` }) },
  { kind: 'tip', make: (b, p, i) => ({ title: 'Tipp', body: `${pick(p.tips, i)}`, notes: ['Allgemeiner Tipp – bitte auf fachliche Richtigkeit für euren Betrieb prüfen.'] }) },
  { kind: 'behind', make: (b, p, i) => ({ title: 'Blick hinter die Kulissen', body: `Heute zeigen wir euch einen Einblick in unseren Alltag bei ${b.name}.`, notes: [`Eigenes Foto/Video aufnehmen: ${pick(p.storyIdeas, i)}`] }) },
  { kind: 'cta', make: (b) => ({ title: 'Kontakt', body: `Habt ihr Fragen oder wollt einen Termin? ${b.phone ? `Ruft uns an: ${b.phone}.` : 'Schreibt uns eine Nachricht.'}${b.website ? ` Mehr Infos: ${b.website}` : ''}` }) },
];

function usable(idea: Idea, b: Business, p: Profile): boolean {
  if (idea.kind === 'tip' && (p.tips.length === 0 || p.regulated)) return false;
  return (idea.needs ?? []).every((k) => { const v = b[k]; return Array.isArray(v) ? v.length > 0 : Boolean(v); });
}

export function hashtagsFor(b: Business, p: Profile): string[] {
  const tags = [...p.hashtags.slice(0, 4)];
  if (b.city) tags.push(slug(b.city));
  tags.push(slug(b.name));
  return [...new Set(tags.filter(Boolean))].slice(0, 6).map((t) => `#${t}`);
}

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Erzeugt einen Content-Kalender. Gleiche Eingaben → gleiche Ausgabe. Alle Einträge sind Entwürfe und brauchen Freigabe. */
export function generatePlan(b: Business, p: Profile, opts: { weeks?: number; start?: Date } = {}): Item[] {
  const weeks = Math.min(Math.max(opts.weeks ?? 4, 1), 12);
  const start = opts.start ?? new Date();
  const ideas = IDEAS.filter((i) => usable(i, b, p));
  const tags = hashtagsFor(b, p);
  const items: Item[] = [];
  let n = 0;
  const regulatedNote = p.regulated ? [`Rechtlicher Hinweis: ${p.regulated}`] : [];

  for (let w = 0; w < weeks; w++) {
    const monday = addDays(start, w * 7);
    // Zwei Feed-Posts pro Woche je Plattform (Di/Fr), Story am Mi, Reel-Idee alle 2 Wochen am Sa.
    const feed: [number, number][] = [[1, 0], [4, 1]];
    for (const plat of p.platforms) {
      for (const [dayOff, slot] of feed) {
        const idea = ideas[(n + slot + (plat === 'facebook' ? 1 : 0)) % ideas.length];
        const c = idea.make(b, p, n + w);
        const body = plat === 'linkedin' ? `${c.body}\n\nMehr dazu im Gespräch – wir freuen uns auf Ihre Nachricht.` : c.body;
        items.push({ date: iso(addDays(monday, dayOff)), platform: plat, format: 'post', title: c.title, body: plat === 'instagram' ? `${body}\n\n${tags.join(' ')}` : body, hashtags: plat === 'instagram' ? tags : [], notes: [...(c.notes ?? []), ...regulatedNote] });
        n++;
      }
    }
    if (p.platforms.includes('instagram')) {
      items.push({ date: iso(addDays(monday, 2)), platform: 'instagram', format: 'story', title: 'Story', body: `Story-Idee: ${pick(p.storyIdeas, w)}. Mit Link/Sticker zu Kontakt${b.phone ? ` (${b.phone})` : ''}.`, hashtags: [], notes: ['Eigene Aufnahme nötig.', ...regulatedNote] });
      if (w % 2 === 0) items.push({ date: iso(addDays(monday, 5)), platform: 'instagram', format: 'reel', title: 'Reel-Idee', body: `Reel (15–30 Sek.): ${pick(p.storyIdeas, w + 1)}. Kurzer Text im Bild, am Ende Hinweis auf Kontakt.`, hashtags: tags, notes: ['Musik-Lizenz beachten (nur freigegebene Tracks).', ...regulatedNote] });
    }
  }
  // Monatlich: Blog-Gliederung und Newsletter (Gerüste, keine erfundenen Inhalte)
  for (let m = 0; m < Math.ceil(weeks / 4); m++) {
    const topic = pick(p.topics, m);
    const d = addDays(start, m * 28 + 10);
    items.push({ date: iso(d), platform: 'blog', format: 'artikel', title: `Blogartikel: ${topic}${b.city ? ` in ${b.city}` : ''}`,
      body: `Gliederung\n1. Einleitung: Worum geht es bei "${topic}" für ${b.audience ?? p.audience}?\n2. Was wir bei ${b.name} dazu anbieten${b.services?.length ? `: ${b.services.slice(0, 3).join(', ')}` : ' (Leistungen ergänzen)'}\n3. Häufige Fragen (aus echten Kundenfragen sammeln)\n4. Kontakt und nächster Schritt${b.phone ? `: ${b.phone}` : ''}`,
      hashtags: [], notes: ['Gerüst: Inhalte vom Betrieb ergänzen, keine Fakten ungeprüft übernehmen.', `Ton: ${b.tone ?? p.tone}`, ...regulatedNote] });
    items.push({ date: iso(addDays(d, 4)), platform: 'newsletter', format: 'newsletter', title: `Newsletter: ${topic}`,
      body: `Betreff-Idee: Neues von ${b.name}\nAufbau: 1) Kurzer Gruß, 2) Thema "${topic}" in 2–3 Sätzen, 3) ${b.offer ? `Angebot: ${b.offer}` : 'Aktuelles aus dem Betrieb (ergänzen)'}, 4) Kontakt${b.phone ? ` (${b.phone})` : ''}, 5) Abmeldelink und Impressum.`,
      hashtags: [], notes: ['Versand nur an Empfänger mit Einwilligung (Double-Opt-in).', `Ton: ${b.tone ?? p.tone}`, ...regulatedNote] });
  }
  return items.sort((a, c) => a.date.localeCompare(c.date) || a.platform.localeCompare(c.platform));
}

/** Aussagen, die ohne Nachweis nicht in Werbetexte gehören (UWG, bei Gesundheitsthemen auch HWG). */
const CLAIMS = /garantier|heilung|heilt\b|heilversprechen|100\s*%\s*(?:erfolg|sicher|wirksam)|nebenwirkungsfrei|risikofrei|platz\s*1\b|nummer\s*1\b/i;

export function validateItem(i: Pick<Item, 'platform' | 'body' | 'hashtags'>): string[] {
  const e: string[] = [];
  if (i.body.length > LIMITS[i.platform]) e.push(`Text zu lang für ${i.platform} (${i.body.length}/${LIMITS[i.platform]})`);
  if (i.platform === 'instagram' && i.hashtags.length > 30) e.push('Zu viele Hashtags');
  if (/\{[a-z_]+\}|\[[^\]]{3,}\]|undefined|null/.test(i.body)) e.push('Unaufgelöster Platzhalter im Text');
  if (!i.body.trim()) e.push('Text ist leer');
  if (CLAIMS.test(i.body)) e.push('Unzulässiges Werbeversprechen (z. B. „garantiert“, Heilversprechen, „100 % Erfolg“) – bitte umformulieren');
  return e;
}

export function toCsv(items: Item[]): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return ['Datum;Plattform;Format;Titel;Text;Hinweise', ...items.map((i) => [i.date, i.platform, i.format, q(i.title), q(i.body), q(i.notes.join(' | '))].join(';'))].join('\n');
}
