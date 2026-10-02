/**
 * Compliance-Leitplanke: Website-Rabatte, Partnerstatus und Community-Vorteile dürfen NIE an einen Versicherungsabschluss gekoppelt werden.
 * Die Prüfung arbeitet satzweise: Ein Satz, der sowohl Versicherungs-Abschluss-Begriffe als auch einen Vorteil nennt, ist ein Verstoß.
 * Wird in Tests gegen alle erzeugten Texte (Copilot, Angebote, E-Mail-Entwürfe, Partner-Gespräch) geprüft.
 */
const INSURANCE = /versicher|police|prämie|haftpflicht|vollkunde|versicherungsnehmer|vertragsabschluss|vertrag abschließ/i;
const BENEFIT = /rabatt|nachlass|ermäßigung|kostenlos|gratis|gutschrift|bonus|partnerpreis|partnerstatus|community-vorteil|vorteil|günstiger/i;
export const INSURANCE_REASON = /versicher|insurance|police|prämie|premium_|vollkunde/i;

/** Liefert den ersten verdächtigen Satz oder null. */
export function insuranceCoupling(text: string): string | null {
  for (const s of text.split(/(?<=[.!])\s+|\n+/)) if (INSURANCE.test(s) && BENEFIT.test(s)) return s.trim();
  return null;
}
export function assertNoInsuranceCoupling(text: string): void {
  const hit = insuranceCoupling(text); if (hit) throw new Error(`Unzulässige Kopplung von Vorteil und Versicherung: „${hit.slice(0, 120)}“`);
}
/** Strukturiert: eine Rabatt-/Vorteilsbegründung darf nie auf Versicherung verweisen. */
export function assertAllowedBenefitReason(reason: string): void {
  if (INSURANCE_REASON.test(reason)) throw new Error('Rabatt- oder Vorteilsgründe dürfen sich nicht auf Versicherungsverträge beziehen.');
}
