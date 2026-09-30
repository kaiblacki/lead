import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RenderMetrics, RenderProvider, ViewportMetrics } from '../types.ts';

const CANDIDATES = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
export const findChromium = () => CANDIDATES.find((p): p is string => Boolean(p) && existsSync(p!));

/** Echte Browsermessung mit Playwright/Chromium (kein API-Key nötig). Ohne Chromium liefert sie null. */
export class PlaywrightRenderProvider implements RenderProvider {
  readonly name = 'playwright'; readonly isMock = false;
  private allowPrivate: boolean;
  constructor(opts: { allowPrivate?: boolean } = {}) { this.allowPrivate = opts.allowPrivate ?? false; }

  async measure(t: { url?: string; html?: string }): Promise<RenderMetrics | null> {
    const exe = findChromium();
    if (!exe || (!t.url && !t.html)) return null;
    const { chromium } = await import('playwright-core');
    let srv: ReturnType<typeof createServer> | undefined;
    let target = t.url;
    if (t.html !== undefined) {
      const html = t.html;
      srv = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
      await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', r));
      target = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`;
    } else if (!this.allowPrivate) {
      const { isPrivateIp } = await import('./crawler.ts');
      const host = new URL(target!).hostname;
      if (isPrivateIp(host) || host === 'localhost') return null;
    }
    const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
    const consoleErrors: string[] = [];
    try {
      const viewports: ViewportMetrics[] = [];
      for (const width of [375, 390, 430, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        page.on('pageerror', (e) => consoleErrors.push(e.message));
        await page.goto(target!, { waitUntil: 'load', timeout: 15000 });
        const m = await page.evaluate(() => {
          const fonts = [...document.querySelectorAll('p,li,a,span,td')].map((e) => parseFloat(getComputedStyle(e).fontSize)).filter((n) => n > 0);
          return {
            scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
            smallTapTargets: [...document.querySelectorAll('a,button')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 40; }).length,
            minFontPx: fonts.length ? Math.min(...fonts) : null,
            hasMenuToggle: !!document.querySelector('[aria-label*="Men" i],[class*="menu-toggle"],[class*="hamburger"],[class*="burger"],[aria-controls*="menu" i]'),
          };
        });
        viewports.push({ width, ...m });
        await page.close();
      }
      return { source: this.name, estimated: false, viewports, consoleErrors: [...new Set(consoleErrors)] };
    } finally { await browser.close(); srv?.close(); }
  }
}
