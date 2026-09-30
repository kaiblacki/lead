import type { CrawledPage, CrawlResult, CrawlerProvider, RenderMetrics, RenderProvider, ViewportMetrics } from '../types.ts';
import { findByDomain } from '../../fixtures/world.ts';
import { siteFor } from '../../fixtures/sites.ts';
import { selectLinks } from '../crawl-util.ts';
import { hostOf } from '../../core/text.ts';

/** Liefert bereits veröffentlichte Mock-Seiten (aus dem Mock-Hosting) an den Crawler. */
export interface HostedSites { baseUrl: string; read(slug: string, path: string): string | null; isDown(slug: string): boolean }

export class MockCrawlerProvider implements CrawlerProvider {
  readonly name = 'mock-crawler'; readonly isMock = true;
  private now: () => Date; private hosted?: HostedSites;
  constructor(opts: { now?: () => Date; hosted?: HostedSites } = {}) { this.now = opts.now ?? (() => new Date()); this.hosted = opts.hosted; }

  async crawl(url: string, opts: { maxPages?: number } = {}): Promise<CrawlResult> {
    const max = Math.min(Math.max(opts.maxPages ?? 4, 1), 8);
    const capturedAt = this.now().toISOString();
    const base: Pick<CrawlResult, 'startUrl' | 'capturedAt' | 'source'> = { startUrl: url, capturedAt, source: this.name };
    if (this.hosted && url.startsWith(this.hosted.baseUrl + '/hosted/')) return this.crawlHosted(url, max, base);
    const host = hostOf(url);
    const b = host ? findByDomain(host) : undefined;
    if (!b) return { ...base, ok: false, pages: [], error: `getaddrinfo ENOTFOUND ${host ?? url}`, requests: 1 };
    const spec = siteFor(b, this.now());
    if (!spec || !spec.ok) return { ...base, ok: false, pages: [], error: spec?.error ?? 'Keine Website', requests: 1 };
    const origin = `${spec.finalScheme}://${b.domain}`;
    const home = spec.pages[0];
    const pages: CrawledPage[] = [{ url: `${origin}/`, status: home.status, html: home.html, loadMs: spec.loadMs, bytes: spec.bytes }];
    for (const link of selectLinks(home.html, `${origin}/`, max - 1)) {
      const p = spec.pages.find((x) => x.path === new URL(link).pathname);
      pages.push({ url: link, status: p?.status ?? 404, html: p?.html ?? '', loadMs: Math.round(spec.loadMs * 0.6), bytes: Math.round((p?.html.length ?? 0) * 1.1) });
    }
    return { ...base, ok: true, finalUrl: `${origin}/`, pages, hasSitemap: spec.hasSitemap, requests: pages.length + 1 };
  }

  private crawlHosted(url: string, max: number, base: Pick<CrawlResult, 'startUrl' | 'capturedAt' | 'source'>): CrawlResult {
    const rel = url.slice(this.hosted!.baseUrl.length + '/hosted/'.length);
    const slug = rel.split('/')[0];
    const path = rel.split('/').slice(1).join('/') || 'index.html';
    if (this.hosted!.isDown(slug)) return { ...base, ok: false, pages: [], error: 'connect ECONNREFUSED (Mock: Ausfall simuliert)', requests: 1 };
    const html = this.hosted!.read(slug, path);
    if (html === null) return { ...base, ok: false, pages: [{ url, status: 404, html: '', loadMs: 50, bytes: 0 }], error: 'HTTP 404', requests: 1 };
    const root = `${this.hosted!.baseUrl}/hosted/${slug}/`;
    const pages: CrawledPage[] = [{ url, status: 200, html, loadMs: 120, bytes: html.length }];
    for (const link of selectLinks(html, root, max - 1)) {
      const p = link.slice(root.length);
      const h = this.hosted!.read(slug, p);
      pages.push({ url: link, status: h === null ? 404 : 200, html: h ?? '', loadMs: 90, bytes: h?.length ?? 0 });
    }
    return { ...base, ok: true, finalUrl: url, pages, hasSitemap: false, requests: pages.length };
  }
}

/** Schätzt Browser-Messwerte aus dem HTML. Gekennzeichnet als `estimated`. */
export class MockRenderProvider implements RenderProvider {
  readonly name = 'mock-render'; readonly isMock = true;
  async measure(t: { url?: string; html?: string }): Promise<RenderMetrics | null> {
    const html = t.html;
    if (!html) return null;
    const viewport = /<meta[^>]+name=["']viewport["']/i.test(html);
    const fixedWidth = /body\{[^}]*width:\s*(\d{3,4})px/i.exec(html) ?? /<table[^>]+width=["']?(\d{3,4})/i.exec(html);
    const layoutW = fixedWidth ? Number(fixedWidth[1]) : 0;
    const toggle = /menu-toggle|hamburger|aria-label=["']Menü/i.test(html);
    const tinyFont = /<font[^>]+size=["']?[12]\b/i.test(html) ? 10 : 16;
    const links = (html.match(/<a\b/gi) ?? []).length;
    const viewports: ViewportMetrics[] = [375, 390, 430, 1280].map((width) => {
      const natural = viewport ? width : Math.max(width, 980);
      const scrollWidth = Math.max(natural, layoutW);
      return { width, scrollWidth, clientWidth: natural, smallTapTargets: width < 600 && !viewport ? links : 0, minFontPx: tinyFont, hasMenuToggle: width < 600 && toggle };
    });
    return { source: this.name, estimated: true, viewports, consoleErrors: [] };
  }
}
