import type { Fact } from '../core/profile.ts';
import { bestFact, findConflicts } from '../core/profile.ts';
import type { AuditReport } from '../audit/types.ts';
import { hostOf, norm, normPhone } from '../core/text.ts';

export type Channel = 'PHONE' | 'EMAIL' | 'WHATSAPP' | 'MANUAL' | 'DO_NOT_CONTACT';
export type Readiness = 'READY_FOR_MANUAL_CALL' | 'EMAIL_PERMISSION_REQUIRED' | 'WHATSAPP_OPT_IN_REQUIRED' | 'MANUAL_REVIEW' | 'DO_NOT_CONTACT';
export type SuppressionHit = { kind: string; value: string; reason?: string | null };
export type ContactAssessment = {
  recommended: Channel; readiness: Readiness;
  /** Erster Eintrag = Hauptgrund. */
  reasons: string[];
  channels: { channel: Exclude<Channel, 'DO_NOT_CONTACT' | 'MANUAL'>; readiness: Readiness; reason: string }[];
  warnings: string[]; legal: string[];
};

export const LEGAL = {
  phone: 'Telefonwerbung gegenüber Unternehmen ist nur mit (mutmaßlicher) Einwilligung zulässig (UWG § 7 Abs. 2 Nr. 1). Den konkreten Bezug zum Bedarf des Unternehmens vor dem Anruf prüfen und festhalten.',
  email: 'E-Mail-Werbung ohne vorherige Einwilligung ist grundsätzlich unzulässig (UWG § 7 Abs. 2 Nr. 3), auch gegenüber Unternehmen.',
  whatsapp: 'Nachrichten über WhatsApp an Unternehmen erfordern eine vorherige Einwilligung bzw. eine vom Empfänger begonnene Konversation; Plattformregeln beachten.',
};

/** Schlüssel, mit denen die Sperrliste (Opt-out) abgeglichen wird. */
export function suppressionKeys(facts: Fact[], companyName: string): { kind: 'phone' | 'email' | 'domain' | 'company'; value: string }[] {
  const out: { kind: 'phone' | 'email' | 'domain' | 'company'; value: string }[] = [];
  for (const f of facts) {
    if (f.key === 'phone') out.push({ kind: 'phone', value: normPhone(String(f.value)) });
    if (f.key === 'email') { out.push({ kind: 'email', value: String(f.value).toLowerCase() }); const d = String(f.value).split('@')[1]; if (d) out.push({ kind: 'domain', value: d.toLowerCase().replace(/^www\./, '') }); }
    if (f.key === 'website') { const h = hostOf(String(f.value)); if (h) out.push({ kind: 'domain', value: h }); }
  }
  out.push({ kind: 'company', value: norm(companyName) });
  return [...new Map(out.filter((o) => o.value).map((o) => [`${o.kind}:${o.value}`, o])).values()];
}

export function assessContact(i: { facts: Fact[]; audit?: AuditReport | null; blocked?: boolean; suppressionHits?: SuppressionHit[]; phoneEnabled: boolean }): ContactAssessment {
  const facts = i.facts;
  const channels: ContactAssessment['channels'] = [];
  const warnings: string[] = [];
  const legal: string[] = [];
  const status = bestFact(facts, 'businessStatus')?.value as string | undefined;
  const phone = bestFact(facts, 'phone');
  const phoneOk = !!phone && normPhone(String(phone.value)).length >= 6;
  const email = bestFact(facts, 'email');
  const wa = !!i.audit?.checks.some((c) => c.code === 'WHATSAPP' && c.status === 'pass');
  const hits = i.suppressionHits ?? [];

  const dnc = (reason: string): ContactAssessment => ({ recommended: 'DO_NOT_CONTACT', readiness: 'DO_NOT_CONTACT', reasons: [reason], channels: [], warnings, legal });
  if (hits.length) return dnc(`Auf der Sperrliste (Opt-out): ${hits.map((h) => `${h.kind} ${h.value}${h.reason ? ` – ${h.reason}` : ''}`).join('; ')}`);
  if (i.blocked) return dnc('Lead ist als „nicht kontaktieren“ markiert.');
  if (status === 'CLOSED_PERMANENTLY') return dnc('Betrieb laut Datenquelle dauerhaft geschlossen.');

  if (phoneOk) {
    legal.push(LEGAL.phone);
    channels.push(i.phoneEnabled
      ? { channel: 'PHONE', readiness: 'READY_FOR_MANUAL_CALL', reason: `Geschäftliche Rufnummer vorhanden (${phone!.source}, Qualität ${phone!.quality}). Anruf erfolgt manuell durch dich.` }
      : { channel: 'PHONE', readiness: 'MANUAL_REVIEW', reason: 'Telefonakquise ist in den Einstellungen noch nicht freigegeben (Rechtsgrundlage bestätigen).' });
    if (findConflicts(facts).some((c) => c.key === 'phone')) warnings.push('Rufnummern aus verschiedenen Quellen widersprechen sich – vor dem Anruf prüfen.');
    if (status === 'CLOSED_TEMPORARILY') warnings.push('Betrieb laut Datenquelle vorübergehend geschlossen.');
  }
  if (email) { legal.push(LEGAL.email); channels.push({ channel: 'EMAIL', readiness: 'EMAIL_PERMISSION_REQUIRED', reason: 'E-Mail-Adresse bekannt, aber Kaltakquise per E-Mail braucht vorherige Einwilligung.' }); }
  if (wa) { legal.push(LEGAL.whatsapp); channels.push({ channel: 'WHATSAPP', readiness: 'WHATSAPP_OPT_IN_REQUIRED', reason: 'WhatsApp auf der Website erkennbar, aber ohne Opt-in keine Erstnachricht.' }); }

  const primary = channels[0];
  if (!primary) return { recommended: 'MANUAL', readiness: 'MANUAL_REVIEW', reasons: ['Keine verlässliche Kontaktmöglichkeit in den Daten gefunden – manuell recherchieren.'], channels, warnings, legal };
  return { recommended: primary.channel, readiness: primary.readiness, reasons: [primary.reason, ...channels.slice(1).map((c) => c.reason)], channels, warnings, legal: [...new Set(legal)] };
}
