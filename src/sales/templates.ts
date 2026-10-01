/**
 * Kontaktvorlagen (nur ENTWÜRFE – das System sendet nichts): E-Mail, Follow-up, Telefon-Einstieg. Inhalte stammen ausschließlich aus den belegten Verkaufsgründen des Leads.
 * Hinweis: Kalt-E-Mails an Unternehmen brauchen in Deutschland grundsätzlich eine Einwilligung (UWG § 7); Telefon nur nach Freigabe in den Einstellungen.
 */
export type ContactTemplates = { email: { subject: string; text: string }; followUp: { subject: string; text: string; afterDays: number }; phoneOpener: string };

export function buildContactTemplates(i: { company: string; reasons: string[]; service: string; sender?: string; demoUrl?: string; opener?: string }): ContactTemplates {
  const reasons = i.reasons.slice(0, 2).map((r) => r.replace(/\.$/, ''));
  const intro = i.sender ? `mein Name ist ${i.sender}.` : 'ich melde mich kurz bei Ihnen.';
  const obs = reasons.length ? `Beim Blick auf die Online-Auftritte von ${i.company} ist mir aufgefallen: ${reasons.join('; ')}.` : `Ich habe mir die Online-Präsenz von ${i.company} angesehen.`;
  const demo = i.demoUrl ? `Ich habe dazu einen unverbindlichen Entwurf vorbereitet, den Sie sich in Ruhe ansehen können:\n${i.demoUrl}\n` : 'Ich habe eine Idee für einen unverbindlichen Entwurf und zeige ihn Ihnen gern.\n';
  const bye = `Mit freundlichen Grüßen${i.sender ? `\n${i.sender}` : ''}`;
  return {
    email: { subject: `Idee für die Website von ${i.company}`, text: `Guten Tag,\n\n${intro} ${obs}\n\n${demo}\nHätten Sie diese Woche 10 Minuten für ein kurzes Gespräch? Passend wäre aus meiner Sicht: ${i.service}.\n\n${bye}` },
    followUp: { afterDays: 4, subject: `Kurze Nachfrage: Website-Entwurf für ${i.company}`, text: `Guten Tag,\n\nich wollte kurz nachfassen, ob Sie meine Nachricht zum Website-Entwurf für ${i.company} erreicht hat.${i.demoUrl ? `\nDen Entwurf finden Sie hier: ${i.demoUrl}` : ''}\nWenn das Thema gerade nicht passt, genügt eine kurze Rückmeldung – dann melde ich mich nicht erneut.\n\n${bye}` },
    phoneOpener: i.opener ?? '',
  };
}
