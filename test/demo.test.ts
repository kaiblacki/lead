import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TEMPLATES, GENERIC, pickTemplate, contrast } from '../src/templates/index.ts';
import { renderDemo, demoWarnings } from '../src/demo/render.ts';
import { buildOffer, type OfferPricing } from '../src/offers/generate.ts';
import type { Lead } from '../src/core/types.ts';

const agency = { name: 'Muster Agentur', contactEmail: 'hallo@muster.example' };
const pricing: OfferPricing = JSON.parse(readFileSync(new URL('../config/pricing.json', import.meta.url), 'utf8'));
const lead = (o: Partial<Lead> = {}): Lead => ({ id: 'x', companyName: 'Salon Müller', city: 'Saarbrücken', address: 'Hauptstr. 1', phone: '0681 123456', source: 't', industry: 'Friseur', ...o });

test('Template-Auswahl nach Branche/Name, Fallback allgemein', () => {
  assert.equal(pickTemplate('Friseur').key, 'friseur');
  assert.equal(pickTemplate(undefined, 'Zahnarztpraxis Dr. X').key, 'zahnarzt');
  assert.equal(pickTemplate('Bäckerei').key, 'allgemein');
});

test('Alle Templates: Kontrast mindestens 4.5:1 (Text, Button)', () => {
  for (const t of [...TEMPLATES, GENERIC]) {
    assert.ok(contrast(t.palette.ink, t.palette.bg) >= 4.5, `${t.key} Text`);
    assert.ok(contrast(t.palette.primaryText, t.palette.primary) >= 4.5, `${t.key} Button`);
    assert.ok(contrast(t.palette.primary, '#ffffff') >= 4.5, `${t.key} weißer Button`);
    assert.ok(contrast(t.palette.ink, t.palette.soft) >= 4.5, `${t.key} Karten`);
  }
});

test('Demo: gekennzeichnet, noindex, eigenständig, ohne fremde Ressourcen', () => {
  for (const t of [...TEMPLATES, GENERIC]) {
    const html = renderDemo(lead(), t, agency);
    assert.match(html, /Unverbindliche Demo \/ Beispiel/);
    assert.match(html, /noindex,nofollow/);
    assert.match(html, /name="viewport"/);
    assert.doesNotMatch(html, /<script|<img|<link|@import|https?:\/\//i);
    assert.match(html, /Salon Müller/);
  }
});

test('Demo: fremde Eingaben werden maskiert, Telefonlink bereinigt, nur Lead-Fakten', () => {
  const html = renderDemo(lead({ companyName: '<script>alert(1)</script> & Co', phone: '0681 "12"' , openingHours: undefined }), TEMPLATES[0], agency);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="tel:0681(?:12)?"|href="tel:068112"/);
  assert.match(html, /folgen \(Beispielentwurf\)/);   // keine erfundenen Öffnungszeiten
  assert.doesNotMatch(renderDemo(lead({ phone: undefined }), TEMPLATES[0], agency), /href="tel:/);
});

test('Demo-Warnungen bei Platzhaltern', () => {
  const html = renderDemo(lead({ phone: undefined }), TEMPLATES[0], { name: '[Name deiner Agentur]', contactEmail: 'a@b.de' });
  assert.equal(demoWarnings(html).length, 2);
  assert.equal(demoWarnings(renderDemo(lead(), TEMPLATES[0], agency)).length, 0);
});

test('Angebot: Summen stimmen, Gültigkeit, Platzhalter-Warnung, unbekanntes Angebot wirft', () => {
  const o = buildOffer(lead(), { offerName: 'Website Modernisierung' }, pricing, new Date('2026-06-01'));
  assert.equal(o.priceCents, 129000); assert.equal(o.depositCents + o.finalCents, o.priceCents);
  assert.equal(o.finalCents, 90000); assert.equal(o.maintenanceCentsPerMonth, 4900);
  assert.equal(o.validUntil, '2026-06-15');
  assert.ok(o.warnings.length === 1);
  const changed = buildOffer(lead(), { offerName: 'Website Starter' }, { ...pricing, offers: { a: { ...pricing.offers.website_starter, priceCents: 100000, depositCents: 25000 } } }, new Date('2026-06-01'));
  assert.equal(changed.finalCents, 75000);
  assert.throws(() => buildOffer(lead(), { offerName: 'Gibt es nicht' }, pricing));
  assert.throws(() => buildOffer(lead(), { offerName: 'Website Starter' }, { ...pricing, offers: { a: { ...pricing.offers.website_starter, depositCents: 999999 } } }), /Anzahlung/);
});
