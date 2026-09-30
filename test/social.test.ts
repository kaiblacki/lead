import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILES, GENERAL, profileByKey } from '../src/social/profiles.ts';
import { generatePlan, validateItem, toCsv, hashtagsFor, type Business } from '../src/social/generate.ts';

const START = new Date('2026-06-01');
const minimal: Business = { name: 'Salon Müller', city: 'Saarbrücken' };
const full: Business = { name: 'Salon Müller', city: 'Saarbrücken', phone: '0681 123456', openingHours: 'Di–Fr 9–18 Uhr\nSa 9–14 Uhr', services: ['Herrenschnitt', 'Färben'], offer: 'Im Juni: 10 % auf Farbe.', website: 'https://salon.example' };

test('Deterministisch: gleiche Eingaben, gleiche Ausgabe', () => {
  assert.deepEqual(generatePlan(full, profileByKey('friseur'), { start: START }), generatePlan(full, profileByKey('friseur'), { start: START }));
});

test('Keine Fakten ohne Quelle: ohne Leistungen/Zeiten/Angebot tauchen sie nicht auf', () => {
  const items = generatePlan(minimal, profileByKey('friseur'), { start: START, weeks: 8 });
  const text = items.map((i) => i.body).join('\n');
  assert.doesNotMatch(text, /Öffnungszeiten|Das bieten wir an|Aktuelles Angebot|Prozent|%|Uhr/);
  assert.ok(!items.some((i) => i.title === 'Aktuelles Angebot' || i.title === 'Wir stellen uns vor'));
  const withFacts = generatePlan(full, profileByKey('friseur'), { start: START, weeks: 8 }).map((i) => i.body).join('\n');
  assert.match(withFacts, /Herrenschnitt/); assert.match(withFacts, /Di–Fr 9–18 Uhr/); assert.match(withFacts, /10 % auf Farbe/);
});

test('Branchenwechsel: gleiche Engine, andere Zielgruppe/Ton/Themen/Plattformen', () => {
  const a = generatePlan(full, profileByKey('friseur'), { start: START });
  const b = generatePlan(full, profileByKey('handwerker'), { start: START });
  assert.notDeepEqual(a.map((i) => i.body), b.map((i) => i.body));
  assert.ok(!a.some((i) => i.platform === 'linkedin')); assert.ok(b.some((i) => i.platform === 'linkedin'));
  assert.match(a.find((i) => i.platform === 'blog')!.body, /Kundinnen und Kunden aus der Umgebung/);
  assert.match(b.find((i) => i.platform === 'blog')!.body, /Privatkunden und Gewerbekunden/);
});

test('Regulierte Branchen: keine Ratschläge, rechtlicher Hinweis an jedem Eintrag', () => {
  for (const key of ['zahnarzt', 'versicherung']) {
    const items = generatePlan(full, profileByKey(key), { start: START, weeks: 8 });
    assert.ok(!items.some((i) => i.title === 'Tipp'), key);
    assert.ok(items.every((i) => i.notes.some((n) => n.startsWith('Rechtlicher Hinweis'))), key);
  }
  assert.ok(generatePlan(full, profileByKey('friseur'), { start: START, weeks: 8 }).some((i) => i.title === 'Tipp'));
});

test('Alle Profile: gültige, vollständige Einträge ohne Platzhalter, Zeitraum und Hashtags korrekt', () => {
  for (const p of [...PROFILES, GENERAL]) for (const biz of [minimal, full]) {
    const items = generatePlan(biz, p, { start: START, weeks: 4 });
    assert.ok(items.length >= 12, p.key);
    for (const i of items) {
      assert.deepEqual(validateItem(i), [], `${p.key}: ${i.title} ${i.body}`);
      assert.ok(p.platforms.includes(i.platform as any) || i.platform === 'blog' || i.platform === 'newsletter');
      assert.ok(i.date >= '2026-06-01' && i.date <= '2026-07-20');
      assert.ok(i.hashtags.length <= 6);
    }
    assert.deepEqual([...items].map((i) => i.date), [...items].map((i) => i.date).sort());
  }
});

test('Hashtags: Ort und Name ohne Umlaute/Leerzeichen, keine Duplikate', () => {
  const t = hashtagsFor({ name: 'Café Größe & Söhne', city: 'Saarbrücken' }, profileByKey('restaurant'));
  assert.ok(t.includes('#saarbrucken') && t.includes('#cafegrossesohne'));
  assert.equal(new Set(t).size, t.length);
});

test('Validierung: Länge, Platzhalter, leer', () => {
  assert.ok(validateItem({ platform: 'instagram', body: 'x'.repeat(2201), hashtags: [] }).length);
  assert.ok(validateItem({ platform: 'facebook', body: 'Hallo {name}', hashtags: [] }).length);
  assert.ok(validateItem({ platform: 'facebook', body: 'Hallo [Ort einsetzen]', hashtags: [] }).length);
  assert.ok(validateItem({ platform: 'facebook', body: '  ', hashtags: [] }).length);
  assert.deepEqual(validateItem({ platform: 'facebook', body: 'Hallo!', hashtags: [] }), []);
});

test('Wochen werden begrenzt, CSV maskiert Anführungszeichen', () => {
  assert.ok(generatePlan(full, GENERAL, { start: START, weeks: 99 }).length < generatePlan(full, GENERAL, { start: START, weeks: 13 }).length + 1);
  assert.equal(new Set(generatePlan(full, GENERAL, { start: START, weeks: 0 }).map((i) => i.date.slice(0, 7))).size >= 1, true);
  const csv = toCsv([{ date: '2026-06-02', platform: 'facebook', format: 'post', title: 'Sag "Hallo"', body: 'a;b\nc', hashtags: [], notes: [] }]);
  assert.match(csv, /"Sag ""Hallo"""/);
});
