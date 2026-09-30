import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SiteFiles } from '../site/engine.ts';
import type { Issue } from './check.ts';

const CANDIDATES = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/google-chrome'];

/** Echter Browsertest: Mobil (375/390/430) und Desktop, horizontales Scrollen, Tap-Ziele, JS-/Ladefehler. */
export async function browserQa(files: SiteFiles): Promise<Issue[]> {
  const exe = CANDIDATES.find((p): p is string => Boolean(p) && existsSync(p!));
  if (!exe) return [{ code: 'BROWSER_SKIPPED', severity: 'warn', file: '-', message: 'Kein Chromium gefunden – Browsertest übersprungen (CHROMIUM_PATH setzen).' }];
  const { chromium } = await import('playwright-core');
  const mime: Record<string, string> = { html: 'text/html; charset=utf-8', txt: 'text/plain', xml: 'application/xml' };
  const srv = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\//, '') || 'index.html';
    if (req.url === '/favicon.ico') { res.writeHead(204); return void res.end(); }
    const body = files[name];
    if (body === undefined) { res.writeHead(404); return void res.end(); }
    res.writeHead(200, { 'content-type': mime[name.split('.').pop()!] ?? 'text/plain' }); res.end(body);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const issues: Issue[] = [];
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  try {
    for (const name of Object.keys(files).filter((f) => f.endsWith('.html'))) {
      for (const width of [375, 390, 430, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        page.on('requestfailed', (r) => errors.push(`Laden fehlgeschlagen: ${r.url()}`));
        const resp = await page.goto(`${base}/${name}`, { waitUntil: 'load' });
        if (!resp?.ok()) issues.push({ code: 'LOAD_FAILED', severity: 'error', file: name, message: `HTTP ${resp?.status()} bei ${width}px` });
        const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
          small: [...document.querySelectorAll('a,button')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height < 40; }).length }));
        if (m.sw > m.cw) issues.push({ code: 'H_SCROLL', severity: 'error', file: name, message: `Seitliches Scrollen bei ${width}px (${m.sw} > ${m.cw})` });
        if (width === 375 && m.small) issues.push({ code: 'TAP_TARGET', severity: 'error', file: name, message: `${m.small} Tap-Ziele unter 40px Höhe` });
        for (const e of errors) issues.push({ code: 'BROWSER_ERROR', severity: 'error', file: name, message: e });
        await page.close();
      }
    }
  } finally { await browser.close(); srv.close(); }
  return issues;
}
