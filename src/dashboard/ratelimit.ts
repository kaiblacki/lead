/** Einfacher Fenster-Zähler pro Schlüssel (z. B. IP). Läuft im Speicher; bei mehreren Instanzen pro Instanz. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  private max: number; private windowMs: number;
  constructor(max: number, windowMs: number) { this.max = max; this.windowMs = windowMs; }
  /** Zählt einen Treffer; false = Limit überschritten. */
  hit(key: string, now = Date.now()): boolean {
    this.sweep(now);
    const e = this.hits.get(key);
    if (!e || e.reset <= now) { this.hits.set(key, { n: 1, reset: now + this.windowMs }); return true; }
    e.n++;
    return e.n <= this.max;
  }
  blocked(key: string, now = Date.now()): boolean {
    const e = this.hits.get(key);
    return Boolean(e && e.reset > now && e.n >= this.max);
  }
  reset(key: string) { this.hits.delete(key); }
  private sweep(now: number) {
    if (this.hits.size < 5000) return;
    for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
  }
}
