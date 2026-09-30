import type { EmployeeBucket } from '../providers/types.ts';

export type SubProfile = {
  key: string; density: number; noSiteBias: number; socialBias: number;
  names: string[];        // {L}=Nachname {F}=Vorname {T}=Ort
  services: string[]; hours: string[][]; emp: Record<EmployeeBucket, number>; placesCategory: string;
};
const H = {
  salon: [['Di–Fr 09:00–18:00', 'Sa 09:00–14:00'], ['Mo–Fr 09:30–18:30', 'Sa 09:00–13:00'], ['Di–Do 09:00–18:00', 'Fr 09:00–19:00', 'Sa 08:30–14:00']],
  praxis: [['Mo–Do 08:00–17:00', 'Fr 08:00–13:00'], ['Mo–Fr 08:00–12:00, 14:00–18:00']],
  handwerk: [['Mo–Fr 07:30–17:00']],
  gastro: [['Di–So 11:30–22:00'], ['Mo–Sa 17:00–23:00', 'So 11:30–21:00']],
  cafe: [['Mo–Sa 08:00–18:00', 'So 09:00–18:00']],
  buero: [['Mo–Fr 09:00–17:00']],
  werkstatt: [['Mo–Fr 08:00–17:30', 'Sa 08:00–12:00']],
  fitness: [['Mo–Fr 06:00–22:00', 'Sa–So 09:00–19:00']],
};
const E = (a: number, b: number, c: number, d: number): Record<EmployeeBucket, number> => ({ '1-4': a, '5-9': b, '10-49': c, '50+': d });

export const SUB_PROFILES: SubProfile[] = [
  { key: 'friseur', density: 1.6, noSiteBias: 0.05, socialBias: 0.8, placesCategory: 'hair_salon', hours: H.salon, emp: E(0.55, 0.3, 0.14, 0.01),
    names: ['Salon {L}', 'Haarstudio {F}', 'Schnittpunkt {T}', 'Kamm & Schere', '{F}s Haarwerkstatt', 'Haargenau {T}', 'Friseur {L}', 'Haarkunst {L}', 'Studio Schnitt & Stil', 'Die Haarmacher', 'Salon Sonnenschein', 'Hair Lounge {T}'],
    services: ['Damenschnitt', 'Herrenschnitt', 'Färben', 'Strähnen', 'Hochsteckfrisuren', 'Kinderhaarschnitt', 'Haarpflege'] },
  { key: 'barbershop', density: 0.7, noSiteBias: 0.05, socialBias: 0.9, placesCategory: 'barber_shop', hours: H.salon, emp: E(0.6, 0.3, 0.1, 0),
    names: ['Barber {L}', 'The Gentlemen Cut', 'Barbershop {T}', 'Bart & Schnitt', 'Kingsize Barber', 'Klingenhandwerk'],
    services: ['Herrenhaarschnitt', 'Bartpflege', 'Rasur', 'Konturenschnitt'] },
  { key: 'nagelstudio', density: 1.7, noSiteBias: 0.25, socialBias: 0.92, placesCategory: 'nail_salon', hours: H.salon, emp: E(0.7, 0.25, 0.05, 0),
    names: ['Nagelstudio {L}', 'Nail Atelier {F}', '{F}s Nagelwelt', 'Nagelzauber {T}', 'Glanzfinger', 'Beauty Nails {T}', 'Nageldesign {L}', 'Pure Nails {T}', 'Fingerkunst', 'Nail Lounge {T}', 'Lackiert & Verliebt', 'Zehn Finger Studio'],
    services: ['Neumodellage', 'Auffüllen', 'Gel-Maniküre', 'Shellac', 'Nail Art', 'Maniküre', 'Pediküre'] },
  { key: 'kosmetik', density: 1.2, noSiteBias: 0.12, socialBias: 0.85, placesCategory: 'beauty_salon', hours: H.salon, emp: E(0.65, 0.28, 0.07, 0),
    names: ['Kosmetikstudio {L}', 'Beauty Oase {T}', 'Hautnah {T}', 'Studio {F}', 'Schönheitsatelier {L}', 'Kosmetik & Wellness {T}', 'Haut & Harmonie'],
    services: ['Gesichtsbehandlung', 'Wimpernverlängerung', 'Augenbrauenformung', 'Microneedling', 'Fußpflege', 'Make-up', 'Waxing'] },
  { key: 'zahnarzt', density: 0.9, noSiteBias: 0.03, socialBias: 0.35, placesCategory: 'dentist', hours: H.praxis, emp: E(0.15, 0.5, 0.33, 0.02),
    names: ['Zahnarztpraxis Dr. {L}', 'Praxis Dr. {L} & Kollegen', 'Zahnmedizin {T}', 'Zahnärzte am Markt', 'Zahnarzt {L}', 'Dental-Zentrum {T}'],
    services: ['Prophylaxe', 'Füllungen', 'Zahnersatz', 'Kinderzahnheilkunde', 'Notdienst nach Vereinbarung'] },
  { key: 'physiotherapie', density: 0.9, noSiteBias: 0.1, socialBias: 0.4, placesCategory: 'physiotherapist', hours: H.praxis, emp: E(0.3, 0.45, 0.24, 0.01),
    names: ['Physiotherapie {L}', 'Praxis für Physiotherapie {T}', 'Bewegungsraum {T}', 'Physio am Park', 'Therapiezentrum {L}'],
    services: ['Krankengymnastik', 'Manuelle Therapie', 'Massage', 'Lymphdrainage', 'Hausbesuche'] },
  { key: 'elektriker', density: 0.9, noSiteBias: 0.25, socialBias: 0.3, placesCategory: 'electrician', hours: H.handwerk, emp: E(0.5, 0.3, 0.17, 0.03),
    names: ['Elektro {L}', 'Elektrotechnik {L} GmbH', 'Elektro-Service {T}', '{L} Elektroinstallation', 'Strom & Licht {T}'],
    services: ['Elektroinstallation', 'Smart Home', 'Reparaturen', 'Prüfungen', 'Photovoltaik-Anschluss'] },
  { key: 'sanitaer', density: 0.9, noSiteBias: 0.25, socialBias: 0.25, placesCategory: 'plumber', hours: H.handwerk, emp: E(0.4, 0.35, 0.22, 0.03),
    names: ['Sanitär {L}', 'Heizung & Bad {L}', '{L} Haustechnik', 'Badstudio {T}', 'Installateur {L}'],
    services: ['Badsanierung', 'Heizungswartung', 'Rohrreinigung', 'Wärmepumpen', 'Notdienst'] },
  { key: 'maler', density: 0.8, noSiteBias: 0.3, socialBias: 0.35, placesCategory: 'painter', hours: H.handwerk, emp: E(0.55, 0.3, 0.14, 0.01),
    names: ['Malerbetrieb {L}', 'Maler & Lackierer {L}', 'Farbe & Raum {T}', '{L} Malerwerkstatt', 'Pinselheld {T}'],
    services: ['Innenanstrich', 'Fassadenanstrich', 'Tapezieren', 'Lackierarbeiten', 'Wärmedämmung'] },
  { key: 'restaurant', density: 1.5, noSiteBias: 0.1, socialBias: 0.75, placesCategory: 'restaurant', hours: H.gastro, emp: E(0.2, 0.4, 0.35, 0.05),
    names: ['Gasthaus {L}', 'Restaurant {T}', 'Zum goldenen {F}', 'Ristorante {L}', 'Landhaus {T}', 'Taverne {L}', 'Zur Linde', 'Wirtshaus am Markt'],
    services: ['Mittagstisch', 'Reservierung', 'Catering', 'Biergarten', 'Familienfeiern'] },
  { key: 'cafe', density: 1.0, noSiteBias: 0.2, socialBias: 0.85, placesCategory: 'cafe', hours: H.cafe, emp: E(0.35, 0.45, 0.2, 0),
    names: ['Café {L}', 'Kaffeehaus {T}', 'Bohne & Blatt', 'Café am Eck', 'Bistro {F}', 'Kuchenliebe'],
    services: ['Frühstück', 'Kuchen', 'Kaffeespezialitäten', 'Torten auf Bestellung'] },
  { key: 'makler', density: 0.6, noSiteBias: 0.05, socialBias: 0.6, placesCategory: 'real_estate_agency', hours: H.buero, emp: E(0.45, 0.35, 0.18, 0.02),
    names: ['Immobilien {L}', '{L} Immobilienservice', 'Immo {T}', 'Haus & Heim {T}', 'Makler {L}'],
    services: ['Verkauf', 'Vermietung', 'Wertermittlung', 'Hausverwaltung'] },
  { key: 'kfz', density: 1.0, noSiteBias: 0.12, socialBias: 0.35, placesCategory: 'car_repair', hours: H.werkstatt, emp: E(0.3, 0.4, 0.27, 0.03),
    names: ['Autowerkstatt {L}', 'Kfz {L}', 'Auto-Service {T}', '{L} Kfz-Meisterbetrieb', 'Reifen & Mehr {T}', 'Werkstatt am Eck'],
    services: ['Inspektion', 'HU/AU', 'Reifenwechsel', 'Bremsenservice', 'Klimaservice'] },
  { key: 'fitnessstudio', density: 0.7, noSiteBias: 0.03, socialBias: 0.9, placesCategory: 'gym', hours: H.fitness, emp: E(0.2, 0.4, 0.35, 0.05),
    names: ['Fitnessstudio {T}', 'Fit & Fun {T}', 'Body Point {T}', 'Sportwelt {L}', 'Move Studio {T}'],
    services: ['Probetraining', 'Kurse', 'Personal Training', 'Sauna'] },
  { key: 'versicherung', density: 0.7, noSiteBias: 0.04, socialBias: 0.45, placesCategory: 'insurance_agency', hours: H.buero, emp: E(0.6, 0.3, 0.09, 0.01),
    names: ['Versicherungsagentur {L}', '{L} Versicherungen', 'Versicherungsbüro {T}', 'Finanz & Vorsorge {L}'],
    services: ['Hausrat', 'Haftpflicht', 'Altersvorsorge', 'Betriebsversicherung'] },
];
export const LAST_NAMES = ['Becker', 'Schmitt', 'Müller', 'Klein', 'Wagner', 'Schneider', 'Fischer', 'Weber', 'Hoffmann', 'Schäfer', 'Koch', 'Bauer', 'Richter', 'Schröder', 'Neumann', 'Schwarz', 'Zimmer', 'Braun', 'Krüger', 'Lang', 'Peters', 'Jung', 'Hahn', 'Lorenz', 'Werner', 'Kirsch', 'Altmeyer', 'Backes', 'Conrad', 'Dincher'];
export const FIRST_NAMES = ['Anna', 'Julia', 'Sabine', 'Nicole', 'Petra', 'Lena', 'Mira', 'Tanja', 'Kim', 'Laura', 'Marco', 'Stefan', 'Jens', 'Tim', 'Daniel', 'Ali', 'Sven', 'Jasmin', 'Linh', 'Elena'];
