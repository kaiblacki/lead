import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { leadsFromCsv } from '../src/connectors/csv.ts';
import { analyzeHtml, buildAudit } from '../src/auditor/analyze.ts';
import { scoreOpportunity, categorize, type ScoringConfig } from '../src/scoring/opportunity.ts';
import { buildSalesPackage, polishOpener, type Pricing } from '../src/ai/sales.ts';
import { AiGateway } from '../src/ai/provider.ts';
import { Budget, BudgetExceeded, KillSwitchActive, DEFAULT_LIMITS } from '../src/guardrails/budget.ts';
import { checkContact } from '../src/guardrails/contact-policy.ts';
import { transition } from '../src/core/status.ts';
import { runPipeline } from '../src/pipeline.ts';
import type { Lead } from '../src/core/types.ts';

const cfg: ScoringConfig = JSON.parse(readFileSync(new URL('../config/scoring.json', import.meta.url), 'utf8'));
const pricing: Pricing = JSON.parse(readFileSync(new URL('../config/pricing.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-06-01');
const lead = (o: Partial<Lead> = {}): Lead => ({ id: 'l1', companyName: 'Salon X', city: 'Saarbrücken', address: 'Str 1', source: 't', ...o });

const OLD_SITE = `<html><title>Salon</title><font>Willkommen</font><p>© 2015 Salon X</p></html>`;
const GOOD_SITE = `<!doctype html><html><head><title>Salon X</title><meta name="description" content="x"><meta name="viewport" content="width=device-width"></head><body>
<a class="btn" href="/termin">Termin buchen</a><a href="tel:+49681123456">0681 123456</a><form><input></form>
<p>Öffnungszeiten Mo-Fr 9-18. FAQ. Kundenstimmen und Bewertungen. ${'Leistungen und Preise für Haarschnitt Färben Styling. '.repeat(12)}</p>
<a href="https://instagram.com/x">IG</a> © 2026</body></html>`;

test('CSV: Semikolon, Aliase, Duplikate, fehlender Name', () => {
  const r = leadsFromCsv('Name;Stadt;Website\n"Müller; Friseur";Saar;a.de\n"Müller; Friseur";Saar;\n;X;\nB;Y;');
  assert.equal(r.leads.length, 2);
  assert.equal(r.leads[0].companyName, 'Müller; Friseur');
  assert.equal(r.skipped.length, 2);
  assert.throws(() => leadsFromCsv('Foo;Bar\n1;2'));
});

test('Auditor: alte Seite liefert belegte Befunde', () => {
  const f = analyzeHtml({ ok: true, finalUrl: 'http://x.de', html: OLD_SITE, loadMs: 7000 }, NOW);
  const codes = f.map((x) => x.code);
  for (const c of ['NO_HTTPS', 'SLOW_LOAD', 'NO_VIEWPORT', 'OLD_TECH', 'STALE_COPYRIGHT', 'NO_ONLINE_BOOKING', 'NO_PHONE']) assert.ok(codes.includes(c), c);
  assert.ok(f.every((x) => x.evidence.length > 0));
});

test('Auditor: gute Seite hat keine mittleren/hohen Befunde', () => {
  const f = analyzeHtml({ ok: true, finalUrl: 'https://x.de', html: GOOD_SITE, loadMs: 800 }, NOW);
  assert.deepEqual(f.filter((x) => x.severity !== 'low').map((x) => x.code), []);
});

test('Audit-Status: keine URL / nicht erreichbar / analysiert', () => {
  assert.equal(buildAudit(lead(), null, NOW).status, 'NO_WEBSITE');
  assert.equal(buildAudit(lead({ websiteUrl: 'x.de' }), { ok: false, error: 'timeout' }, NOW).status, 'UNREACHABLE');
  const a = buildAudit(lead({ websiteUrl: 'x.de' }), { ok: true, finalUrl: 'https://x.de', html: GOOD_SITE, loadMs: 500 }, NOW);
  assert.equal(a.status, 'ANALYZED');
  assert.ok(a.scores!.website > 80);
});

test('Score: ohne Website = HOT, erklärt, gedeckelt; unerreichbar = kein Score', () => {
  const l = lead({ socials: [{ platform: 'instagram', url: 'u', lastActivityAt: '2026-05-20' }] });
  const o = scoreOpportunity(l, buildAudit(l, null, NOW), cfg, NOW);
  assert.ok(o.scored && o.score === 100 && o.category === 'HOT');
  assert.ok(o.scored && o.why.includes('keine Website'));
  const u = scoreOpportunity(lead({ websiteUrl: 'x.de' }), buildAudit(lead({ websiteUrl: 'x.de' }), { ok: false }, NOW), cfg, NOW);
  assert.equal(u.scored, false);
});

test('Score: gute Seite niedrig, alte Seite hoch, Gewichte konfigurierbar', () => {
  const l = lead({ websiteUrl: 'x.de' });
  const good = scoreOpportunity(l, buildAudit(l, { ok: true, finalUrl: 'https://x.de', html: GOOD_SITE, loadMs: 500 }, NOW), cfg, NOW);
  const old = buildAudit(l, { ok: true, finalUrl: 'http://x.de', html: OLD_SITE, loadMs: 500 }, NOW);
  const bad = scoreOpportunity(l, old, cfg, NOW);
  assert.ok(good.scored && good.score <= 10, `good=${good.scored && good.score}`);
  assert.ok(bad.scored && bad.score === 65);
  const changed = scoreOpportunity(l, old, { ...cfg, weights: { ...cfg.weights, website_outdated: 0 } }, NOW);
  assert.ok(bad.scored && changed.scored && changed.score === bad.score - 20);
});

test('Kategorien an den Grenzen', () => {
  const t = cfg.thresholds;
  assert.deepEqual([100, 90, 89, 75, 74, 60, 59, 40, 39, 0].map((s) => categorize(s, t)),
    ['HOT', 'HOT', 'HIGH POTENTIAL', 'HIGH POTENTIAL', 'MEDIUM', 'MEDIUM', 'LOW', 'LOW', 'IGNORE', 'IGNORE']);
});

test('Verkaufspaket nur aus Befunden, immer mit menschlicher Freigabe', () => {
  const l = lead({ websiteUrl: 'x.de' });
  const a = buildAudit(l, { ok: true, finalUrl: 'http://x.de', html: OLD_SITE, loadMs: 500 }, NOW);
  const p = buildSalesPackage(l, a, scoreOpportunity(l, a, cfg, NOW), pricing)!;
  assert.ok(p.needsHumanApproval && p.offerName === 'Website Modernisierung' && p.priceCents === 129000);
  assert.ok(p.problems.every((x) => a.findings.some((f) => f.code === x.code)));
  const none = lead();
  assert.equal(buildSalesPackage(none, buildAudit(none, null, NOW), { scored: false, reason: '' }, pricing), null);
});

test('KI-Einstieg: erfundene Codes werden verworfen, Budget greift', async () => {
  const l = lead({ websiteUrl: 'x.de' });
  const a = buildAudit(l, { ok: true, finalUrl: 'http://x.de', html: OLD_SITE, loadMs: 500 }, NOW);
  const pkg = buildSalesPackage(l, a, scoreOpportunity(l, a, cfg, NOW), pricing)!;
  const mk = (resp: string, budget = new Budget()) => new AiGateway({ model: 'fake', complete: async () => resp }, budget);
  const good = await polishOpener(pkg, mk(JSON.stringify({ opener: 'Hallo, Ihre Seite lädt ohne HTTPS.', used_codes: ['NO_HTTPS'] })));
  assert.equal(good.openerSource, 'ai');
  const fake = await polishOpener(pkg, mk(JSON.stringify({ opener: 'Hallo, Ihre Seite ist gehackt worden.', used_codes: ['HACKED'] })));
  assert.equal(fake.openerSource, 'template');
  const junk = await polishOpener(pkg, mk('kein json'));
  assert.equal(junk.opener, pkg.opener);
  const tight = new Budget({ ...DEFAULT_LIMITS, maxAiRequestsPerLead: 1 });
  const gw = mk('{}', tight);
  await gw.complete('l1', 'x');
  await assert.rejects(() => gw.complete('l1', 'x'), BudgetExceeded);
});

test('Budget: Limits und Kill Switch stoppen', () => {
  const b = new Budget({ ...DEFAULT_LIMITS, maxLeadsPerRun: 2, maxDailyCents: 3 });
  b.takeLead(); b.takeLead();
  assert.throws(() => b.takeLead(), BudgetExceeded);
  b.takeAi('a', 2);
  assert.throws(() => b.takeAi('b', 2), /DAILY/);
  b.killSwitch = true;
  assert.throws(() => b.takeAudit(), KillSwitchActive);
});

test('Kontakt-Policy: im Zweifel nicht senden', () => {
  const base = { channel: 'email' as const, leadId: 'l', recipient: 'a@b.de', sentTodayOnChannel: 0, suppressed: false };
  const ok = { autoSend: true, legalBasis: 'einwilligung', dailyLimit: 5, platformRulesAllowAutomation: true };
  assert.equal(checkContact({ ...base, channelConfig: ok }).allowed, true);
  for (const r of [
    { ...base }, { ...base, channelConfig: { ...ok, autoSend: false } }, { ...base, channelConfig: { ...ok, legalBasis: '' } },
    { ...base, channelConfig: { ...ok, platformRulesAllowAutomation: false } }, { ...base, channelConfig: ok, suppressed: true },
    { ...base, channelConfig: ok, leadBlocked: true }, { ...base, channelConfig: ok, sentTodayOnChannel: 5 },
  ]) {
    const d = checkContact(r);
    assert.ok(!d.allowed && d.action === 'Manuelle Kontaktaufnahme erforderlich.');
  }
});

test('Statusautomat: nur erlaubte Übergänge, Grund Pflicht', () => {
  assert.equal(transition('l', 'NEW', 'ANALYZING', 'Start').to, 'ANALYZING');
  assert.throws(() => transition('l', 'NEW', 'DEPLOYED', 'x'));
  assert.throws(() => transition('l', 'DEPOSIT_PENDING', 'PRODUCTION', 'ohne Zahlung'));
  assert.throws(() => transition('l', 'NEW', 'ANALYZING', ' '));
});

test('Pipeline stoppt sauber beim Lead-Limit und liefert Teilergebnis', async () => {
  const leads = [lead({ id: '1' }), lead({ id: '2' }), lead({ id: '3' })];
  const r = await runPipeline(leads, { fetchSite: async () => ({ ok: false }), scoring: cfg, pricing, budget: new Budget({ ...DEFAULT_LIMITS, maxLeadsPerRun: 2 }), now: NOW });
  assert.equal(r.reports.length, 2);
  assert.match(r.stoppedReason!, /MAX LEADS/);
});
