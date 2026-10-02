/** Partnermodell (rein, ohne Datenbank): Stadien, erlaubte Übergänge, Voraussetzungen, Passung zu Leads. Eigenständiges Kooperationsmodell – keine Versicherungskriterien. */
export const PARTNER_STATUSES = ['NONE', 'PARTNER_CANDIDATE', 'PARTNER_DISCUSSION', 'PARTNER_APPROVED', 'ACTIVE_PARTNER', 'PAUSED_PARTNER', 'ENDED_PARTNER'] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];
export const PARTNER_LABEL: Record<PartnerStatus, string> = { NONE: 'Kein Partner', PARTNER_CANDIDATE: 'Partner-Kandidat', PARTNER_DISCUSSION: 'Im Partnergespräch', PARTNER_APPROVED: 'Partner freigegeben', ACTIVE_PARTNER: 'Aktiver Partner', PAUSED_PARTNER: 'Partner pausiert', ENDED_PARTNER: 'Partnerschaft beendet' };

const NEXT: Record<PartnerStatus, PartnerStatus[]> = {
  NONE: ['PARTNER_CANDIDATE'],
  PARTNER_CANDIDATE: ['PARTNER_DISCUSSION', 'NONE', 'ENDED_PARTNER'],
  PARTNER_DISCUSSION: ['PARTNER_APPROVED', 'PARTNER_CANDIDATE', 'ENDED_PARTNER'],
  PARTNER_APPROVED: ['ACTIVE_PARTNER', 'PARTNER_DISCUSSION', 'ENDED_PARTNER'],
  ACTIVE_PARTNER: ['PAUSED_PARTNER', 'ENDED_PARTNER'],
  PAUSED_PARTNER: ['ACTIVE_PARTNER', 'ENDED_PARTNER'],
  ENDED_PARTNER: ['PARTNER_CANDIDATE'],
};
export const nextPartnerStatuses = (s: PartnerStatus) => NEXT[s];

/** Kriterien des Partnerstatus – ausschließlich Kooperation (kein Versicherungsabschluss, keine Prämie, kein Versicherungsumsatz). */
export const CRITERIA = ['conversation_held', 'shared_segment', 'regional_fit', 'referral_willingness', 'agreement', 'contact_person_known', 'active_collaboration'] as const;
export type Criterion = (typeof CRITERIA)[number];
export const CRITERIA_LABEL: Record<Criterion, string> = { conversation_held: 'Partnergespräch geführt', shared_segment: 'Gemeinsames Kundensegment', regional_fit: 'Regionale Ergänzung', referral_willingness: 'Bereitschaft zu gegenseitigen Empfehlungen', agreement: 'Kooperationsvereinbarung', contact_person_known: 'Ansprechpartner vorhanden', active_collaboration: 'Aktive Zusammenarbeit' };
export type Criteria = Partial<Record<Criterion, boolean>>;

/** Was für den Wechsel in ein Stadium vorliegen muss. */
const REQUIRED: Partial<Record<PartnerStatus, Criterion[]>> = { PARTNER_APPROVED: ['conversation_held', 'referral_willingness'], ACTIVE_PARTNER: ['agreement', 'contact_person_known'] };
export function missingForStatus(to: PartnerStatus, criteria: Criteria, o: { contactPerson?: string | null } = {}): Criterion[] {
  return (REQUIRED[to] ?? []).filter((c) => !(criteria[c] || (c === 'contact_person_known' && o.contactPerson)));
}
export function checkTransition(from: PartnerStatus, to: PartnerStatus, criteria: Criteria, o: { contactPerson?: string | null } = {}): { ok: boolean; reason?: string } {
  if (from === to) return { ok: false, reason: 'Der Partnerstatus ist bereits gesetzt.' };
  if (!NEXT[from].includes(to)) return { ok: false, reason: `Wechsel ${PARTNER_LABEL[from]} → ${PARTNER_LABEL[to]} ist nicht vorgesehen.` };
  const miss = missingForStatus(to, criteria, o); if (miss.length) return { ok: false, reason: `Voraussetzung fehlt: ${miss.map((m) => CRITERIA_LABEL[m]).join(', ')}.` };
  return { ok: true };
}

export const REFERRAL_FIELDS = ['company_name', 'industry', 'city', 'address', 'phone', 'email', 'website', 'note'] as const;
export type ReferralField = (typeof REFERRAL_FIELDS)[number];
export const REFERRAL_FIELD_LABEL: Record<ReferralField, string> = { company_name: 'Firmenname', industry: 'Branche', city: 'Ort', address: 'Adresse', phone: 'Telefonnummer', email: 'E-Mail', website: 'Website', note: 'Kurznotiz (von Kai)' };
/** Standardmäßig vorausgewählt: nur öffentliche Firmenangaben ohne Kontaktwege. Kontaktwege nur ausdrücklich. */
export const REFERRAL_DEFAULT_FIELDS: ReferralField[] = ['company_name', 'industry', 'city'];
export const REFERRAL_CONTACT_FIELDS: ReferralField[] = ['phone', 'email'];
export const REFERRAL_STATUS_LABEL: Record<string, string> = { PROPOSED: 'Vorgeschlagen', CONFIRMED: 'Bestätigt (noch nicht weitergegeben)', SENT: 'Weitergegeben', CLOSED: 'Abgeschlossen', CANCELLED: 'Abgebrochen' };

export type MatchPartner = { id: string; company_name: string; status: string; industry?: string | null; region?: string | null; radius_km?: number | null; lead_industries?: string[] | null; services?: string | null };
export type MatchLead = { id: string; sub_industry?: string | null; industry?: string | null; city?: string | null; contact_blocked?: boolean };
const norm = (s?: string | null) => (s ?? '').toLowerCase().trim();
/**
 * „Passender Partner vorhanden“: nur AKTIVE Partner, deren bevorzugte Lead-Branchen die Branche des Leads enthalten und deren Region zum Ort passt (oder keine Region hinterlegt ist).
 * Es ist ein Vorschlag – weitergeleitet wird nie automatisch.
 */
export function matchPartners(lead: MatchLead, partners: MatchPartner[]): MatchPartner[] {
  if (lead.contact_blocked) return [];
  const inds = [norm(lead.sub_industry), norm(lead.industry)].filter(Boolean);
  return partners.filter((p) => {
    if (p.status !== 'ACTIVE_PARTNER') return false;
    const want = (p.lead_industries ?? []).map(norm).filter(Boolean);
    if (!want.length || !inds.some((i) => want.includes(i))) return false;
    const reg = norm(p.region); return !reg || !lead.city || norm(lead.city).includes(reg) || reg.includes(norm(lead.city));
  });
}
