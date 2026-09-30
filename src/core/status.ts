export const STATUSES = [
  'NEW', 'ANALYZING', 'QUALIFIED', 'IGNORED', 'RECHECK', 'DEMO_CREATED', 'CONTACTED', 'REPLIED', 'INTERESTED',
  'OFFER_SENT', 'DEPOSIT_PENDING', 'DEPOSIT_PAID', 'PRODUCTION', 'CUSTOMER_REVIEW', 'APPROVED',
  'FINAL_PAYMENT', 'DEPLOYED', 'MAINTENANCE',
] as const;
export type Status = (typeof STATUSES)[number];

const NEXT: Record<Status, Status[]> = {
  NEW: ['ANALYZING', 'IGNORED'],
  ANALYZING: ['QUALIFIED', 'IGNORED', 'RECHECK'],
  RECHECK: ['ANALYZING', 'IGNORED'],
  QUALIFIED: ['DEMO_CREATED', 'CONTACTED', 'IGNORED'],
  IGNORED: ['ANALYZING'],
  DEMO_CREATED: ['CONTACTED', 'IGNORED'],
  CONTACTED: ['REPLIED', 'IGNORED'],
  REPLIED: ['INTERESTED', 'IGNORED'],
  INTERESTED: ['OFFER_SENT', 'IGNORED'],
  OFFER_SENT: ['DEPOSIT_PENDING', 'IGNORED'],
  DEPOSIT_PENDING: ['DEPOSIT_PAID', 'IGNORED'],
  DEPOSIT_PAID: ['PRODUCTION'],
  PRODUCTION: ['CUSTOMER_REVIEW'],
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

/** Kürzester erlaubter Weg von `from` nach `to` innerhalb der Analyse-Zustände. Leer = kein Wechsel nötig/möglich. */
export function analysisPath(from: Status, to: Status): Status[] {
  if (from === to || !ANALYSIS_STATES.includes(from) || !ANALYSIS_STATES.includes(to)) return [];
  const queue: Status[][] = [[from]];
  const seen = new Set<Status>([from]);
  while (queue.length) {
    const path = queue.shift()!;
    for (const n of NEXT[path[path.length - 1]]) {
      if (!ANALYSIS_STATES.includes(n) || seen.has(n)) continue;
      const next = [...path, n];
      if (n === to) return next.slice(1);
      seen.add(n); queue.push(next);
    }
  }
  return [];
}

export const nextStatuses = (from: Status): Status[] => [...NEXT[from]];
