export type Contactability = 'READY' | 'PHONE_ONLY' | 'EMAIL_ONLY' | 'WEB_FORM_ONLY' | 'SOCIAL_ONLY' | 'NO_CONTACT_DATA';
export type PreferredChannel = 'PHONE' | 'EMAIL' | 'WHATSAPP' | 'WEB_FORM' | 'SOCIAL';
export type WorkStatus = 'DATA_NEEDED' | 'CONTACTABLE';
export const CONTACTABILITY_LABEL: Record<Contactability, string> = { READY: 'Telefon + E-Mail', PHONE_ONLY: 'nur Telefon', EMAIL_ONLY: 'nur E-Mail', WEB_FORM_ONLY: 'nur Kontaktformular', SOCIAL_ONLY: 'nur Social/WhatsApp', NO_CONTACT_DATA: 'keine Kontaktdaten' };
export const WORK_STATUS_LABEL: Record<WorkStatus, string> = { DATA_NEEDED: 'Daten beschaffen', CONTACTABLE: 'kontaktierbar' };

/**
 * Kontaktierbarkeit aus den vorhandenen Angaben. DATA_NEEDED gilt, wenn weder Telefonnummer noch geschäftliche E-Mail bekannt sind –
 * unabhängig von der Verkaufspriorität (ein Lead kann B sein UND DATA_NEEDED). Es wird nichts gesendet.
 */
export function assessContactability(i: { phone: boolean; email: boolean; webForm: boolean; whatsapp: boolean; social: boolean }): { contactability: Contactability; preferred: PreferredChannel | null; workStatus: WorkStatus } {
  const contactability: Contactability = i.phone && i.email ? 'READY' : i.phone ? 'PHONE_ONLY' : i.email ? 'EMAIL_ONLY' : i.webForm ? 'WEB_FORM_ONLY' : i.whatsapp || i.social ? 'SOCIAL_ONLY' : 'NO_CONTACT_DATA';
  const preferred: PreferredChannel | null = i.phone ? 'PHONE' : i.email ? 'EMAIL' : i.whatsapp ? 'WHATSAPP' : i.webForm ? 'WEB_FORM' : i.social ? 'SOCIAL' : null;
  return { contactability, preferred, workStatus: i.phone || i.email ? 'CONTACTABLE' : 'DATA_NEEDED' };
}
