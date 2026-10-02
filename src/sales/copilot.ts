/**
 * Sales Copilot: macht aus den vorhandenen Daten eines Leads eine persönliche Gesprächsvorbereitung (regelbasiert, kostenlos – MASS).
 * Reine Funktion ohne Datenbank und ohne KI. Es wird nichts gesendet, nichts erstellt und nichts entschieden: nur Potenziale, Fragen und Formulierungsvorschläge.
 *
 * Faktenkontrolle: Jede Aussage über den Betrieb stammt aus `CopilotInput` (Lead-Daten, Prüfbefunde, Quellen, Demo, Gesprächsnotizen).
 * Umsatz, Mitarbeiterzahl, Kundenzahl, Versicherungsdeckung und Unternehmensprobleme werden nie erfunden. Branchenüblichkeit wird als solche gekennzeichnet.
 * Die drei Themen Website, Bedarfsanalyse (Absicherung) und Kooperation sind getrennt; es gibt keine Kopplung (kein Rabatt gegen Abschluss).
 */

export type Potential = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
export const NEXT_ACTIONS = ['CALL', 'CREATE_DEMO', 'SHOW_DEMO', 'CALLBACK', 'NEEDS_ANALYSIS', 'PARTNERSHIP_DISCUSSION', 'MANUAL_RESEARCH', 'NO_ACTION'] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];
export const NEXT_ACTION_LABEL: Record<NextAction, string> = { CALL: 'Anrufen', CREATE_DEMO: 'Demo erstellen (nach Bestätigung)', SHOW_DEMO: 'Demo zeigen', CALLBACK: 'Rückruf', NEEDS_ANALYSIS: 'Bedarfsanalyse-Termin', PARTNERSHIP_DISCUSSION: 'Kooperationsgespräch', MANUAL_RESEARCH: 'Manuell recherchieren', NO_ACTION: 'Keine Aktion' };
export const POTENTIAL_LABEL: Record<Potential, string> = { HIGH: 'HOCH', MEDIUM: 'MITTEL', LOW: 'NIEDRIG', UNKNOWN: 'NICHT GENUG DATEN' };
export const NEEDS_LABEL: Record<Potential, string> = { HIGH: 'INTERESSANT', MEDIUM: 'SPÄTER', LOW: 'SPÄTER', UNKNOWN: 'NICHT GENUG DATEN' };

export const STRATEGIES = ['WEBSITE_FIRST', 'PARTNER_FIRST', 'NEEDS_ANALYSIS_FIRST', 'WEBSITE_AND_PARTNER', 'GENERAL_DISCOVERY', 'FOLLOW_UP', 'NO_ACTION'] as const;
export type Strategy = (typeof STRATEGIES)[number];
export const STRATEGY_LABEL: Record<Strategy, string> = { WEBSITE_FIRST: 'Website zuerst', PARTNER_FIRST: 'Partnerschaft zuerst', NEEDS_ANALYSIS_FIRST: 'Bedarfsanalyse zuerst', WEBSITE_AND_PARTNER: 'Website und Partnerschaft', GENERAL_DISCOVERY: 'Allgemeines Kennenlernen', FOLLOW_UP: 'Nachfassen', NO_ACTION: 'Keine Aktion' };
export const CONTACT_STRATEGIES = ['CALL', 'EMAIL_DRAFT', 'DEMO_FIRST', 'CALL_AND_DEMO', 'FOLLOW_UP', 'MANUAL_RESEARCH', 'NO_CONTACT'] as const;
export type ContactStrategy = (typeof CONTACT_STRATEGIES)[number];
export const CONTACT_STRATEGY_LABEL: Record<ContactStrategy, string> = { CALL: 'Anrufen', EMAIL_DRAFT: 'E-Mail-Entwurf', DEMO_FIRST: 'Erst Demo', CALL_AND_DEMO: 'Anruf + Demo', FOLLOW_UP: 'Nachfassen', MANUAL_RESEARCH: 'Manuell recherchieren', NO_CONTACT: 'Kein Kontakt' };
export const CONTACT_STRATEGY_HELP: Record<ContactStrategy, string> = { CALL: 'Der Lead kommt in „Heute anrufen“.', EMAIL_DRAFT: 'Es wird ein E-Mail-Entwurf vorbereitet – nichts wird gesendet.', DEMO_FIRST: 'Erst eine Demo erstellen (nach deiner Bestätigung), dann zulässig Kontakt aufnehmen.', CALL_AND_DEMO: 'Demo vorbereiten, danach anrufen.', FOLLOW_UP: 'Nachfassen nach bisherigem Kontakt.', MANUAL_RESEARCH: 'Erst Daten beschaffen bzw. Voraussetzungen klären.', NO_CONTACT: 'Keine Kontaktaufnahme.' };

export type CheckInput = { code: string; status: string; severity: string; summary: string; evidence: string };
export type CallInput = { result: string; note?: string | null; callbackAt?: string | null; at?: string };
export type CopilotInput = {
  company: string; city?: string | null; subKey?: string | null; subLabel?: string | null; industryKey?: string | null; industryLabel?: string | null; bookingIndustry?: boolean;
  websiteState: string | null; websiteUrl?: string | null; websiteScore?: number | null; auditStatus?: string | null; checks: CheckInput[]; officialVerified?: string | null; enrichmentStatus?: string | null;
  salesOpportunity?: number | null; priority?: string | null; workStatus?: string | null; contactReadiness?: string | null; contactReason?: string | null; contactBlocked?: boolean;
  hasPhone: boolean; hasEmail: boolean; hasWhatsapp: boolean; hasContactForm: boolean; hasSocial: boolean; phoneSource?: string | null;
  reviewCount?: number | null; rating?: number | null; employeeBucket?: string | null; isChain?: boolean; closed?: boolean; address?: string | null; source?: string | null;
  demo: { exists: boolean; modules: { key: string; label: string; demoLabel?: string }[]; familyLabel?: string | null }; demoRecommended: boolean;
  recommendedModules: { key: string; label: string }[];
  partnerStatus?: string | null; contactStrategyManual?: string | null;
  manualChecks: string[]; interestTopics: string[]; callCount: number; lastCall?: CallInput | null; note?: string | null; callerName: string;
};

export type Argument = { claim: string; evidence: string; benefit: string; basis: 'Prüfbefund' | 'Datenlage' | 'Branche' };
export type Copilot = {
  version: number;
  summary30: string;
  introduction: string;
  opener: { text: string; variant: string };
  website: { potential: Potential; label: string; reason: string; problems: { text: string; evidence: string }[]; improvements: string[]; modules: { key: string; label: string; claim: string; basis: string }[]; demoSensible: { value: boolean | null; text: string }; };
  needsAnalysis: { potential: Potential; label: string; reason: string; questions: string[]; note: string };
  partnership: { potential: Potential; label: string; reason: string; customerGroups: string[]; referral: string[]; question: string; note: string };
  questions: { company: string[]; online: string[]; safeguards: string[]; cooperation: string[] };
  arguments: Argument[];
  demoPitch: { exists: boolean; text: string; points: string[]; note: string };
  objections: { key: string; objection: string; answer: string }[];
  goal: { code: string; text: string; note: string };
  flow: string[];
  nextAction: { code: NextAction; label: string; reason: string };
  uncertain: string[];
  facts: string[];
  /** BESTE GESPRÄCHSSTRATEGIE: immer genau eine Hauptstrategie, danach mögliche Nebenthemen (Website / Bedarfsanalyse / Partnerschaft bleiben getrennt). */
  strategy: { main: Strategy; label: string; reason: string; secondary: { topic: 'WEBSITE' | 'BEDARFSANALYSE' | 'PARTNERSCHAFT'; text: string }[] };
  /** Empfehlung des Systems; Kai entscheidet (Lead-Spalte contact_strategy). */
  contactStrategy: { code: ContactStrategy; label: string; reason: string };
  partnerTalk: { intro: string; questions: string[]; note: string; status: string } | null;
};

const FORBIDDEN = /(?:^|\W)(?:rabatt|prämie|police|haftpflicht|berufsunf|rechtsschutz|hausrat|abschluss(?:geschenk)?)(?:\W|$)/i;
/** Wird in Tests und bei KI-Ergebnissen geprüft: keine Produktempfehlung, keine Kopplung von Website und Versicherung. */
export const copilotViolation = (text: string): string | null => (FORBIDDEN.test(text) ? 'Produkt-/Rabattaussage' : null);

const join = (xs: string[], and = 'und') => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${and} ${xs[xs.length - 1]}`);
const trimDot = (s: string) => s.replace(/[.\s]+$/, '');
const SEV: Record<string, number> = { high: 0, medium: 1, low: 2 };

export function buildCopilot(i: CopilotInput, cfg: any): Copilot {
  const C = cfg.copilot;
  const profile = (i.industryKey && C.profiles[i.industryKey]) || C.defaultProfile;
  const noSite = i.websiteState === 'none';
  const unknownSite = !i.websiteState || i.websiteState === 'unknown' || i.auditStatus === 'UNREACHABLE';
  const fineSite = i.websiteState === 'fine';
  const hasSiteData = !noSite && !unknownSite;
  const uncertainSite = i.officialVerified === 'UNCERTAIN' || i.officialVerified === 'LIKELY';
  const branch = i.subLabel || i.industryLabel || profile.label;
  const place = i.city ? ` in ${i.city}` : '';
  const dataNeeded = i.workStatus === 'DATA_NEEDED';
  const topics = new Set(i.interestTopics ?? []);
  const last = i.lastCall ?? null;
  const problems = i.checks.filter((c) => (c.status === 'fail' || c.status === 'warn') && c.severity !== 'low')
    .sort((a, b) => (a.status === b.status ? (SEV[a.severity] ?? 3) - (SEV[b.severity] ?? 3) : a.status === 'fail' ? -1 : 1));
  const failing = (code: string) => i.checks.find((c) => c.code === code && (c.status === 'fail' || c.status === 'warn'));
  const uncertain: string[] = [];

  // ---------- Website-Potenzial ----------
  let wp: Potential; let wReason: string;
  const businessSignals = i.hasPhone || !!i.reviewCount || !!i.address;
  if (i.closed) { wp = 'LOW'; wReason = 'Der Betrieb ist laut Quelle dauerhaft geschlossen.'; }
  else if (noSite) {
    if (uncertainSite) { wp = 'MEDIUM'; wReason = 'Eine mögliche Website wurde gefunden, ist aber nicht sicher dem Betrieb zugeordnet – erst manuell prüfen.'; uncertain.push('Mögliche Website nicht sicher zugeordnet – vor dem Anruf prüfen.'); }
    else if (!businessSignals) { wp = 'MEDIUM'; wReason = 'In den verfügbaren Quellen keine Website gefunden, aber auch kaum weitere Daten zum Betrieb.'; }
    else { wp = 'HIGH'; wReason = 'In den verfügbaren Quellen wurde keine eigene Website gefunden; der Betrieb ist anderweitig erreichbar bzw. belegt (Telefon, Bewertungen oder Adresse).'; }
  } else if (unknownSite) { wp = 'UNKNOWN'; wReason = i.auditStatus === 'UNREACHABLE' ? 'Die Website war beim Abruf nicht erreichbar – Zustand nicht beurteilbar.' : 'Der Zustand der Website ist nicht geprüft.'; }
  else if (fineSite) { const hi = problems.filter((p) => p.severity === 'high').length; wp = hi ? 'MEDIUM' : 'LOW'; wReason = hi ? 'Website grundsätzlich in Ordnung, aber mit einzelnen gewichtigen Befunden.' : 'Die Website ist laut Prüfung in Ordnung – wenig Verbesserungsbedarf.'; }
  else {
    const weak = (i.websiteScore ?? 100) < C.potential.websiteScoreWeak, hi = problems.filter((p) => p.severity === 'high').length;
    wp = weak || hi >= 2 ? 'HIGH' : problems.length ? 'MEDIUM' : 'UNKNOWN';
    wReason = wp === 'UNKNOWN' ? 'Website vorhanden, aber ohne klare Befunde.' : `Website vorhanden mit Verbesserungsbedarf${i.websiteScore != null ? ` (Website-Score ${Math.round(i.websiteScore)}/100)` : ''}; ${problems.length} Befund${problems.length === 1 ? '' : 'e'} aus der Prüfung.`;
  }
  if (i.websiteState === 'exists' && !problems.length && wp !== 'LOW') { wp = 'UNKNOWN'; wReason = 'Website vorhanden, aber nicht ausreichend geprüft.'; }

  // ---------- Module + Argumente ----------
  const labelOf = new Map<string, string>(i.recommendedModules.map((m) => [m.key, m.label]));
  const args: Argument[] = [];
  const addArg = (a: Argument) => { if (args.length < 5 && !args.some((x) => x.claim === a.claim)) args.push(a); };
  const enrichNote = i.enrichmentStatus === 'not_found' ? 'Auch die Web-Suche hat keine eigene Website zugeordnet.' : i.enrichmentStatus && ['pending', 'provider_unavailable', 'skipped_priority', 'budget_blocked', 'not_needed'].includes(i.enrichmentStatus) ? 'Eine Web-Suche wurde nicht durchgeführt.' : '';
  if (noSite && !uncertainSite && !i.closed) addArg({ claim: 'Eine eigene Website könnte den Betrieb online auffindbar machen.', evidence: `In den verfügbaren Quellen wurde keine eigene Website gefunden.${enrichNote ? ` ${enrichNote}` : ''}`, benefit: 'Interessenten finden Leistungen, Adresse und Kontakt an einem Ort.', basis: 'Datenlage' });
  if (hasSiteData) for (const p of problems) {
    const m = C.checkArguments[p.code]; if (!m) continue;
    addArg({ claim: m.claim, evidence: `${trimDot(p.summary)}${p.evidence ? ` (${trimDot(p.evidence)})` : ''}.`, benefit: m.benefit, basis: 'Prüfbefund' });
  }
  if (!i.hasWhatsapp && (noSite || failing('WHATSAPP'))) addArg({ ...argFrom(C.moduleWhy.whatsapp), evidence: 'In den Daten ist kein WhatsApp-Kontakt hinterlegt.', basis: 'Datenlage' });
  if (noSite && !i.hasContactForm) {
    const key = labelOf.has('reservation') ? 'reservation' : i.bookingIndustry ? 'booking' : 'quote';
    if (C.moduleWhy[key] && args.length < 4) addArg({ ...argFrom(C.moduleWhy[key]), evidence: `Ohne eigene Website ist online kein Anfrageweg bekannt (nur Telefon${i.hasEmail ? ' und E-Mail' : ''} in den Daten).`, basis: 'Datenlage' });
  }
  if ((i.reviewCount ?? 0) >= 10) addArg({ claim: 'Der Betrieb scheint bei Kunden bekannt zu sein – eine gute Website könnte das sichtbar machen.', evidence: `${i.reviewCount} Bewertungen laut Quelle${i.rating ? ` (Ø ${String(i.rating).replace('.', ',')})` : ''}.`, benefit: 'Interessenten, die sich vorab informieren, sehen den Betrieb in gutem Licht.', basis: 'Datenlage' });
  if (noSite && (labelOf.has('gallery') || labelOf.has('services'))) { const k = labelOf.has('gallery') ? 'gallery' : 'services'; addArg({ ...argFrom(C.moduleWhy[k]), evidence: `Für ${branch} üblich – ohne eigene Website ist online kein Ort dafür bekannt (Branchenwissen, kein Befund zum Betrieb).`, basis: 'Branche' }); }
  const modules = i.recommendedModules.slice(0, 6).map((m) => ({ key: m.key, label: m.label, claim: C.moduleWhy[m.key]?.claim ?? '', basis: noSite || failing(({ contact_form: 'CONTACT_FORM', whatsapp: 'WHATSAPP', booking: 'RESERVATION', gallery: 'GALLERY', menu: 'MENU', map: 'MAPS', quote: 'QUOTE_REQUEST' } as Record<string, string>)[m.key] ?? '') ? 'Datenlage/Prüfbefund' : 'Branchenüblich' }));

  const improvements = [...new Set(problems.slice(0, 4).map((p) => C.checkArguments[p.code]?.claim ?? p.summary))];
  const demoSensible = (() => {
    if (i.demo.exists) return { value: true, text: 'Demo liegt bereits vor.' };
    if (i.closed || i.contactBlocked) return { value: false, text: 'Nein – Betrieb geschlossen bzw. gesperrt.' };
    if (dataNeeded) return { value: null, text: 'Noch nicht beurteilbar – erst Kontaktdaten beschaffen.' };
    if (i.demoRecommended) return { value: true, text: 'Ja – das System empfiehlt eine Demo (wird erst nach Ihrer Bestätigung erstellt).' };
    return { value: wp === 'HIGH' ? true : wp === 'MEDIUM' ? null : false, text: wp === 'HIGH' ? 'Ja, grundsätzlich sinnvoll – Erstellung erst nach Ihrer Bestätigung.' : wp === 'MEDIUM' ? 'Erst im Gespräch klären, ob Interesse besteht.' : 'Eher nicht sinnvoll.' };
  })();

  // ---------- Bedarfsanalyse (Absicherung) – nur Fragen, keine Diagnose ----------
  let np: Potential; let nReason: string;
  const bigBucket = (C.potential.needsEmployeeBuckets as string[]).includes(i.employeeBucket ?? '');
  if (topics.has('needs')) { np = 'HIGH'; nReason = 'Im Gespräch wurde Interesse an einer Bedarfsanalyse geäußert.'; }
  else if (i.closed || i.contactBlocked || i.isChain) { np = 'LOW'; nReason = i.isChain ? 'Filiale bzw. Teil einer Kette – Entscheidungen fallen vermutlich zentral (Annahme, im Gespräch prüfen).' : 'Betrieb geschlossen bzw. gesperrt.'; }
  else if (bigBucket || (i.reviewCount ?? 0) >= C.potential.needsMinReviews) { np = 'HIGH'; nReason = bigBucket ? `Größenklasse laut Quelle: ${i.employeeBucket} Mitarbeitende – Absicherung ist hier meist ein eigenes Thema.` : `Etablierter Betrieb (${i.reviewCount} Bewertungen laut Quelle) – ein separates Gespräch kann sinnvoll sein.`; }
  else if (!i.industryKey && !i.subKey) { np = 'UNKNOWN'; nReason = 'Branche und Betriebsgröße sind nicht bekannt – keine Aussage möglich.'; }
  else { np = 'MEDIUM'; nReason = `Zu Absicherung und Betriebsgröße liegen keine Daten vor. Als ${branch} ist ein separates Gespräch später möglich – im Gespräch klären, nicht vorab annehmen.`; }
  const insQ = (C.insuranceQuestions.always as string[]).slice(0, 1)
    .concat((profile.insurance as string[]).map((k) => C.insuranceQuestions[k]).filter(Boolean).slice(0, 2)).concat((C.insuranceQuestions.always as string[]).slice(1, 2));

  // ---------- Kooperation ----------
  let pp: Potential; let pReason: string;
  const referralBase = (i.reviewCount ?? 0) >= C.potential.partnerMinReviews && (i.rating ?? 0) >= C.potential.partnerMinRating;
  if (topics.has('partner')) { pp = 'HIGH'; pReason = 'Im Gespräch wurde Interesse an einer Kooperation geäußert.'; }
  else if (i.closed || i.contactBlocked) { pp = 'LOW'; pReason = 'Betrieb geschlossen bzw. gesperrt.'; }
  else if (i.isChain) { pp = 'LOW'; pReason = 'Teil einer Kette – lokale Empfehlungspartnerschaften sind eher unwahrscheinlich (Annahme).'; }
  else if (referralBase) { pp = 'HIGH'; pReason = `Viele positive Bewertungen laut Quelle (${i.reviewCount}, Ø ${String(i.rating).replace('.', ',')}) – der Betrieb hat vermutlich einen festen Kundenkreis.`; }
  else if (profile.customerFacing && (i.hasPhone || i.address) && (i.industryKey || i.subKey)) { pp = 'MEDIUM'; pReason = `Lokaler, kundennaher Betrieb (${branch}) – Kooperation grundsätzlich denkbar; es gibt aber keine Daten zu Kundenkreis oder Empfehlungen.`; }
  else { pp = 'UNKNOWN'; pReason = 'Zu wenig Daten, um ein Kooperationspotenzial zu beurteilen.'; }

  // ---------- Demo-Verkaufsargumente ----------
  const demoPoints = i.demo.exists ? [
    ...(i.demo.familyLabel ? [`Aufbau: ${i.demo.familyLabel}`] : []),
    ...i.demo.modules.slice(0, 3).map((m) => `Enthält: ${m.label}${m.demoLabel ? ` (${m.demoLabel})` : ''}`),
    ...(i.address || i.hasPhone ? [`Kontaktdaten${i.address ? ' und Adresse' : ''} aus den öffentlichen Quellen sind eingebaut`] : []),
  ].slice(0, 3) : [];
  const demoPitch = { exists: i.demo.exists, text: i.demo.exists ? C.demoPitch.exists : C.demoPitch.missing, points: demoPoints,
    note: i.demo.exists ? 'Die Demo ist ein Entwurf – keine fertige Website. Verlinken oder zeigen erst im Gespräch.' : 'Noch keine Demo: nicht sagen, dass bereits etwas vorbereitet wurde.' };

  // ---------- Gesprächsziel + nächste Aktion ----------
  const blocked = !!i.contactBlocked || i.contactReadiness === 'DO_NOT_CONTACT' || last?.result === 'DO_NOT_CONTACT';
  const phoneGate = (i.contactReason ?? '').startsWith('Telefonakquise ist in den Einstellungen');
  let goalCode = 'CHECK_INTEREST';
  if (blocked || last?.result === 'NO_INTEREST') goalCode = 'NONE';
  else if (dataNeeded || phoneGate || !i.hasPhone) goalCode = 'RESEARCH';
  else if (last?.result === 'CALL_BACK') goalCode = 'CALLBACK';
  else if (last?.result === 'NEEDS_ANALYSIS' || (topics.has('needs') && !topics.has('website'))) goalCode = 'NEEDS_ANALYSIS_APPOINTMENT';
  else if (last?.result === 'PARTNERSHIP' || (topics.has('partner') && !topics.has('website') && !topics.has('needs'))) goalCode = 'PARTNERSHIP_CHECK';
  else if (i.demo.exists) goalCode = 'DEMO_APPOINTMENT';
  else if (wp === 'HIGH' && (i.demoRecommended || demoSensible.value)) goalCode = 'DEMO_PERMISSION';
  else if (wp === 'MEDIUM' || wp === 'HIGH') goalCode = 'LEARN_NEEDS';
  else if (pp === 'HIGH' && wp === 'LOW') goalCode = 'PARTNERSHIP_CHECK';
  const goal = { code: goalCode, text: C.goals[goalCode], note: C.goalNote };

  let na: NextAction; let naReason: string;
  if (blocked || last?.result === 'NO_INTEREST') { na = 'NO_ACTION'; naReason = blocked ? 'Lead ist gesperrt (Do not contact).' : 'Im Gespräch wurde kein Interesse geäußert.'; }
  else if (dataNeeded) { na = 'MANUAL_RESEARCH'; naReason = 'Weder Telefonnummer noch E-Mail bekannt – erst Daten beschaffen (Enrichment oder manuelle Recherche).'; }
  else if (phoneGate) { na = 'MANUAL_RESEARCH'; naReason = 'Telefonakquise ist in den Einstellungen noch nicht aktiviert – erst bewusst freigeben.'; }
  else if (!i.hasPhone) { na = 'MANUAL_RESEARCH'; naReason = 'Keine Telefonnummer bekannt – Telefonnummer manuell recherchieren.'; }
  else if (last?.result === 'CALL_BACK') { na = 'CALLBACK'; naReason = `Rückruf vereinbart${last.callbackAt ? ` für ${last.callbackAt}` : ''}.`; }
  else if (last?.result === 'NEEDS_ANALYSIS') { na = 'NEEDS_ANALYSIS'; naReason = 'Interesse an einer Bedarfsanalyse – separaten Termin vereinbaren.'; }
  else if (last?.result === 'PARTNERSHIP') { na = 'PARTNERSHIP_DISCUSSION'; naReason = 'Interesse an einer Kooperation – Gespräch dazu vereinbaren.'; }
  else if (last && ['DEMO', 'INTERESTED', 'OFFER', 'MULTIPLE'].includes(last.result) && topics.has('website')) {
    if (i.demo.exists) { na = 'SHOW_DEMO'; naReason = 'Interesse an der Website – Demo liegt vor, jetzt zeigen.'; }
    else { na = 'CREATE_DEMO'; naReason = 'Interesse an der Website, noch keine Demo – nach Ihrer Bestätigung erstellen.'; }
  } else if (last && ['DEMO', 'INTERESTED', 'OFFER', 'MULTIPLE'].includes(last.result)) { na = 'CALLBACK'; naReason = 'Interesse geäußert – nächsten Schritt vereinbaren.'; }
  else if (last?.result === 'NO_ANSWER') { na = 'CALL'; naReason = 'Nicht erreicht – erneut versuchen.'; }
  else if (i.demo.exists) { na = 'CALL'; naReason = 'Demo liegt vor – anrufen und Demo-Termin vereinbaren.'; }
  else { na = 'CALL'; naReason = i.demoRecommended ? 'Anrufen und Erlaubnis für einen unverbindlichen Demo-Entwurf einholen.' : 'Anrufen und Interesse prüfen.'; }

  // ---------- Einstieg ----------
  const sender = i.callerName;
  const askBranch = i.subLabel ? `Betriebe aus dem Bereich ${i.subLabel}${i.city ? ` in der Region ${i.city}` : ''}` : `Betriebe${i.city ? ` in der Region ${i.city}` : ''}`;
  let opener: { text: string; variant: string };
  if (last?.result === 'CALL_BACK') opener = { variant: 'callback', text: `Guten Tag, hier ist ${sender}. Wir hatten ausgemacht, dass ich mich noch einmal melde. Passt es gerade kurz?` };
  else if (last && last.result !== 'NO_ANSWER' && last.result !== 'NO_INTEREST') opener = { variant: 'followup', text: `Guten Tag, hier ist ${sender}. Wir hatten zuletzt telefoniert${last.note ? ' – ich habe mir Ihre Anmerkungen notiert' : ''}. Ich wollte nachfragen, wie wir weitermachen.` };
  else if (noSite && !uncertainSite) opener = { variant: 'no_website', text: `Guten Tag, hier ist ${sender}. Ich bin auf ${i.company} gestoßen, weil ich mir einige ${askBranch} angeschaut habe. Dabei habe ich online keine eigene Website von Ihnen gefunden. Ist das aktuell bewusst so oder wäre ein moderner Online-Auftritt grundsätzlich interessant?` };
  else if (noSite) opener = { variant: 'website_uncertain', text: `Guten Tag, hier ist ${sender}. Ich bin auf ${i.company} gestoßen, weil ich mir einige ${askBranch} angeschaut habe. Ich bin nicht sicher, ob ich Ihre richtige Website gefunden habe – haben Sie aktuell eine eigene Seite, die Kunden nutzen?` };
  else if (hasSiteData && (wp === 'HIGH' || wp === 'MEDIUM') && problems.length) opener = { variant: 'website_improvable', text: `Guten Tag, hier ist ${sender}. Ich habe mir den Online-Auftritt von ${i.company} angesehen und dabei ein paar Punkte gesehen, die man relativ einfach moderner und kundenfreundlicher gestalten könnte${problems[0] ? ` – zum Beispiel: ${trimDot(problems[0].summary)}` : ''}. Darf ich kurz erzählen, was ich meine?` };
  else if (fineSite) opener = { variant: 'website_fine', text: `Guten Tag, hier ist ${sender}. Ich habe mir den Online-Auftritt von ${i.company} angesehen – der wirkt solide. Mich interessiert eher, wie Sie neue Kunden gewinnen und ob es da etwas gibt, das Sie gern einfacher hätten. Haben Sie kurz zwei Minuten?` };
  else opener = { variant: 'neutral', text: `Guten Tag, hier ist ${sender}. Ich bin auf ${i.company} gestoßen, weil ich mir einige ${askBranch} angeschaut habe. Ich konnte mir Ihren Online-Auftritt noch nicht abschließend ansehen. Wie erreichen Sie Neukunden aktuell hauptsächlich?` };

  // ---------- Fragen (5–10, je Lead unterschiedlich) ----------
  const company = (C.companyQuestions as string[]).slice(0, i.demo.exists || last ? 1 : 2);
  const online = [...(profile.online as string[])];
  if (noSite) online.unshift('Gibt es aktuell einen Ort im Internet, an dem Kunden alles Wichtige zu Ihnen finden?');
  else if (hasSiteData) online.push('Wie oft wird die Website aktuell gepflegt und von wem?');
  const safeguards = insQ;
  const cooperation = [profile.partnerQuestion as string];
  const questions = { company, online: online.slice(0, 3), safeguards, cooperation };

  // ---------- Zusammenfassung ----------
  const siteSentence = noSite ? (uncertainSite ? 'Eine mögliche Website wurde gefunden, ist aber nicht sicher zugeordnet.' : 'In den verfügbaren Quellen wurde keine eigene Website gefunden.')
    : unknownSite ? 'Der Zustand der Website konnte nicht geprüft werden.'
    : fineSite ? 'Website vorhanden und laut Prüfung in Ordnung.'
    : `Website vorhanden${i.websiteScore != null ? ` (Website-Score ${Math.round(i.websiteScore)}/100)` : ''}${problems[0] ? `, auffällig: ${trimDot(problems[0].summary)}` : ''}.`;
  const contactSentence = dataNeeded ? 'Telefon und E-Mail sind nicht bekannt – erst Daten beschaffen.' : i.hasPhone ? 'Der Betrieb ist telefonisch erreichbar.' : i.hasEmail ? 'Nur E-Mail als Kontaktweg bekannt (kein Versand ohne Einwilligung).' : 'Kontaktweg unklar.';
  const topMods = join(i.recommendedModules.slice(0, 4).map((m) => m.label));
  const summary30 = [
    `${i.subLabel || i.industryLabel || 'Betrieb'}${place}${i.reviewCount ? ` mit ${i.reviewCount} Bewertungen` : ''}.`,
    siteSentence,
    i.salesOpportunity != null ? `Verkaufschance ${Math.round(i.salesOpportunity)}/100${i.priority ? `, Priorität ${i.priority}` : ''}.` : '',
    wp === 'HIGH' || wp === 'MEDIUM' ? (topMods ? `Interessant wären: ${topMods}.` : '') : '',
    contactSentence,
    last ? `Letztes Gespräch: ${last.result}${last.note ? ` – „${last.note.slice(0, 120)}“` : ''}.` : '',
  ].filter(Boolean).join(' ');

  const facts = [
    `Quelle: ${i.source ?? 'nicht verfügbar'}`, i.address ? `Adresse: ${i.address}` : 'Adresse: nicht verfügbar', i.hasPhone ? `Telefon vorhanden${i.phoneSource ? ` (${i.phoneSource})` : ''}` : 'Telefon: nicht verfügbar',
    i.reviewCount ? `Bewertungen: ${i.reviewCount}${i.rating ? ` (Ø ${String(i.rating).replace('.', ',')})` : ''}` : 'Bewertungen: nicht verfügbar', i.employeeBucket ? `Mitarbeitende (Größenklasse laut Quelle): ${i.employeeBucket}` : 'Mitarbeiterzahl: nicht verfügbar',
  ];
  for (const m of i.manualChecks.slice(0, 3)) uncertain.push(`Manuell prüfen: ${m}`);
  if (i.officialVerified === 'LIKELY') uncertain.push('Gefundene Website ist nur wahrscheinlich die des Betriebs (LIKELY).');
  uncertain.push('Absicherung, Umsatz, Kunden- und Mitarbeiterzahl sind nicht bekannt und werden nicht geschätzt.');

  const reasonShort = noSite ? 'keine eigene Website in den verfügbaren Quellen gefunden' : problems[0] ? trimDot(problems[0].summary) : 'ich habe mir einige Betriebe der Branche angesehen';
  const mainTopic = goalCode.startsWith('NEEDS') ? 'Bedarfsanalyse' : goalCode.startsWith('PARTNER') ? 'Kooperation' : 'Website';
  const flow = (C.flow as string[]).map((s) => s.replace('{reason}', reasonShort).replace('{question}', questions.online[0] ?? questions.company[0]).replace('{topic}', mainTopic).replace('{goal}', C.goals[goalCode]));

  // ---------- Gesprächsstrategie (eine Hauptstrategie) + Kontaktstrategie-Empfehlung ----------
  const followUpResult = !!last && ['CALL_BACK', 'NO_ANSWER'].includes(last.result);
  let main: Strategy; let sReason: string;
  if (blocked || last?.result === 'NO_INTEREST') { main = 'NO_ACTION'; sReason = blocked ? 'Lead ist gesperrt.' : 'Im Gespräch wurde kein Interesse geäußert.'; }
  else if (followUpResult) { main = 'FOLLOW_UP'; sReason = last!.result === 'CALL_BACK' ? 'Rückruf vereinbart – dort anknüpfen.' : 'Nicht erreicht – erneut versuchen und anknüpfen.'; }
  else if (last?.result === 'NEEDS_ANALYSIS' || (topics.has('needs') && !topics.has('website') && !topics.has('partner'))) { main = 'NEEDS_ANALYSIS_FIRST'; sReason = 'Im Gespräch wurde Interesse an einer Bedarfsanalyse geäußert (eigenes Thema, getrennter Termin).'; }
  else if (last?.result === 'PARTNERSHIP' || (topics.has('partner') && !topics.has('website'))) { main = 'PARTNER_FIRST'; sReason = 'Im Gespräch wurde Interesse an einer Kooperation geäußert.'; }
  else if ((topics.has('website') && topics.has('partner')) || (wp === 'HIGH' && pp === 'HIGH')) { main = 'WEBSITE_AND_PARTNER'; sReason = 'Website- und Partnerpotenzial sind beide hoch – zwei getrennte Themen, Website führt das Gespräch.'; }
  else if (wp === 'HIGH' || wp === 'MEDIUM') { main = 'WEBSITE_FIRST'; sReason = `Website-Potenzial ${POTENTIAL_LABEL[wp]}: ${wReason}`; }
  else if (pp === 'HIGH') { main = 'PARTNER_FIRST'; sReason = 'Kaum Websitebedarf, aber hohes Partnerpotenzial.'; }
  else { main = 'GENERAL_DISCOVERY'; sReason = 'Keine klare Hauptchance in den Daten – erst kennenlernen.'; }
  const mkSecondary = (): Copilot['strategy']['secondary'] => {
    const out: Copilot['strategy']['secondary'] = [];
    const websiteMain = main === 'WEBSITE_FIRST' || main === 'WEBSITE_AND_PARTNER', partnerMain = main === 'PARTNER_FIRST' || main === 'WEBSITE_AND_PARTNER', needsMain = main === 'NEEDS_ANALYSIS_FIRST';
    if (main === 'NO_ACTION') return out;
    if (!websiteMain && (wp === 'HIGH' || wp === 'MEDIUM')) out.push({ topic: 'WEBSITE', text: 'Nur ansprechen, wenn das Gespräch es hergibt.' });
    if (!partnerMain && (pp === 'HIGH' || pp === 'MEDIUM')) out.push({ topic: 'PARTNERSCHAFT', text: 'Kooperationsfrage am Ende stellen, ohne Druck.' });
    if (!needsMain && np === 'HIGH') out.push({ topic: 'BEDARFSANALYSE', text: 'Nur auf Wunsch – eigener Termin, nicht im selben Atemzug.' });
    return out;
  };
  const hasEmailOnly = !i.hasPhone && i.hasEmail;
  let csCode: ContactStrategy; let csReason: string;
  if (blocked || last?.result === 'NO_INTEREST') { csCode = 'NO_CONTACT'; csReason = blocked ? 'Lead ist gesperrt (Do not contact).' : 'Kein Interesse laut Gespräch.'; }
  else if (dataNeeded || phoneGate || (!i.hasPhone && !i.hasEmail)) { csCode = 'MANUAL_RESEARCH'; csReason = dataNeeded ? 'Weder Telefonnummer noch E-Mail bekannt.' : phoneGate ? 'Telefonakquise ist noch nicht aktiviert.' : 'Kein Kontaktweg bekannt.'; }
  else if (last) { csCode = 'FOLLOW_UP'; csReason = 'Es gab bereits Kontakt – nachfassen.'; }
  else if (hasEmailOnly && wp === 'HIGH' && i.demoRecommended && !i.demo.exists) { csCode = 'DEMO_FIRST'; csReason = 'Nur E-Mail bekannt: erst Demo vorbereiten, dann zulässig Kontakt aufnehmen.'; }
  else if (hasEmailOnly || (hasSiteData && wp === 'MEDIUM' && ['C', 'D'].includes(i.priority ?? '') && i.hasEmail)) { csCode = 'EMAIL_DRAFT'; csReason = hasEmailOnly ? 'Nur E-Mail bekannt – Entwurf vorbereiten; Versand nur mit Einwilligung/Freigabe.' : 'Bestehende Website mit kleinen Verbesserungen, weniger dringend – E-Mail-Entwurf passt.'; }
  else if (i.hasPhone && wp === 'HIGH' && i.demoRecommended && !i.demo.exists) { csCode = 'CALL_AND_DEMO'; csReason = 'Demo vorbereiten (nach deiner Bestätigung), danach anrufen.'; }
  else { csCode = 'CALL'; csReason = i.demo.exists ? 'Demo liegt vor – anrufen und zeigen.' : 'Telefonnummer vorhanden.'; }
  const pStatus = i.partnerStatus ?? 'NONE';
  const partnerRelevant = pp === 'HIGH' || pp === 'MEDIUM' || ['PARTNER_CANDIDATE', 'PARTNER_DISCUSSION', 'PARTNER_APPROVED', 'ACTIVE_PARTNER'].includes(pStatus);
  const partnerTalk: Copilot['partnerTalk'] = partnerRelevant && !blocked ? { status: pStatus,
    intro: pStatus === 'ACTIVE_PARTNER' ? C.partnerTalk.introActive : C.partnerTalk.intro, questions: C.partnerTalk.questions as string[], note: C.partnerTalk.note } : null;

  const objections = (C.objections as any[]).map((o) => ({ key: o.key, objection: o.objection, answer: o.answer ?? (noSite ? o.answerNoSite : o.answerHasSite) }));

  return {
    version: C.version, summary30,
    introduction: (C.introduction as string).replace('{branchPhrase}', profile.branchPhrase ?? ''),
    opener,
    website: { potential: wp, label: POTENTIAL_LABEL[wp], reason: wReason, problems: problems.slice(0, 4).map((p) => ({ text: p.summary, evidence: p.evidence })), improvements, modules, demoSensible: demoSensible as { value: boolean | null; text: string } },
    needsAnalysis: { potential: np, label: NEEDS_LABEL[np], reason: nReason, questions: safeguards, note: 'Nur Fragen zur Vorbereitung – keine Diagnose, keine Produktempfehlung. Eigenständiges Thema, unabhängig von der Website.' },
    partnership: { potential: pp, label: POTENTIAL_LABEL[pp], reason: pReason, customerGroups: profile.customerGroups, referral: profile.referral, question: profile.partnerQuestion, note: 'Eigenständiges Thema – nicht an Website oder Absicherung gekoppelt.' },
    questions, arguments: args, demoPitch, objections, goal, flow,
    nextAction: { code: na, label: NEXT_ACTION_LABEL[na], reason: naReason }, uncertain: [...new Set(uncertain)], facts,
    strategy: { main, label: STRATEGY_LABEL[main], reason: sReason, secondary: mkSecondary() },
    contactStrategy: { code: csCode, label: CONTACT_STRATEGY_LABEL[csCode], reason: csReason }, partnerTalk,
  };
}

function argFrom(m: { claim: string; benefit: string }) { return { claim: m.claim, benefit: m.benefit, evidence: '', basis: 'Datenlage' as const }; }
