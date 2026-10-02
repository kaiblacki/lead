/** Follow-up-Regeln (rein): aus einem Anruf-Ergebnis werden Aufgaben abgeleitet. Nichts wird gesendet oder erstellt – es entstehen nur Aufgaben für Kai. */
import { parseBerlinLocal } from '../core/time.ts';

export const TASK_TYPES = ['CALL', 'CALL_RETRY', 'CALLBACK', 'PREPARE_DEMO', 'CREATE_DEMO', 'DEMO_FOLLOW_UP', 'PREPARE_OFFER', 'OFFER_FOLLOW_UP', 'NEEDS_ANALYSIS_APPOINTMENT', 'PARTNER_CONVERSATION', 'CUSTOMER_REQUEST', 'PAYMENT_CHECK', 'CUSTOM'] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export const TASK_LABEL: Record<TaskType, string> = { CALL: 'Anrufen', CALL_RETRY: 'Erneut anrufen', CALLBACK: 'Rückruf', PREPARE_DEMO: 'Demo vorbereiten', CREATE_DEMO: 'Demo erstellen', DEMO_FOLLOW_UP: 'Nach der Demo nachfassen', PREPARE_OFFER: 'Angebot vorbereiten', OFFER_FOLLOW_UP: 'Angebot nachfassen', NEEDS_ANALYSIS_APPOINTMENT: 'Bedarfsanalyse-Termin vereinbaren', PARTNER_CONVERSATION: 'Partnergespräch führen', CUSTOMER_REQUEST: 'Kundenanfrage bearbeiten', PAYMENT_CHECK: 'Zahlung prüfen', CUSTOM: 'Aufgabe' };
export const TASK_STATUSES = ['OPEN', 'DONE', 'CANCELLED', 'SNOOZED'] as const;
export type TaskPriority = 'HIGH' | 'NORMAL' | 'LOW';
export type TaskSpec = { type: TaskType; title: string; dueAt: Date; priority: TaskPriority; notes?: string };

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
const berlinParts = (d: Date) => Object.fromEntries(dayFmt.formatToParts(d).map((p) => [p.type, p.value]));
/** Nächster Werktag (Mo–Fr) nach `from`, um `hour` Uhr Berliner Zeit. `skip` = zusätzliche Werktage. */
export function nextBusinessDay(from: Date, hour = 9, skip = 0): Date {
  let d = new Date(from.getTime()); let left = 1 + skip;
  while (left > 0) { d = new Date(d.getTime() + 24 * 3600_000); const wd = berlinParts(d).weekday; if (wd !== 'Sat' && wd !== 'Sun') left--; }
  const p = berlinParts(d);
  return parseBerlinLocal(`${p.year}-${p.month}-${p.day}T${String(hour).padStart(2, '0')}:00`) ?? d;
}

export type RuleCtx = { now: Date; callbackAt?: Date | null; topics: string[]; nextStep?: string; hasDemo: boolean; attempts: number; maxAttempts: number; company: string };
export type RulePlan = { create: TaskSpec[]; completeTypes: TaskType[]; cancelAll: boolean };

/**
 * Ergebnis → Folgeaufgaben (Auftrag Teil 17):
 * nicht erreicht → nächster Werktag · Rückruf → gewähltes Datum · interessiert (Website) → Demo/Angebot vorbereiten · Demo gewünscht → Demo-Aufgabe ·
 * Bedarfsanalyse → separater Termin · Kooperation → Partnergespräch · mehrere Themen → je Thema eine Folgeaufgabe (gestaffelt) · kein Interesse / nicht kontaktieren → aus der aktiven Pipeline.
 */
export function followUps(result: string, c: RuleCtx): RulePlan {
  const note = (extra = '') => [c.nextStep ? `Nächster Schritt: ${c.nextStep}` : '', extra].filter(Boolean).join(' · ') || undefined;
  const plan: RulePlan = { create: [], completeTypes: [], cancelAll: false };
  const websiteTask = (due: Date): TaskSpec => c.hasDemo ? { type: 'DEMO_FOLLOW_UP', title: `Demo bei ${c.company} nachfassen`, dueAt: due, priority: 'NORMAL', notes: note() } : { type: 'PREPARE_DEMO', title: `Demo für ${c.company} vorbereiten (nach deiner Bestätigung)`, dueAt: due, priority: 'HIGH', notes: note() };
  const needsTask = (due: Date): TaskSpec => ({ type: 'NEEDS_ANALYSIS_APPOINTMENT', title: `Separaten Bedarfsanalyse-Termin mit ${c.company} vereinbaren`, dueAt: due, priority: 'NORMAL', notes: note('Eigenständiges Thema – unabhängig von Website und Partnerschaft.') });
  const partnerTask = (due: Date): TaskSpec => ({ type: 'PARTNER_CONVERSATION', title: `Partnergespräch mit ${c.company} führen`, dueAt: due, priority: 'NORMAL', notes: note('Eigenständiges Kooperationsmodell.') });
  if (result !== 'NO_ANSWER') plan.completeTypes.push('CALL_RETRY', 'CALLBACK', 'CALL');
  switch (result) {
    case 'NO_ANSWER':
      plan.create.push(c.attempts < c.maxAttempts ? { type: 'CALL_RETRY', title: `${c.company} erneut anrufen (Versuch ${c.attempts + 1})`, dueAt: nextBusinessDay(c.now), priority: 'NORMAL', notes: note() }
        : { type: 'CUSTOM', title: `${c.company}: ${c.maxAttempts} Versuche ohne Erfolg – entscheiden, wie es weitergeht`, dueAt: nextBusinessDay(c.now), priority: 'LOW' }); break;
    case 'CALL_BACK': if (c.callbackAt) plan.create.push({ type: 'CALLBACK', title: `Rückruf bei ${c.company}`, dueAt: c.callbackAt, priority: 'HIGH', notes: note() }); break;
    case 'INTERESTED': plan.create.push(websiteTask(nextBusinessDay(c.now))); if (!c.hasDemo) plan.create.push({ type: 'PREPARE_OFFER', title: `Angebot für ${c.company} vorbereiten`, dueAt: nextBusinessDay(c.now, 9, 2), priority: 'NORMAL' }); break;
    case 'DEMO': plan.create.push(c.hasDemo ? websiteTask(nextBusinessDay(c.now)) : { type: 'CREATE_DEMO', title: `Demo für ${c.company} erstellen (nach deiner Bestätigung)`, dueAt: c.now, priority: 'HIGH', notes: note() }); break;
    case 'OFFER': plan.create.push({ type: 'PREPARE_OFFER', title: `Angebot für ${c.company} erstellen`, dueAt: c.now, priority: 'HIGH', notes: note() }); break;
    case 'NEEDS_ANALYSIS': plan.create.push(needsTask(nextBusinessDay(c.now))); break;
    case 'PARTNERSHIP': plan.create.push(partnerTask(nextBusinessDay(c.now))); break;
    case 'MULTIPLE': {
      const order = ['website', 'needs', 'partner'].filter((t) => c.topics.includes(t)); let skip = 0;
      for (const t of order) { const due = nextBusinessDay(c.now, 9, skip++); plan.create.push(t === 'website' ? websiteTask(due) : t === 'needs' ? needsTask(due) : partnerTask(due)); }
      break; }
    case 'NO_INTEREST': case 'DO_NOT_CONTACT': plan.cancelAll = true; break;
    case 'BOUGHT': plan.cancelAll = true; break;
  }
  return plan;
}

/** Gruppen des Aufgaben-Dashboards (Berliner Kalender): ÜBERFÄLLIG · HEUTE · DIESE WOCHE (bis Sonntag) · SPÄTER. */
export function groupOf(due: Date, now: Date, startOfToday: Date, endOfToday: Date): 'OVERDUE' | 'TODAY' | 'WEEK' | 'LATER' {
  if (due < startOfToday) return 'OVERDUE'; if (due < endOfToday) return 'TODAY';
  const p = berlinParts(now); const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday); const sundayEnd = new Date(endOfToday.getTime() + (6 - dow) * 24 * 3600_000);
  return due < sundayEnd ? 'WEEK' : 'LATER';
}
