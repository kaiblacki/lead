import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/core/config.ts';
import { createProviders } from '../../src/providers/registry.ts';
import { getWorld } from '../../src/fixtures/world.ts';
import { analyzeCandidate, type CandidateResult } from '../../src/search/analyze-candidate.ts';
import { assessContact, suppressionKeys } from '../../src/contact/strategy.ts';
import { buildBrief, polishOpener } from '../../src/sales/brief.ts';
import { CriteriaError, criteriaFromForm, describeCriteria, normalizeCriteria, parseQuickSearch, postfilter, prefilter } from '../../src/search/criteria.ts';
import { MockAIProvider } from '../../src/providers/mock/ai.ts';
import type { PlaceCandidate } from '../../src/providers/types.ts';

const NOW = new Date('2026-06-01T10:00:00Z');
const cfg = loadConfig();
const P = createProviders({}, { baseUrl: 'http://x', now: () => NOW, hostingRoot: mkdtempSync(join(tmpdir(), 'h-')) }).providers;
const VK = { lat: 49.2514, lng: 6.8447 };
const tax = cfg.taxonomy;

async function result(variant: string, sub = 'nagelstudio'): Promise<CandidateResult> {
  const b = getWorld().find((x) => x.variant === variant && x.subKey === sub && x.inPlaces && x.phone && x.status === 'OPERATIONAL') ?? getWorld().find((x) => x.variant === variant && x.inPlaces && x.phone)!;
  const place = (await P.places.search({ center: b.point, radiusKm: 1, keywords: [b.name], limit: 50 })).items.find((i) => i.externalId === b.id) as PlaceCandidate;
  return analyzeCandidate(P, cfg, { place, center: VK, searchSub: b.subKey, now: NOW });
}
const contact = (r: CandidateResult, o: Partial<Parameters<typeof assessContact>[0]> = {}) => assessContact({ facts: r.facts, audit: r.audit, phoneEnabled: true, ...o });
const brief = (r: CandidateResult, c = contact(r)) => buildBrief({ company: r.lead.companyName, facts: r.facts, audit: r.audit, analysis: r.analysis, contact: c, now: NOW, pricing: cfg.pricing, sales: cfg.sales, callerName: 'Kai' });

test('Kontaktstatus: Telefon freigegeben → READY_FOR_MANUAL_CALL, sonst MANUAL_REVIEW mit Grund', async () => {
  const r = await result('none');
  const ready = contact(r);
  assert.equal(ready.recommended, 'PHONE'); assert.equal(ready.readiness, 'READY_FOR_MANUAL_CALL');
  assert.match(ready.reasons[0], /Geschäftliche Rufnummer vorhanden/); assert.ok(ready.legal.some((l) => /UWG/.test(l)));
  const gated = contact(r, { phoneEnabled: false });
  assert.equal(gated.readiness, 'MANUAL_REVIEW'); assert.match(gated.reasons[0], /noch nicht freigegeben/);
});

test('Kontaktstatus: nur E-Mail → Einwilligung nötig, nur WhatsApp → Opt-in nötig, nichts → manuell prüfen', async () => {
  const r = await result('none');
  const noPhone = r.facts.filter((f) => f.key !== 'phone');
  const withMail = [...noPhone, { key: 'email' as const, value: 'info@x.example', source: 'mock-directory', capturedAt: NOW.toISOString(), quality: 'medium' as const }];
  const e = assessContact({ facts: withMail, phoneEnabled: true });
  assert.equal(e.readiness, 'EMAIL_PERMISSION_REQUIRED'); assert.equal(e.recommended, 'EMAIL'); assert.match(e.reasons[0], /Einwilligung/);
  const wa = assessContact({ facts: noPhone.filter((f) => f.key !== 'email'), phoneEnabled: true, audit: { checks: [{ code: 'WHATSAPP', category: 'conversion', status: 'pass', severity: 'low', summary: '', evidence: '' }] } as any });
  assert.equal(wa.readiness, 'WHATSAPP_OPT_IN_REQUIRED'); assert.equal(wa.recommended, 'WHATSAPP');
  const none = assessContact({ facts: noPhone.filter((f) => f.key !== 'email'), phoneEnabled: true });
  assert.equal(none.readiness, 'MANUAL_REVIEW'); assert.equal(none.recommended, 'MANUAL');
});

test('Kontaktstatus: Sperrliste, Sperrvermerk und geschlossene Betriebe → DO_NOT_CONTACT mit Grund; Schlüssel für den Abgleich', async () => {
  const r = await result('none');
  const hit = contact(r, { suppressionHits: [{ kind: 'phone', value: '068980123', reason: 'Wunsch des Inhabers' }] });
  assert.equal(hit.readiness, 'DO_NOT_CONTACT'); assert.equal(hit.recommended, 'DO_NOT_CONTACT'); assert.match(hit.reasons[0], /Sperrliste.*Wunsch des Inhabers/);
  assert.match(contact(r, { blocked: true }).reasons[0], /nicht kontaktieren/);
  const closed = contact({ ...r, facts: [...r.facts.filter((f) => f.key !== 'businessStatus'), { key: 'businessStatus', value: 'CLOSED_PERMANENTLY', source: 'x', capturedAt: NOW.toISOString(), quality: 'high' }] });
  assert.match(closed.reasons[0], /geschlossen/);
  const keys = suppressionKeys(r.facts, r.lead.companyName);
  assert.ok(keys.some((k) => k.kind === 'phone' && /^0\d{9,}$/.test(k.value)) && keys.some((k) => k.kind === 'company'));
});

test('Kontaktstatus: widersprüchliche Rufnummern erzeugen eine Warnung', async () => {
  const b = getWorld().find((x) => x.inPlaces && x.inDirectory && x.phone)!;
  const place = (await P.places.search({ center: b.point, radiusKm: 1, keywords: [b.name], limit: 50 })).items.find((i) => i.externalId === b.id)!;
  const facts = [{ key: 'phone' as const, value: place.phone!, source: 'a', capturedAt: NOW.toISOString(), quality: 'high' as const }, { key: 'phone' as const, value: '0681 099999', source: 'b', capturedAt: NOW.toISOString(), quality: 'medium' as const }];
  const a = assessContact({ facts, phoneEnabled: true });
  assert.equal(a.readiness, 'READY_FOR_MANUAL_CALL'); assert.ok(a.warnings.some((w) => /widersprechen/.test(w)));
});

test('Sales-Brief: Priorität, 3 belegte Gründe, Leistung, Schätzung als Schätzung, Einwände, nächste Aktion', async () => {
  const r = await result('none');
  const b = brief(r);
  assert.match(b.priority, /[AB]/); assert.match(b.priorityLabel, /heute anrufen|diese Woche/);
  assert.ok(b.reasons.length >= 2 && b.reasons.every((x) => x.code && x.text && x.evidence));
  assert.equal(b.reasons[0].code, 'NO_WEBSITE');
  assert.equal(b.service.name, 'Website Starter'); assert.equal(b.service.priceCents, 129000);
  assert.equal(b.valueRange.estimate, true); assert.match(b.valueRange.label, /Schätzung/);
  assert.equal(b.valueRange.lowCents, 129000); assert.ok(b.valueRange.highCents > b.valueRange.lowCents);
  assert.ok(b.valueRange.breakdown.some((l) => /Wartung/.test(l)));
  assert.ok(b.objections.length >= 3 && b.objections.some((o) => /1\.290,00/.test(o.response)));
  assert.ok(!b.objections.some((o) => /schon eine Website/.test(o.objection)));
  assert.equal(b.nextAction.code, 'READY_FOR_MANUAL_CALL'); assert.match(b.nextAction.text, /anrufen/);
  assert.match(b.opener, /Kai/); assert.match(b.opener, /keine eigene Website/); assert.equal(b.openerSource, 'rules'); assert.equal(b.needsHumanApproval, true);
});

test('Sales-Brief: bestehende Website → Modernisierung, Einwand „haben schon eine Website“, Gründe nur aus Befunden', async () => {
  const r = await result('outdated');
  const b = brief(r);
  assert.equal(b.service.name, 'Website Modernisierung');
  assert.ok(b.objections.some((o) => /schon eine Website/.test(o.objection)));
  const codes = new Set(r.audit.checks.map((c) => c.code).concat(['SOCIAL', 'ACTIVE_BUSINESS', 'LOW_NEED', 'NO_WEBSITE']));
  assert.ok(b.reasons.every((x) => codes.has(x.code) || /^(UPSELL|IMPLIED)_/.test(x.code)));
  assert.ok(b.reasons.some((x) => ['HTTPS', 'VIEWPORT', 'OLD_TECH', 'FRESHNESS', 'CONTACT_OPTION'].includes(x.code)));
});

test('Sales-Brief: Sperrliste → Priorität D; ohne Freigabe der Telefonakquise höchstens B', async () => {
  const r = await result('none');
  assert.equal(brief(r, contact(r, { suppressionHits: [{ kind: 'company', value: 'x' }] })).priority, 'D');
  assert.notEqual(brief(r, contact(r, { phoneEnabled: false })).priority, 'A');
});

test('KI-Gesprächseinstieg: nur belegte Fakten; erfundene Codes, Preise und Versprechen werden verworfen', async () => {
  const r = await result('outdated'); const base = brief(r);
  const calls: string[] = [];
  const gw = (text: string) => ({ complete: async (_k: string, req: any) => { calls.push(req.prompt); return { text }; } });
  const good = await polishOpener(base, { company: r.lead.companyName, callerName: 'Kai' }, gw(JSON.stringify({ opener: 'Guten Tag, ich habe mir Ihre Website angesehen und bei einigen Punkten Verbesserungen entdeckt. Darf ich Ihnen einen Entwurf zeigen?', used_codes: [base.reasons[0].code] })), 'k');
  assert.equal(good.openerSource, 'ai');
  assert.match(calls[0], /FACTS_JSON/); assert.ok(!/129000|1\.290/.test(calls[0]));                // keine Preise im Prompt
  for (const bad of [
    JSON.stringify({ opener: 'Guten Tag, wir garantieren Ihnen Platz 1 bei Google für Ihre Website.', used_codes: [base.reasons[0].code] }),
    JSON.stringify({ opener: 'Guten Tag, Ihre Seite wurde gehackt, das sollten wir beheben.', used_codes: ['HACKED'] }),
    JSON.stringify({ opener: 'Guten Tag, nur 999 € für Ihre neue Website, ein tolles Angebot für Sie.', used_codes: [base.reasons[0].code] }),
    JSON.stringify({ opener: 'Guten Tag, ich rufe wegen Ihrer Website an, das ist wichtig für Sie.', used_codes: [] }), 'kein json',
  ]) assert.equal((await polishOpener(base, { company: 'x' }, gw(bad), 'k')).openerSource, 'rules', bad);
  // Mock-KI liefert im selben Format
  const ai = new MockAIProvider();
  const viaMock = await polishOpener(base, { company: r.lead.companyName, callerName: 'Kai' }, { complete: async (_k, req) => ai.complete(req) }, 'k');
  assert.equal(viaMock.openerSource, 'ai'); assert.match(viaMock.opener, /Kai/);
});

test('Kriterien: Normalisierung, Standardwerte, alle Fehler auf einmal', () => {
  const c = normalizeCriteria({ location: ' Völklingen ', radiusKm: '30', subIndustries: ['nagelstudio'], website: ['none', 'needs_improvement'], maxLeads: '40' }, tax);
  assert.equal(c.location, 'Völklingen'); assert.equal(c.radiusKm, 30); assert.deepEqual(c.website, ['none', 'needs_improvement']);
  assert.equal(c.excludeExisting, true); assert.equal(c.sort, 'sales_opportunity'); assert.equal(c.minLeads, 0);
  assert.match(describeCriteria(c, tax), /Völklingen · 30 km · Nagelstudio · Website fehlt oder Website verbesserungswürdig · max\. 40 Leads/);
  try { normalizeCriteria({ location: '', radiusKm: '0', subIndustries: ['gibtsnicht'], maxLeads: '9999', minOpportunity: '140', website: ['x'], minRating: '4', maxRating: '3', readiness: ['Y'], sort: 'z' }, tax); assert.fail('sollte werfen'); }
  catch (e) { assert.ok(e instanceof CriteriaError); assert.ok((e as CriteriaError).errors.length >= 8, (e as CriteriaError).errors.join('|')); }
  assert.throws(() => normalizeCriteria({ location: 'X', radiusKm: '10' }, tax), /Branche, Unterbranche oder ein Stichwort/);
  assert.throws(() => normalizeCriteria({ location: 'X', radiusKm: '10', keywords: 'a,b,c,d,e,f' }, tax), /Stichwörter/);
  assert.throws(() => normalizeCriteria({ location: 'X', radiusKm: '10', industry: 'beauty', minLeads: '50', maxLeads: '10' }, tax), /Mindestzahl/);
  assert.throws(() => normalizeCriteria({ location: 'X', radiusKm: '10.5', industry: 'beauty' }, tax), /Radius/);
  assert.throws(() => normalizeCriteria({ location: 'x'.repeat(200), radiusKm: '10', industry: 'beauty' }, tax), /zu lang/);
});

test('Kriterien aus Formular: Checkbox-Standards und Mehrfachauswahl', () => {
  const f = new URLSearchParams('_form=1&location=Saarlouis&radiusKm=20&industry=beauty&sub=nagelstudio&sub=kosmetik&website=none&mobileProblems=1&emp=1-4&emp=5-9&maxLeads=25');
  const c = normalizeCriteria(criteriaFromForm(f), tax);
  assert.deepEqual(c.subIndustries, ['nagelstudio', 'kosmetik']); assert.equal(c.mobileProblems, true); assert.equal(c.excludeExisting, false);
  assert.deepEqual(c.employeeBuckets, ['1-4', '5-9']);
  const d = normalizeCriteria(criteriaFromForm(new URLSearchParams('location=Saarlouis&radiusKm=20&industry=beauty')), tax);
  assert.equal(d.excludeExisting, true);
});

test('Schnellsuche: das Beispiel „Völklingen + 30 km + Nagelstudios + Website fehlt oder verbesserungswürdig“', () => {
  const q = parseQuickSearch('Völklingen + 30 km + Nagelstudios + Website fehlt oder verbesserungswürdig', tax);
  assert.deepEqual(q.unmatched, []);
  assert.equal(q.criteria.location, 'Völklingen'); assert.equal(q.criteria.radiusKm, 30);
  assert.deepEqual(q.criteria.subIndustries, ['nagelstudio']); assert.equal(q.criteria.industry, 'beauty');
  assert.deepEqual(q.criteria.website, ['none', 'needs_improvement']);
  const c = normalizeCriteria(q.criteria, tax);
  assert.equal(c.radiusKm, 30);
  const more = parseQuickSearch('Saarbrücken + 15 km + Friseure + mobile Probleme + keine Terminbuchung + Instagram aktiv + Score ab 60 + 20 Leads + 1-4 Mitarbeiter + Blablubb 123', tax);
  assert.deepEqual([more.criteria.mobileProblems, more.criteria.noBooking, more.criteria.socialActive, more.criteria.minOpportunity, more.criteria.maxLeads], [true, true, 'yes', 60, 20]);
  assert.deepEqual(more.criteria.employeeBuckets, ['1-4']); assert.deepEqual(more.unmatched, ['Blablubb 123']);
});

test('Vorfilter: Radius, Größe, Bewertung, vorhanden, Kette, geschlossen, „nur ohne Website“ spart Audits', () => {
  const c = normalizeCriteria({ location: 'V', radiusKm: '30', industry: 'beauty', employeeBuckets: ['1-4'], includeUnknownSize: false, minReviews: '10', website: ['none'] }, tax);
  assert.equal(prefilter(c, { employeeBucket: '1-4', reviewCount: 20 }), null);
  assert.match(prefilter(c, { distanceKm: 31 })!, /Außerhalb/);
  assert.match(prefilter(c, { employeeBucket: '10-49', reviewCount: 20 })!, /nicht gewünscht/);
  assert.match(prefilter(c, { reviewCount: 20 })!, /unbekannt/);
  assert.match(prefilter(c, { employeeBucket: '1-4', reviewCount: 3 })!, /Nur 3 Bewertungen/);
  assert.match(prefilter(c, { employeeBucket: '1-4', reviewCount: 20, hasWebsite: true })!, /Hat eine Website/);
  assert.match(prefilter(c, { closed: true })!, /geschlossen/);
  assert.match(prefilter(c, { existing: true })!, /vorhanden/);
  const c2 = normalizeCriteria({ location: 'V', radiusKm: '30', industry: 'beauty', excludeChains: true, excludeExisting: false }, tax);
  assert.match(prefilter(c2, { isChain: true })!, /Kette/); assert.equal(prefilter(c2, { existing: true }), null);
});

async function post(variant: string, sub = 'nagelstudio') {
  const r = await result(variant, sub);
  return { r, view: (over: object = {}) => ({ analysis: r.analysis, audit: r.audit, profiles: r.lead.socials ?? [], socialComplete: !!r.social?.complete, readiness: contact(r).readiness, hasPhone: !!r.lead.phone, hasEmail: !!r.lead.email, bookingRelevant: true, now: NOW, cfg: cfg.scoring, ...over }) };
}
const crit = (o: object) => normalizeCriteria({ location: 'V', radiusKm: '30', industry: 'beauty', ...o }, tax);

test('Nachfilter: Website fehlt/verbesserungswürdig/in Ordnung/vorhanden', async () => {
  const none = await post('none'), old = await post('outdated'), good = await post('modern', 'friseur');
  const both = crit({ website: ['none', 'needs_improvement'] });
  assert.deepEqual(postfilter(both, none.view()), []); assert.deepEqual(postfilter(both, old.view()), []); assert.ok(postfilter(both, good.view()).length);
  assert.deepEqual(postfilter(crit({ website: ['exists'] }), old.view()), []); assert.ok(postfilter(crit({ website: ['exists'] }), none.view()).length);
  assert.deepEqual(postfilter(crit({ website: ['fine'] }), good.view()), []); assert.ok(postfilter(crit({ website: ['fine'] }), old.view()).length);
  const unreachable = await post('unreachable');
  assert.match(postfilter(crit({ website: ['needs_improvement'] }), unreachable.view()).join(), /nicht erreichbar/);
});

test('Nachfilter: mobile Probleme, keine Terminbuchung, Social, Score, Telefon/E-Mail, Kontaktstatus', async () => {
  const nm = await post('nomobile'), none = await post('none'), nob = await post('modern-nobooking'), good = await post('modern', 'friseur');
  assert.deepEqual(postfilter(crit({ mobileProblems: '1' }), nm.view()), []);
  assert.ok(postfilter(crit({ mobileProblems: '1' }), none.view()).length, 'ohne Website gibt es keine „mobilen Probleme“');
  assert.deepEqual(postfilter(crit({ noBooking: '1' }), nob.view()), []); assert.deepEqual(postfilter(crit({ noBooking: '1' }), none.view()), []);
  assert.ok(postfilter(crit({ noBooking: '1' }), good.view()).length);
  assert.match(postfilter(crit({ noBooking: '1' }), nob.view({ bookingRelevant: false })).join(), /nicht relevant/);
  const ps = (v: any, k: string, val: string) => postfilter(crit({ [k]: val }), v);
  const s = none.view({ profiles: [{ platform: 'instagram', lastPostAt: new Date(NOW.getTime() - 5 * 86400000).toISOString() }] });
  assert.deepEqual(ps(s, 'socialPresent', 'yes'), []); assert.deepEqual(ps(s, 'socialActive', 'yes'), []); assert.ok(ps(s, 'socialPresent', 'no').length);
  const dormant = none.view({ profiles: [{ platform: 'instagram', lastPostAt: new Date(NOW.getTime() - 200 * 86400000).toISOString() }] });
  assert.ok(ps(dormant, 'socialActive', 'yes').length); assert.deepEqual(ps(dormant, 'socialActive', 'no'), []);
  const nosocial = none.view({ profiles: [], socialComplete: true }); assert.deepEqual(ps(nosocial, 'socialPresent', 'no'), []);
  assert.match(ps(none.view({ profiles: [], socialComplete: false }), 'socialPresent', 'no').join(), /nicht zuverlässig/);
  assert.match(postfilter(crit({ minOpportunity: '99' }), none.view()).join(), /unter 99/); assert.deepEqual(postfilter(crit({ minOpportunity: '10' }), none.view()), []);
  assert.match(postfilter(crit({ minOpportunity: '10' }), (await post('unreachable')).view()).join(), /nicht bewertbar/);
  assert.match(postfilter(crit({ requirePhone: '1' }), none.view({ hasPhone: false })).join(), /Telefonnummer/);
  assert.match(postfilter(crit({ requireEmail: '1' }), none.view({ hasEmail: false })).join(), /E-Mail/);
  assert.match(postfilter(crit({ readiness: ['READY_FOR_MANUAL_CALL'] }), none.view({ readiness: 'DO_NOT_CONTACT' })).join(), /nicht gewünscht/);
});
