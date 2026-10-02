import type { Copilot } from './copilot.ts';
import { assertNoInsuranceCoupling } from '../core/compliance.ts';

export type EmailDraft = { subject: string; body: string; points: string[]; notices: string[] };
const trimDot = (s: string) => s.replace(/[.\s]+$/, '');

/**
 * Individueller E-Mail-Entwurf aus dem Verkaufsassistenten (nur Website-Thema; Bedarfsanalyse und Partnerschaft werden hier nicht vermischt).
 * Enthält: persönliche Anrede soweit bekannt, einen belegten Grund, höchstens zwei Punkte, kurze Vorstellung, klare nächste Aktion.
 * Es wird NICHTS gesendet – Versand läuft ausschließlich über die bestehende Einwilligungs-/Freigabelogik.
 */
export function buildEmailDraft(c: Copilot, o: { company: string; city?: string | null; subLabel?: string | null; contactPerson?: string | null; callerName: string; demoUrl?: string | null }): EmailDraft {
  const noSite = c.opener.variant === 'no_website' || c.opener.variant === 'website_uncertain';
  const points = c.arguments.filter((a) => a.basis !== 'Branche').slice(0, 2);
  const greeting = o.contactPerson ? `Guten Tag ${o.contactPerson},` : 'Guten Tag,';
  const where = o.subLabel ? ` (${o.subLabel}${o.city ? `, ${o.city}` : ''})` : '';
  const reason = noSite
    ? `ich bin auf ${o.company}${where} gestoßen. In den verfügbaren Quellen habe ich keine eigene Website von Ihnen gefunden – falls es sie gibt, entschuldigen Sie bitte den Hinweis.`
    : `ich habe mir den Online-Auftritt von ${o.company}${where} angesehen${points.length ? ' und dabei ' + (points.length === 1 ? 'einen Punkt' : 'zwei Punkte') + ' gesehen, die man einfach verbessern könnte:' : '.'}`;
  const bullets = noSite ? [] : points.map((p) => `• ${trimDot(p.claim)} (Beobachtung: ${trimDot(p.evidence)}.)`);
  const next = o.demoUrl
    ? `Ich habe dazu einen unverbindlichen Entwurf vorbereitet: ${o.demoUrl}. Wenn Sie mögen, sprechen wir kurz darüber – antworten Sie einfach auf diese E-Mail oder nennen Sie mir einen passenden Zeitpunkt.`
    : 'Wenn Sie möchten, bereite ich Ihnen unverbindlich einen kleinen Entwurf vor. Antworten Sie einfach auf diese E-Mail oder nennen Sie mir einen passenden Zeitpunkt für ein kurzes Telefonat.';
  const body = [greeting, '', reason, ...(bullets.length ? ['', ...bullets] : []), '',
    'Kurz zu mir: Ich unterstütze lokale Unternehmen bei der Digitalisierung und bei modernen Online-Auftritten.', '', next, '',
    'Falls Sie keine weiteren Nachrichten von mir wünschen, genügt eine kurze Antwort – dann melde ich mich nicht erneut.', '', 'Freundliche Grüße', o.callerName].join('\n');
  assertNoInsuranceCoupling(body);
  return { subject: noSite ? `Online-Auftritt für ${o.company}` : `Ihr Online-Auftritt – kurze Idee für ${o.company}`, body, points: points.map((p) => p.claim),
    notices: ['ENTWURF – es wurde nichts gesendet.', 'Versand nur mit Einwilligung bzw. nach der Freigabe in der bestehenden E-Mail-Logik (Kontaktstrategie, Einwilligung, Sperrliste).', 'Keine Behauptung ohne Beleg: Punkte stammen aus der Websiteprüfung bzw. der Datenlage.'] };
}
