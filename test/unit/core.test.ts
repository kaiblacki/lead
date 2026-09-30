import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leadsFromCsv } from '../../src/connectors/csv.ts';
import { Budget, BudgetExceeded, KillSwitchActive, DEFAULT_LIMITS } from '../../src/guardrails/budget.ts';
import { AiGateway } from '../../src/ai/gateway.ts';
import { MockAIProvider } from '../../src/providers/mock/ai.ts';
import { checkContact } from '../../src/guardrails/contact-policy.ts';
import { transition, canTransition, findPath, nextStatuses, STATUSES, analysisPath } from '../../src/core/status.ts';
import { assertOrderTransition } from '../../src/orders/status.ts';
import { parseBerlinLocal, startOfBerlinDay, endOfBerlinDay } from '../../src/core/time.ts';
import { Repo } from '../../src/db/repo.ts';

test('CSV: Semikolon, Aliase, Duplikate, fehlender Name, Anführungszeichen', () => {
  const r = leadsFromCsv('Name;Stadt;Website\n"Müller; Friseur";Saar;a.de\n"Müller; Friseur";Saar;\n;X;\nB;Y;');
  assert.equal(r.leads.length, 2);
  assert.equal(r.leads[0].companyName, 'Müller; Friseur');
  assert.equal(r.skipped.length, 2);
  assert.throws(() => leadsFromCsv('Foo;Bar\n1;2'));
  assert.equal(leadsFromCsv('Name,Stadt\nA,B').leads[0].city, 'B');
  assert.equal(leadsFromCsv('Name;Stadt\nA;B').leads[0].id, leadsFromCsv('Name;Stadt\nA;B').leads[0].id);   // stabile IDs
});

test('Budget: alle Limits inkl. Places/Crawl und Kill Switch stoppen', () => {
  const b = new Budget({ ...DEFAULT_LIMITS, maxLeadsPerRun: 2, maxDailyCents: 3, maxPlacesRequestsPerRun: 2, maxCrawlPagesPerRun: 5 });
  b.takeLead(); b.takeLead(); assert.throws(() => b.takeLead(), BudgetExceeded);
  b.takePlaces(2); assert.throws(() => b.takePlaces(1), /PLACES/);
  b.takeCrawl(5); assert.throws(() => b.takeCrawl(1), /CRAWL/);
  b.takeAi('a', 2); assert.throws(() => b.takeAi('b', 2), /DAILY/);
  b.killSwitch = true; assert.throws(() => b.takeAudit(), KillSwitchActive); assert.throws(() => b.takePlaces(), KillSwitchActive);
});

test('KI-Gateway: zählt pro Lead, Mock-KI kostet nichts, Budget greift', async () => {
  const b = new Budget({ ...DEFAULT_LIMITS, maxAiRequestsPerLead: 2 });
  const gw = new AiGateway(new MockAIProvider(), b);
  await gw.complete('l', { task: 'generic', prompt: 'x' }); await gw.complete('l', { task: 'generic', prompt: 'x' });
  await assert.rejects(() => gw.complete('l', { task: 'generic', prompt: 'x' }), BudgetExceeded);
  assert.equal(b.dailyCents, 0); assert.equal(gw.log.length, 2);
});

test('Kontakt-Policy: im Zweifel nicht senden', () => {
  const base = { channel: 'email' as const, leadId: 'l', recipient: 'a@b.de', sentTodayOnChannel: 0, suppressed: false };
  const ok = { autoSend: true, legalBasis: 'einwilligung', dailyLimit: 5, platformRulesAllowAutomation: true };
  assert.equal(checkContact({ ...base, channelConfig: ok }).allowed, true);
  for (const r of [{ ...base }, { ...base, channelConfig: { ...ok, autoSend: false } }, { ...base, channelConfig: { ...ok, legalBasis: '' } }, { ...base, channelConfig: { ...ok, platformRulesAllowAutomation: false } },
    { ...base, channelConfig: ok, suppressed: true }, { ...base, channelConfig: ok, leadBlocked: true }, { ...base, channelConfig: ok, sentTodayOnChannel: 5 }]) {
    const d = checkContact(r); assert.ok(!d.allowed && d.action === 'Manuelle Kontaktaufnahme erforderlich.');
  }
});

test('Statusmaschine: alle 20 Stufen, nur erlaubte Übergänge, Grund Pflicht, Wege', () => {
  assert.equal(STATUSES.length, 20);
  for (const s of ['OFFER_ACCEPTED', 'QA']) assert.ok(STATUSES.includes(s as never));
  assert.equal(transition('l', 'NEW', 'ANALYZING', 'Start').to, 'ANALYZING');
  assert.throws(() => transition('l', 'NEW', 'DEPLOYED', 'x')); assert.throws(() => transition('l', 'DEPOSIT_PENDING', 'PRODUCTION', 'ohne Zahlung'));
  assert.throws(() => transition('l', 'NEW', 'ANALYZING', ' '));
  assert.throws(() => transition('l', 'PRODUCTION', 'CUSTOMER_REVIEW', 'QA überspringen'));
  assert.deepEqual(findPath('QUALIFIED', 'INTERESTED'), ['CONTACTED', 'INTERESTED']);          // nicht über „Demo erstellt“
  assert.deepEqual(findPath('QUALIFIED', 'IGNORED'), ['IGNORED']);
  assert.deepEqual(findPath('INTERESTED', 'OFFER_SENT'), ['OFFER_SENT']);
  assert.deepEqual(findPath('OFFER_SENT', 'DEPOSIT_PENDING'), ['OFFER_ACCEPTED', 'DEPOSIT_PENDING']);
  assert.deepEqual(findPath('DEPOSIT_PENDING', 'MAINTENANCE').length, 8);
  assert.deepEqual(findPath('MAINTENANCE', 'NEW'), []);
  assert.deepEqual(analysisPath('IGNORED', 'QUALIFIED'), ['ANALYZING', 'QUALIFIED']); assert.deepEqual(analysisPath('CONTACTED', 'QUALIFIED'), []);
  assert.ok(canTransition('QUALIFIED', 'CONTACTED') && !canTransition('QUALIFIED', 'QA')); assert.deepEqual(nextStatuses('MAINTENANCE'), []);
});

test('Bestellstatus: Zahlungslogik nicht umgehbar, QA sichtbar', () => {
  assertOrderTransition('PAYMENT_PENDING', 'DEPOSIT_PAID'); assertOrderTransition('IN_PRODUCTION', 'QA'); assertOrderTransition('QA', 'CUSTOMER_REVIEW'); assertOrderTransition('QA', 'IN_PRODUCTION');
  for (const [a, b] of [['PAYMENT_PENDING', 'IN_PRODUCTION'], ['IN_PRODUCTION', 'CUSTOMER_REVIEW'], ['APPROVED', 'FULLY_PAID'], ['FINAL_PAYMENT_PENDING', 'DEPLOYED'], ['IN_PRODUCTION', 'APPROVED']] as const) assert.throws(() => assertOrderTransition(a, b), a + b);
});

test('Zeit: Berliner Ortszeit (Sommer/Winter), Tagesgrenzen', () => {
  assert.equal(parseBerlinLocal('2026-06-01T14:30')!.toISOString(), '2026-06-01T12:30:00.000Z');
  assert.equal(parseBerlinLocal('2026-01-15T09:00')!.toISOString(), '2026-01-15T08:00:00.000Z');
  assert.equal(parseBerlinLocal('kaputt'), null); assert.equal(parseBerlinLocal('2026-13-45T09:00'), null); assert.equal(parseBerlinLocal('2026-03-29T02:30'), null);   // Stunde existiert bei der Zeitumstellung nicht
  assert.equal(startOfBerlinDay(new Date('2026-06-01T22:30:00Z')).toISOString(), '2026-06-01T22:00:00.000Z');   // 00:30 Uhr am 02.06. Berlin
  assert.equal(startOfBerlinDay(new Date('2026-06-01T10:00:00Z')).toISOString(), '2026-05-31T22:00:00.000Z');
  assert.equal(endOfBerlinDay(new Date('2026-06-01T10:00:00Z')).toISOString(), '2026-06-01T22:00:00.000Z');
  assert.equal(endOfBerlinDay(new Date('2026-03-28T10:00:00Z')).getTime() - startOfBerlinDay(new Date('2026-03-28T10:00:00Z')).getTime(), 86400000);
  assert.equal(endOfBerlinDay(new Date('2026-03-29T10:00:00Z')).getTime() - startOfBerlinDay(new Date('2026-03-29T10:00:00Z')).getTime(), 23 * 3600000);   // Zeitumstellung
});

test('Sperrlisten-Werte werden normalisiert', () => {
  assert.equal(Repo.normalizeSuppression('phone', '+49 (0681) 123-456'), '0681123456');
  assert.equal(Repo.normalizeSuppression('email', ' Info@Salon.DE '), 'info@salon.de');
  assert.equal(Repo.normalizeSuppression('domain', 'https://www.Salon.de/kontakt'), 'salon.de');
  assert.equal(Repo.normalizeSuppression('company', 'Salon Müller & Söhne'), 'salon mueller soehne');
});
