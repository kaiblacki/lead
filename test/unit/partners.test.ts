import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CRITERIA, PARTNER_STATUSES, checkTransition, matchPartners, missingForStatus, nextPartnerStatuses } from '../../src/partners/model.ts';
import { assertAllowedBenefitReason, assertNoInsuranceCoupling, insuranceCoupling } from '../../src/core/compliance.ts';
import { buildCopilot, type CopilotInput } from '../../src/sales/copilot.ts';
import { buildEmailDraft } from '../../src/sales/email-draft.ts';
import { loadConfig } from '../../src/core/config.ts';

const cfg = loadConfig();
const base = (o: Partial<CopilotInput> = {}): CopilotInput => ({
  company: 'Salon Muster', city: 'Saarbrücken', subKey: 'friseur', subLabel: 'Friseur', industryKey: 'beauty', industryLabel: 'Beauty & Körperpflege', bookingIndustry: true,
  websiteState: 'none', websiteUrl: null, websiteScore: null, auditStatus: 'NO_WEBSITE', checks: [], officialVerified: null, enrichmentStatus: null,
  salesOpportunity: 74, priority: 'A', workStatus: 'CONTACTABLE', contactReadiness: 'READY_FOR_MANUAL_CALL', contactReason: null, contactBlocked: false,
  hasPhone: true, hasEmail: false, hasWhatsapp: false, hasContactForm: false, hasSocial: false, phoneSource: 'OpenStreetMap', reviewCount: null, rating: null, employeeBucket: null,
  isChain: false, closed: false, address: 'Hauptstr. 1', source: 'OpenStreetMap', demo: { exists: false, modules: [], familyLabel: null }, demoRecommended: true,
  recommendedModules: [{ key: 'booking', label: 'Online-Terminbuchung' }, { key: 'gallery', label: 'Galerie' }], manualChecks: [], interestTopics: [], callCount: 0, lastCall: null, note: null, callerName: 'Kai Schwarz', ...o,
});
const allText = (c: unknown) => JSON.stringify(c).replace(/[{}\[\]"]/g, ' ');

test('Partnerstatus: sieben Stadien, erlaubte Wege, Voraussetzungen – ausschließlich Kooperationskriterien (nichts mit Versicherung)', () => {
  assert.deepEqual([...PARTNER_STATUSES], ['NONE', 'PARTNER_CANDIDATE', 'PARTNER_DISCUSSION', 'PARTNER_APPROVED', 'ACTIVE_PARTNER', 'PAUSED_PARTNER', 'ENDED_PARTNER']);
  assert.equal(checkTransition('NONE', 'ACTIVE_PARTNER', {}).ok, false); assert.equal(checkTransition('PARTNER_CANDIDATE', 'PARTNER_DISCUSSION', {}).ok, true);
  assert.equal(checkTransition('PARTNER_DISCUSSION', 'PARTNER_APPROVED', { conversation_held: true }).ok, false);
  assert.equal(checkTransition('PARTNER_DISCUSSION', 'PARTNER_APPROVED', { conversation_held: true, referral_willingness: true }).ok, true);
  assert.deepEqual(missingForStatus('ACTIVE_PARTNER', {}), ['agreement', 'contact_person_known']);
  assert.deepEqual(missingForStatus('ACTIVE_PARTNER', { agreement: true }, { contactPerson: 'Frau Muster' }), [], 'Ansprechpartner im Profil zählt');
  assert.equal(checkTransition('PARTNER_APPROVED', 'ACTIVE_PARTNER', { agreement: true, contact_person_known: true }).ok, true);
  assert.deepEqual(nextPartnerStatuses('ACTIVE_PARTNER'), ['PAUSED_PARTNER', 'ENDED_PARTNER']); assert.ok(nextPartnerStatuses('ENDED_PARTNER').includes('PARTNER_CANDIDATE'));
  for (const w of [...CRITERIA, ...PARTNER_STATUSES]) assert.doesNotMatch(w, /versicher|police|praemie|prämie|insurance/i, `Kriterium/Status ohne Versicherungsbezug: ${w}`);
});

test('Compliance: Vorteile (Rabatt, Partnerstatus, Community) dürfen nie an Versicherungsabschlüsse gekoppelt sein', () => {
  for (const bad of ['Wenn Sie eine Versicherung abschließen, erhalten Sie 50 % Website-Rabatt.', 'Als Versicherungsnehmer bekommen Sie den Partnerpreis.', 'Community kostenlos bei Vertragsabschluss mit der Versicherung.', 'Vollkunde im Versicherungsbereich? Dann günstiger.'])
    assert.ok(insuranceCoupling(bad), bad);
  for (const ok of ['Partner-Rabatt: 50 % auf den Basispreis, Grund ACTIVE_PARTNER.', 'Die Bedarfsanalyse ist ein eigenständiges, optionales Angebot.', 'Ich bin zusätzlich im Versicherungsbereich tätig. Der Rabatt gilt für aktive Partner.', 'Community-Mitgliedschaft kostenlos für aktive Partner.']) assert.equal(insuranceCoupling(ok), null, ok);
  assert.throws(() => assertNoInsuranceCoupling('Bei Versicherungsabschluss gibt es einen Rabatt.'), /Kopplung/);
  assert.doesNotThrow(() => assertAllowedBenefitReason('ACTIVE_PARTNER')); assert.throws(() => assertAllowedBenefitReason('INSURANCE_CUSTOMER'), /Versicherung/); assert.throws(() => assertAllowedBenefitReason('Versicherungsvertrag'), /Versicherung/);
});

test('„Passender Partner“: nur aktive Partner mit passender Lead-Branche und Region; gesperrte Leads nie', () => {
  const lead = { id: 'l', sub_industry: 'friseur', industry: 'beauty', city: 'Saarbrücken' };
  const p = (o: object) => ({ id: 'p', company_name: 'Elektro Meier', status: 'ACTIVE_PARTNER', lead_industries: ['friseur'], region: 'Saarbrücken', ...o });
  assert.equal(matchPartners(lead, [p({})]).length, 1); assert.equal(matchPartners(lead, [p({ status: 'PARTNER_APPROVED' })]).length, 0, 'nur ACTIVE_PARTNER');
  assert.equal(matchPartners(lead, [p({ lead_industries: ['restaurant'] })]).length, 0); assert.equal(matchPartners(lead, [p({ lead_industries: [] })]).length, 0, 'ohne bevorzugte Branchen kein Vorschlag');
  assert.equal(matchPartners(lead, [p({ region: 'Trier' })]).length, 0); assert.equal(matchPartners(lead, [p({ region: null })]).length, 1);
  assert.equal(matchPartners({ ...lead, contact_blocked: true }, [p({})]).length, 0);
});

test('Gesprächsstrategie: immer genau eine Hauptstrategie, Nebenthemen getrennt; Partnergespräch nur bei Partnerrelevanz', () => {
  const m = (o: Partial<CopilotInput>) => buildCopilot(base(o), cfg);
  assert.equal(m({}).strategy.main, 'WEBSITE_FIRST'); assert.equal(m({ contactBlocked: true }).strategy.main, 'NO_ACTION');
  assert.equal(m({ lastCall: { result: 'CALL_BACK' } }).strategy.main, 'FOLLOW_UP'); assert.equal(m({ lastCall: { result: 'NEEDS_ANALYSIS' }, interestTopics: ['needs'] }).strategy.main, 'NEEDS_ANALYSIS_FIRST');
  assert.equal(m({ lastCall: { result: 'PARTNERSHIP' }, interestTopics: ['partner'] }).strategy.main, 'PARTNER_FIRST');
  assert.equal(m({ reviewCount: 120, rating: 4.7 }).strategy.main, 'WEBSITE_AND_PARTNER');
  const fine = m({ websiteState: 'fine', websiteUrl: 'https://x.example', websiteScore: 92, auditStatus: 'OK', isChain: true, demoRecommended: false }); assert.equal(fine.strategy.main, 'GENERAL_DISCOVERY');
  const first = m({}); assert.ok(!first.strategy.secondary.some((s) => s.topic === 'WEBSITE'), 'Hauptthema ist kein Nebenthema'); assert.ok(first.strategy.secondary.some((s) => s.topic === 'PARTNERSCHAFT'));
  assert.ok(m({ interestTopics: ['needs'], lastCall: { result: 'MULTIPLE' } }).strategy.main !== undefined);
  const talk = m({}).partnerTalk!; assert.ok(talk); assert.equal(talk.questions.length, 7); assert.match(talk.intro, /langfristige Zusammenarbeit/); assert.match(talk.intro, /gegenseitig passende Kontakte weiterempfehlen/); assert.match(talk.note, /Nicht sofort alles verkaufen/);
  assert.equal(m({ isChain: true, websiteState: 'fine', websiteUrl: 'x', websiteScore: 90, auditStatus: 'OK' }).partnerTalk, null, 'Kette → kein Partnergespräch');
  assert.match(m({ partnerStatus: 'ACTIVE_PARTNER' }).partnerTalk!.intro, /bereits als Partner/);
  for (const c of [m({}), m({ reviewCount: 120, rating: 4.7 }), m({ partnerStatus: 'ACTIVE_PARTNER' })]) assert.equal(insuranceCoupling(allText(c)), null, 'keine Versicherungs-Kopplung in keinem erzeugten Text');
});

test('Kontaktstrategie-Empfehlung: CALL, CALL_AND_DEMO, EMAIL_DRAFT, DEMO_FIRST, FOLLOW_UP, MANUAL_RESEARCH, NO_CONTACT', () => {
  const cs = (o: Partial<CopilotInput>) => buildCopilot(base(o), cfg).contactStrategy.code;
  assert.equal(cs({ demoRecommended: false }), 'CALL'); assert.equal(cs({}), 'CALL_AND_DEMO'); assert.equal(cs({ demo: { exists: true, modules: [], familyLabel: null } }), 'CALL');
  assert.equal(cs({ hasPhone: false, hasEmail: true, demoRecommended: false }), 'EMAIL_DRAFT'); assert.equal(cs({ hasPhone: false, hasEmail: true }), 'DEMO_FIRST');
  assert.equal(cs({ lastCall: { result: 'NO_ANSWER' } }), 'FOLLOW_UP'); assert.equal(cs({ workStatus: 'DATA_NEEDED', hasPhone: false }), 'MANUAL_RESEARCH');
  assert.equal(cs({ contactReason: 'Telefonakquise ist in den Einstellungen noch nicht freigegeben.' }), 'MANUAL_RESEARCH'); assert.equal(cs({ contactBlocked: true }), 'NO_CONTACT'); assert.equal(cs({ lastCall: { result: 'NO_INTEREST' } }), 'NO_CONTACT');
  assert.equal(cs({ websiteState: 'needs_improvement', websiteUrl: 'https://x.example', websiteScore: 60, auditStatus: 'OK', priority: 'C', hasEmail: true, demoRecommended: false, checks: [{ code: 'CONTACT_FORM', status: 'fail', severity: 'medium', summary: 'Kein Kontaktformular', evidence: 'nur Telefon' }] }), 'EMAIL_DRAFT', 'bestehende Website, weniger dringend, E-Mail bekannt');
});

test('E-Mail-Entwurf: persönlich, belegt, höchstens zwei Punkte, kurze Vorstellung, klare nächste Aktion – nichts wird gesendet', () => {
  const weak = buildCopilot(base({ websiteState: 'needs_improvement', websiteUrl: 'https://x.example', websiteScore: 38, auditStatus: 'OK', demoRecommended: false, hasEmail: true, checks: [
    { code: 'CONTACT_FORM', status: 'fail', severity: 'high', summary: 'Kein Kontaktformular gefunden', evidence: 'Nur eine Telefonnummer als Kontaktweg sichtbar' }, { code: 'MOBILE_NAV', status: 'fail', severity: 'medium', summary: 'Navigation auf dem Smartphone schwer bedienbar', evidence: 'Kein Menü-Button' }, { code: 'HTTPS', status: 'fail', severity: 'medium', summary: 'Keine sichere Verbindung', evidence: 'http statt https' }] }), cfg);
  const d = buildEmailDraft(weak, { company: 'Salon Muster', city: 'Saarbrücken', subLabel: 'Friseur', contactPerson: 'Anna Beispiel', callerName: 'Kai Schwarz' });
  assert.match(d.body, /^Guten Tag Anna Beispiel,/); assert.equal((d.body.match(/^•/gm) ?? []).length, 2, 'höchstens zwei Punkte'); assert.match(d.body, /Beobachtung: /); assert.match(d.body, /Kai Schwarz$/);
  assert.match(d.body, /Digitalisierung und bei modernen Online-Auftritten/); assert.match(d.body, /Antworten Sie einfach auf diese E-Mail/); assert.match(d.body, /keine weiteren Nachrichten/); assert.ok(d.notices.some((n) => /nichts gesendet/.test(n)));
  assert.doesNotMatch(d.body, /Versicherung|Partner/, 'Website-Mail vermischt keine anderen Themen'); assert.equal(insuranceCoupling(d.body), null);
  const noSite = buildEmailDraft(buildCopilot(base({ hasEmail: true }), cfg), { company: 'Salon Muster', callerName: 'Kai Schwarz', demoUrl: 'https://demo.example/d/abc' });
  assert.match(noSite.body, /^Guten Tag,/); assert.match(noSite.body, /keine eigene Website von Ihnen gefunden/); assert.equal((noSite.body.match(/^•/gm) ?? []).length, 0); assert.match(noSite.body, /https:\/\/demo\.example\/d\/abc/); assert.match(noSite.subject, /Online-Auftritt/);
});
