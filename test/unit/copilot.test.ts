import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCopilot, copilotViolation, NEXT_ACTIONS, type CopilotInput } from '../../src/sales/copilot.ts';
import { loadConfig } from '../../src/core/config.ts';

const cfg = loadConfig();
const base = (o: Partial<CopilotInput> = {}): CopilotInput => ({
  company: 'Salon Muster', city: 'Saarbrücken', subKey: 'friseur', subLabel: 'Friseur', industryKey: 'beauty', industryLabel: 'Beauty & Körperpflege', bookingIndustry: true,
  websiteState: 'none', websiteUrl: null, websiteScore: null, auditStatus: 'NO_WEBSITE', checks: [], officialVerified: null, enrichmentStatus: null,
  salesOpportunity: 74, priority: 'A', workStatus: 'CONTACTABLE', contactReadiness: 'READY_FOR_MANUAL_CALL', contactReason: null, contactBlocked: false,
  hasPhone: true, hasEmail: false, hasWhatsapp: false, hasContactForm: false, hasSocial: false, phoneSource: 'OpenStreetMap', reviewCount: null, rating: null, employeeBucket: null,
  isChain: false, closed: false, address: 'Hauptstr. 1, Saarbrücken', source: 'OpenStreetMap',
  demo: { exists: false, modules: [], familyLabel: null }, demoRecommended: true,
  recommendedModules: [{ key: 'booking', label: 'Online-Terminbuchung' }, { key: 'gallery', label: 'Galerie' }, { key: 'whatsapp', label: 'WhatsApp' }],
  manualChecks: [], interestTopics: [], callCount: 0, lastCall: null, note: null, callerName: 'Kai Schwarz', ...o,
});
const weakSite = (o: Partial<CopilotInput> = {}) => base({ websiteState: 'needs_improvement', websiteUrl: 'https://salon-muster.example', websiteScore: 38, auditStatus: 'OK', demoRecommended: false, checks: [
  { code: 'CONTACT_FORM', status: 'fail', severity: 'high', summary: 'Kein Kontaktformular gefunden', evidence: 'Nur eine Telefonnummer als Kontaktweg sichtbar' },
  { code: 'MOBILE_NAV', status: 'fail', severity: 'medium', summary: 'Navigation auf dem Smartphone schwer bedienbar', evidence: 'Kein Menü-Button im mobilen Layout' }], ...o });
const text = (c: unknown) => JSON.stringify(c);

test('Ohne Website: nur belegte Aussage („in den verfügbaren Quellen nicht gefunden“), Website-Potenzial HIGH, Einstieg persönlich', () => {
  const c = buildCopilot(base(), cfg);
  assert.equal(c.website.potential, 'HIGH');
  assert.match(c.summary30, /In den verfügbaren Quellen wurde keine eigene Website gefunden/); assert.doesNotMatch(text(c), /hat keine Website|besitzt keine Website/i);
  assert.match(c.opener.text, /Kai Schwarz/); assert.match(c.opener.text, /Salon Muster/); assert.match(c.opener.text, /keine eigene Website von Ihnen gefunden/); assert.equal(c.opener.variant, 'no_website');
  assert.match(c.summary30, /Verkaufschance 74\/100/); assert.match(c.summary30, /telefonisch erreichbar/);
});

test('Schlechte Website: Einstieg nicht beleidigend, Argumente mit Beleg und Nutzen aus dem Prüfbefund', () => {
  const c = buildCopilot(weakSite(), cfg);
  assert.equal(c.website.potential, 'HIGH'); assert.equal(c.opener.variant, 'website_improvable'); assert.doesNotMatch(c.opener.text, /schlecht|katastroph|veraltet|mies/i);
  assert.ok(c.arguments.length >= 2 && c.arguments.length <= 5);
  for (const a of c.arguments) { assert.ok(a.claim && a.evidence && a.benefit, 'Aussage, Beleg, Nutzen'); }
  const form = c.arguments.find((a) => /anfrage/i.test(a.claim))!; assert.match(form.evidence, /Telefonnummer als Kontaktweg/); assert.equal(form.basis, 'Prüfbefund');
});

test('Ordentliche Website: niedriges Website-Potenzial, anderer Einstieg, keine erfundenen Probleme', () => {
  const c = buildCopilot(base({ websiteState: 'fine', websiteUrl: 'https://x.example', websiteScore: 88, auditStatus: 'OK', checks: [], demoRecommended: false }), cfg);
  assert.equal(c.website.potential, 'LOW'); assert.equal(c.opener.variant, 'website_fine'); assert.equal(c.website.problems.length, 0);
  assert.deepEqual(c.arguments.filter((a) => a.basis === 'Prüfbefund'), []);
});

test('Drei getrennte Potenziale, keine Kopplung, keine Produktempfehlung', () => {
  for (const i of [base(), weakSite(), base({ interestTopics: ['needs'] }), base({ reviewCount: 120, rating: 4.7 })]) {
    const c = buildCopilot(i, cfg);
    for (const p of [c.website.potential, c.needsAnalysis.potential, c.partnership.potential]) assert.ok(['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'].includes(p));
    assert.equal(copilotViolation(text(c)), null, 'keine Produkte, Rabatte, Prämien');
    assert.doesNotMatch(text(c), /Website-Rabatt|Rabatt|Versicherung abschließen|brauchen (eine )?Versicherung/i);
    assert.match(c.needsAnalysis.note, /keine Diagnose/); assert.match(c.partnership.note, /nicht an Website oder Absicherung gekoppelt/);
  }
  assert.equal(buildCopilot(base(), cfg).needsAnalysis.potential, 'MEDIUM');                       // nur Branchenkontext: später, im Gespräch klären
  assert.equal(buildCopilot(base({ industryKey: null, subKey: null, subLabel: null, industryLabel: null }), cfg).needsAnalysis.potential, 'UNKNOWN');
  assert.equal(buildCopilot(base({ interestTopics: ['needs'] }), cfg).needsAnalysis.potential, 'HIGH');
  assert.equal(buildCopilot(base({ reviewCount: 80, rating: 4.6 }), cfg).partnership.potential, 'HIGH');
  assert.equal(buildCopilot(base({ isChain: true }), cfg).partnership.potential, 'LOW');
});

test('Keine erfundenen Fakten: ohne Daten keine Mitarbeiter-, Umsatz-, Kunden- oder Deckungsangaben; Unsicheres wird markiert', () => {
  const c = buildCopilot(base({ reviewCount: null, employeeBucket: null }), cfg); const t = text(c);
  assert.doesNotMatch(t, /\d+ Mitarbeit|Umsatz von|\d+ Kunden|ist (nicht )?(ausreichend )?versichert/i);
  assert.ok(c.facts.includes('Mitarbeiterzahl: nicht verfügbar')); assert.ok(c.uncertain.some((u) => /nicht bekannt und werden nicht geschätzt/.test(u)));
  const u = buildCopilot(base({ officialVerified: 'UNCERTAIN' }), cfg); assert.equal(u.website.potential, 'MEDIUM'); assert.match(u.opener.text, /nicht sicher/); assert.ok(u.uncertain.some((x) => /nicht sicher zugeordnet/.test(x)));
  assert.equal(buildCopilot(base({ websiteState: 'unknown', auditStatus: 'UNREACHABLE' }), cfg).website.potential, 'UNKNOWN');
});

test('Demo: ohne Demo keine Behauptung, es sei etwas vorbereitet; mit Demo drei Punkte aus der Demo', () => {
  const none = buildCopilot(base(), cfg);
  assert.equal(none.demoPitch.exists, false); assert.match(none.demoPitch.text, /kann ich Ihnen unverbindlich einen Entwurf vorbereiten/); assert.doesNotMatch(none.demoPitch.text, /habe Ihnen|bereits (etwas )?vorbereitet/); assert.deepEqual(none.demoPitch.points, []);
  const has = buildCopilot(base({ demo: { exists: true, familyLabel: 'Terminbasierte Betriebe', modules: [{ key: 'booking', label: 'Online-Terminbuchung', demoLabel: 'Terminanfrage' }, { key: 'gallery', label: 'Galerie', demoLabel: 'Bildergalerie' }, { key: 'whatsapp', label: 'WhatsApp' }] } }), cfg);
  assert.equal(has.demoPitch.exists, true); assert.match(has.demoPitch.text, /unverbindlichen Entwurf/); assert.equal(has.demoPitch.points.length, 3); assert.match(has.demoPitch.points.join(' '), /Online-Terminbuchung/);
  assert.equal(has.goal.code, 'DEMO_APPOINTMENT'); assert.equal(has.nextAction.code, 'CALL');
});

test('Gesprächsziel: ein Hauptziel je Situation', () => {
  const g = (o: Partial<CopilotInput>) => buildCopilot(base(o), cfg).goal.code;
  assert.equal(g({}), 'DEMO_PERMISSION'); assert.equal(g({ demoRecommended: false, websiteState: 'fine', websiteScore: 90, checks: [], auditStatus: 'OK', websiteUrl: 'https://x.example' }), 'CHECK_INTEREST');
  assert.equal(g({ lastCall: { result: 'CALL_BACK' } }), 'CALLBACK'); assert.equal(g({ lastCall: { result: 'NEEDS_ANALYSIS' }, interestTopics: ['needs'] }), 'NEEDS_ANALYSIS_APPOINTMENT');
  assert.equal(g({ lastCall: { result: 'PARTNERSHIP' }, interestTopics: ['partner'] }), 'PARTNERSHIP_CHECK'); assert.equal(g({ workStatus: 'DATA_NEEDED', hasPhone: false }), 'RESEARCH');
  assert.equal(g({ contactBlocked: true }), 'NONE'); assert.equal(g({ lastCall: { result: 'NO_INTEREST' } }), 'NONE');
  assert.equal(g({ websiteState: 'fine', websiteScore: 90, checks: [], auditStatus: 'OK', websiteUrl: 'https://x.example', demoRecommended: false, partnershipTest: 1 } as never, ), 'CHECK_INTEREST');
  assert.match(buildCopilot(base(), cfg).goal.note, /nicht gleichzeitig alle drei Themen/);
});

test('Nächste Aktion: gültige Werte, DATA_NEEDED → MANUAL_RESEARCH, Anruf-Ergebnisse steuern den nächsten Schritt', () => {
  const na = (o: Partial<CopilotInput>) => buildCopilot(base(o), cfg).nextAction.code;
  for (const o of [{}, { workStatus: 'DATA_NEEDED' as const }, { lastCall: { result: 'DEMO' }, interestTopics: ['website'] }]) assert.ok((NEXT_ACTIONS as readonly string[]).includes(na(o)));
  assert.equal(na({}), 'CALL'); assert.equal(na({ workStatus: 'DATA_NEEDED', hasPhone: false }), 'MANUAL_RESEARCH');
  assert.equal(na({ contactReason: 'Telefonakquise ist in den Einstellungen noch nicht freigegeben.' }), 'MANUAL_RESEARCH');
  assert.equal(na({ lastCall: { result: 'DEMO' }, interestTopics: ['website'] }), 'CREATE_DEMO');
  assert.equal(na({ lastCall: { result: 'DEMO' }, interestTopics: ['website'], demo: { exists: true, modules: [], familyLabel: null } }), 'SHOW_DEMO');
  assert.equal(na({ lastCall: { result: 'CALL_BACK', callbackAt: '01.12.2026, 10:00' } }), 'CALLBACK'); assert.equal(na({ lastCall: { result: 'NEEDS_ANALYSIS' }, interestTopics: ['needs'] }), 'NEEDS_ANALYSIS');
  assert.equal(na({ lastCall: { result: 'PARTNERSHIP' }, interestTopics: ['partner'] }), 'PARTNERSHIP_DISCUSSION'); assert.equal(na({ lastCall: { result: 'NO_ANSWER' } }), 'CALL');
  assert.equal(na({ lastCall: { result: 'NO_INTEREST' } }), 'NO_ACTION'); assert.equal(na({ contactBlocked: true }), 'NO_ACTION');
});

test('Fragen: 5–10, je Branche unterschiedlich; Einwände vollständig; Ablauf mit 7 Schritten', () => {
  const f = buildCopilot(base(), cfg), h = buildCopilot(base({ subKey: 'elektriker', subLabel: 'Elektriker', industryKey: 'handwerk', industryLabel: 'Handwerk' }), cfg), r = buildCopilot(base({ subKey: 'restaurant', subLabel: 'Restaurant', industryKey: 'gastro', industryLabel: 'Gastronomie' }), cfg);
  const n = (c: typeof f) => c.questions.company.length + c.questions.online.length + c.questions.safeguards.length + c.questions.cooperation.length;
  for (const c of [f, h, r]) assert.ok(n(c) >= 5 && n(c) <= 10, String(n(c)));
  assert.match(f.questions.online.join(' '), /Termine/); assert.match(h.questions.online.join(' '), /Angebotsanfragen/); assert.match(r.questions.online.join(' '), /Reservierungen/);
  assert.match(h.questions.safeguards.join(' '), /Fahrzeuge/); assert.doesNotMatch(f.questions.safeguards.join(' '), /Fahrzeuge/);
  assert.ok(f.questions.safeguards.some((q) => /Wie ist das Unternehmen aktuell abgesichert\?/.test(q)) && f.questions.safeguards.some((q) => /festen Ansprechpartner für Versicherungen/.test(q)));
  assert.match(f.partnership.question, /Arbeiten Sie bereits mit anderen lokalen Dienstleistern zusammen/);
  const keys = f.objections.map((o) => o.key); for (const k of ['no_interest', 'no_time', 'too_expensive', 'no_website_needed', 'already_someone', 'referrals', 'instagram', 'send_info', 'later']) assert.ok(keys.includes(k), k);
  assert.ok(f.objections.every((o) => o.answer.length > 20 && !/\d+\s?(€|Euro|%)/.test(o.answer)), 'keine Preise/Zahlen in Einwand-Antworten');
  assert.equal(f.flow.length, 7); assert.match(f.introduction, /Digitalisierung und modernen Online-Auftritten/); assert.match(f.introduction, /Versicherungsbereich/);
  assert.notEqual(f.introduction, h.introduction);
});

test('Gleiche Eingabe → gleiche Ausgabe (deterministisch, Grundlage für den Cache)', () => { assert.deepEqual(buildCopilot(base(), cfg), buildCopilot(base(), cfg)); });
