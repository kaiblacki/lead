import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from '../../src/providers/real/render.ts';
import { loadConfig } from '../../src/core/config.ts';
import { renderDemo } from '../../src/site/engine.ts';
import { templateByKey } from '../../src/site/templates.ts';
import { effectiveModules, familyFor, recommendModules, type Family } from '../../src/site/modules.ts';

/** Demo im echten Browser: Desktop (1280), Tablet (768) und Mobil (375/430) – kein seitliches Scrollen, große Tap-Ziele, Pflichtbereiche sichtbar, keine Skripte/Fehler. Mit SHOTS_DIR=… werden Screenshots gespeichert. */
const cfg = loadConfig(); const skip = findChromium() ? false : 'Chromium nicht gefunden';
const labels = Object.fromEntries(Object.entries(cfg.pipeline.demo.modules).map(([k, v]: any) => [k, v.label]));
const CASES: { sub: string; tpl: string; name: string; extra?: object }[] = [
  { sub: 'nagelstudio', tpl: 'nagelstudio', name: 'Nagelstudio Kovan' }, { sub: 'restaurant', tpl: 'restaurant', name: 'Trattoria Lumi' }, { sub: 'elektriker', tpl: 'handwerker', name: 'Elektro Tilemo', extra: { openingHours: 'Mo–Fr 7:00–16:00 Uhr' } },
  { sub: 'friseur', tpl: 'friseur', name: 'Haarwerk Zeno', extra: { email: 'info@haarwerk-zeno.example' } },
];

test('Demo-Seiten (3 Layout-Familien) im Browser: Desktop, Tablet, Mobil', { skip, timeout: 120_000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
  const problems: string[] = []; const shots = process.env.SHOTS_DIR; if (shots) mkdirSync(shots, { recursive: true });
  try {
    for (const c of CASES) {
      const family: Family = familyFor(cfg, { subIndustry: c.sub }); const mods = effectiveModules(cfg, { recommended: recommendModules(cfg, { family, subIndustry: c.sub }) });
      const html = renderDemo({ companyName: c.name, city: 'Völklingen', address: 'Rathausstraße 3', postalCode: '66333', phone: '06898 123456', services: [{ title: 'Beispielleistung A', text: 'Beschreibung' }, { title: 'Beispielleistung B', text: '' }], legal: {}, ...c.extra } as never,
        templateByKey(c.tpl), { name: 'Kai Schwarz', contactEmail: 'kontakt@beispiel.example' }, { servicesAreExamples: true, sources: ['osm'] }, { plan: { family, modules: mods, moduleLabels: labels }, extras: {} });
      for (const w of [375, 430, 768, 1280]) {
        const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, javaScriptEnabled: false }); const pg = await ctx.newPage();
        await pg.setContent(html, { waitUntil: 'load' });
        const r = await pg.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          const over = [...document.querySelectorAll('body *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && getComputedStyle(e).position !== 'fixed' && (b.right > vw + 1 || b.left < -1); }).slice(0, 5).map((e) => e.tagName + '.' + (e as HTMLElement).className);
          const small = [...document.querySelectorAll('a, button, input, select, textarea')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.height < 43.5; }).slice(0, 5).map((e) => `${e.tagName} "${(e.textContent ?? '').trim().slice(0, 20)}" ${Math.round(e.getBoundingClientRect().height)}px`);
          const ids = ['top', 'kontakt', 'oeffnungszeiten', 'ueber-uns'].filter((i) => !document.getElementById(i));
          return { sw: document.documentElement.scrollWidth, vw, over, small, ids, h1: document.querySelector('h1')?.textContent ?? '', scripts: document.querySelectorAll('script').length, hero: getComputedStyle(document.querySelector('.hero')!).textAlign };
        });
        if (r.sw > r.vw + 1) problems.push(`${c.sub}@${w}: seitliches Scrollen (${r.sw}>${r.vw})`); if (r.over.length) problems.push(`${c.sub}@${w}: ragt heraus ${r.over.join(', ')}`); if (r.small.length) problems.push(`${c.sub}@${w}: kleine Tap-Ziele ${r.small.join(', ')}`);
        if (r.ids.length) problems.push(`${c.sub}@${w}: fehlt ${r.ids.join(',')}`); if (r.scripts) problems.push(`${c.sub}: Skript im Dokument`); if (!r.h1.trim()) problems.push(`${c.sub}: keine Überschrift`);
        assert.equal(r.hero, family === 'APPOINTMENT' ? 'center' : 'left', `${c.sub}: Hero-Ausrichtung je Familie`);
        if (shots && (w === 375 || w === 1280)) await pg.screenshot({ path: join(shots, `demo-${c.sub}-${w}.png`), fullPage: true });
        await ctx.close();
      }
    }
  } finally { await browser.close(); }
  assert.deepEqual(problems, []);
});
