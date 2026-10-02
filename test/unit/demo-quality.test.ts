import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allTemplates } from '../../src/site/templates.ts';
import { renderDemo } from '../../src/site/engine.ts';
import { FAMILIES, moduleDefs, moduleKeys } from '../../src/site/modules.ts';
import { loadConfig } from '../../src/core/config.ts';
import { DEMO_STAGES, effectiveDemoStage } from '../../src/demo/stage.ts';

const cfg = loadConfig();
const labels = Object.fromEntries(Object.entries(moduleDefs(cfg)).map(([k, v]) => [k, v.label]));
const agency = { name: 'Muster Agentur', contactEmail: 'hallo@muster.example' };
const base = { companyName: 'Salon Müller', city: 'Saarbrücken', address: 'Hauptstr. 1', postalCode: '66111', phone: '0681 123456', services: [{ title: 'Herrenschnitt', text: '' }], legal: {} };
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('Demo-Qualität: starke Hero mit Branche/Ort, Mobil-Viewport, klare Struktur, CTA – für alle Vorlagen und Layout-Familien', () => {
  for (const t of allTemplates()) for (const family of FAMILIES) {
    const html = renderDemo(base as never, t, agency, { servicesAreExamples: true }, { plan: { family, modules: moduleKeys(cfg).slice(0, 8), moduleLabels: labels } });
    assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/); assert.match(html, /class="eyebrow"/); assert.match(html, /Saarbrücken/); assert.match(html, /<h1>/); assert.match(html, /class="cta"/);
    assert.match(html, /clamp\(/, 'fließende Typografie'); assert.match(html, /prefers-reduced-motion/); assert.match(html, /Unverbindliche Demo/); assert.ok((html.match(/<h1/g) ?? []).length === 1, 'genau eine H1');
    assert.match(html, /@media \(max-width:640px\)/, 'mobile Regeln'); assert.ok(!/overflow-x:\s*scroll/.test(html));
  }
});

test('Keine erfundenen Inhalte in Demos: keine Rezensionen/Sterne, keine Preise, keine Mitarbeiter-/Erfahrungs-/Zertifikatsbehauptungen – Platzhalter sind als Beispiel gekennzeichnet', () => {
  const FORBIDDEN = /★|☆|\d[.,]?\d?\s*(von|\/)\s*5\s*Sterne|Rezension|Kundenstimmen|Kunden sagen|Bewertungen von|zertifiziert|Zertifikat|Meisterbetrieb|ausgezeichnet|Award|seit (19|20)\d\d|\d+\s*Jahre Erfahrung|über \d+ (Kunden|Projekte|Mitarbeiter)|unser Team aus|\d+\s?(€|Euro)/i;
  for (const t of allTemplates()) for (const family of FAMILIES) {
    const html = renderDemo(base as never, t, agency, { servicesAreExamples: true }, { plan: { family, modules: moduleKeys(cfg), moduleLabels: labels } });
    const body = text(html); assert.doesNotMatch(body, FORBIDDEN, `${t.key}/${family}: ${(FORBIDDEN.exec(body) ?? [])[0]}`);
    assert.match(body, /Beispiel/, 'Platzhalter als Beispiel gekennzeichnet'); assert.match(body, /nicht die offizielle Website|nicht die offizielle/i);
    if (html.includes('Preis folgt')) assert.match(body, /Preis folgt/);
  }
});

test('Demo-Stufen: wirksame Stufe aus Demo, Kais Auswahl und Systemempfehlung', () => {
  assert.deepEqual([...DEMO_STAGES], ['NO_DEMO', 'DEMO_RECOMMENDED', 'DEMO_SELECTED', 'DEMO_CREATED', 'DEMO_SHOWN']);
  const s = (l: object, has = false) => effectiveDemoStage(l, has);
  assert.equal(s({}), 'NO_DEMO'); assert.equal(s({ demo_recommendation: 'DEMO_RECOMMENDED' }), 'DEMO_RECOMMENDED'); assert.equal(s({ demo_recommendation: 'DEMO_RECOMMENDED', demo_stage: 'DEMO_SELECTED' }), 'DEMO_SELECTED');
  assert.equal(s({ demo_recommendation: 'DEMO_RECOMMENDED', demo_stage: 'NO_DEMO' }), 'NO_DEMO', 'Kai entscheidet gegen die Empfehlung'); assert.equal(s({ demo_recommendation: 'DEMO_RECOMMENDED', demo_decision: 'skipped' }), 'NO_DEMO');
  assert.equal(s({ demo_stage: 'DEMO_SELECTED' }, true), 'DEMO_CREATED', 'vorhandene Demo gilt immer'); assert.equal(s({ demo_stage: 'DEMO_SHOWN' }, true), 'DEMO_SHOWN'); assert.equal(s({ demo_stage: 'DEMO_SHOWN' }, false), 'NO_DEMO', 'ohne Demo kein „gezeigt“');
});
