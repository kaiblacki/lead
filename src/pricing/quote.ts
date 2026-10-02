/**
 * Preis-Konfigurator (rein): Paket + Add-ons + Wartung + Partnerstatus → Normalpreis, Partner-Rabatt, Add-ons, Einmalpreis, monatlicher Preis, Drittanbieter, Gesamt.
 * Alle Preise kommen aus config/packages.json (INTERNAL_DRAFT_PRICE) und sind pro Position überschreibbar.
 * Partner-Rabatt (separat sichtbar als `partner_discount`): nur auf den Basispreis des Pakets und nur bei ACTIVE_PARTNER nach manueller Freigabe. Grund ausschließlich `ACTIVE_PARTNER`
 * (oder ausdrücklich manuell von Kai, nie mit Versicherungsbezug). Extras, Fremdkosten und Wartung bleiben regulär.
 */
import { assertAllowedBenefitReason } from '../core/compliance.ts';

export type AddonSel = { key: string; quantity?: number; priceOverrideCents?: number | null };
export type ThirdPartySel = { label: string; cents: number; monthly?: boolean };
export type QuoteSelection = {
  package: string; packagePriceOverrideCents?: number | null; addons?: AddonSel[]; care?: string | null; carePriceOverrideCents?: number | null;
  thirdParty?: ThirdPartySel[]; partnerStatus?: string | null; partnerDiscountApproved?: boolean; manualDiscount?: { percent: number; reason: string } | null;
};
export type QuoteLine = { kind: 'PACKAGE' | 'ADDON' | 'CARE' | 'THIRD_PARTY'; key?: string; label: string; cents: number; monthly?: boolean; note?: string; overridden?: boolean };
export type PartnerDiscount = { eligible: boolean; approved: boolean; applied: boolean; percent: number; baseCents: number; cents: number; reason: 'ACTIVE_PARTNER' | 'MANUAL' | null; note: string };
export type Quote = {
  package: { key: string; label: string; normalCents: number; baseCents: number; overridden: boolean };
  lines: QuoteLine[]; partner_discount: PartnerDiscount;
  normalPriceCents: number; addonsCents: number; oneTimeCents: number; monthlyCents: number; thirdPartyOneTimeCents: number; thirdPartyMonthlyCents: number; totalCents: number;
  depositCents: number; finalCents: number; priceStatus: string; warnings: string[];
};

const intCents = (n: unknown, what: string) => { if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 100_000_00) throw new Error(`${what}: Betrag in Cent (ganze Zahl 0 bis 100.000 €) erwartet.`); return n; };

export function computeQuote(cfg: any, sel: QuoteSelection): Quote {
  const P = cfg.packages; const pkg = P.packages[sel.package]; if (!pkg) throw new Error(`Unbekanntes Paket: ${sel.package}`);
  const lines: QuoteLine[] = []; const warnings: string[] = [];
  const normal = pkg.priceCents as number; const base = sel.packagePriceOverrideCents == null ? normal : intCents(sel.packagePriceOverrideCents, 'Paketpreis');
  lines.push({ kind: 'PACKAGE', key: sel.package, label: `Paket ${pkg.label}`, cents: base, overridden: base !== normal, note: pkg.pages });

  let addons = 0; const seen = new Set<string>();
  for (const a of sel.addons ?? []) {
    const def = P.addons[a.key]; if (!def) throw new Error(`Unbekanntes Add-on: ${a.key}`); if (seen.has(a.key)) throw new Error(`Add-on doppelt: ${a.key}`); seen.add(a.key);
    const qty = a.quantity ?? 1; if (!Number.isInteger(qty) || qty < 1 || qty > 50) throw new Error('Menge: 1 bis 50.');
    const included = (def.includedIn as string[] | undefined)?.includes(sel.package);
    const unit = a.priceOverrideCents == null ? def.priceCents as number : intCents(a.priceOverrideCents, def.label);
    const cents = included && a.priceOverrideCents == null ? 0 : unit * qty;
    addons += cents; lines.push({ kind: 'ADDON', key: a.key, label: `${def.label}${qty > 1 ? ` × ${qty}` : ''}`, cents, overridden: a.priceOverrideCents != null, note: included && a.priceOverrideCents == null ? `im Paket ${pkg.label} enthalten` : def.thirdParty ? 'Drittanbieter-Kosten ggf. separat' : undefined });
  }

  // Partner-Rabatt: nur Basispreis, nur ACTIVE_PARTNER, nur nach Freigabe
  const rule = P.partnerDiscount; const eligible = sel.partnerStatus === rule.requiresStatus;
  const approved = !!sel.partnerDiscountApproved;
  let pd: PartnerDiscount = { eligible, approved, applied: false, percent: 0, baseCents: base, cents: 0, reason: null, note: eligible ? (approved ? '' : 'Partnerpreis möglich – noch nicht freigegeben (manuelle Freigabe vor dem Angebot).') : 'Kein aktiver Partner – kein Partnerpreis.' };
  if (sel.manualDiscount) {
    const pc = sel.manualDiscount.percent; if (typeof pc !== 'number' || !(pc >= 0 && pc <= 100)) throw new Error('Manueller Rabatt: 0 bis 100 %.');
    const why = String(sel.manualDiscount.reason ?? '').trim(); if (why.length < 5) throw new Error('Manueller Rabatt braucht eine Begründung (mind. 5 Zeichen).'); assertAllowedBenefitReason(why);
    pd = { eligible, approved: true, applied: pc > 0, percent: pc, baseCents: base, cents: Math.round(base * pc / 100), reason: 'MANUAL', note: `Manuell von Kai festgelegt: ${why}` };
  } else if (eligible && approved) {
    pd = { eligible, approved, applied: true, percent: rule.percent, baseCents: base, cents: Math.round(base * rule.percent / 100), reason: rule.reason, note: rule.note };
  }
  if (pd.applied) lines.push({ kind: 'PACKAGE', key: 'partner_discount', label: `Partner-Rabatt ${pd.percent} % auf den Basispreis (${pd.reason})`, cents: -pd.cents, note: 'Nur auf den Basispreis; Extras, Wartung und Fremdkosten regulär' });

  let monthly = 0;
  if (sel.care) { const c = P.care[sel.care]; if (!c) throw new Error(`Unbekanntes Wartungspaket: ${sel.care}`); const m = sel.carePriceOverrideCents == null ? c.monthlyCents as number : intCents(sel.carePriceOverrideCents, 'Wartungspreis'); monthly += m; lines.push({ kind: 'CARE', key: sel.care, label: `Wartung ${c.label}`, cents: m, monthly: true, overridden: sel.carePriceOverrideCents != null }); }
  let tpOne = 0, tpMonthly = 0;
  for (const t of sel.thirdParty ?? []) { const l = String(t.label ?? '').trim(); if (!l) throw new Error('Drittanbieter-Position braucht eine Bezeichnung.'); const c = intCents(t.cents, l); lines.push({ kind: 'THIRD_PARTY', label: l, cents: c, monthly: !!t.monthly, note: 'Fremdkosten, nicht rabattiert' }); if (t.monthly) tpMonthly += c; else tpOne += c; }

  const oneTime = base - pd.cents + addons; const total = oneTime + tpOne;
  const deposit = Math.round(oneTime * (P.paymentPlan.depositPercent / 100));
  if (P.status === 'INTERNAL_DRAFT_PRICE') warnings.push('INTERNAL_DRAFT_PRICE: Preise sind interne Entwürfe und von Kai noch nicht final bestätigt.');
  return { package: { key: sel.package, label: pkg.label, normalCents: normal, baseCents: base, overridden: base !== normal }, lines, partner_discount: pd, normalPriceCents: normal, addonsCents: addons, oneTimeCents: oneTime, monthlyCents: monthly,
    thirdPartyOneTimeCents: tpOne, thirdPartyMonthlyCents: tpMonthly, totalCents: total, depositCents: deposit, finalCents: oneTime - deposit, priceStatus: P.status, warnings };
}

/** Vorschläge: Add-ons, deren Baustein in den (empfohlenen/gewählten) Demo-Modulen vorkommt und die nicht im Paket enthalten sind. */
export function suggestAddons(cfg: any, pkg: string, modules: string[]): string[] {
  return Object.entries(cfg.packages.addons as Record<string, any>).filter(([, a]) => a.module && modules.includes(a.module) && !(a.includedIn as string[] | undefined)?.includes(pkg)).map(([k]) => k);
}
/** Community-Gebühr: kostenlos für aktive Partner – nie wegen eines Versicherungsvertrags. */
export function communityFee(cfg: any, partnerStatus: string | null | undefined): { monthlyCents: number; yearlyCents: number; free: boolean; reason: string } {
  const c = cfg.packages.community; const free = (c.freeFor as string[]).includes(partnerStatus ?? '');
  return { monthlyCents: free ? 0 : c.monthlyCents, yearlyCents: free ? 0 : c.yearlyCents, free, reason: free ? partnerStatus! : '' };
}
