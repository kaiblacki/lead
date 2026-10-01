import type { Analysis } from '../scoring/intelligence.ts';
import type { AuditReport } from '../audit/types.ts';
import type { ContactAssessment, Readiness } from '../contact/strategy.ts';
import type { Fact } from '../core/profile.ts';
import { factValue } from '../core/profile.ts';
import type { AIProvider } from '../providers/types.ts';
import { findPlaceholders } from '../core/text.ts';

export type BriefReason = { code: string; text: string; evidence: string };
export type SalesBrief = {
  priority: 'A' | 'B' | 'C' | 'D'; priorityLabel: string;
  reasons: BriefReason[];
  service: { offerKey: string; name: string; priceCents: number; upsells: { key: string; label: string; oneTimeCents: number; monthlyCents: number; reason: string }[] };
  valueRange: { lowCents: number; highCents: number; estimate: true; label: string; breakdown: string[] };
  opener: string; openerSource: 'rules' | 'ai';
  objections: { objection: string; response: string }[];
  nextAction: { code: Readiness; text: string };
  needsHumanApproval: true;
};

const eur = (cents: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(cents / 100);

export type BriefInput = {
  company: string; facts: Fact[]; audit: AuditReport; analysis: Analysis; contact: ContactAssessment; now: Date;
  pricing: any; sales: any; callerName?: string;
};

export function buildBrief(i: BriefInput): SalesBrief {
  const { analysis: a, audit, pricing, sales } = i;
  const noSite = audit.status === 'NO_WEBSITE';
  const reasons: BriefReason[] = [];
  if (noSite) reasons.push({ code: 'NO_WEBSITE', text: 'Es ist keine eigene Website hinterlegt.', evidence: a.dimensions.websiteNeed.reasons[0]?.text ?? 'Keine Website in den Datenquellen' });
  const fails = audit.checks.filter((c) => c.status === 'fail' || c.status === 'warn').sort((x, y) => (x.status === y.status ? (({ high: 0, medium: 1, low: 2 } as any)[x.severity] - ({ high: 0, medium: 1, low: 2 } as any)[y.severity]) : x.status === 'fail' ? -1 : 1));
  for (const c of fails) if (reasons.length < 4 && c.severity !== 'low') reasons.push({ code: c.code, text: c.summary, evidence: c.evidence });
  for (const u of a.upsells) if (reasons.length < 4) reasons.push(u.when === 'social_inactive_or_none' ? { code: 'SOCIAL', text: u.reason, evidence: 'Social-Media-Daten der Quelle' } : { code: `UPSELL_${u.key.toUpperCase()}`, text: u.reason, evidence: `Ableitung aus den Prüfdaten (${u.label})` });
  if (noSite) for (const k of ['conversionNeed', 'contentNeed'] as const) { const d = a.dimensions[k]; if (d.state === 'implied' && reasons.length < 3) reasons.push({ code: `IMPLIED_${k.toUpperCase()}`, text: d.reasons[0].text, evidence: 'Abgeleitet: keine Website hinterlegt' }); }
  const revs = factValue<number>(i.facts, 'reviewCount'), rating = factValue<number>(i.facts, 'rating');
  if (reasons.length < 3 && revs && revs >= 10) reasons.push({ code: 'ACTIVE_BUSINESS', text: `Aktiver Betrieb mit ${revs} Bewertungen${rating ? ` (Ø ${String(rating).replace('.', ',')})` : ''} – Website-Verbesserungen wirken sich aus.`, evidence: 'Bewertungsdaten der Quelle' });
  if (!reasons.length) reasons.push({ code: 'LOW_NEED', text: 'Aus den Daten ergibt sich kein deutlicher Verbesserungsbedarf.', evidence: 'Keine Probleme festgestellt' });

  const offerKey = noSite ? pricing.noWebsiteOffer : pricing.existingWebsiteOffer;
  const offer = pricing.offers[offerKey];
  const upsells = a.upsells.map((u) => ({ key: u.key, label: u.label, oneTimeCents: u.oneTimeCents, monthlyCents: u.monthlyCents, reason: u.reason }));
  const months = pricing.estimate?.maintenanceMonths ?? 12;
  const oneTime = upsells.reduce((s, u) => s + u.oneTimeCents, 0), monthly = upsells.reduce((s, u) => s + u.monthlyCents, 0);
  const low = offer.priceCents;
  const high = offer.priceCents + oneTime + months * (offer.maintenanceCentsPerMonth + monthly);
  const breakdown = [`${offer.name}: ${eur(offer.priceCents)} einmalig`, ...upsells.map((u) => `${u.label}: ${u.oneTimeCents ? `${eur(u.oneTimeCents)} einmalig` : ''}${u.oneTimeCents && u.monthlyCents ? ' + ' : ''}${u.monthlyCents ? `${eur(u.monthlyCents)}/Monat` : ''}`),
    `Wartung: ${eur(offer.maintenanceCentsPerMonth)}/Monat × ${months} Monate (falls gebucht)`];

  const score = a.salesOpportunity.value;
  const pr = sales.priorities;
  let priority: SalesBrief['priority'] = score === null ? 'D' : score >= pr.A.minScore ? 'A' : score >= pr.B.minScore ? 'B' : score >= pr.C.minScore ? 'C' : 'D';
  if (i.contact.readiness === 'DO_NOT_CONTACT') priority = 'D';
  else if (priority === 'A' && i.contact.readiness !== 'READY_FOR_MANUAL_CALL') priority = 'B';

  const top = reasons[0];
  const fill = (s: string) => s.replace('{price}', eur(offer.priceCents)).replace('{maintenance}', eur(offer.maintenanceCentsPerMonth)).replace('{top_reason}', top.text.replace(/\.$/, ''));
  const hasSocial = i.facts.some((f) => f.key === 'social');
  const objections = (sales.objections as any[]).filter((o) => o.when === 'always' || (o.when === 'has_website' && !noSite) || (o.when === 'no_website' && noSite) || (o.when === 'social_present' && hasSocial))
    .slice(0, 4).map((o) => ({ objection: o.objection, response: fill(o.response) }));

  const sender = i.callerName && !findPlaceholders(i.callerName).length ? i.callerName : sales.defaultSender;
  const reasonText = reasons.filter((r) => r.code !== 'LOW_NEED').slice(0, 2).map((r) => r.text.replace(/\.$/, '')).join('; ');
  const opener = noSite
    ? `Guten Tag, hier ist ${sender}. Ich habe gesehen, dass ${i.company} online keine eigene Website hinterlegt hat. Ich habe einen unverbindlichen Entwurf vorbereitet – darf ich Ihnen in zwei Minuten zeigen, wie das aussehen könnte?`
    : `Guten Tag, hier ist ${sender}. Beim Blick auf die Website von ${i.company} ist mir aufgefallen: ${reasonText || 'kleinere Verbesserungsmöglichkeiten'}. Ich habe einen unverbindlichen Entwurf vorbereitet – darf ich Ihnen in zwei Minuten zeigen, wie das einfacher gehen könnte?`;

  return {
    priority, priorityLabel: pr[priority].label, reasons, service: { offerKey, name: offer.name, priceCents: offer.priceCents, upsells },
    valueRange: { lowCents: low, highCents: high, estimate: true, label: pricing.estimate?.label ?? 'Schätzung', breakdown },
    opener, openerSource: 'rules', objections, nextAction: { code: i.contact.readiness, text: sales.nextActions[i.contact.readiness] }, needsHumanApproval: true,
  };
}

const FORBIDDEN = /garantier|umsatz|platz\s*1|erste[rn]?\s+platz|%|€|\bEuro\b|kostenlos|gratis/i;
/**
 * Optional: Die KI formuliert den Gesprächseinstieg. Verworfen wird die Antwort, wenn sie Befund-Codes nennt, die es nicht gibt,
 * keine nennt, Zahlen/Preise/Versprechen enthält oder kein gültiges JSON ist. Dann bleibt der Regeltext.
 */
export async function polishOpener(brief: SalesBrief, ctx: { company: string; callerName?: string }, ai: { complete: (leadId: string, r: Parameters<AIProvider['complete']>[0]) => Promise<{ text: string }> }, leadKey: string): Promise<SalesBrief> {
  const allowed = brief.reasons.filter((r) => r.code !== 'LOW_NEED').map((r) => r.code);
  if (!allowed.length) return brief;
  const prompt = ['Formuliere einen höflichen, kurzen deutschen Gesprächseinstieg (max. 3 Sätze) für einen telefonischen Erstkontakt.',
    'Verwende AUSSCHLIESSLICH die folgenden belegten Fakten. Erfinde nichts. Keine Preise, keine Prozentangaben, keine Versprechen zu Umsatz oder Ranking.',
    'Antworte nur als JSON: {"opener": "...", "used_codes": ["CODE"]}', 'FACTS_JSON:',
    JSON.stringify({ company: ctx.company, sender: ctx.callerName, reasons: brief.reasons.filter((r) => r.code !== 'LOW_NEED').map((r) => ({ code: r.code, text: r.text })) })].join('\n');
  try {
    const res = await ai.complete(leadKey, { task: 'sales_opener', prompt, maxTokens: 300, tier: 'MASS', purpose: 'contact' });
    const raw = res.text;
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { opener?: string; used_codes?: string[] };
    const ok = typeof j.opener === 'string' && j.opener.length > 20 && j.opener.length < 700 && Array.isArray(j.used_codes) && j.used_codes.length > 0 && j.used_codes.every((c) => allowed.includes(c)) && !FORBIDDEN.test(j.opener);
    return ok ? { ...brief, opener: j.opener!, openerSource: 'ai' } : brief;
  } catch { return brief; }
}
