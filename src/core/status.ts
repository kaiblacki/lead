export const STATUSES = [
  'NEW', 'ANALYZING', 'QUALIFIED', 'IGNORED', 'RECHECK', 'DEMO_CREATED', 'CONTACTED', 'REPLIED', 'INTERESTED',
  'OFFER_SENT', 'OFFER_ACCEPTED', 'DEPOSIT_PENDING', 'DEPOSIT_PAID', 'PRODUCTION', 'QA', 'CUSTOMER_REVIEW', 'APPROVED',
  'FINAL_PAYMENT', 'DEPLOYED', 'MAINTENANCE',
] as const;
export type Status = (typeof STATUSES)[number];

/** Anzeige-Namen der Pipeline-Stufen (Reihenfolge = Ablauf). */
export const STAGE_LABEL: Record<Status, string> = {
  NEW: 'Neuer Lead', ANALYZING: 'Wird analysiert', RECHECK: 'Erneut prüfen', QUALIFIED: 'Qualifiziert', IGNORED: 'Zurückgestellt/abgelehnt', DEMO_CREATED: 'Demo erstellt', CONTACTED: 'Kontaktiert',
  REPLIED: 'Geantwortet', INTERESTED: 'Interessiert', OFFER_SENT: 'Angebot gesendet', OFFER_ACCEPTED: 'Angebot angenommen', DEPOSIT_PENDING: 'Anzahlung offen', DEPOSIT_PAID: 'Anzahlung bezahlt',
  PRODUCTION: 'In Produktion', QA: 'Qualitätsprüfung', CUSTOMER_REVIEW: 'Kundenfreigabe', APPROVED: 'Freigegeben', FINAL_PAYMENT: 'Restzahlung offen', DEPLOYED: 'Veröffentlicht', MAINTENANCE: 'Wartung aktiv',
};

const NEXT: Record<Status, Status[]> = {
  NEW: ['ANALYZING', 'IGNORED'],
  ANALYZING: ['QUALIFIED', 'IGNORED', 'RECHECK'],
  RECHECK: ['ANALYZING', 'IGNORED'],
  QUALIFIED: ['CONTACTED', 'DEMO_CREATED', 'IGNORED'],
  IGNORED: ['ANALYZING'],
  DEMO_CREATED: ['CONTACTED', 'INTERESTED', 'OFFER_SENT', 'IGNORED'],
  CONTACTED: ['REPLIED', 'INTERESTED', 'DEMO_CREATED', 'IGNORED'],
  REPLIED: ['INTERESTED', 'IGNORED'],
  INTERESTED: ['OFFER_SENT', 'DEMO_CREATED', 'IGNORED'],
  OFFER_SENT: ['OFFER_ACCEPTED', 'INTERESTED', 'IGNORED'],
  OFFER_ACCEPTED: ['DEPOSIT_PENDING'],
  DEPOSIT_PENDING: ['DEPOSIT_PAID', 'IGNORED'],
  DEPOSIT_PAID: ['PRODUCTION'],
  PRODUCTION: ['QA'],
  QA: ['CUSTOMER_REVIEW', 'PRODUCTION'],
  CUSTOMER_REVIEW: ['PRODUCTION', 'APPROVED'],
  APPROVED: ['FINAL_PAYMENT'],
  FINAL_PAYMENT: ['DEPLOYED'],
  DEPLOYED: ['MAINTENANCE'],
  MAINTENANCE: [],
};

export function canTransition(from: Status, to: Status): boolean {
  return NEXT[from].includes(to);
}

export type LeadEvent = { leadId: string; type: 'status_change'; from: Status; to: Status; reason: string; at: string };

/** Einziger erlaubter Weg, einen Status zu ändern. Liefert das Audit-Event mit. */
export function transition(leadId: string, from: Status, to: Status, reason: string, now = new Date()): LeadEvent {
  if (!canTransition(from, to)) throw new Error(`Übergang ${from} → ${to} ist nicht erlaubt`);
  if (!reason.trim()) throw new Error('Ein Grund ist Pflicht');
  return { leadId, type: 'status_change', from, to, reason, at: now.toISOString() };
}

const ANALYSIS_STATES: Status[] = ['NEW', 'ANALYZING', 'QUALIFIED', 'IGNORED', 'RECHECK'];

/** Kürzester erlaubter Weg von `from` nach `to` (Liste der Zwischenschritte inkl. Ziel). Leer = kein Wechsel nötig oder kein Weg. */
export function findPath(from: Status, to: Status, within?: Status[]): Status[] {
  if (from === to) return [];
  const ok = (s: Status) => !within || within.includes(s);
  if (!ok(from) || !ok(to)) return [];
  const queue: Status[][] = [[from]];
  const seen = new Set<Status>([from]);
  while (queue.length) {
    const path = queue.shift()!;
    for (const n of NEXT[path[path.length - 1]]) {
      if (!ok(n) || seen.has(n)) continue;
      const next = [...path, n];
      if (n === to) return next.slice(1);
      seen.add(n); queue.push(next);
    }
  }
  return [];
}
/** Weg innerhalb der Analyse-Zustände (für automatische Status-Updates nach einer Analyse). */
export const analysisPath = (from: Status, to: Status) => findPath(from, to, ANALYSIS_STATES);

export const nextStatuses = (from: Status): Status[] => [...NEXT[from]];
