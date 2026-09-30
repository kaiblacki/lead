import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { CrawledPage, CrawlResult, CrawlerProvider } from '../types.ts';
import { selectLinks } from '../crawl-util.ts';

export function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  if (isIP(v) === 6) return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
  const p = v.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** Ruft nur öffentliche Websites ab: Schema-Prüfung, keine privaten/internen Adressen (auch nicht über Weiterleitungen), robots.txt, Timeouts, Größenlimit. */
export class HttpCrawlerProvider implements CrawlerProvider {
  readonly name = 'http-crawler'; readonly isMock = false;
  private timeoutMs: number; private ua: string; private allowPrivate: boolean; private now: () => Date;
  constructor(opts: { timeoutMs?: number; userAgent?: string; allowPrivate?: boolean; now?: () => Date } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 10000; this.ua = opts.userAgent ?? 'AgencyOS-Audit/1.0 (Website-Check)'; this.allowPrivate = opts.allowPrivate ?? false; this.now = opts.now ?? (() => new Date());
  }

  private async assertPublic(u: URL) {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Nur http/https erlaubt');
    if (this.allowPrivate) return;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Interne oder private Adresse wird nicht abgerufen');
  }

  private async get(url: string, binaryLimit = 500_000): Promise<{ status: number; html: string; loadMs: number; bytes: number; finalUrl: string }> {
    let cur = url;
    const started = Date.now();
    for (let hop = 0; hop < 5; hop++) {
      const u = new URL(cur);
      await this.assertPublic(u);
      const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs), headers: { 'user-agent': this.ua, accept: 'text/html,application/xhtml+xml' } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { cur = new URL(res.headers.get('location')!, u).toString(); continue; }
      const type = res.headers.get('content-type') ?? '';
      const buf = type.includes('html') || type.includes('text') || type.includes('xml') ? await res.text() : '';
      return { status: res.status, html: buf.slice(0, binaryLimit), loadMs: Date.now() - started, bytes: Number(res.headers.get('content-length')) || buf.length, finalUrl: u.toString() };
    }
    throw new Error('Zu viele Weiterleitungen');
  }

  private async robotsAllows(origin: string, path: string): Promise<boolean> {
    try {
      const r = await this.get(`${origin}/robots.txt`, 50_000);
      if (r.status !== 200) return true;
      let applies = false; const disallow: string[] = [];
      for (const raw of r.html.split(/\r?\n/)) {
        const line = raw.split('#')[0].trim();
        const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
        if (!m) continue;
        const k = m[1].toLowerCase(), v = m[2].trim();
        if (k === 'user-agent') applies = v === '*' || this.ua.toLowerCase().startsWith(v.toLowerCase());
        else if (k === 'disallow' && applies && v) disallow.push(v);
      }
      return !disallow.some((d) => path.startsWith(d));
    } catch { return true; }
  }

  async crawl(url: string, opts: { maxPages?: number } = {}): Promise<CrawlResult> {
    const max = Math.min(Math.max(opts.maxPages ?? 4, 1), 8);
    const base = { startUrl: url, capturedAt: this.now().toISOString(), source: this.name };
    let requests = 0;
    try {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^https?:\/\//i.test(url)) throw new Error('Nur http/https erlaubt');
      const start = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      const u0 = new URL(start);
      if (!(await this.robotsAllows(u0.origin, u0.pathname || '/'))) return { ...base, ok: false, pages: [], robotsBlocked: true, error: 'robots.txt verbietet den Abruf', requests: 1 };
      requests++;
      const first = await this.get(start); requests++;
      const pages: CrawledPage[] = [{ url: first.finalUrl, status: first.status, html: first.html, loadMs: first.loadMs, bytes: first.bytes }];
      if (first.status >= 400) return { ...base, ok: false, finalUrl: first.finalUrl, pages, error: `HTTP ${first.status}`, requests };
      for (const link of selectLinks(first.html, first.finalUrl, max - 1)) {
        const lu = new URL(link);
        if (!(await this.robotsAllows(lu.origin, lu.pathname))) continue;
        try { const r = await this.get(link); requests++; pages.push({ url: r.finalUrl, status: r.status, html: r.html, loadMs: r.loadMs, bytes: r.bytes }); } catch { pages.push({ url: link, status: 0, html: '', loadMs: 0, bytes: 0 }); }
      }
      let hasSitemap = false;
      try { const s = await this.get(`${new URL(first.finalUrl).origin}/sitemap.xml`, 2000); requests++; hasSitemap = s.status === 200; } catch { /* egal */ }
      return { ...base, ok: true, finalUrl: first.finalUrl, pages, hasSitemap, requests };
    } catch (e) {
      return { ...base, ok: false, pages: [], error: e instanceof Error ? e.message : String(e), requests: Math.max(requests, 1) };
    }
  }
}
