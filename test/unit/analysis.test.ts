import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/core/config.ts';
import { createProviders } from '../../src/providers/registry.ts';
import { getWorld } from '../../src/fixtures/world.ts';
import { analyzeCandidate } from '../../src/search/analyze-candidate.ts';
import { runAudit } from '../../src/audit/audit.ts';
import { bestFact, buildFacts, findConflicts } from '../../src/core/profile.ts';
import { categorize } from '../../src/scoring/intelligence.ts';
import type { PlaceCandidate } from '../../src/providers/types.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = new Date('2026-06-01T10:00:00Z');
const cfg = loadConfig();
const reg = createProviders({}, { baseUrl: 'http://x', now: () => NOW, hostingRoot: mkdtempSync(join(tmpdir(), 'h-')) });
const P = reg.providers;
const VK = { lat: 49.2514, lng: 6.8447 };

async function forVariant(variant: string, pred: (b: ReturnType<typeof getWorld>[number]) => boolean = () => true) {
  const b = getWorld().find((x) => x.variant === variant && x.instagram && x.inPlaces && x.status === 'OPERATIONAL' && pred(x)) ?? getWorld().find((x) => x.variant === variant && x.inPlaces)!;
  const place = (await P.places.search({ center: b.point, radiusKm: 1, keywords: [b.name], limit: 50 })).items.find((i) => i.externalId === b.id) as PlaceCandidate;
  return { b, r: await analyzeCandidate(P, cfg, { place, center: VK, searchSub: b.subKey, now: NOW }) };
}

test('Audit moderne Seite mit Buchung: überwiegend ✅, hohe Qualität', async () => {
  const { r } = await forVariant('modern', (b) => ['friseur', 'nagelstudio', 'kosmetik'].includes(b.subKey));
  const code = (c: string) => r.audit.checks.find((x) => x.code === c)!;
  for (const c of ['HTTPS', 'VIEWPORT', 'ONLINE_BOOKING', 'PHONE', 'CTA', 'IMPRINT', 'TITLE']) assert.equal(code(c).status, 'pass', c);
  assert.ok(r.audit.overallQuality! >= 80, String(r.audit.overallQuality));
  assert.ok(r.audit.checks.every((c) => c.evidence.length > 0 && c.summary.length > 0));
  assert.equal(r.analysis.websiteState, 'fine');
  assert.ok(r.analysis.dimensions.websiteNeed.value! < 25);
});

test('Audit Seite ohne Buchung: konkreter Befund „Keine Online-Terminbuchung erkennbar“ mit Beleg', async () => {
  const { r } = await forVariant('modern-nobooking', (b) => ['friseur', 'nagelstudio', 'kosmetik'].includes(b.subKey));
  const c = r.audit.checks.find((x) => x.code === 'ONLINE_BOOKING')!;
  assert.equal(c.status, 'fail'); assert.match(c.summary, /Keine Online-Terminbuchung erkennbar/); assert.match(c.evidence, /geprüften Seite/);
  assert.ok(r.analysis.upsells.some((u) => u.key === 'online_booking'));
});

test('Audit alte Seite: HTTPS, Viewport, Alt-Technik, Aktualität, Telefon, kaputte Unterseite', async () => {
  const { r } = await forVariant('outdated');
  const s = (c: string) => r.audit.checks.find((x) => x.code === c)?.status;
  assert.equal(s('HTTPS'), 'fail'); assert.equal(s('VIEWPORT'), 'fail'); assert.equal(s('OLD_TECH'), 'fail'); assert.equal(s('FRESHNESS'), 'fail');
  assert.equal(s('PHONE'), 'warn'); assert.equal(s('BROKEN_PAGES'), 'warn');
  assert.ok(r.audit.overallQuality! < 60, String(r.audit.overallQuality));
  assert.equal(r.analysis.websiteState, 'needs_improvement');
  assert.ok(r.analysis.dimensions.mobileNeed.value! >= 60);
});

test('Audit ohne Viewport/feste Breite und langsame Seite', async () => {
  const nm = (await forVariant('nomobile')).r.audit.checks;
  assert.equal(nm.find((c) => c.code === 'FIXED_WIDTH')?.status, 'fail');
  assert.equal(nm.find((c) => c.code === 'HORIZONTAL_SCROLL')?.status, 'fail');
  assert.match(nm.find((c) => c.code === 'HORIZONTAL_SCROLL')!.summary, /geschätzt/);
  const slow = (await forVariant('slow')).r.audit.checks;
  assert.equal(slow.find((c) => c.code === 'LOAD_TIME')?.status, 'fail'); assert.equal(slow.find((c) => c.code === 'PAGE_WEIGHT')?.status, 'fail');
  assert.equal((await forVariant('nohttps')).r.audit.checks.find((c) => c.code === 'HTTPS')?.status, 'fail');
});

test('JavaScript-Seite: Textprüfungen „nicht zuverlässig prüfbar“ statt erfundener Fehler', async () => {
  const { r } = await forVariant('spa');
  assert.equal(r.audit.renderDependent, true);
  for (const c of ['SERVICES_CLEAR', 'PHONE', 'CTA', 'ONLINE_BOOKING']) { const k = r.audit.checks.find((x) => x.code === c); if (k) assert.equal(k.status, 'unknown', c); }
  assert.ok(r.audit.notes.some((n) => /JavaScript/.test(n)));
  assert.ok(r.audit.coverage < 0.75);
});

test('Keine Website: alle Seiten-Dimensionen abgeleitet (implied) oder nicht verfügbar, nie erfunden', async () => {
  const { r } = await forVariant('none');
  assert.equal(r.audit.status, 'NO_WEBSITE'); assert.equal(r.analysis.websiteState, 'none');
  const d = r.analysis.dimensions;
  assert.deepEqual([d.websiteNeed.state, d.mobileNeed.state, d.conversionNeed.state, d.contentNeed.state], ['measured', 'implied', 'implied', 'implied']);
  assert.deepEqual([d.designNeed.state, d.technicalNeed.state], ['unavailable', 'unavailable']);
  assert.equal(r.analysis.digitalNeed.value, 100);
  assert.match(d.websiteNeed.reasons.map((x) => x.text).join(' '), /keine eigene Website hinterlegt/);
  assert.match(r.analysis.missing.join('\n'), /Design Need: nicht verfügbar/);
});

test('Unerreichbare Website: kein Score, „nicht zuverlässig ermittelbar“', async () => {
  const { r } = await forVariant('unreachable');
  assert.equal(r.audit.status, 'UNREACHABLE');
  assert.equal(r.analysis.dimensions.websiteNeed.state, 'unreliable'); assert.equal(r.analysis.dimensions.websiteNeed.value, null);
  assert.equal(r.analysis.salesOpportunity.category, 'UNRATED'); assert.equal(r.analysis.salesOpportunity.value, null);
  assert.match(r.analysis.salesOpportunity.note, /Nicht bewertbar/);
  assert.match(r.analysis.missing.join('\n'), /nicht zuverlässig ermittelbar/);
});

test('Nur-Social-Media als Website: zählt als „keine Website“, Hinweis bleibt sichtbar', async () => {
  const { r } = await forVariant('social-only');
  assert.equal(r.analysis.websiteState, 'none');
  assert.ok(r.facts.some((f) => f.key === 'social' && f.note?.includes('nur ein Social-Media-Profil')));
  assert.ok(!bestFact(r.facts, 'website'));
  assert.match(r.analysis.dimensions.websiteNeed.reasons.map((x) => x.text).join(' '), /nur ein Social-Media-Profil/);
});

test('Sales Opportunity: keine Website + gute Daten > schlechte Seite > moderne Seite; Gewichte/Schwellen aus der Konfiguration', async () => {
  const none = (await forVariant('none')).r.analysis.salesOpportunity.value!;
  const old = (await forVariant('outdated')).r.analysis.salesOpportunity.value!;
  const good = (await forVariant('modern', (b) => b.subKey === 'friseur')).r.analysis.salesOpportunity.value!;
  assert.ok(none > good && old > good, `none=${none} old=${old} good=${good}`);
  assert.ok(none >= 60, String(none));
  assert.ok(good < 45, String(good));
  const t = cfg.scoring.thresholds;
  assert.deepEqual([100, t.HOT, t.HOT - 1, t.HIGH_POTENTIAL, t.MEDIUM, t.LOW, t.LOW - 1].map((s) => categorize(s, t)), ['HOT', 'HOT', 'HIGH POTENTIAL', 'HIGH POTENTIAL', 'MEDIUM', 'LOW', 'IGNORE']);
  const { r } = await forVariant('none');
  const changed = analyzeLeadWith(r, { ...cfg.scoring, salesWeights: { ...cfg.scoring.salesWeights, digitalNeed: 0.9 } });
  assert.ok(changed !== r.analysis.salesOpportunity.value);
});
import { analyzeLead } from '../../src/scoring/intelligence.ts';
function analyzeLeadWith(r: Awaited<ReturnType<typeof analyzeCandidate>>, scoring: any) {
  return analyzeLead({ facts: r.facts, audit: r.audit, social: r.social, bookingRelevant: true, upsells: cfg.pricing.upsells, now: NOW }, scoring).salesOpportunity.value;
}

test('Erklärbarkeit: „Warum interessant?“ nennt konkrete Gründe mit Punkten; Beiträge ergeben den Score', async () => {
  const { r } = await forVariant('outdated');
  assert.ok(r.analysis.why.length >= 2 && r.analysis.why.every((w) => w.text.length > 15 && (w.points ?? 0) > 0));
  const sum = r.analysis.salesOpportunity.contributions.reduce((s, c) => s + c.points, 0);
  assert.ok(Math.abs(sum - r.analysis.salesOpportunity.value!) <= 2, `Summe ${sum} vs ${r.analysis.salesOpportunity.value}`);
  const dn = r.analysis.digitalNeed.contributions.reduce((s, c) => s + c.points, 0);
  assert.ok(Math.abs(dn - r.analysis.digitalNeed.value!) <= 2);
});

test('Fakten: jede Angabe mit Quelle, Datum, Qualität; Quellenkonflikte sichtbar', async () => {
  const w = getWorld().filter((b) => b.inPlaces && b.inDirectory && b.phone);
  let conflictSeen = false;
  for (const b of w.slice(0, 120)) {
    const place = (await P.places.search({ center: b.point, radiusKm: 1, keywords: [b.name], limit: 50 })).items.find((i) => i.externalId === b.id)!;
    const dir = (await P.directory.lookup(b.name, b.city))!;
    const facts = buildFacts({ place, directory: dir, capturedAt: NOW.toISOString() });
    assert.ok(facts.every((f) => f.source && f.capturedAt && f.quality));
    if (findConflicts(facts).some((c) => c.key === 'phone')) { conflictSeen = true; assert.equal(bestFact(facts, 'phone')!.source, 'mock-google-places'); }
  }
  assert.ok(conflictSeen);
});

test('Datenqualität und Contactability: fehlende Werte werden ausgewiesen, nicht ersetzt', async () => {
  const b = getWorld().find((x) => x.inPlaces && !x.inDirectory && x.variant === 'none' && !x.phone)
    ?? getWorld().find((x) => x.inPlaces && !x.inDirectory && !x.email)!;
  const place = (await P.places.search({ center: b.point, radiusKm: 1, keywords: [b.name], limit: 50 })).items.find((i) => i.externalId === b.id)!;
  const r = await analyzeCandidate(P, cfg, { place: { ...place, phone: undefined }, directory: null, center: VK, now: NOW });
  assert.match(r.analysis.dimensions.dataQuality.reasons.map((x) => x.text).join('\n'), /Telefon: nicht verfügbar/);
  assert.match(r.analysis.dimensions.contactability.reasons.map((x) => x.text).join('\n'), /Keine Telefonnummer verfügbar/);
  assert.match(r.analysis.missing.join('\n'), /Mitarbeitergröße: nicht verfügbar|E-Mail: nicht verfügbar/);
  assert.ok(r.analysis.dimensions.dataQuality.value! < 75);
});

test('runAudit ohne Crawl/mit Fehlern liefert definierte Zustände', () => {
  assert.equal(runAudit({ lead: { companyName: 'x' }, now: NOW }).status, 'NO_WEBSITE');
  const u = runAudit({ websiteUrl: 'https://x.example', lead: { companyName: 'x' }, now: NOW, crawl: { ok: false, startUrl: 'x', pages: [], error: 'timeout', capturedAt: NOW.toISOString(), requests: 1, source: 't' } });
  assert.equal(u.status, 'UNREACHABLE'); assert.equal(u.checks[0].evidence, 'timeout'); assert.equal(u.overallQuality, null);
  const robots = runAudit({ websiteUrl: 'https://x.example', lead: { companyName: 'x' }, now: NOW, crawl: { ok: false, startUrl: 'x', pages: [], robotsBlocked: true, error: 'robots', capturedAt: NOW.toISOString(), requests: 1, source: 't' } });
  assert.match(robots.checks[0].evidence, /robots/);
});

test('Audit: Branchen ohne Buchungsrelevanz bekommen keinen Buchungs-Befund', async () => {
  const b = getWorld().find((x) => x.subKey === 'elektriker' && x.variant === 'modern-nobooking' && x.inPlaces)!;
  const place = (await P.places.search({ center: b.point, radiusKm: 1, keywords: [b.name], limit: 50 })).items.find((i) => i.externalId === b.id)!;
  const r = await analyzeCandidate(P, cfg, { place, searchSub: 'elektriker', now: NOW });
  assert.ok(!r.audit.checks.some((c) => c.code === 'ONLINE_BOOKING' || c.code === 'WHATSAPP'));
  assert.ok(!r.analysis.upsells.some((u) => u.key === 'online_booking'));
});
