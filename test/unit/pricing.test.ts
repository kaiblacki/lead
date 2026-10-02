import { test } from 'node:test';
import assert from 'node:assert/strict';
import { communityFee, computeQuote, suggestAddons } from '../../src/pricing/quote.ts';
import { buildOfferFromQuote } from '../../src/offers/from-quote.ts';
import { loadConfig } from '../../src/core/config.ts';
import { insuranceCoupling } from '../../src/core/compliance.ts';

const cfg = loadConfig(); const mock = loadConfig('config.mock');
const q = (o: object) => computeQuote(cfg, { package: 'BUSINESS', ...o });

test('Pakete und Preise zentral konfiguriert (INTERNAL_DRAFT_PRICE): Starter 790, Business 1.490, Pro 2.490; Wartung 39/69/119; Community 29/290', () => {
  const P = cfg.packages; assert.equal(P.status, 'INTERNAL_DRAFT_PRICE');
  assert.deepEqual(Object.fromEntries(Object.entries(P.packages).map(([k, v]: [string, any]) => [k, v.priceCents])), { STARTER: 79000, BUSINESS: 149000, PRO: 249000 });
  assert.deepEqual(Object.fromEntries(Object.entries(P.care).map(([k, v]: [string, any]) => [k, v.monthlyCents])), { CARE: 3900, CARE_PLUS: 6900, GROWTH: 11900 });
  const add = (k: string) => P.addons[k].priceCents; assert.deepEqual(['extra_page', 'whatsapp_cta', 'location_map', 'gallery', 'social_links', 'menu', 'online_booking', 'reservation', 'quote_request', 'callback', 'newsletter', 'jobs', 'extra_language', 'local_seo', 'analytics_setup'].map(add), [9900, 3900, 3900, 7900, 3900, 9900, 14900, 14900, 14900, 7900, 12900, 19900, 19900, 24900, 7900]);
  assert.deepEqual([P.community.monthlyCents, P.community.yearlyCents, P.community.freeFor], [2900, 29000, ['ACTIVE_PARTNER']]); assert.equal(P.partnerDiscount.percent, 50); assert.equal(P.partnerDiscount.reason, 'ACTIVE_PARTNER');
});

test('Partnerpreis 50 % nur auf den Basispreis: 790→395, 1.490→745, 2.490→1.245 – nur für ACTIVE_PARTNER und nach Freigabe; Extras, Wartung, Fremdkosten regulär', () => {
  for (const [pkg, normal, partner] of [['STARTER', 79000, 39500], ['BUSINESS', 149000, 74500], ['PRO', 249000, 124500]] as const) {
    const r = computeQuote(cfg, { package: pkg, partnerStatus: 'ACTIVE_PARTNER', partnerDiscountApproved: true });
    assert.equal(r.normalPriceCents, normal); assert.equal(r.oneTimeCents, partner, pkg); assert.equal(r.partner_discount.cents, normal - partner); assert.equal(r.partner_discount.reason, 'ACTIVE_PARTNER'); assert.equal(r.partner_discount.applied, true);
  }
  const x = q({ partnerStatus: 'ACTIVE_PARTNER', partnerDiscountApproved: true, addons: [{ key: 'whatsapp_cta' }, { key: 'online_booking' }, { key: 'extra_page', quantity: 2 }], care: 'CARE_PLUS', thirdParty: [{ label: 'Domain', cents: 1500, monthly: false }, { label: 'Buchungstool', cents: 900, monthly: true }] });
  assert.equal(x.package.normalCents, 149000); assert.equal(x.partner_discount.cents, 74500); assert.equal(x.addonsCents, 3900 + 14900 + 2 * 9900, 'Extras regulär'); assert.equal(x.oneTimeCents, 74500 + 3900 + 14900 + 19800); assert.equal(x.monthlyCents, 6900, 'Wartung regulär');
  assert.equal(x.thirdPartyOneTimeCents, 1500); assert.equal(x.thirdPartyMonthlyCents, 900); assert.equal(x.totalCents, x.oneTimeCents + 1500); assert.equal(x.depositCents, Math.round(x.oneTimeCents * 0.3)); assert.equal(x.depositCents + x.finalCents, x.oneTimeCents);
  // ohne Freigabe / ohne aktiven Partner kein Rabatt
  assert.equal(q({ partnerStatus: 'ACTIVE_PARTNER', partnerDiscountApproved: false }).oneTimeCents, 149000); assert.match(q({ partnerStatus: 'ACTIVE_PARTNER' }).partner_discount.note, /noch nicht freigegeben/);
  for (const st of [undefined, null, 'NONE', 'PARTNER_CANDIDATE', 'PARTNER_APPROVED', 'PAUSED_PARTNER', 'ENDED_PARTNER']) { const r = q({ partnerStatus: st, partnerDiscountApproved: true }); assert.equal(r.oneTimeCents, 149000, String(st)); assert.equal(r.partner_discount.applied, false); }
});

test('Konfigurator: Add-ons hinzufügen/entfernen/Preis überschreiben, im Paket enthaltene Bausteine, Wartung und Paketpreis überschreibbar; ungültige Eingaben abgelehnt', () => {
  assert.equal(q({ addons: [{ key: 'gallery' }] }).addonsCents, 0, 'Galerie im Business-Paket enthalten'); assert.equal(computeQuote(cfg, { package: 'STARTER', addons: [{ key: 'gallery' }] }).addonsCents, 7900);
  assert.equal(q({ addons: [{ key: 'gallery', priceOverrideCents: 5000 }] }).addonsCents, 5000, 'Überschreiben gilt auch bei enthaltenem Baustein'); assert.equal(q({ addons: [{ key: 'local_seo', priceOverrideCents: 0 }] }).addonsCents, 0);
  assert.equal(q({ packagePriceOverrideCents: 120000 }).oneTimeCents, 120000); assert.equal(q({ packagePriceOverrideCents: 120000 }).package.overridden, true); assert.equal(q({ care: 'GROWTH', carePriceOverrideCents: 9900 }).monthlyCents, 9900);
  assert.equal(computeQuote(cfg, { package: 'PRO', partnerStatus: 'ACTIVE_PARTNER', partnerDiscountApproved: true, packagePriceOverrideCents: 200000 }).partner_discount.cents, 100000, 'Rabatt auf den (überschriebenen) Basispreis');
  assert.throws(() => q({ addons: [{ key: 'nope' }] }), /Unbekanntes Add-on/); assert.throws(() => computeQuote(cfg, { package: 'X' }), /Unbekanntes Paket/); assert.throws(() => q({ addons: [{ key: 'callback' }, { key: 'callback' }] }), /doppelt/);
  assert.throws(() => q({ addons: [{ key: 'extra_page', quantity: 0 }] }), /Menge/); assert.throws(() => q({ packagePriceOverrideCents: -5 }), /Betrag/); assert.throws(() => q({ care: 'X' }), /Wartungspaket/); assert.throws(() => q({ thirdParty: [{ label: '', cents: 100 }] }), /Bezeichnung/);
  assert.deepEqual(suggestAddons(cfg, 'STARTER', ['booking', 'gallery', 'map', 'menu']).sort(), ['gallery', 'menu', 'online_booking']);
});

test('Keine Versicherungs-Kopplung: manueller Rabatt braucht eine Begründung ohne Versicherungsbezug; Partnerpreis-Grund ist immer ACTIVE_PARTNER; Community nur für aktive Partner kostenlos', () => {
  const ok = q({ manualDiscount: { percent: 10, reason: 'Kulanz nach Gespräch' } }); assert.equal(ok.partner_discount.reason, 'MANUAL'); assert.equal(ok.partner_discount.cents, 14900); assert.equal(ok.oneTimeCents, 134100);
  for (const bad of ['Bei Abschluss einer Versicherung', 'INSURANCE_CUSTOMER', 'Versicherungsnehmer', 'Vollkunde']) assert.throws(() => q({ manualDiscount: { percent: 10, reason: bad } }), /Versicherung/, bad);
  assert.throws(() => q({ manualDiscount: { percent: 10, reason: 'ok' } }), /Begründung/); assert.throws(() => q({ manualDiscount: { percent: 120, reason: 'Kulanz nach Gespräch' } }), /0 bis 100/);
  assert.equal(communityFee(cfg, 'ACTIVE_PARTNER').free, true); assert.equal(communityFee(cfg, 'ACTIVE_PARTNER').monthlyCents, 0); for (const st of [null, 'NONE', 'PARTNER_CANDIDATE', 'PAUSED_PARTNER']) { const f = communityFee(cfg, st); assert.equal(f.free, false); assert.equal(f.monthlyCents, 2900); assert.equal(f.yearlyCents, 29000); }
});

test('Angebot aus dem Konfigurator: Leistungsumfang, Preise, Partnerpreis, Zahlungsplan, Ablauf, Voraussetzungen – kein Marktpreis, keine Versicherungs-Kopplung; Platzhalter blockieren', () => {
  const quote = q({ partnerStatus: 'ACTIVE_PARTNER', partnerDiscountApproved: true, addons: [{ key: 'whatsapp_cta' }], care: 'CARE', thirdParty: [{ label: 'Domain', cents: 1500 }] });
  const o = buildOfferFromQuote(mock, quote, { customer: { name: 'Salon Muster', address: 'Hauptstr. 1' }, now: new Date('2026-06-01T10:00:00Z') });
  assert.equal(o.priceCents, 74500 + 3900); assert.equal(o.partnerDiscount!.reason, 'ACTIVE_PARTNER'); assert.equal(o.partnerDiscount!.cents, 74500); assert.equal(o.maintenanceCentsPerMonth, 3900); assert.equal(o.depositCents + o.finalCents, o.priceCents);
  assert.ok(o.scope.some((s) => /Zusatz: WhatsApp-CTA/.test(s))); assert.ok(o.process.length >= 6); assert.ok(o.prerequisites.length >= 2); assert.equal(o.revisionRounds, 2); assert.equal(o.thirdParty[0].label, 'Domain'); assert.equal(o.internalDraft, true); assert.deepEqual(o.warnings, [], 'config.mock: keine Platzhalter');
  const json = JSON.stringify(o); assert.doesNotMatch(json, /Marktrichtwert|2\.800|280000|Median|Agentur-Stichprobe|1\.500–7\.000/, 'interner Marktrichtwert nie im Kundenangebot'); assert.equal(insuranceCoupling(json.replace(/[{}\[\]"]/g, ' ')), null); assert.doesNotMatch(json, /INSURANCE|Versicherung/i);
  const real = buildOfferFromQuote(cfg, quote, { customer: { name: 'X' } }); assert.equal(real.warnings.length, 1); assert.match(real.warnings[0], /Platzhalter/);
});
