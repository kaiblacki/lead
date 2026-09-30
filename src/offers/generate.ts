import type { Lead } from '../core/types.ts';
import type { SalesPackage } from '../ai/sales.ts';

export type OfferPricing = {
  offers: Record<string, { name: string; priceCents: number; depositCents: number; maintenanceCentsPerMonth: number; scope: string[]; revisionRounds: number; deliveryNote: string }>;
  offerValidDays: number; vatNote: string; maintenanceScope: string[]; termsDraft: string[];
};

export type Offer = {
  title: string;
  company: string;
  scope: string[];
  priceCents: number;
  depositCents: number;
  finalCents: number;
  maintenanceCentsPerMonth: number;
  maintenanceScope: string[];
  revisionRounds: number;
  deliveryNote: string;
  validUntil: string;
  vatNote: string;
  terms: string[];
  warnings: string[];
};

/** Baut ein Angebot aus der zentralen Preis-Konfiguration. Nichts ist im Code fest verdrahtet. */
export function buildOffer(lead: Lead, pkg: Pick<SalesPackage, 'offerName'>, pricing: OfferPricing, now = new Date()): Offer {
  const o = Object.values(pricing.offers).find((x) => x.name === pkg.offerName);
  if (!o) throw new Error(`Angebot "${pkg.offerName}" ist in der Preis-Konfiguration nicht vorhanden`);
  if (o.depositCents < 0 || o.depositCents > o.priceCents) throw new Error('Anzahlung muss zwischen 0 und dem Gesamtpreis liegen');
  const valid = new Date(now.getTime() + pricing.offerValidDays * 86400000);
  const offer: Offer = {
    title: o.name, company: lead.companyName, scope: o.scope, priceCents: o.priceCents, depositCents: o.depositCents,
    finalCents: o.priceCents - o.depositCents, maintenanceCentsPerMonth: o.maintenanceCentsPerMonth, maintenanceScope: pricing.maintenanceScope,
    revisionRounds: o.revisionRounds, deliveryNote: o.deliveryNote, validUntil: valid.toISOString().slice(0, 10), vatNote: pricing.vatNote,
    terms: pricing.termsDraft, warnings: [],
  };
  const all = JSON.stringify(offer);
  if (/\[[^\]]{3,}\]/.test(all)) offer.warnings.push('Platzhalter in config/pricing.json (Lieferzeit, USt-Hinweis, Bedingungen) müssen vor dem Versand ersetzt werden.');
  return offer;
}
