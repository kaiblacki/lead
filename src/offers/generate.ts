import { findPlaceholders } from '../core/text.ts';

export type OfferPricing = {
  offers: Record<string, { name: string; priceCents: number; depositCents: number; maintenanceCentsPerMonth: number; scope: string[]; revisionRounds: number; deliveryNote: string }>;
  offerValidDays: number; vatNote: string; maintenanceScope: string[]; termsDraft: string[];
  upsells?: { key: string; label: string; oneTimeCents: number; monthlyCents: number }[];
};

export type Offer = {
  title: string;                       // Leistung
  customer: { name: string; address?: string };
  scope: string[];                     // Leistungsumfang
  priceCents: number; depositCents: number; finalCents: number;
  maintenanceCentsPerMonth: number; maintenanceScope: string[];
  revisionRounds: number;              // Änderungsumfang
  deliveryNote: string;
  validUntil: string;
  vatNote: string;
  terms: string[];
  optional: { label: string; oneTimeCents: number; monthlyCents: number }[];   // Zusatzleistungen, nicht im Preis enthalten
  demoUrl?: string;
  warnings: string[];
};

/** Baut ein Angebot aus der zentralen Preis-Konfiguration. Nichts ist im Code fest verdrahtet. */
export function buildOffer(customer: { name: string; address?: string }, offerName: string, pricing: OfferPricing, opts: { now?: Date; upsellKeys?: string[]; demoUrl?: string } = {}): Offer {
  const o = Object.values(pricing.offers).find((x) => x.name === offerName);
  if (!o) throw new Error(`Angebot "${offerName}" ist in der Preis-Konfiguration nicht vorhanden`);
  if (o.depositCents < 0 || o.depositCents > o.priceCents) throw new Error('Anzahlung muss zwischen 0 und dem Gesamtpreis liegen');
  const valid = new Date((opts.now ?? new Date()).getTime() + pricing.offerValidDays * 86400000);
  const offer: Offer = {
    title: o.name, customer, scope: o.scope, priceCents: o.priceCents, depositCents: o.depositCents, finalCents: o.priceCents - o.depositCents,
    maintenanceCentsPerMonth: o.maintenanceCentsPerMonth, maintenanceScope: pricing.maintenanceScope, revisionRounds: o.revisionRounds, deliveryNote: o.deliveryNote,
    validUntil: valid.toISOString().slice(0, 10), vatNote: pricing.vatNote, terms: pricing.termsDraft,
    optional: (pricing.upsells ?? []).filter((u) => opts.upsellKeys?.includes(u.key)).map((u) => ({ label: u.label, oneTimeCents: u.oneTimeCents, monthlyCents: u.monthlyCents })),
    demoUrl: opts.demoUrl, warnings: [],
  };
  if (findPlaceholders({ ...offer, demoUrl: undefined }).length) offer.warnings.push('Platzhalter in config/pricing.json (Lieferzeit, USt-Hinweis, Bedingungen) müssen vor Freigabe und Versand ersetzt werden.');
  return offer;
}
