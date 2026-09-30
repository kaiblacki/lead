export type Template = {
  key: string;
  label: string;
  keywords: string[];
  palette: { primary: string; primaryText: string; bg: string; ink: string; soft: string };
  tagline: (name: string, city?: string) => string;
  heroSub: string;
  cta: string;
  booking: boolean;
  services: { title: string; text: string }[];
};

const T = (t: Template) => t;
export const TEMPLATES: Template[] = [
  T({ key: 'friseur', label: 'Friseur / Beauty', keywords: ['friseur', 'hair', 'salon', 'beauty', 'kosmetik', 'barber', 'nagel'],
    palette: { primary: '#7a2e5c', primaryText: '#ffffff', bg: '#fffafc', ink: '#2a1a24', soft: '#f6e9f0' },
    tagline: (n, c) => `${n}${c ? ` in ${c}` : ''}`, heroSub: 'Ihr Termin in wenigen Klicks – Beispielentwurf.', cta: 'Termin anfragen', booking: true,
    services: [{ title: 'Schneiden & Styling', text: 'Beispieltext: Hier beschreiben wir später Ihre Schnitt- und Stylingleistungen.' }, { title: 'Farbe & Pflege', text: 'Beispieltext: Hier stehen später Ihre Farb- und Pflegeangebote.' }, { title: 'Beratung', text: 'Beispieltext: Hier erklären wir, wie Sie Ihre Kundinnen und Kunden beraten.' }] }),
  T({ key: 'restaurant', label: 'Restaurant / Gastro', keywords: ['restaurant', 'gastro', 'café', 'cafe', 'bistro', 'imbiss', 'pizz', 'bar'],
    palette: { primary: '#8a3b12', primaryText: '#ffffff', bg: '#fffaf5', ink: '#2b1d14', soft: '#f7e9dc' },
    tagline: (n, c) => `${n}${c ? ` – ${c}` : ''}`, heroSub: 'Speisekarte, Öffnungszeiten und Reservierung auf einen Blick – Beispielentwurf.', cta: 'Tisch anfragen', booking: true,
    services: [{ title: 'Speisekarte', text: 'Beispieltext: Hier erscheint später Ihre aktuelle Speisekarte.' }, { title: 'Reservierung', text: 'Beispieltext: Hier können Gäste später einen Tisch anfragen.' }, { title: 'Veranstaltungen', text: 'Beispieltext: Hier stehen später Hinweise zu Feiern und Events.' }] }),
  T({ key: 'zahnarzt', label: 'Zahnarzt / Praxis', keywords: ['zahn', 'arzt', 'praxis', 'ärzt', 'physio', 'therap', 'heilprakt', 'orthop'],
    palette: { primary: '#0b5c7a', primaryText: '#ffffff', bg: '#f7fbfd', ink: '#10232b', soft: '#e3f1f7' },
    tagline: (n, c) => `${n}${c ? `, ${c}` : ''}`, heroSub: 'Sprechzeiten, Leistungen und Terminanfrage – Beispielentwurf.', cta: 'Termin anfragen', booking: true,
    services: [{ title: 'Leistungen', text: 'Beispieltext: Hier stellen wir später das Leistungsspektrum der Praxis vor.' }, { title: 'Das Team', text: 'Beispieltext: Hier folgen später Informationen zum Team.' }, { title: 'Anfahrt & Sprechzeiten', text: 'Beispieltext: Hier stehen später Anfahrt und Sprechzeiten.' }] }),
  T({ key: 'handwerker', label: 'Handwerk', keywords: ['handwerk', 'elektr', 'sanitär', 'sanitaer', 'maler', 'dach', 'schreiner', 'tischler', 'heizung', 'bau', 'installat', 'garten'],
    palette: { primary: '#b34700', primaryText: '#ffffff', bg: '#fffaf6', ink: '#241a12', soft: '#f8e8db' },
    tagline: (n, c) => `${n}${c ? ` in ${c}` : ''}`, heroSub: 'Leistungen und direkter Kontakt für Ihre Anfrage – Beispielentwurf.', cta: 'Anfrage senden', booking: false,
    services: [{ title: 'Leistungen', text: 'Beispieltext: Hier beschreiben wir später Ihre Gewerke und Leistungen.' }, { title: 'Ablauf', text: 'Beispieltext: Hier erklären wir später, wie eine Zusammenarbeit abläuft.' }, { title: 'Einsatzgebiet', text: 'Beispieltext: Hier nennen wir später Ihr Einsatzgebiet.' }] }),
  T({ key: 'autowerkstatt', label: 'Autowerkstatt', keywords: ['auto', 'kfz', 'werkstatt', 'reifen', 'fahrzeug'],
    palette: { primary: '#1f3a8a', primaryText: '#ffffff', bg: '#f8f9fd', ink: '#141a2e', soft: '#e6eaf7' },
    tagline: (n, c) => `${n}${c ? ` – ${c}` : ''}`, heroSub: 'Leistungen und Terminanfrage für Ihre Werkstatt – Beispielentwurf.', cta: 'Termin anfragen', booking: true,
    services: [{ title: 'Service & Wartung', text: 'Beispieltext: Hier stehen später Ihre Service-Leistungen.' }, { title: 'Reparatur', text: 'Beispieltext: Hier stehen später Ihre Reparaturleistungen.' }, { title: 'Reifen', text: 'Beispieltext: Hier stehen später Angebote rund um Reifen.' }] }),
  T({ key: 'fitness', label: 'Fitness / Sport', keywords: ['fitness', 'gym', 'sport', 'yoga', 'studio', 'training'],
    palette: { primary: '#0f6b3a', primaryText: '#ffffff', bg: '#f6fbf8', ink: '#10231a', soft: '#e0f2e8' },
    tagline: (n, c) => `${n}${c ? ` in ${c}` : ''}`, heroSub: 'Kurse, Angebote und Probetraining anfragen – Beispielentwurf.', cta: 'Probetraining anfragen', booking: true,
    services: [{ title: 'Angebote', text: 'Beispieltext: Hier stehen später Ihre Kurse und Angebote.' }, { title: 'Trainer', text: 'Beispieltext: Hier folgen später Informationen zu Ihrem Team.' }, { title: 'Preise', text: 'Beispieltext: Hier stehen später Ihre Mitgliedschaften und Preise.' }] }),
  T({ key: 'immobilien', label: 'Immobilien', keywords: ['immobil', 'makler', 'hausverwalt'],
    palette: { primary: '#334155', primaryText: '#ffffff', bg: '#f8fafc', ink: '#0f172a', soft: '#e7ecf3' },
    tagline: (n, c) => `${n}${c ? ` – ${c}` : ''}`, heroSub: 'Leistungen und persönlicher Kontakt – Beispielentwurf.', cta: 'Beratung anfragen', booking: false,
    services: [{ title: 'Verkauf & Vermietung', text: 'Beispieltext: Hier beschreiben wir später Ihre Leistungen.' }, { title: 'Bewertung', text: 'Beispieltext: Hier steht später Ihr Angebot zur Wertermittlung.' }, { title: 'Objekte', text: 'Beispieltext: Hier erscheinen später Ihre Objekte.' }] }),
  T({ key: 'versicherung', label: 'Versicherung / Beratung', keywords: ['versicher', 'finanz', 'steuer', 'berat', 'kanzlei', 'anwalt'],
    palette: { primary: '#14532d', primaryText: '#ffffff', bg: '#f7fbf8', ink: '#0f2117', soft: '#e1f0e6' },
    tagline: (n, c) => `${n}${c ? `, ${c}` : ''}`, heroSub: 'Beratung und Kontakt auf einen Blick – Beispielentwurf.', cta: 'Beratung anfragen', booking: true,
    services: [{ title: 'Beratung', text: 'Beispieltext: Hier beschreiben wir später Ihre Beratungsfelder.' }, { title: 'Ablauf', text: 'Beispieltext: Hier erklären wir später den Ablauf eines Erstgesprächs.' }, { title: 'Kontakt', text: 'Beispieltext: Hier stehen später Ihre Kontaktmöglichkeiten.' }] }),
];

export const GENERIC: Template = T({ key: 'allgemein', label: 'Allgemein', keywords: [],
  palette: { primary: '#1d4ed8', primaryText: '#ffffff', bg: '#f8faff', ink: '#111827', soft: '#e5ecfb' },
  tagline: (n, c) => `${n}${c ? ` in ${c}` : ''}`, heroSub: 'Ihr Unternehmen klar und modern präsentiert – Beispielentwurf.', cta: 'Kontakt aufnehmen', booking: false,
  services: [{ title: 'Leistungen', text: 'Beispieltext: Hier beschreiben wir später Ihre Leistungen.' }, { title: 'Über uns', text: 'Beispieltext: Hier stellen wir Sie später vor.' }, { title: 'Kontakt', text: 'Beispieltext: Hier stehen später Ihre Kontaktmöglichkeiten.' }] });

export function pickTemplate(industry?: string, companyName?: string): Template {
  const hay = `${industry ?? ''} ${companyName ?? ''}`.toLowerCase();
  return TEMPLATES.find((t) => t.keywords.some((k) => hay.includes(k))) ?? GENERIC;
}
export const templateByKey = (key: string) => [...TEMPLATES, GENERIC].find((t) => t.key === key) ?? GENERIC;

function lum(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
