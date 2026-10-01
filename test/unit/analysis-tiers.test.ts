import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStructured, contentHash, websiteStatusOf, type StructInput } from '../../src/analysis/structured.ts';
import { FORBIDDEN, validateConcept, validateDeep } from '../../src/analysis/ai.ts';
import { estimateCostCents, resolveTier } from '../../src/ai/tiers.ts';
import { AiGateway } from '../../src/ai/gateway.ts';
import { Budget, DEFAULT_LIMITS } from '../../src/guardrails/budget.ts';
import { AnthropicProvider } from '../../src/providers/real/ai.ts';
import { loadConfig } from '../../src/core/config.ts';
import { effectiveEmailStatus } from '../../src/contact/service.ts';
import { nextActionText } from '../../src/dashboard/pages/lead-parts.ts';
import { runAudit } from '../../src/audit/audit.ts';

const cfg = loadConfig('config');
const chk = (code: string, status: any, summary: string, severity: any = 'medium', category: any = 'conversion') => ({ code, category, status, severity, summary, evidence: `Beleg ${code}` });
const base: StructInput = { companyName: 'Studio X', subLabel: 'Nagelstudio', features: ['booking', 'gallery', 'maps'], websiteUrl: 'https://x.example', auditStatus: 'ANALYZED', auditNotes: [], renderDependent: false, websiteScore: 48, salesOpportunity: 77, coverage: 0.8, dataQualityFactor: 0.9,
  checks: [chk('ONLINE_BOOKING', 'fail', 'Keine Online-Terminbuchung erkennbar.'), chk('HORIZONTAL_SCROLL', 'unknown', 'Mobile Darstellung nicht im Browser geprüft.', 'high', 'mobile'), chk('HTTPS', 'pass', 'HTTPS vorhanden.', 'high', 'technical'), chk('CTA', 'warn', 'Kein deutlich hervorgehobener nächster Schritt erkennbar.')],
  facts: [{ key: 'name', value: 'Studio X', source: 'osm', capturedAt: '2026-06-01', quality: 'medium' }, { key: 'phone', value: '06898 1', source: 'osm', capturedAt: '2026-06-01', quality: 'medium' }], reasons: [{ code: 'ONLINE_BOOKING', text: 'Keine Online-Terminbuchung erkennbar.', evidence: 'x' }], source: 'osm', phone: '06898 1', email: null, address: 'Hauptstr. 1' };

test('Strukturierte Analyse: website_score und sales_opportunity getrennt, Schwächen mit Beleg, Unbekanntes als „manuell prüfen“', () => {
  const a = buildStructured(base, cfg.analysis);
  assert.equal(a.website_status, 'ANALYZED'); assert.equal(a.website_score, 48); assert.equal(a.sales_opportunity, 77);
  assert.deepEqual(a.weaknesses.map((w) => w.code), ['ONLINE_BOOKING', 'CTA']); assert.ok(a.weaknesses.every((w) => w.evidence));
  assert.ok(a.positive_points.some((p) => p.code === 'HTTPS'));
  assert.ok(a.manual_checks.some((m) => /Nicht festgestellt – manuell prüfen: Mobile Darstellung/.test(m)));
  assert.ok(a.recommended_improvements.includes(cfg.analysis.improvements.ONLINE_BOOKING));
  assert.match(a.telephone_talking_points[0], /Mir ist aufgefallen: Keine Online-Terminbuchung erkennbar\./);
  assert.ok(a.missing_information.some((m) => /E-Mail/.test(m)) && a.missing_information.some((m) => /Ansprechpartner/.test(m)));
  assert.ok(a.sources.some((s) => s.source === 'osm' && s.fields.includes('phone'))); assert.ok(a.confidence > 0 && a.confidence <= 1);
  assert.doesNotMatch(JSON.stringify(a), /verlier|garantier|Umsatz|%/i);
});

test('Ohne Website: NO_WEBSITE, KEIN Website-Score, Chance bleibt, Demo-Features aus der Branche, Hinweis „prüfen ob doch eine Website existiert“', () => {
  const a = buildStructured({ ...base, websiteUrl: null, auditStatus: 'NO_WEBSITE', websiteScore: null, checks: [], salesOpportunity: 81 }, cfg.analysis);
  assert.equal(a.website_status, 'NO_WEBSITE'); assert.equal(a.website_score, null); assert.equal(a.sales_opportunity, 81);
  assert.match(a.analysis_summary, /keine eigene Website gefunden.*OpenStreetMap/); assert.deepEqual(a.recommended_demo_features, ['Online-Terminbuchung', 'Bildergalerie', 'Karte / Anfahrt']);
  assert.ok(a.manual_checks[0].startsWith('Prüfen, ob doch eine eigene Website existiert')); assert.match(a.telephone_talking_points[0], /unverbindlich einen Entwurf vorbereitet/);
  // gesperrte Website: Score bleibt leer, nicht erfunden
  const bl = buildStructured({ ...base, auditStatus: 'UNREACHABLE', auditNotes: ['Website vorhanden, aber der Abruf wird blockiert (HTTP 403)'], websiteScore: null, checks: [] }, cfg.analysis);
  assert.equal(bl.website_status, 'BLOCKED'); assert.equal(bl.website_score, null); assert.match(bl.manual_checks[0], /blockiert/);
  assert.equal(websiteStatusOf('ANALYZED', [], true), 'NOT_VERIFIED');
});

test('Branchenabhängig: Features steuern Audit-Prüfpunkte (Speisekarte nur bei Gastro, Einsatzgebiet nur bei Handwerk) – keine Branche im Code', () => {
  const crawl = (html: string) => ({ ok: true, startUrl: 'https://a.example', finalUrl: 'https://a.example', pages: [{ url: 'https://a.example', status: 200, html, loadMs: 800, bytes: 3000 }], capturedAt: '2026-06-01T00:00:00Z', requests: 1, source: 't' });
  const html = '<!doctype html><html lang="de"><head><title>Test Betrieb Titel</title><meta name="viewport" content="width=device-width"></head><body><h1>Betrieb</h1><p>' + 'Text '.repeat(120) + '</p><img src="a.jpg"></body></html>';
  const codes = (features?: string[]) => runAudit({ websiteUrl: 'https://a.example', lead: { companyName: 'A', features }, crawl: crawl(html) as never, now: new Date('2026-06-01') }).checks.map((c) => c.code);
  assert.ok(!codes().includes('MENU') && !codes().includes('MAPS'));
  assert.ok(codes(['menu', 'maps', 'gallery']).includes('MENU') && codes(['menu', 'maps']).includes('MAPS') && !codes(['menu']).includes('SERVICE_AREA'));
  assert.ok(codes(['service_area', 'quote']).includes('SERVICE_AREA') && codes(['service_area', 'quote']).includes('QUOTE_REQUEST'));
  const gastro = cfg.taxonomy.sub('restaurant')!, handw = cfg.taxonomy.sub('elektriker')!, nail = cfg.taxonomy.sub('nagelstudio')!;
  assert.ok(gastro.features!.includes('menu') && !handw.features!.includes('menu') && handw.features!.includes('service_area') && nail.features!.includes('booking'));
});

test('KI-Antworten werden geprüft: verbotene Aussagen, unbekannte Codes, erfundene Belege/Preise fliegen raus; Konzept-Texte werden als Beispiel gekennzeichnet', () => {
  assert.ok(FORBIDDEN.test('Sie verlieren jeden Monat Kunden') && FORBIDDEN.test('30 % mehr Umsatz') && FORBIDDEN.test('garantiert') && !FORBIDDEN.test('Keine Online-Terminbuchung erkennbar.'));
  const v = validateDeep({ analysis_summary: 'Die Website zeigt keine Terminaktion.', sales_reasons: [{ code: 'ONLINE_BOOKING', text: 'Keine Terminbuchung erkennbar.' }, { code: 'ERFUNDEN', text: 'Etwas anderes.' }, { code: 'CTA', text: 'Das bringt 30 % mehr Umsatz.' }], recommended_improvements: ['Terminaktion', 'Gratis Beratung'], telephone_talking_points: ['Mir ist aufgefallen …'] }, ['ONLINE_BOOKING', 'CTA'])!;
  assert.equal(v.fields.sales_reasons!.length, 1); assert.equal(v.fields.sales_reasons![0].code, 'ONLINE_BOOKING'); assert.deepEqual(v.fields.recommended_improvements, ['Terminaktion']); assert.equal(v.dropped, 2);
  assert.equal(validateDeep('kein json', []), null); assert.equal(validateDeep({ foo: 1 }, []), null);
  const c = validateConcept({ concept: { site_structure: [{ page: 'Startseite', sections: ['Kopf', 'Termin'] }], conversion_concept: ['Button oben'], copy_samples: [{ section: 'Titel', text: 'Willkommen bei uns' }, { section: 'Bewertung', text: '4,9 / 5 Sterne von 120 Kunden' }, { section: 'Preis', text: 'Maniküre ab 25' }], tone: 'locker' } })!;
  assert.deepEqual(c.copy_samples, [{ section: 'Titel', text: 'Beispiel: Willkommen bei uns' }]);
  assert.equal(validateConcept({ concept: { site_structure: [], conversion_concept: [] } }), null);
});

test('KI-Stufen: Modell-ID aus Config/Umgebung, Kostenschätzung aus Token, Mock kostet nichts', () => {
  assert.equal(resolveTier(cfg.ai, 'MASS', {}).model, 'claude-haiku-4-5-20251001'); assert.equal(resolveTier(cfg.ai, 'DEEP', { ANTHROPIC_MODEL_DEEP: 'mein-modell' }).model, 'mein-modell');
  assert.ok(resolveTier(cfg.ai, 'PREMIUM', {}).maxTokens > resolveTier(cfg.ai, 'MASS', {}).maxTokens);
  // 1M Input + 1M Output der DEEP-Stufe: (3 + 15) $ × 0,92 = 16,56 € = 1656 Cent
  assert.equal(estimateCostCents(cfg.ai, 'DEEP', 1_000_000, 1_000_000, false, {}), 1656); assert.equal(estimateCostCents(cfg.ai, 'DEEP', 5000, 1000, true, {}), 0); assert.equal(estimateCostCents(cfg.ai, 'MASS', 0, 0, false, {}), 0);
  assert.ok(estimateCostCents(cfg.ai, 'PREMIUM', 4000, 3000, false, {}) > estimateCostCents(cfg.ai, 'MASS', 4000, 3000, false, {}));
});

test('Gateway + Anthropic-Adapter: Stufe → Modell im Request, Token → Kosten, Protokollzeile je Aufruf, Budget wird gezählt', async () => {
  const orig = globalThis.fetch; const bodies: any[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 2000, output_tokens: 500 } }), { status: 200 }); }) as typeof fetch;
  try {
    const provider = new AnthropicProvider('standard-modell', 'sk-test');
    const gw = new AiGateway(provider, new Budget({ ...DEFAULT_LIMITS, maxDailyCents: 100000, maxMonthlyCents: 100000 }), { cfg: cfg.ai, env: { ANTHROPIC_MODEL_PREMIUM: 'premium-x' } });
    await gw.complete('lead-1', { task: 'analyze_lead', prompt: 'x', tier: 'MASS', purpose: 'analysis' });
    await gw.complete('lead-1', { task: 'premium_concept', prompt: 'y', tier: 'PREMIUM', purpose: 'demo' });
    assert.equal(bodies[0].model, 'claude-haiku-4-5-20251001'); assert.equal(bodies[1].model, 'premium-x'); assert.ok(bodies[1].max_tokens >= 4000);
    assert.deepEqual(gw.log.map((l) => [l.tier, l.task, l.purpose, l.inputTokens, l.outputTokens]), [['MASS', 'analyze_lead', 'analysis', 2000, 500], ['PREMIUM', 'premium_concept', 'demo', 2000, 500]]);
    assert.ok(gw.log[1].estCents > gw.log[0].estCents && gw.log[0].estCents > 0 && gw.log[0].model === 'claude-haiku-4-5-20251001');
    const tiny = new AiGateway(provider, new Budget({ ...DEFAULT_LIMITS, maxDailyCents: 0.00001 }), { cfg: cfg.ai, env: {} });
    await assert.rejects(tiny.complete('l', { task: 'generic', prompt: 'x', tier: 'PREMIUM' }), /DAILY AI BUDGET/);
  } finally { globalThis.fetch = orig; }
});

test('Hash-Cache: gleiche Grundlage → gleicher Hash, andere Befunde/Stufe → anderer Hash', () => {
  const h = contentHash(base, 'DEEP:m'); assert.equal(h, contentHash({ ...base }, 'DEEP:m'));
  assert.notEqual(h, contentHash(base, 'PREMIUM:m')); assert.notEqual(h, contentHash({ ...base, checks: base.checks.slice(1) }, 'DEEP:m'));
});

test('E-Mail-Status: gesendet wird nach der Frist zu „follow_up_due“; Nächste Aktion für die Liste', () => {
  const now = new Date('2026-06-10T10:00:00Z');
  assert.equal(effectiveEmailStatus('sent', '2026-06-01T10:00:00Z', now), 'follow_up_due'); assert.equal(effectiveEmailStatus('sent', '2026-06-09T10:00:00Z', now), 'sent'); assert.equal(effectiveEmailStatus('draft', null, now), 'draft');
  const l = (o: object) => ({ status: 'QUALIFIED', contact_readiness: 'READY_FOR_MANUAL_CALL', phone: '1', call_count: 0, ...o });
  assert.equal(nextActionText(l({ demo_ready_call: true }), now), 'Demo fertig – anrufen'); assert.match(nextActionText(l({ website_url: 'https://a', has_demo: false }), now), /Entscheiden/);
  assert.equal(nextActionText(l({ website_state: 'none', has_demo: false }), now), 'Demo erstellen'); assert.equal(nextActionText(l({}), now), 'Anrufen'); assert.equal(nextActionText(l({ contact_readiness: 'DO_NOT_CONTACT' }), now), '—');
  assert.equal(nextActionText(l({ email_send_status: 'sent', email_sent_at: '2026-06-01T10:00:00Z', call_count: 1 }), now), 'Follow-up fällig');
});
