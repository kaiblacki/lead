import { WebSearchError, type WebSearchProvider, type WebSearchResult } from '../../sources/types.ts';

export type BraveOptions = { usdPerThousandRequests: number; minIntervalMs?: number; maxRetries?: number; timeoutMs?: number };

/**
 * Brave Search API (BRAVE_SEARCH_API_KEY): GET /res/v1/web/search mit Header X-Subscription-Token.
 * Preis laut Anbieter: 5 USD je 1.000 Anfragen → 0,005 USD je Anfrage (Betrag in USD, siehe config/pipeline.json → sources.WEB_SEARCH.pricing).
 * Höflichkeit/Robustheit: Mindestabstand zwischen Anfragen (Standard 1,1 s), bei HTTP 429 Wiederholung nach Retry-After/X-RateLimit-Reset (höchstens 2×),
 * klare Fehlertexte; 401/402/403 gelten als „fatal“ (ungültiger Schlüssel/Kontingent) – keine Fehlerkaskade über viele Leads.
 * Nicht gegen den echten Dienst getestet (nur mit nachgestellten Antworten) – der erste echte Lauf ist der kontrollierte 5-Lead-Test.
 */
export class BraveSearchProvider implements WebSearchProvider {
  readonly name = 'brave-search'; readonly isMock = false;
  private key: string | undefined; private o: Required<BraveOptions>; private now: () => Date; private base: string; private last = 0;
  constructor(apiKey: string | undefined = process.env.BRAVE_SEARCH_API_KEY, opts: BraveOptions = { usdPerThousandRequests: 5 }, now: () => Date = () => new Date(), base = 'https://api.search.brave.com/res/v1/web/search') {
    this.key = apiKey; this.now = now; this.base = base;
    this.o = { usdPerThousandRequests: opts.usdPerThousandRequests, minIntervalMs: opts.minIntervalMs ?? 1100, maxRetries: opts.maxRetries ?? 2, timeoutMs: opts.timeoutMs ?? 20_000 };
  }
  /** Kosten je Anfrage in USD (5 USD / 1000 = 0,005). */
  get usdPerRequest() { return this.o.usdPerThousandRequests / 1000; }
  private async wait() { const w = this.last + this.o.minIntervalMs - Date.now(); if (w > 0) await new Promise((r) => setTimeout(r, w)); this.last = Date.now(); }

  async search(q: { query: string; count?: number }): Promise<WebSearchResult> {
    if (!this.key) throw new WebSearchError('BRAVE_SEARCH_API_KEY fehlt', { fatal: true });
    // country (zweistelliger Ländercode in Großbuchstaben) und search_lang sind optional: lehnt die API einen der Werte ab, wird einmal ohne ihn wiederholt (eine abgelehnte Anfrage wird nicht berechnet)
    const params: Record<string, string> = { q: q.query.slice(0, 380), count: String(Math.min(Math.max(q.count ?? 10, 1), 20)), country: 'DE', search_lang: 'de' }; let paramRetry = false;
    for (let attempt = 0; ; attempt++) {
      await this.wait();
      let res: Response;
      try { res = await fetch(`${this.base}?${new URLSearchParams(params).toString().replace(/\+/g, '%20')}`, { headers: { accept: 'application/json', 'x-subscription-token': this.key }, signal: AbortSignal.timeout(this.o.timeoutMs) }); }
      catch (e) { throw new WebSearchError(`Brave Search nicht erreichbar: ${e instanceof Error ? e.message : String(e)}`, { fatal: false }); }
      const rate = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'].map((h) => res.headers.get(h) ? `${h.replace('x-ratelimit-', '')}=${res.headers.get(h)}` : '').filter(Boolean).join(' ');
      if (res.status === 429 && attempt < this.o.maxRetries) {
        const wait = Number(res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset')?.split(',')[0]) || 2; await new Promise((r) => setTimeout(r, Math.min(15, Math.max(1, wait)) * 1000)); continue;
      }
      if (!res.ok) {
        // Fehlerbody laut API: {"error":{"code":"SUBSCRIPTION_TOKEN_INVALID","detail":"…","meta":{"errors":[{"loc":["query","country"],"msg":"…"}]},"status":422}} – Brave meldet einen ungültigen Schlüssel mit HTTP 422 (nicht 401)
        const raw = (await res.text().catch(() => '')).slice(0, 2000); let code = '', detail = ''; const bad: { loc: string[]; msg: string }[] = [];
        try { const j = JSON.parse(raw); code = String(j?.error?.code ?? ''); detail = String(j?.error?.detail ?? ''); for (const e of j?.error?.meta?.errors ?? []) bad.push({ loc: (e.loc ?? []).map(String), msg: String(e.msg ?? '') }); } catch { /* kein JSON */ }
        const dropable = bad.map((e) => e.loc[e.loc.length - 1]).filter((n) => n === 'country' || n === 'search_lang');
        if (res.status === 422 && code === 'VALIDATION' && dropable.length && !paramRetry) { paramRetry = true; for (const n of dropable) delete params[n]; continue; }
        const tokenBad = code === 'SUBSCRIPTION_TOKEN_INVALID' || bad.some((e) => e.loc.includes('x-subscription-token'));
        const why = tokenBad ? 'API-Schlüssel ungültig oder fehlt – BRAVE_SEARCH_API_KEY prüfen' : res.status === 401 || res.status === 403 ? 'API-Schlüssel ungültig oder ohne Berechtigung' : res.status === 402 ? 'Kontingent/Zahlung' : res.status === 422 ? 'Anfrage abgelehnt' : res.status === 429 ? (/quota/i.test(code) ? 'Kontingent erschöpft' : 'Rate-Limit/Kontingent erreicht') : 'Serverfehler';
        const info = [code, detail, ...bad.map((e) => `${e.loc.join('.')}: ${e.msg}`)].filter(Boolean).join(' – ') || raw.slice(0, 160).replace(/\s+/g, ' ');
        throw new WebSearchError(`Brave Search HTTP ${res.status} (${why})${info ? `: ${info}` : ''}`, { status: res.status, fatal: tokenBad || [401, 402, 403, 429].includes(res.status) });
      }
      const j = (await res.json()) as { web?: { results?: { url?: string; title?: string; description?: string }[] } };
      const hits = (j.web?.results ?? []).filter((r) => r.url).map((r, i) => ({ url: r.url!, title: (r.title ?? '').replace(/<[^>]+>/g, ''), snippet: (r.description ?? '').replace(/<[^>]+>/g, ''), rank: i + 1 }));
      return { hits, requests: 1, source: this.name, retrievedAt: this.now().toISOString(), cost: { amount: this.usdPerRequest, currency: 'USD' }, rateLimit: rate || undefined };
    }
  }
}
