import type { ProviderBase } from '../providers/types.ts';

/** Datenquellen der Pipeline. Die Geschäftslogik kennt nur diese Kennungen und die Fakten (Wert + Quelle), nie die konkrete Schnittstelle. */
export type SourceId = 'OSM' | 'WEB_SEARCH' | 'DIRECT_WEBSITE' | 'GOOGLE_PLACES';

export type WebSearchHit = { url: string; title: string; snippet: string; rank: number };
/** Geldbetrag mit Währung (kein stilles „Cent“): Providerkosten stehen immer in der Währung des Anbieters. */
export type Money = { amount: number; currency: 'USD' | 'EUR' };
export type WebSearchResult = { hits: WebSearchHit[]; requests: number; source: string; retrievedAt: string; cost: Money; /** Rate-Limit-Hinweise des Anbieters (nur zur Anzeige). */ rateLimit?: string };
/** Fehler eines Websuche-Anbieters. `fatal`: weitere Anfragen sind sinnlos (ungültiger Schlüssel, Kontingent leer) – ein Stapel bricht dann ab, statt für jeden Lead erneut zu scheitern. */
export class WebSearchError extends Error {
  status?: number; fatal: boolean;
  constructor(message: string, o: { status?: number; fatal?: boolean } = {}) { super(message); this.name = 'WebSearchError'; this.status = o.status; this.fatal = o.fatal ?? false; }
}
export interface WebSearchProvider extends ProviderBase { search(q: { query: string; count?: number }): Promise<WebSearchResult> }

export type SourceStatus = { id: SourceId; provider: string; mode: string; enabled: boolean; isMock: boolean; note: string; pricing: string };
