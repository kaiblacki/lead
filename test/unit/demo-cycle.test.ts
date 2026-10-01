import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanizeHours } from '../../src/core/hours.ts';
import { buildContactTemplates } from '../../src/sales/templates.ts';

test('Öffnungszeiten: OSM-Format wird lesbar, Unklares bleibt unverändert', () => {
  assert.equal(humanizeHours('Mo-Fr 10:00-18:00; Sa 10:00-16:00; PH,Su off'), 'Mo–Fr: 10:00–18:00 Uhr\nSa: 10:00–16:00 Uhr\nFeiertage, So: geschlossen');
  assert.equal(humanizeHours('Mo,We 09:00-12:00,14:00-18:00'), 'Mo, Mi: 09:00–12:00 und 14:00–18:00 Uhr');
  for (const raw of ['24/7', 'Mo-Fr sunrise-sunset', 'Montag: 10:00–18:00 Uhr', 'Mo-Fr 10:00-18:00; Sa nach Vereinbarung', '']) assert.equal(humanizeHours(raw), raw);
});

test('Kontaktvorlagen: nur belegte Gründe, Demo-Link nur wenn vorhanden, kein Platzhalter-Absender, nichts erfunden', () => {
  const a = buildContactTemplates({ company: 'Kim Nails Studio', reasons: ['Es ist keine eigene Website hinterlegt.', 'Ohne Website keine eigene Online-Terminbuchung.', 'Dritter'], service: 'Website Starter', sender: 'Kai', demoUrl: 'https://x.example/d/abc', opener: 'Guten Tag, …' });
  assert.match(a.email.subject, /Kim Nails Studio/); assert.match(a.email.text, /mein Name ist Kai/); assert.match(a.email.text, /keine eigene Website hinterlegt; Ohne Website keine eigene Online-Terminbuchung\./);
  assert.ok(!a.email.text.includes('Dritter')); assert.match(a.email.text, /https:\/\/x\.example\/d\/abc/); assert.match(a.followUp.text, /https:\/\/x\.example\/d\/abc/); assert.equal(a.followUp.afterDays, 4); assert.equal(a.phoneOpener, 'Guten Tag, …');
  const b = buildContactTemplates({ company: 'A', reasons: [], service: 'S' });
  assert.ok(!/\[|\]|undefined|Kai/.test(b.email.text + b.followUp.text)); assert.doesNotMatch(b.email.text, /https?:/); assert.match(b.email.text, /Ich habe mir die Online-Präsenz von A angesehen/);
});
