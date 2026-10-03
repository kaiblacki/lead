/** Rollen, Zugriffsregeln, Ergebnis-Definitionen, Playbooks und Trainingsfälle des Mitarbeiter-Vertriebssystems (rein, ohne Datenbank). */
export const ROLES = ['ADMIN', 'TEAM_LEAD', 'SALES'] as const; export type Role = (typeof ROLES)[number];
export const ROLE_LABEL: Record<Role, string> = { ADMIN: 'Administrator', TEAM_LEAD: 'Teamleitung', SALES: 'Vertrieb' };
export const STAFF_STATUSES = ['ACTIVE', 'PAUSED', 'DISABLED'] as const; export type StaffStatus = (typeof STAFF_STATUSES)[number];
export const STAFF_STATUS_LABEL: Record<StaffStatus, string> = { ACTIVE: 'Aktiv', PAUSED: 'Pausiert', DISABLED: 'Deaktiviert' };
export type SessionUser = { id: string | null; name: string; role: Role };

const TL_BLOCKED = /^\/(settings|orders|offers|customers|community|maintenance|social|search|enrichment|killswitch|payments|demos|dupes)(\/|$)/;
const TL_POST_OK = /^\/(team|handoffs|work)(\/|$)/;
/** Wer darf welche Seite? SALES nur den Arbeitsplatz (/work); TEAM_LEAD liest fast alles, ändert aber nur Team-Bereiche; ADMIN alles. */
export function pathAllowed(role: Role, method: string, path: string, view?: string | null): boolean {
  if (role === 'ADMIN') return true;
  if (path === '/healthz') return true;
  if (role === 'SALES') return path === '/work' || path.startsWith('/work/');
  if (path === '/work' || path.startsWith('/work/')) return true;
  if (TL_BLOCKED.test(path)) return false;
  if (path === '/analytics' && view === 'costs') return false;
  return method === 'GET' || TL_POST_OK.test(path);
}
export const homeFor = (role: Role) => (role === 'SALES' ? '/work' : '/');

// ---------------------------------------------------------------------------------------------------------------------------------------------
export type ResultKey = 'NO_ANSWER' | 'NO_INTEREST' | 'CALL_BACK' | 'WEBSITE_INTEREST' | 'DEMO_WANTED' | 'PARTNER_INTEREST' | 'NEEDS_ANALYSIS' | 'MULTIPLE_TOPICS' | 'OFFER_REQUESTED' | 'HANDOFF' | 'DO_NOT_CONTACT' | 'REACHED';
export type ContactStatus = 'NOT_CONTACTED' | 'CONTACT_ATTEMPTED' | 'REACHED' | 'QUALIFIED' | 'INTERESTED' | 'FOLLOW_UP' | 'NO_INTEREST' | 'DO_NOT_CONTACT';
export const CONTACT_STATUS_LABEL: Record<ContactStatus, string> = { NOT_CONTACTED: 'Nicht kontaktiert', CONTACT_ATTEMPTED: 'Kontaktversuch', REACHED: 'Erreicht', QUALIFIED: 'Qualifiziert', INTERESTED: 'Interessiert', FOLLOW_UP: 'Nachfassen', NO_INTEREST: 'Kein Interesse', DO_NOT_CONTACT: 'Nicht kontaktieren' };
export type ResultDef = { key: ResultKey; label: string; /** Anruf-Ergebnis der bestehenden Pipeline (null = eigene Behandlung) */ call: string | null; status: ContactStatus; needsNote: boolean; icon: string; next: string; adminTask?: 'PREPARE_DEMO' | 'PREPARE_OFFER' };
export const RESULTS: ResultDef[] = [
  { key: 'NO_ANSWER', label: 'NICHT ERREICHT', call: 'NO_ANSWER', status: 'CONTACT_ATTEMPTED', needsNote: false, icon: '📞', next: 'Neuer Versuch morgen' },
  { key: 'NO_INTEREST', label: 'KEIN INTERESSE', call: 'NO_INTEREST', status: 'NO_INTEREST', needsNote: false, icon: '✖', next: 'Lead abgeschlossen' },
  { key: 'CALL_BACK', label: 'RÜCKRUF', call: 'CALL_BACK', status: 'FOLLOW_UP', needsNote: false, icon: '↩', next: 'Rückruf zum gewählten Termin' },
  { key: 'WEBSITE_INTEREST', label: 'WEBSITE INTERESSANT', call: 'INTERESTED', status: 'INTERESTED', needsNote: true, icon: '🌐', next: 'Website-Follow-up' },
  { key: 'DEMO_WANTED', label: 'DEMO GEWÜNSCHT', call: 'INTERESTED', status: 'INTERESTED', needsNote: true, icon: '🌐', next: 'Demo-Aufgabe für Kai (Demo wird erst nach Kais Bestätigung erstellt)', adminTask: 'PREPARE_DEMO' },
  { key: 'PARTNER_INTEREST', label: 'PARTNERSCHAFT INTERESSANT', call: 'PARTNERSHIP', status: 'QUALIFIED', needsNote: true, icon: '🤝', next: 'Partner-Follow-up' },
  { key: 'NEEDS_ANALYSIS', label: 'BEDARFSANALYSE INTERESSANT', call: 'NEEDS_ANALYSIS', status: 'QUALIFIED', needsNote: true, icon: '🛡', next: 'Übergabe / Termin Bedarfsanalyse' },
  { key: 'MULTIPLE_TOPICS', label: 'MEHRERE THEMEN', call: 'MULTIPLE', status: 'QUALIFIED', needsNote: true, icon: '🗂', next: 'Themen getrennt weiterverfolgen' },
  { key: 'OFFER_REQUESTED', label: 'ANGEBOT GEWÜNSCHT', call: 'INTERESTED', status: 'INTERESTED', needsNote: true, icon: '📄', next: 'Angebotsprozess (Aufgabe für Kai)', adminTask: 'PREPARE_OFFER' },
  { key: 'HANDOFF', label: 'AN KAI ÜBERGEBEN', call: null, status: 'QUALIFIED', needsNote: true, icon: '➡', next: 'Übergabe an Kai' },
  { key: 'DO_NOT_CONTACT', label: 'NICHT MEHR KONTAKTIEREN', call: 'DO_NOT_CONTACT', status: 'DO_NOT_CONTACT', needsNote: false, icon: '⛔', next: 'Lead gesperrt' },
  { key: 'REACHED', label: 'ERREICHT – NOCH OFFEN', call: null, status: 'REACHED', needsNote: false, icon: '✔', next: 'Nächsten Schritt festlegen' },
];
export const RESULT_BY_KEY = Object.fromEntries(RESULTS.map((r) => [r.key, r])) as Record<ResultKey, ResultDef>;
export const resultLabel = (k: string) => (RESULT_BY_KEY as Record<string, ResultDef | undefined>)[k]?.label ?? (k === 'EMAIL_DRAFT' ? 'E-MAIL-ENTWURF' : k === 'EMAIL_SENT' ? 'E-MAIL VERSENDET' : k);
export const resultIcon = (k: string, channel = 'PHONE') => (channel === 'EMAIL' ? '✉️' : (RESULT_BY_KEY as Record<string, ResultDef | undefined>)[k]?.icon ?? '📞');
export const HANDOFF_REASONS = ['WEBSITE_ANGEBOT', 'PARTNER_GESPRAECH', 'BEDARFSANALYSE', 'GROSSKUNDE', 'SONDERFALL', 'MEHRERE_THEMEN'] as const; export type HandoffReason = (typeof HANDOFF_REASONS)[number];
export const HANDOFF_LABEL: Record<HandoffReason, string> = { WEBSITE_ANGEBOT: 'Website-Angebot', PARTNER_GESPRAECH: 'Partnergespräch', BEDARFSANALYSE: 'Bedarfsanalyse', GROSSKUNDE: 'Großkunde', SONDERFALL: 'Sonderfall', MEHRERE_THEMEN: 'Mehrere Themen' };
export const CHANNELS = ['PHONE', 'EMAIL', 'WHATSAPP', 'IN_PERSON', 'OTHER'] as const;
export const CHANNEL_LABEL: Record<string, string> = { PHONE: '📞 Anruf', EMAIL: '✉️ E-Mail', WHATSAPP: 'WhatsApp', IN_PERSON: 'Vor Ort', OTHER: 'Sonstiges' };
export const ASSIGNMENT_STATUS_LABEL: Record<string, string> = { UNASSIGNED: 'Nicht zugewiesen', ASSIGNED: 'Zugewiesen', IN_PROGRESS: 'In Arbeit', COMPLETED: 'Erledigt', RETURNED: 'Zurückgegeben', TRANSFERRED: 'Übergeben' };
export const ASSIGNMENT_SOURCES = ['MANUAL', 'BATCH_ASSIGNMENT', 'ROUND_ROBIN', 'AUTO_RULE'] as const;

// ---------------------------------------------------------------------------------------------------------------------------------------------
/** Kennzahlen: SQL-Prädikate über einem Kontaktversuch `a` (nur feste Texte, nie Nutzereingaben). */
const INTEREST = "'WEBSITE_INTEREST','DEMO_WANTED','OFFER_REQUESTED'";
const QUALIFIED = `${INTEREST},'PARTNER_INTEREST','NEEDS_ANALYSIS','MULTIPLE_TOPICS','HANDOFF'`;
export const METRICS: Record<string, { label: string; sql: string }> = {
  attempts: { label: 'Kontaktversuche', sql: "a.result not in ('EMAIL_DRAFT')" },
  calls: { label: 'Anrufe', sql: "a.channel = 'PHONE'" },
  emails: { label: 'E-Mails (als versendet bestätigt)', sql: "a.channel = 'EMAIL' and a.status = 'SENT'" },
  drafts: { label: 'E-Mail-Entwürfe', sql: "a.channel = 'EMAIL' and a.status = 'DRAFT'" },
  reached: { label: 'Erreichte Ansprechpartner', sql: "a.channel = 'PHONE' and a.result not in ('NO_ANSWER')" },
  qualified: { label: 'Qualifizierte Gespräche', sql: `a.result in (${QUALIFIED})` },
  interested: { label: 'Interessiert', sql: `a.result in (${INTEREST})` },
  demos: { label: 'Demo gewünscht', sql: "a.result = 'DEMO_WANTED'" },
  partner: { label: 'Partnerinteresse', sql: "a.result = 'PARTNER_INTEREST'" },
  needs: { label: 'Bedarfsanalyse-Interesse', sql: "a.result = 'NEEDS_ANALYSIS'" },
  offers: { label: 'Angebotswunsch', sql: "a.result = 'OFFER_REQUESTED'" },
  callbacks: { label: 'Rückrufe vereinbart', sql: "a.result = 'CALL_BACK'" },
  handoffs: { label: 'Übergaben', sql: "a.result = 'HANDOFF'" },
  dnc: { label: 'Nicht mehr kontaktieren', sql: "a.result = 'DO_NOT_CONTACT'" },
  noanswer: { label: 'Nicht erreicht', sql: "a.result = 'NO_ANSWER'" },
};

// ---------------------------------------------------------------------------------------------------------------------------------------------
export type Playbook = { id: string; short: string; title: string; goal: string; intro: string; steps: string[]; questions: string[]; avoid: string[] };
export const PLAYBOOKS: Playbook[] = [
  { id: 'PLAYBOOK_A_NO_WEBSITE', short: 'NO_WEBSITE', title: 'A · Keine Website', goal: 'Interesse an einer Demo-Website klären', intro: 'Ich habe gesehen, dass Sie online bisher keine eigene Website haben, über die Kunden Sie direkt finden.',
    steps: ['Vorstellen und Grund nennen', 'Fragen, wie Kunden Sie bisher finden', 'Nutzen einer einfachen Website nennen (Öffnungszeiten, Kontakt, Leistungen)', 'Kostenlose Demo-Ansicht anbieten – Kai erstellt sie nach Bestätigung', 'Ergebnis und Folgeschritt vereinbaren'], questions: ['Wie finden neue Kunden Sie aktuell?', 'Wie oft fragen Kunden nach Öffnungszeiten oder Leistungen?', 'Wer kümmert sich bei Ihnen um Online-Themen?'], avoid: ['Keine Preise nennen', 'Keine Versicherungs- oder Rabattaussagen', 'Nichts versprechen, was nicht vereinbart ist'] },
  { id: 'PLAYBOOK_B_WEBSITE_IMPROVEMENT', short: 'WEBSITE_IMPROVEMENT', title: 'B · Website verbessern', goal: 'Verbesserungsbedarf der bestehenden Website prüfen', intro: 'Ich habe mir Ihre Website angesehen und einige Punkte gefunden, die Kunden den Weg zu Ihnen erschweren könnten.',
    steps: ['Vorstellen und Grund nennen', 'Einen konkreten Prüfbefund nennen (aus dem Verkaufsassistenten)', 'Fragen, ob das bekannt ist und stört', 'Interesse an einer verbesserten Demo prüfen', 'Ergebnis und Folgeschritt vereinbaren'], questions: ['Wie zufrieden sind Sie mit Ihrer Website?', 'Kommen darüber Anfragen an?', 'Wer pflegt die Seite aktuell?'], avoid: ['Die bisherige Seite nicht abwerten', 'Keine Preise nennen'] },
  { id: 'PLAYBOOK_C_PARTNER', short: 'PARTNER', title: 'C · Partnerschaft', goal: 'Kooperationsinteresse klären', intro: 'Ich arbeite gerne mit lokalen Unternehmen zusammen und suche Partner für gegenseitige Empfehlungen.',
    steps: ['Vorstellen und Grund nennen', 'Passende Kundengruppen erfragen', 'Gegenseitige Empfehlung erklären – freiwillig, ohne Verpflichtung', 'Interesse an einem Kennenlern-Gespräch prüfen', 'Ergebnis vermerken (Kai führt das Partnergespräch)'], questions: ['Welche Kunden würden Sie gern häufiger empfehlen?', 'Gibt es Leistungen, die Ihre Kunden bei Ihnen vermissen?'], avoid: ['Keine Weitergabe von Kundendaten besprechen', 'Keine Kopplung mit Versicherungsverträgen', 'Keine Vorteile versprechen'] },
  { id: 'PLAYBOOK_D_NEEDS_ANALYSIS', short: 'NEEDS_ANALYSIS', title: 'D · Bedarfsanalyse', goal: 'Qualifizierte Übergabe', intro: 'Neben Digitalthemen biete ich ein unverbindliches Gespräch zur Bedarfsanalyse an.',
    steps: ['Vorstellen und Grund nennen', 'Offene Fragen stellen, zuhören', 'Terminwunsch für ein persönliches Gespräch klären', 'Notiz mit Ausgangslage schreiben', 'An Kai übergeben'], questions: ['Wann haben Sie zuletzt Ihre bestehenden Absicherungen überprüft?', 'Gibt es Veränderungen im Betrieb?'], avoid: ['Keine Produkte empfehlen oder Preise nennen', 'Keine Beratung am Telefon', 'Thema getrennt von Website und Partnerschaft halten'] },
  { id: 'PLAYBOOK_E_WEBSITE_PARTNER', short: 'WEBSITE_PARTNER', title: 'E · Website + Partnerschaft', goal: 'Website und Kooperation sauber getrennt prüfen', intro: 'Ich habe zwei getrennte Anliegen: einen besseren Online-Auftritt und mögliche gegenseitige Empfehlungen.',
    steps: ['Vorstellen und Grund nennen', 'Zuerst das Hauptthema besprechen', 'Danach – nur bei Interesse – das zweite Thema getrennt ansprechen', 'Beide Ergebnisse getrennt vermerken', 'Folgeschritte je Thema festlegen'], questions: ['Was ist Ihnen wichtiger: mehr Sichtbarkeit oder Empfehlungen?'], avoid: ['Themen nie vermischen', 'Keine Vorteile für das eine Thema an das andere knüpfen'] },
];
export const playbookById = (id: string | null | undefined) => PLAYBOOKS.find((p) => p.id === id || p.short === id) ?? null;
export function recommendPlaybook(i: { websiteState: string | null; strategy: string | null; needsPotential?: string | null }): Playbook {
  const pick = (id: string) => PLAYBOOKS.find((p) => p.id === id)!;
  if (i.strategy === 'WEBSITE_AND_PARTNER') return pick('PLAYBOOK_E_WEBSITE_PARTNER');
  if (i.strategy === 'PARTNER_FIRST') return pick('PLAYBOOK_C_PARTNER');
  if (i.strategy === 'NEEDS_ANALYSIS_FIRST') return pick('PLAYBOOK_D_NEEDS_ANALYSIS');
  return i.websiteState === 'none' ? pick('PLAYBOOK_A_NO_WEBSITE') : pick('PLAYBOOK_B_WEBSITE_IMPROVEMENT');
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
/** Gesprächsleitfaden: je Schritt nur wenige Optionen. */
export type FlowStep = 'start' | 'interest' | 'topic' | 'nointerest' | 'unsure';
export function flowOptions(step: string): { step: FlowStep; question: string; options: { label: string; to?: FlowStep; result?: ResultKey }[] } {
  switch (step) {
    case 'interest': return { step: 'interest', question: 'Besteht grundsätzlich Interesse?', options: [{ label: 'JA', to: 'topic' }, { label: 'NEIN', to: 'nointerest' }, { label: 'UNSICHER', to: 'unsure' }] };
    case 'topic': return { step: 'topic', question: 'Woran besteht Interesse?', options: ['WEBSITE_INTEREST', 'DEMO_WANTED', 'PARTNER_INTEREST', 'NEEDS_ANALYSIS', 'MULTIPLE_TOPICS', 'OFFER_REQUESTED'].map((k) => ({ label: RESULT_BY_KEY[k as ResultKey].label, result: k as ResultKey })) };
    case 'nointerest': return { step: 'nointerest', question: 'Wie soll es mit dem Lead weitergehen?', options: [{ label: RESULT_BY_KEY.NO_INTEREST.label, result: 'NO_INTEREST' }, { label: RESULT_BY_KEY.DO_NOT_CONTACT.label, result: 'DO_NOT_CONTACT' }] };
    case 'unsure': return { step: 'unsure', question: 'Was ist vereinbart?', options: [{ label: RESULT_BY_KEY.CALL_BACK.label, result: 'CALL_BACK' }, { label: RESULT_BY_KEY.REACHED.label, result: 'REACHED' }] };
    default: return { step: 'start', question: 'Ansprechpartner erreicht?', options: [{ label: 'JA', to: 'interest' }, { label: 'NEIN', result: 'NO_ANSWER' }] };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
/** Trainingsmodus: ausschließlich erfundene Firmen – nie echte Leads. */
export type TrainingCase = { id: string; company: string; branch: string; city: string; situation: string; playbook: string; opener: string; objections: { q: string; a: string; next: string }[] };
export const TRAINING: TrainingCase[] = [
  { id: 't1', company: 'Beispiel-Friseur „Haarlinie“ (erfunden)', branch: 'Friseur', city: 'Beispielstadt', situation: 'Salon ohne eigene Website, nur Social-Media-Seite. Inhaberin ist am Telefon freundlich, aber im Stress.', playbook: 'PLAYBOOK_A_NO_WEBSITE', opener: 'Guten Tag, hier ist {Name}. Ich habe gesehen, dass Sie online bisher keine eigene Website haben – haben Sie kurz zwei Minuten?',
    objections: [{ q: 'Ich habe keine Zeit.', a: 'Verstehe ich. Darf ich Sie morgen zu einer ruhigeren Zeit zurückrufen? Es dauert nur zwei Minuten.', next: 'Rückruf-Termin festlegen (Ergebnis: RÜCKRUF)' }, { q: 'Wir haben doch Instagram.', a: 'Das ist eine gute Ergänzung. Eine Website hilft zusätzlich, weil Kunden dort Öffnungszeiten und Kontakt sofort finden.', next: 'Interesse an einer Demo prüfen' }, { q: 'Was kostet das?', a: 'Preise besprechen wir nicht am Telefon. Ich kann Ihnen eine unverbindliche Demo-Ansicht zeigen lassen.', next: 'Ergebnis: DEMO GEWÜNSCHT (mit Notiz) oder RÜCKRUF' }] },
  { id: 't2', company: 'Beispiel-Elektro „Volt & Sohn“ (erfunden)', branch: 'Elektriker', city: 'Beispielstadt', situation: 'Website vorhanden, aber nicht mobil nutzbar. Geschäftsführer ist skeptisch.', playbook: 'PLAYBOOK_B_WEBSITE_IMPROVEMENT', opener: 'Guten Tag, hier ist {Name}. Ich habe mir Ihre Website auf dem Handy angesehen und einen Punkt gefunden, der Anfragen kosten könnte.',
    objections: [{ q: 'Unsere Seite läuft doch.', a: 'Auf dem Computer sicher. Auf dem Handy ist das Kontaktfeld schwer erreichbar – das wollte ich Ihnen zeigen.', next: 'Konkreten Befund nennen, Interesse prüfen' }, { q: 'Kein Bedarf.', a: 'Alles klar, danke für Ihre Zeit. Darf ich mich in einem halben Jahr noch einmal melden?', next: 'Ergebnis: KEIN INTERESSE (oder RÜCKRUF)' }] },
  { id: 't3', company: 'Beispiel-Bäckerei „Krumm“ (erfunden)', branch: 'Bäckerei', city: 'Beispielstadt', situation: 'Gut besuchtes Geschäft, Inhaber offen für Zusammenarbeit mit anderen Geschäften der Straße.', playbook: 'PLAYBOOK_C_PARTNER', opener: 'Guten Tag, hier ist {Name}. Ich suche lokale Unternehmen, die sich gegenseitig weiterempfehlen möchten.',
    objections: [{ q: 'Was hätte ich davon?', a: 'Gegenseitige Empfehlungen – freiwillig, ohne Verpflichtung. Ob es passt, klären wir in einem kurzen Kennenlern-Gespräch mit meinem Kollegen.', next: 'Ergebnis: PARTNERSCHAFT INTERESSANT mit Notiz, dann AN KAI ÜBERGEBEN' }, { q: 'Geben Sie dann meine Kundendaten weiter?', a: 'Nein. Es werden keine Kundendaten ohne ausdrückliche Zustimmung weitergegeben.', next: 'Beruhigen, Ergebnis dokumentieren' }] },
];
