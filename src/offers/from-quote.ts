import { findPlaceholders } from '../core/text.ts';
import { assertNoInsuranceCoupling } from '../core/compliance.ts';
import type { Offer } from './generate.ts';
import type { Quote } from '../pricing/quote.ts';

/** Erweitertes Angebot aus dem Preis-Konfigurator. Bleibt kompatibel zum bestehenden Angebot (Auftrag, Zahlungen, Anzeige). */
export type OfferV2 = Offer & {
  quoteBased: true; packageKey: string; priceStatus: string; internalDraft: boolean;
  lines: { label: string; cents: number; monthly?: boolean; note?: string }[];
  partnerDiscount: { applied: boolean; percent: number; cents: number; baseCents: number; reason: string | null } | null;
  addons: { label: string; cents: number; note?: string }[];
  thirdParty: { label: string; cents: number; monthly: boolean }[];
  paymentPlan: { depositCents: number; finalCents: number; depositPercent: number };
  process: string[]; prerequisites: string[]; maintenanceTerm: string; thirdPartyNote: string;
};

/**
 * Baut den Angebotsentwurf aus dem Konfigurator. Es kommt NIE ein Marktpreis in das Kundenangebot (marketReference bleibt intern).
 * Platzhalter (Lieferzeit, USt-Hinweis, Bedingungen, Wartungslaufzeit) aus config/pricing.json erzeugen eine Warnung und blockieren Freigabe/Versand.
 */
export function buildOfferFromQuote(cfg: any, q: Quote, o: { customer: { name: string; address?: string }; demoUrl?: string; now?: Date }): OfferV2 {
  const P = cfg.packages, pricing = cfg.pricing; const pkg = P.packages[q.package.key];
  const valid = new Date((o.now ?? new Date()).getTime() + (pricing.offerValidDays ?? 14) * 86400000);
  const care = q.lines.find((l) => l.kind === 'CARE');
  const addons = q.lines.filter((l) => l.kind === 'ADDON').map((l) => ({ label: l.label, cents: l.cents, note: l.note }));
  const pd = q.partner_discount;
  const offer: OfferV2 = {
    quoteBased: true, packageKey: q.package.key, priceStatus: q.priceStatus, internalDraft: q.priceStatus === 'INTERNAL_DRAFT_PRICE',
    title: `Website ${pkg.label}`, customer: o.customer,
    scope: [...pkg.includes, ...addons.map((a) => `Zusatz: ${a.label}`)],
    priceCents: q.oneTimeCents, depositCents: q.depositCents, finalCents: q.finalCents,
    maintenanceCentsPerMonth: q.monthlyCents - 0, maintenanceScope: care ? P.care[care.key!].includes : [], revisionRounds: pkg.revisionRounds,
    deliveryNote: pricing.deliveryNote ?? Object.values<any>(pricing.offers)[0]?.deliveryNote ?? '[Lieferzeit festlegen]',
    validUntil: valid.toISOString().slice(0, 10), vatNote: pricing.vatNote, terms: pricing.termsDraft, optional: [], demoUrl: o.demoUrl, warnings: [],
    lines: q.lines.filter((l) => l.kind !== 'THIRD_PARTY').map((l) => ({ label: l.label, cents: l.cents, monthly: l.monthly, note: l.note })),
    partnerDiscount: pd.applied ? { applied: true, percent: pd.percent, cents: pd.cents, baseCents: pd.baseCents, reason: pd.reason } : null,
    addons, thirdParty: q.lines.filter((l) => l.kind === 'THIRD_PARTY').map((l) => ({ label: l.label, cents: l.cents, monthly: !!l.monthly })),
    paymentPlan: { depositCents: q.depositCents, finalCents: q.finalCents, depositPercent: P.paymentPlan.depositPercent },
    process: P.process, prerequisites: P.prerequisites, maintenanceTerm: pricing.maintenanceTerm ?? '[Laufzeit der Wartung festlegen]', thirdPartyNote: P.thirdPartyNote,
  };
  if (findPlaceholders({ ...offer, demoUrl: undefined }).length) offer.warnings.push('Platzhalter in config/pricing.json (Lieferzeit, USt-Hinweis, Bedingungen, Wartungslaufzeit) müssen vor Freigabe und Versand ersetzt werden.');
  assertNoInsuranceCoupling(JSON.stringify(offer).replace(/[{}\[\]"]/g, ' '));
  return offer;
}
