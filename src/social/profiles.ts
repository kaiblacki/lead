/** Branchenprofil: Nur diese Daten ändern sich, wenn die Branche wechselt. Die Engine bleibt gleich. */
export type Profile = {
  key: string; label: string; audience: string; tone: string;
  topics: string[];              // Themenfelder (Inhaltssäulen)
  hashtags: string[];            // Basis-Hashtags ohne Ort
  tips: string[];                // allgemeine, unkritische Tipps; leer bei regulierten Branchen
  storyIdeas: string[];          // Ideen für eigene Fotos/Videos (nichts Erfundenes)
  platforms: ('instagram' | 'facebook' | 'linkedin')[];
  regulated?: string;            // Hinweis auf Berufs-/Werberecht; dann keine Ratschläge
};

export const PROFILES: Profile[] = [
  { key: 'friseur', label: 'Friseur / Beauty', audience: 'Kundinnen und Kunden aus der Umgebung', tone: 'freundlich, locker, inspirierend', topics: ['Looks', 'Pflege', 'Team', 'Termine'],
    hashtags: ['friseur', 'haare', 'hairstyle', 'beauty'], platforms: ['instagram', 'facebook'],
    tips: ['Regelmäßiges Spitzenschneiden hilft, dass Haare gepflegt aussehen.', 'Hitzeschutz vor dem Föhnen schont das Haar.', 'Bürste und Kamm regelmäßig reinigen – das Haar dankt es.'],
    storyIdeas: ['Vorher/Nachher (nur mit Einwilligung der Kundin/des Kunden)', 'Kurzer Blick auf die Arbeitsplätze am Morgen', 'Ein Produkt, das ihr im Salon täglich nutzt'] },
  { key: 'restaurant', label: 'Restaurant / Gastro', audience: 'Gäste aus der Region und Besucher', tone: 'einladend, herzlich, appetitanregend', topics: ['Gerichte', 'Team', 'Reservierung', 'Events'],
    hashtags: ['restaurant', 'essen', 'foodie', 'lecker'], platforms: ['instagram', 'facebook'],
    tips: ['Reservieren Sie am Wochenende am besten rechtzeitig.', 'Fragen Sie nach unserer aktuellen Tageskarte.'],
    storyIdeas: ['Ein Gericht von der Zubereitung bis zum Teller', 'Das Team beim Vorbereiten des Tages', 'Ein Blick in die Küche (Hygieneregeln beachten)'] },
  { key: 'zahnarzt', label: 'Zahnarzt / Praxis', audience: 'Patientinnen und Patienten aus der Umgebung', tone: 'sachlich, ruhig, vertrauensvoll', topics: ['Praxis', 'Team', 'Sprechzeiten', 'Service'],
    hashtags: ['zahnarzt', 'praxis', 'gesundheit'], platforms: ['instagram', 'facebook'], tips: [],
    regulated: 'Heilberufe: Berufs- und Heilmittelwerberecht (z. B. HWG) beachten. Keine Heilversprechen, keine Vorher/Nachher-Bilder ohne rechtliche Prüfung.',
    storyIdeas: ['Das Praxisteam stellt sich vor (mit Einwilligung)', 'Ein Blick ins Wartezimmer', 'Hinweis auf Sprechzeiten und Terminvergabe'] },
  { key: 'handwerker', label: 'Handwerk', audience: 'Privatkunden und Gewerbekunden in der Region', tone: 'bodenständig, verlässlich, klar', topics: ['Projekte', 'Team', 'Ablauf', 'Anfrage'],
    hashtags: ['handwerk', 'handwerker', 'meisterbetrieb'], platforms: ['instagram', 'facebook', 'linkedin'],
    tips: ['Frühzeitig anfragen: Gute Termine sind oft Wochen im Voraus vergeben.', 'Fotos vom Bestand helfen bei einer ersten Einschätzung.'],
    storyIdeas: ['Ein Projekt in drei Bildern (mit Einverständnis des Kunden)', 'Werkzeug und Material vor dem Einsatz', 'Das Team auf der Baustelle (Sicherheitsregeln beachten)'] },
  { key: 'autowerkstatt', label: 'Autowerkstatt', audience: 'Autofahrerinnen und Autofahrer aus der Umgebung', tone: 'kompetent, direkt, freundlich', topics: ['Service', 'Reifen', 'Team', 'Termine'],
    hashtags: ['autowerkstatt', 'kfz', 'auto'], platforms: ['instagram', 'facebook'],
    tips: ['Reifendruck regelmäßig prüfen – das hilft Sicherheit und Verbrauch.', 'Rechtzeitig einen Termin für den Reifenwechsel planen.'],
    storyIdeas: ['Ein Arbeitsschritt bei der Inspektion', 'Der Werkstattalltag am Morgen', 'Ein Blick auf das Team'] },
  { key: 'fitness', label: 'Fitness / Sport', audience: 'Mitglieder und Interessierte aus der Umgebung', tone: 'motivierend, energiegeladen, nahbar', topics: ['Training', 'Kurse', 'Team', 'Probetraining'],
    hashtags: ['fitness', 'training', 'workout', 'gym'], platforms: ['instagram', 'facebook'],
    tips: ['Kleine, feste Trainingszeiten helfen, dranzubleiben.', 'Aufwärmen nicht vergessen.'],
    storyIdeas: ['Ein Kurs in Aktion (Einwilligung der Teilnehmenden)', 'Trainer zeigt eine Übung', 'Der Studio-Start in den Tag'] },
  { key: 'immobilien', label: 'Immobilien', audience: 'Eigentümer, Käufer und Mieter in der Region', tone: 'professionell, transparent, persönlich', topics: ['Objekte', 'Markt', 'Ablauf', 'Beratung'],
    hashtags: ['immobilien', 'makler', 'wohnen'], platforms: ['instagram', 'facebook', 'linkedin'],
    tips: ['Aktuelle Unterlagen früh zusammenstellen – das beschleunigt jeden Verkauf.'],
    storyIdeas: ['Ein Objekt-Rundgang (nur mit Freigabe des Eigentümers)', 'Der Weg von der Anfrage zur Besichtigung', 'Das Team stellt sich vor'] },
  { key: 'versicherung', label: 'Versicherung / Beratung', audience: 'Privat- und Geschäftskunden', tone: 'seriös, verständlich, zugewandt', topics: ['Beratung', 'Team', 'Ablauf', 'Kontakt'],
    hashtags: ['beratung', 'versicherung', 'finanzen'], platforms: ['facebook', 'linkedin'], tips: [],
    regulated: 'Finanz-/Versicherungsberatung: Werberegeln (z. B. VVG/WpHG, Pflichtangaben) beachten. Keine Rendite- oder Leistungsversprechen.',
    storyIdeas: ['Das Beratungsteam stellt sich vor', 'Wie läuft ein Erstgespräch ab (Ablauf, keine Beispielzahlen)', 'Hinweis auf Kontaktwege'] },
];

export const GENERAL: Profile = { key: 'allgemein', label: 'Allgemein', audience: 'Kundinnen und Kunden aus der Region', tone: 'freundlich, klar', topics: ['Angebot', 'Team', 'Kontakt'],
  hashtags: ['lokal', 'regional'], platforms: ['instagram', 'facebook'], tips: [], storyIdeas: ['Ein Blick hinter die Kulissen', 'Das Team stellt sich vor'] };

export const profileByKey = (k: string) => [...PROFILES, GENERAL].find((p) => p.key === k) ?? GENERAL;
