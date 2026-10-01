import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChecks, CHECK_USABLE_MIN, renderReport, type CheckReport, type LeadReport, type LeadSnap } from '../../src/enrich/check.ts';

/** Prüfliste und Entscheidungshilfe des Echttests (rein, ohne Datenbank). */
const snap = (o: Partial<LeadSnap> = {}): LeadSnap => ({ name: 'X', city: null, postalCode: null, address: null, hasCoordinates: true, stage: 'QUALIFIED', website: null, websiteState: 'none', websiteStatus: 'NO_WEBSITE', websiteScore: null, salesOpportunity: 57, opportunityScore: 57,
  priority: 'C', manualPriority: null, priorityReason: 'C – …', workStatus: 'DATA_NEEDED', contactability: 'NO_CONTACT_DATA', preferredChannel: null, phone: null, email: null, demoRecommendation: 'DEMO_NOT_RECOMMENDED', demoReason: null, demoApproval: 'NOT_REQUIRED', demoCount: 0,
  enrichmentStatus: null, candidate: null, candidateConfidence: null, candidateVerdict: null, facts: [], ...o });
const cand = (host: string, v: 'VERIFIED' | 'LIKELY' | 'UNCERTAIN' | 'REJECTED', why: string[], warnings: string[] = []) => ({ url: `https://${host}/`, host, verification: v, confidence: v === 'VERIFIED' ? 90 : v === 'LIKELY' ? 65 : v === 'UNCERTAIN' ? 45 : 5, why, warnings, pages: 2 });
const lead = (name: string, o: Partial<LeadReport> & { site?: string; verification?: string; facts?: LeadReport['newFacts']; cands?: ReturnType<typeof cand>[]; requests?: number; hits?: { rank: number; url: string; title: string; note?: string }[] } = {}): LeadReport => {
  const site = o.site; const facts = o.facts ?? [];
  return { leadId: name, name, picked: 'ausdrücklich ausgewählt', before: snap({ name }), after: snap({ name, website: site ? `https://${site}/` : null, candidateVerdict: (!site && o.cands?.[0]?.verification) || null, workStatus: facts.some((f) => ['phone', 'email'].includes(f.key)) ? 'CONTACTABLE' : 'DATA_NEEDED' }),
    newFacts: [...(site ? [{ key: 'website', value: `https://${site}/`, source: 'web-search', sourceUrl: `https://${site}/`, quality: 'medium' }] : []), ...facts],
    outcome: { status: site ? 'website_found' : 'not_found', label: '', note: '', requests: o.requests ?? 1, providerCost: { amount: (o.requests ?? 1) * 0.005, currency: 'USD' }, costEurCents: 0.46, verification: o.verification, found: [] },
    trace: { queries: [{ query: 'q', requests: o.requests ?? 1, cost: { amount: 0.005, currency: 'USD' }, hits: o.hits ?? [] }], candidates: o.cands ?? [], social: [] } };
};
const crawl = (key: string, host: string) => ({ key, value: key === 'contactForm' ? 'true' : '0683146306', source: 'website-crawl', sourceUrl: `https://${host}/kontakt`, quality: 'medium' });
const safe = (o: Partial<CheckReport['safety']['after']> = {}): CheckReport['safety'] => { const b = { demos: 10, outbox: 0, contacts: 3, approvalsOther: 0, approvalsAdvanced: 0, stages: { A: 'QUALIFIED' }, emailStates: { A: 'draft' } }; return { ok: true, before: b, after: { ...b, ...o }, violations: [] }; };
const run = (leads: LeadReport[], o: { requests?: number; attempts?: number; cap?: number; log?: { requests: number; amount: number; currencies: string[] }; safety?: CheckReport['safety'] } = {}) => {
  const requests = o.requests ?? leads.reduce((n, l) => n + (l.outcome?.requests ?? 0), 0);
  return buildChecks({ leads, requests, attempts: o.attempts ?? requests, cap: o.cap ?? 15, usdPerRequest: 0.005, log: o.log ?? { requests, amount: Math.round(requests * 0.005 * 1e6) / 1e6, currencies: ['USD'] }, safety: o.safety ?? safe() });
};
const byId = (r: ReturnType<typeof run>, id: string) => r.checks.find((c) => c.id === id)!;

test('Prüfliste: sauberer Lauf – alle sechs Punkte ✔, Entscheidungshilfe zählt brauchbare Leads (verifizierte Website + neuer Kontaktweg direkt von dort)', () => {
  const good = (n: string, host: string, v: 'VERIFIED' | 'LIKELY') => lead(n, { site: host, verification: v, facts: [crawl('phone', host), crawl('email', host)], cands: [cand(host, v, ['Firmenname steht auf der Seite', 'Ort stimmt', 'PLZ stimmt', 'Adresse der Website liegt am OSM-Standort (0 km)'])], hits: [{ rank: 1, url: 'https://www.gelbeseiten.de/x', title: 'Verz', note: 'Verzeichnis/Portal (keine eigene Website)' }] });
  const leads = [good('A', 'a-salon.example', 'VERIFIED'), good('B', 'b-salon.example', 'LIKELY'), good('C', 'c-salon.example', 'VERIFIED'),
    lead('D', { requests: 3, cands: [cand('d-salon.example', 'REJECTED', ['Firmenname in der Domain'], ['Adresse der Website liegt in anderer Stadt (Gengenbach)', 'Adresse der Website liegt 141.1 km vom OSM-Standort entfernt'])] }), lead('E', { requests: 3 })];
  const r = run(leads); assert.ok(r.checks.every((c) => c.ok), JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.match(byId(r, 'namesake').details.join('\n'), /✔ D: Namensvetter abgewiesen – d-salon\.example \(Adresse der Website liegt in anderer Stadt \(Gengenbach\)/); assert.match(byId(r, 'directory').details.join('\n'), /3 Verzeichnis-\/Portal-Treffer .*gelbeseiten\.de.* nur gezählt/);
  assert.match(byId(r, 'cost').summary, /^ja – 9 × 0,005 USD = 0,045 USD; Protokoll: 9 Anfragen, 0,045 USD, Währung USD/); assert.match(byId(r, 'limit').summary, /9 Anfragen verbraucht, 9 Versuche, Obergrenze 15/);
  assert.deepEqual([r.decision.verified, r.decision.likely, r.decision.rejected, r.decision.notFound, r.decision.usable.length], [2, 1, 1, 1, 3]); assert.equal(r.decision.threshold, CHECK_USABLE_MIN); assert.equal(r.decision.met, true); assert.ok(Math.abs(r.decision.avgRequests! - 9 / 5) < 1e-9);
});

test('Prüfliste: Abweichungen werden erkannt – Zuordnung ohne Ortsbeleg, Daten aus Verzeichnis/Suchtreffer/fremder Domain, Demo, Versand, Obergrenze, Kosten/Währung', () => {
  // Website nur über den Namen zugeordnet (kein Orts-/Standortbeleg) → Namensvetter-Risiko
  const nameOnly = lead('A', { site: 'a.example', verification: 'LIKELY', facts: [crawl('phone', 'a.example')], cands: [cand('a.example', 'LIKELY', ['Firmenname steht auf der Seite', 'Firmenname im Seitentitel/in der Überschrift'])] });
  assert.equal(byId(run([nameOnly]), 'namesake').ok, false); assert.match(byId(run([nameOnly]), 'namesake').details[0], /✘ A: a\.example ohne ausreichenden Orts-\/Standortbeleg/);
  const farAccepted = lead('A', { site: 'a.example', verification: 'LIKELY', facts: [crawl('phone', 'a.example')], cands: [cand('a.example', 'LIKELY', ['Ort stimmt'], ['Adresse der Website liegt in anderer Stadt (Köln)'])] });
  assert.equal(byId(run([farAccepted]), 'namesake').ok, false);
  // Telefon aus der Websuche / aus einem Verzeichnis / von einer fremden Domain
  const ev = (f: LeadReport['newFacts'][number]) => lead('A', { site: 'a.example', verification: 'VERIFIED', facts: [f], cands: [cand('a.example', 'VERIFIED', ['Ort stimmt'])] });
  assert.equal(byId(run([ev({ key: 'phone', value: '0681', source: 'web-search', sourceUrl: 'https://www.dasoertliche.de/x', quality: 'medium' })]), 'directory').ok, false);
  assert.match(byId(run([ev({ key: 'email', value: 'a@b.example', source: 'website-crawl', sourceUrl: 'https://andere.example/kontakt', quality: 'medium' })]), 'directory').details.join('\n'), /✘ A: email stammt von andere\.example, nicht von der übernommenen Website/);
  const dirSite = lead('A', { site: 'www.gelbeseiten.de', verification: 'LIKELY', cands: [cand('gelbeseiten.de', 'LIKELY', ['Ort stimmt'])] }); assert.match(byId(run([dirSite]), 'directory').details.join('\n'), /zeigt auf Verzeichnis\/Portal gelbeseiten\.de/);
  const social = lead('A', { facts: [{ key: 'social', value: '{"platform":"instagram"}', source: 'web-search', sourceUrl: 'https://instagram.com/x', quality: 'medium' }] }); assert.equal(byId(run([social]), 'directory').ok, false);
  const lowSocial = lead('A', { facts: [{ key: 'social', value: '{"platform":"instagram"}', source: 'web-search', sourceUrl: 'https://instagram.com/x', quality: 'low' }] }); assert.equal(byId(run([lowSocial]), 'directory').ok, true, 'ungeprüfte Social-Profile (low) sind erlaubt');
  // Demo / Versand
  const ok = lead('A');
  assert.equal(byId(run([ok], { safety: safe({ demos: 11 }) }), 'demo').ok, false); assert.equal(byId(run([ok], { safety: safe({ approvalsAdvanced: 1 }) }), 'demo').ok, false);
  assert.equal(byId(run([ok], { safety: safe({ outbox: 1 }) }), 'sent').ok, false); assert.equal(byId(run([ok], { safety: safe({ contacts: 4 }) }), 'sent').ok, false); assert.equal(byId(run([ok], { safety: safe({ approvalsOther: 1 }) }), 'sent').ok, false);
  assert.equal(byId(run([ok], { safety: { ...safe(), violations: ['E-Mail-Status von „A“ geändert (draft → sent)'] } }), 'sent').ok, false);
  // Obergrenze / Kosten
  assert.equal(byId(run([lead('A', { requests: 16 })], { cap: 15 }), 'limit').ok, false); assert.equal(byId(run([lead('A', { requests: 3 })], { attempts: 16, cap: 15 }), 'limit').ok, false);
  assert.equal(byId(run([lead('A', { requests: 3 })], { log: { requests: 3, amount: 0.014, currencies: ['USD'] } }), 'cost').ok, false, 'falscher Betrag');
  assert.equal(byId(run([lead('A', { requests: 3 })], { log: { requests: 3, amount: 0.015, currencies: ['EUR'] } }), 'cost').ok, false, 'falsche Währung'); assert.equal(byId(run([lead('A', { requests: 3 })], { log: { requests: 2, amount: 0.01, currencies: ['USD'] } }), 'cost').ok, false, 'Protokoll weicht ab');
  assert.equal(byId(run([lead('A', { requests: 3 })]), 'cost').ok, true);
});

test('Entscheidungshilfe und Bericht: weniger als 3 brauchbare Leads → „nicht erfüllt“ und Empfehlung für zusätzliche Quellen; Abweichung der Prüfliste → erst klären', () => {
  const useful = (n: string) => lead(n, { site: `${n.toLowerCase()}.example`, verification: 'VERIFIED', facts: [crawl('contactForm', `${n.toLowerCase()}.example`)], cands: [cand(`${n.toLowerCase()}.example`, 'VERIFIED', ['PLZ stimmt'])] });
  const noContact = lead('C', { site: 'c.example', verification: 'VERIFIED', cands: [cand('c.example', 'VERIFIED', ['PLZ stimmt'])] });   // Website gefunden, aber kein Kontaktweg → nicht brauchbar
  const base = (leads: LeadReport[], checks: ReturnType<typeof run>): CheckReport => ({ startedAt: '2026-10-01T10:00:00Z', runId: 'r', dryRun: false, provider: 'brave-search', pricing: '5 USD je 1.000 Anfragen = 0,005 USD je Anfrage', eurPerUsd: 0.92, capRequests: 15, attempts: 5, requests: 5, providerCost: { amount: 0.025, currency: 'USD' }, costEurCents: 2.3,
    budgetBefore: { monthlyLimitCents: 1000, dailyLimitCents: 200, monthSpentCents: 0, monthLeftCents: 1000, todaySpentCents: 0, todayLeftCents: 200, monthRequests: 0, todayRequests: 0, monthEnrichedLeads: 0, costPerEnrichedLeadCents: null }, budgetAfter: { monthlyLimitCents: 1000, dailyLimitCents: 200, monthSpentCents: 2.3, monthLeftCents: 997.7, todaySpentCents: 2.3, todayLeftCents: 197.7, monthRequests: 5, todayRequests: 5, monthEnrichedLeads: 5, costPerEnrichedLeadCents: 0.46 },
    leads, warnings: [], safety: safe(), checks: checks.checks, decision: checks.decision, extrapolation: { remaining: 42, avgRequestsPerLead: 1, expectedRequests: 42, expectedUsd: 0.21, expectedEurCents: 19.32, worstRequests: 126, worstUsd: 0.63, worstEurCents: 57.96, dailyRequestsFit: 429 } });
  const few = run([useful('A'), useful('B'), noContact, lead('D'), lead('E')]); assert.equal(few.decision.usable.length, 2); assert.equal(few.decision.met, false);
  const md = renderReport(base([useful('A')], few)); assert.match(md, /## Prüfliste \(automatisch\)/); assert.match(md, /\| 1 \| Wurde kein Namensvetter falsch zugeordnet\? \| ✔ ja/); assert.match(md, /Brauchbar\*\* .*: \*\*2 von 5\*\* \(A, B\) → Kriterium „mindestens 3“: \*\*nicht erfüllt\*\*/); assert.match(md, /zusätzliche Enrichment-Quellen einbauen/); assert.match(md, /Danach STOPP/);
  const good = run([useful('A'), useful('B'), useful('C')]); assert.equal(good.decision.met, true); assert.match(renderReport(base([useful('A')], good)), /Kriterium „mindestens 3“: \*\*erfüllt\*\*.*\n.*alle sechs Punkte in Ordnung|alle sechs Punkte in Ordnung/s); assert.match(renderReport(base([useful('A')], good)), /kontrollierte\*\* Anreicherung der übrigen Leads – aber erst nach ausdrücklicher Bestätigung/);
  const bad = run([useful('A'), useful('B'), useful('C')], { safety: safe({ demos: 12 }) }); assert.equal(bad.decision.met, true); assert.match(renderReport(base([useful('A')], bad)), /Erst die Abweichung der Prüfliste klären/); assert.match(renderReport(base([useful('A')], bad)), /\| 3 \| Wurde keine Demo erstellt\? \| ✘ NEIN/);
});
