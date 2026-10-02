import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followUps, groupOf, nextBusinessDay } from '../../src/tasks/rules.ts';
import { endOfBerlinDay, startOfBerlinDay } from '../../src/core/time.ts';

const base = { now: new Date('2026-10-02T09:30:00Z'), topics: [] as string[], hasDemo: false, attempts: 1, maxAttempts: 3, company: 'Salon Muster' };   // Freitag 2.10.2026 11:30 Berlin
const berlin = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' }).format(d);

test('Nächster Werktag: Freitag → Montag 09:00 (Berliner Zeit), Mittwoch → Donnerstag; Werktage überspringen Wochenende', () => {
  assert.equal(berlin(nextBusinessDay(new Date('2026-10-02T09:30:00Z'))), '2026-10-05 09:00');
  assert.equal(berlin(nextBusinessDay(new Date('2026-10-07T20:00:00Z'))), '2026-10-08 09:00');
  assert.equal(berlin(nextBusinessDay(new Date('2026-10-03T09:00:00Z'))), '2026-10-05 09:00', 'Samstag → Montag');
  assert.equal(berlin(nextBusinessDay(new Date('2026-10-01T09:00:00Z'), 9, 2)), '2026-10-06 09:00', 'Donnerstag + 3 Werktage = Dienstag');
});

test('Follow-up-Regeln je Anruf-Ergebnis (Teil 17)', () => {
  const r = (result: string, o: object = {}) => followUps(result, { ...base, ...o });
  assert.deepEqual(r('NO_ANSWER').create.map((t) => [t.type, berlin(t.dueAt)]), [['CALL_RETRY', '2026-10-05 09:00']]);
  assert.equal(r('NO_ANSWER', { attempts: 3 }).create[0].type, 'CUSTOM', 'nach 3 Versuchen entscheiden statt weiter anrufen');
  const cb = new Date('2026-10-12T08:00:00Z'); assert.deepEqual(r('CALL_BACK', { callbackAt: cb }).create.map((t) => [t.type, t.dueAt.getTime()]), [['CALLBACK', cb.getTime()]]); assert.deepEqual(r('CALL_BACK').create, [], 'ohne Datum keine Aufgabe');
  assert.deepEqual(r('INTERESTED').create.map((t) => t.type), ['PREPARE_DEMO', 'PREPARE_OFFER']); assert.deepEqual(r('INTERESTED', { hasDemo: true }).create.map((t) => t.type), ['DEMO_FOLLOW_UP']);
  assert.deepEqual(r('DEMO').create.map((t) => t.type), ['CREATE_DEMO']); assert.equal(r('DEMO').create[0].priority, 'HIGH'); assert.match(r('DEMO').create[0].title, /nach deiner Bestätigung/); assert.deepEqual(r('DEMO', { hasDemo: true }).create.map((t) => t.type), ['DEMO_FOLLOW_UP']);
  assert.deepEqual(r('NEEDS_ANALYSIS').create.map((t) => t.type), ['NEEDS_ANALYSIS_APPOINTMENT']); assert.match(r('NEEDS_ANALYSIS').create[0].notes!, /Eigenständiges Thema/);
  assert.deepEqual(r('PARTNERSHIP').create.map((t) => t.type), ['PARTNER_CONVERSATION']); assert.deepEqual(r('OFFER').create.map((t) => t.type), ['PREPARE_OFFER']);
  const m = r('MULTIPLE', { topics: ['partner', 'website', 'needs'] }).create; assert.deepEqual(m.map((t) => t.type), ['PREPARE_DEMO', 'NEEDS_ANALYSIS_APPOINTMENT', 'PARTNER_CONVERSATION']); assert.equal(new Set(m.map((t) => t.dueAt.getTime())).size, 3, 'gestaffelt');
  for (const x of ['NO_INTEREST', 'DO_NOT_CONTACT', 'BOUGHT']) { assert.equal(r(x).cancelAll, true, x); assert.deepEqual(r(x).create, []); }
  assert.ok(r('INTERESTED').completeTypes.includes('CALL_RETRY') && r('INTERESTED').completeTypes.includes('CALLBACK')); assert.deepEqual(r('NO_ANSWER').completeTypes, []);
  assert.match(r('INTERESTED', { nextStep: 'Demo am Dienstag' }).create[0].notes!, /Demo am Dienstag/);
});

test('Gruppen: überfällig · heute · diese Woche (bis Sonntag) · später', () => {
  const now = new Date('2026-10-07T10:00:00Z'); const s = startOfBerlinDay(now), e = endOfBerlinDay(now);   // Mittwoch
  const g = (iso: string) => groupOf(new Date(iso), now, s, e);
  assert.equal(g('2026-10-06T07:00:00Z'), 'OVERDUE'); assert.equal(g('2026-10-07T05:00:00Z'), 'TODAY'); assert.equal(g('2026-10-07T21:00:00Z'), 'TODAY');
  assert.equal(g('2026-10-08T07:00:00Z'), 'WEEK'); assert.equal(g('2026-10-11T20:00:00Z'), 'WEEK', 'Sonntag zählt noch zu dieser Woche'); assert.equal(g('2026-10-12T07:00:00Z'), 'LATER');
});
