import type { AuditResult, Finding, Lead } from '../core/types.ts';
import type { Opportunity } from '../scoring/opportunity.ts';
import type { AiGateway } from './provider.ts';

export type Pricing = {
  currency: string;
  offers: Record<string, { name: string; priceCents: number; depositCents: number; maintenanceCentsPerMonth: number }>;
  noWebsiteOffer: string;
  existingWebsiteOffer: string;
};

export type SalesPackage = {
  leadId: string;
  company: string;
  problems: { code: string; text: string; evidence: string }[];
  chance: string;
  offerName: string;
  priceCents: number;
  opener: string;
  openerSource: 'template' | 'ai';
  needsHumanApproval: true;
};

export const eur = (cents: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(cents / 100);

function chanceText(problems: Finding[], noSite: boolean): string {
  if (noSite) return 'Neue mobile-first Website mit Kontaktweg und, falls gewünscht, Online-Terminbuchung.';
  const codes = new Set(problems.map((p) => p.code));
  const parts = ['Neue mobile-first Website'];
  if (codes.has('NO_ONLINE_BOOKING')) parts.push('mit Online-Terminbuchung');
  if (codes.has('NO_CLEAR_CTA') || codes.has('NO_PHONE') || codes.has('NO_CONTACT_OPTION')) parts.push('und klarem Kontaktweg');
  return parts.join(' ') + '.';
}

function templateOpener(lead: Lead, problems: Finding[], noSite: boolean): string {
  if (noSite) return `Guten Tag, ich habe gesehen, dass ${lead.companyName} online noch keine eigene Website hat. Ich habe ein unverbindliches Beispiel vorbereitet, wie ein Auftritt für Ihren Betrieb aussehen könnte.`;
  const top = problems.slice(0, 2).map((p) => p.summary.replace(/\.$/, '')).join('; ');
  return `Guten Tag, beim Blick auf die Website von ${lead.companyName} ist mir aufgefallen: ${top}. Ich habe ein unverbindliches Beispiel vorbereitet, wie das einfacher gehen könnte.`;
}

/** Erstellt das Verkaufspaket ausschließlich aus belegten Befunden. Ohne Befunde und ohne "keine Website" entsteht kein Paket. */
export function buildSalesPackage(lead: Lead, audit: AuditResult, opp: Opportunity, pricing: Pricing): SalesPackage | null {
  if (!opp.scored) return null;
  const noSite = audit.status === 'NO_WEBSITE';
  const relevant = audit.findings.filter((f) => f.severity !== 'low' || noSite).slice(0, 6);
  const problems = noSite
    ? [{ code: 'NO_WEBSITE', text: 'Es ist keine Website hinterlegt.', evidence: 'Keine URL in den Quelldaten' }]
    : relevant.map((f) => ({ code: f.code, text: f.summary, evidence: f.evidence }));
  if (!problems.length) return null;
  const offer = pricing.offers[noSite ? pricing.noWebsiteOffer : pricing.existingWebsiteOffer];
  return {
    leadId: lead.id, company: lead.companyName, problems, chance: chanceText(relevant, noSite), offerName: offer.name, priceCents: offer.priceCents,
    opener: templateOpener(lead, relevant, noSite), openerSource: 'template', needsHumanApproval: true,
  };
}

/**
 * Optional: KI formuliert den Gesprächseinstieg neu. Die Antwort wird verworfen, wenn sie Befund-Codes
 * nennt, die es nicht gibt, oder keine nennt. Im Fehlerfall bleibt der Vorlagentext.
 */
export async function polishOpener(pkg: SalesPackage, ai: AiGateway): Promise<SalesPackage> {
  const allowed = pkg.problems.map((p) => p.code);
  const prompt = [
    'Formuliere einen höflichen, kurzen deutschen Gesprächseinstieg (max. 3 Sätze) für einen Erstkontakt mit dem Unternehmen.',
    'Verwende AUSSCHLIESSLICH die folgenden belegten Fakten. Erfinde nichts, mache keine Versprechen zu Umsatz oder Ranking.',
    `Unternehmen: ${pkg.company}`,
    'Fakten (code: Text):', ...pkg.problems.map((p) => `- ${p.code}: ${p.text}`),
    'Antworte nur als JSON: {"opener": "...", "used_codes": ["CODE", ...]}',
  ].join('\n');
  try {
    const raw = await ai.complete(pkg.leadId, prompt);
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { opener?: string; used_codes?: string[] };
    const ok = typeof json.opener === 'string' && json.opener.length > 10 && Array.isArray(json.used_codes) && json.used_codes.length > 0 && json.used_codes.every((c) => allowed.includes(c));
    return ok ? { ...pkg, opener: json.opener!, openerSource: 'ai' } : pkg;
  } catch {
    return pkg;
  }
}
