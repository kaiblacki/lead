import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allTemplates, contrast, loadTemplates, pickTemplate, templateByKey, validateTemplate, fill, SECTION_KEYS } from '../../src/site/templates.ts';
import { buildSite, demoWarnings, renderDemo } from '../../src/site/engine.ts';
import { contentFromFacts } from '../../src/site/content.ts';
import { buildOffer, type OfferPricing } from '../../src/offers/generate.ts';
import { loadConfig } from '../../src/core/config.ts';
import { buildFacts } from '../../src/core/profile.ts';
import { staticQa } from '../../src/qa/check.ts';
import { getWorld } from '../../src/fixtures/world.ts';
import { createProviders } from '../../src/providers/registry.ts';

const cfg = loadConfig();
const tax = cfg.taxonomy;
const agency = { name: 'Muster Agentur', contactEmail: 'hallo@muster.example' };
const pricing: OfferPricing = JSON.parse(readFileSync(new URL('../../config/pricing.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-06-01T10:00:00Z');
const content = (o: object = {}) => ({ companyName: 'Salon Müller', city: 'Saarbrücken', address: 'Hauptstr. 1', postalCode: '66111', phone: '0681 123456', services: [{ title: 'Herrenschnitt', text: 'Klassisch.' }], legal: {}, ...o });

test('Template-Engine: 11 Vorlagen als Datendateien, alle gewünschten Branchen vorhanden', () => {
  const keys = allTemplates().map((t) => t.key);
  for (const k of ['friseur', 'nagelstudio', 'kosmetik', 'zahnarzt', 'handwerker', 'restaurant', 'immobilien', 'autowerkstatt', 'fitness', 'versicherung', 'allgemein']) assert.ok(keys.includes(k), k);
  assert.equal(readdirSync(new URL('../../templates/', import.meta.url)).filter((f) => f.endsWith('.json')).length, keys.length);
  for (const t of allTemplates()) {
    assert.ok(t.sections[0] === 'hero' && t.sections.includes('contact') && t.sections.every((s) => SECTION_KEYS.includes(s)));
    assert.ok(t.imageLogic.mode === 'placeholder' && t.components.length && t.cta.primary && t.seo.titleFormat.includes('{name}'));
  }
  assert.notDeepEqual(templateByKey('nagelstudio').sections, templateByKey('zahnarzt').sections);   // Seitenstruktur unterscheidet sich je Branche
});

test('Vorlagen-Validierung: Kontrast, unbekannte Sektionen, fremde Bilder verboten', () => {
  const ok = JSON.parse(readFileSync(new URL('../../templates/friseur.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => validateTemplate(ok));
  assert.throws(() => validateTemplate({ ...ok, palette: { ...ok.palette, primary: '#ffff00' } }), /Kontrast/);
  assert.throws(() => validateTemplate({ ...ok, sections: ['hero', 'slider', 'contact'] }), /unbekannte Sektion/);
  assert.throws(() => validateTemplate({ ...ok, imageLogic: { ...ok.imageLogic, mode: 'stock' } }), /keine fremden Bilder/);
  assert.throws(() => validateTemplate({ ...ok, sections: ['services', 'contact'] }), /hero/);
  assert.throws(() => validateTemplate({ ...ok, key: 'Ungültig Key' }), /key/);
  assert.ok(contrast('#000000', '#ffffff') > 20);
});

test('Vorlagen laden aus beliebigem Verzeichnis (Kunden-/Branchenvorlagen ohne Code)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpl-'));
  const base = JSON.parse(readFileSync(new URL('../../templates/allgemein.json', import.meta.url), 'utf8'));
  writeFileSync(join(dir, 'allgemein.json'), JSON.stringify(base)); writeFileSync(join(dir, 'bäcker.json'), JSON.stringify({ ...base, key: 'baecker', label: 'Bäckerei' }));
  process.env.TEMPLATES_DIR = dir;
  try { assert.deepEqual([...loadTemplates().keys()].sort(), ['allgemein', 'baecker']); } finally { delete process.env.TEMPLATES_DIR; }
  const empty = mkdtempSync(join(tmpdir(), 'tpl-')); mkdirSync(join(empty, 'x')); process.env.TEMPLATES_DIR = empty;
  try { assert.throws(() => loadTemplates(), /allgemein/); } finally { delete process.env.TEMPLATES_DIR; }
});

test('Vorlagenwahl: Unterbranche → Stichwort → Allgemein', () => {
  assert.equal(pickTemplate({ subIndustry: 'nagelstudio' }, tax).key, 'nagelstudio');
  assert.equal(pickTemplate({ subIndustry: 'kosmetik' }, tax).key, 'kosmetik');
  assert.equal(pickTemplate({ industryText: 'Friseur' }).key, 'friseur');
  assert.equal(pickTemplate({ name: 'Zahnarztpraxis Dr. X' }).key, 'zahnarzt');
  assert.equal(pickTemplate({ industryText: 'Bäckerei' }).key, 'allgemein');
  assert.equal(fill('{name} in {city}', { name: 'A', city: undefined }), 'A');
  assert.equal(fill('{name} – {city}', { name: 'A', city: 'B' }), 'A – B');
});

test('Demo: gekennzeichnet, noindex, eigenständig, ohne fremde Ressourcen und ohne Skripte – für jede Vorlage', () => {
  for (const t of allTemplates()) {
    const h = renderDemo(content() as never, t, agency, { servicesAreExamples: true, bookingGap: true });
    assert.match(h, /Unverbindliche Demo \/ Beispiel/); assert.match(h, /noindex,nofollow/); assert.match(h, /name="viewport"/);
    assert.doesNotMatch(h, /<script|<img|<link|@import|https?:\/\//i); assert.match(h, /Salon Müller/);
    assert.match(h, /Was dieser Entwurf zeigt/);
  }
});

test('Demo: fremde Eingaben maskiert, nur Lead-Fakten, Beispiele gekennzeichnet', () => {
  const t = templateByKey('friseur');
  const h = renderDemo(content({ companyName: '<script>alert(1)</script> & Co', phone: '0681 "12"' }) as never, t, agency);
  assert.doesNotMatch(h, /<script>alert/); assert.match(h, /&lt;script&gt;/); assert.match(h, /href="tel:068112"/);
  assert.match(h, /folgen \(Beispielentwurf\)/);                       // keine erfundenen Öffnungszeiten
  assert.doesNotMatch(renderDemo(content({ phone: undefined }) as never, t, agency), /href="tel:/);
  assert.match(renderDemo(content() as never, t, agency, { servicesAreExamples: true }), /Beispiel-Inhalte/);
  assert.doesNotMatch(renderDemo(content() as never, t, agency, { servicesAreExamples: false }), /Beispiel-Inhalte/);
  assert.match(renderDemo(content() as never, t, agency, { sources: ['mock-google-places'] }), /aus öffentlichen Quellen \(mock-google-places\)/);
});

test('Demo nutzt Lead-Daten + Website-Analyse + Branche: Buchung nur bei Lücke/Branche, echte Leistungen statt Beispielen', async () => {
  const P = createProviders({}, { baseUrl: 'http://x', now: () => NOW }).providers;
  const b = getWorld().find((x) => x.subKey === 'nagelstudio' && x.inPlaces && x.inDirectory && x.phone && x.services.length)!;
  const place = (await P.places.search({ center: b.point, radiusKm: 1, keywords: [b.name], limit: 50 })).items.find((i) => i.externalId === b.id)!;
  const dir = (await P.directory.lookup(b.name, b.city))!;
  const facts = buildFacts({ place, directory: dir, searchSub: 'nagelstudio', capturedAt: NOW.toISOString() });
  const tpl = pickTemplate({ subIndustry: 'nagelstudio' }, tax);
  const { content: c, hints } = contentFromFacts(facts, tpl, tax);
  assert.equal(c.companyName, b.name); assert.equal(c.phone, place.phone); assert.ok(c.address && !c.address.includes(','));
  assert.deepEqual(c.services.map((s) => s.title), dir.services!.slice(0, 8)); assert.equal(hints.servicesAreExamples, false);
  assert.ok(hints.sources!.includes('mock-google-places') && hints.sources!.includes('mock-directory'));
  const h = renderDemo(c, tpl, agency, { ...hints, bookingGap: true });
  for (const s of b.services) assert.ok(h.includes(s.replace(/&/g, '&amp;')), s);
  assert.match(h, /Terminanfrage-Schaltfläche/); assert.match(h, /Online-Termin/);
  const noBooking = renderDemo(c, templateByKey('handwerker'), agency, { ...hints, bookingGap: false });
  assert.doesNotMatch(noBooking, /Online-Termin/);
  const bare = contentFromFacts([], tpl, tax); assert.equal(bare.hints.servicesAreExamples, true); assert.equal(bare.content.companyName, 'Ihr Unternehmen');
});

test('Demo-Warnungen bei Platzhaltern', () => {
  const t = templateByKey('friseur');
  assert.equal(demoWarnings(renderDemo(content({ phone: undefined }) as never, t, { name: '[Name deiner Agentur]', contactEmail: 'a@b.de' })).length, 2);
  assert.equal(demoWarnings(renderDemo(content() as never, t, agency)).length, 0);
});

test('Produktion: echte Seite ohne Demo-Hinweise besteht die QA; Platzhalter/Beispiele nicht', () => {
  const full = { companyName: 'Salon Müller', industryLabel: 'Friseur', address: 'Hauptstr. 1', postalCode: '66111', city: 'Saarbrücken', phone: '0681 123456', email: 'info@salon.example', openingHours: 'Di–Fr 9–18 Uhr',
    about: 'Seit vielen Jahren schneiden wir Haare in Saarbrücken.', services: [{ title: 'Herrenschnitt', text: 'Klassisch oder modern.' }], legal: { owner: 'Erika Müller', hosting: 'Vercel Inc.' } };
  for (const t of allTemplates()) {
    const files = buildSite(full, t, { hosting: 'Vercel Inc.' });
    assert.deepEqual(staticQa(files, { content: full, legalConfirmed: true }).filter((i) => i.severity === 'error'), [], t.key);
    assert.doesNotMatch(files['index.html'], /Unverbindliche Demo|Platzhalter|Beispiel|<script|https?:\/\//);
    assert.match(files['index.html'], /<title>[^<]*Salon Müller/); assert.match(files['impressum.html'], /Erika Müller/);
  }
  const withBooking = { ...full, bookingUrl: 'https://booking.example/salon' };
  for (const t of allTemplates()) { const f = buildSite(withBooking, t); assert.deepEqual(staticQa(f, { content: withBooking, legalConfirmed: true }).filter((i) => i.severity === 'error'), [], `${t.key} mit Buchungslink`); assert.match(f['index.html'], /booking\.example/); }
  const demoish = { ...full, phone: undefined, openingHours: undefined, about: undefined, services: templateByKey('friseur').services };
  const codes = new Set(staticQa(buildSite(demoish, templateByKey('friseur')), { content: demoish, legalConfirmed: false }).map((i) => i.code));
  for (const c of ['CONTENT_MISSING', 'LEGAL_NOT_CONFIRMED', 'PLACEHOLDER']) assert.ok(codes.has(c), c);
});

test('Angebot: Summen, Kunde, Änderungsumfang, Zusatzleistungen, Gültigkeit, Platzhalter-Warnung, unbekanntes Angebot', () => {
  const o = buildOffer({ name: 'Salon Müller', address: 'Hauptstr. 1' }, 'Website Modernisierung', pricing, { now: new Date('2026-06-01'), upsellKeys: ['online_booking'], demoUrl: 'http://x/d/abc' });
  assert.equal(o.priceCents, 129000); assert.equal(o.depositCents + o.finalCents, o.priceCents); assert.equal(o.finalCents, 90000); assert.equal(o.maintenanceCentsPerMonth, 4900);
  assert.equal(o.validUntil, '2026-06-15'); assert.equal(o.revisionRounds, 2); assert.equal(o.customer.name, 'Salon Müller'); assert.equal(o.optional.length, 1); assert.equal(o.optional[0].oneTimeCents, 39000);
  assert.ok(o.scope.length >= 3 && o.warnings.length === 1);
  const changed = buildOffer({ name: 'x' }, 'Website Starter', { ...pricing, offers: { a: { ...pricing.offers.website_starter, priceCents: 100000, depositCents: 25000 } } }, { now: new Date('2026-06-01') });
  assert.equal(changed.finalCents, 75000);
  assert.throws(() => buildOffer({ name: 'x' }, 'Gibt es nicht', pricing)); assert.throws(() => buildOffer({ name: 'x' }, 'Website Starter', { ...pricing, offers: { a: { ...pricing.offers.website_starter, depositCents: 999999 } } }), /Anzahlung/);
  const fillAll = (v: unknown): unknown => (typeof v === 'string' ? v.replace(/\[[^\]]{3,}\]/g, 'Festgelegt') : Array.isArray(v) ? v.map(fillAll) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillAll(x)])) : v);
  const filled = fillAll(pricing) as typeof pricing;
  assert.equal(buildOffer({ name: 'x' }, 'Website Starter', filled).warnings.length, 0);
});

test('Preise kommen ausschließlich aus config/pricing.json (kein Preis im Code)', () => {
  const files = ['src/offers/generate.ts', 'src/sales/brief.ts', 'src/sales/docs.ts', 'src/orders/service.ts', 'src/calls/service.ts'];
  for (const f of files) assert.doesNotMatch(readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8'), /\b(129000|39000|4900|1290)\b/, f);
});
