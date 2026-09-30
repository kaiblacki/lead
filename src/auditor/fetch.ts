import type { FetchResult } from '../core/types.ts';

/** Ruft genau die Startseite der Firmen-Website ab (ein Request, Timeout, identifizierbarer User-Agent). */
export async function fetchSite(url: string, timeoutMs = 10000): Promise<FetchResult> {
  const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const started = Date.now();
  try {
    const res = await fetch(normalized, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'AgencyOS-Audit/0.1 (Website-Check)', accept: 'text/html' },
    });
    const html = (await res.text()).slice(0, 500_000);
    return { ok: res.ok, status: res.status, finalUrl: res.url, loadMs: Date.now() - started, html };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
