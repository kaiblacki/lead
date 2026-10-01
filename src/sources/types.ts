import type { ProviderBase } from '../providers/types.ts';

/** Datenquellen der Pipeline. Die Geschäftslogik kennt nur diese Kennungen und die Fakten (Wert + Quelle), nie die konkrete Schnittstelle. */
export type SourceId = 'OSM' | 'WEB_SEARCH' | 'DIRECT_WEBSITE' | 'GOOGLE_PLACES';

export type WebSearchHit = { url: string; title: string; snippet: string; rank: number };
export type WebSearchResult = { hits: WebSearchHit[]; requests: number; source: string; retrievedAt: string; costCents: number };
export interface WebSearchProvider extends ProviderBase { search(q: { query: string; count?: number }): Promise<WebSearchResult> }

export type SourceStatus = { id: SourceId; provider: string; mode: string; enabled: boolean; isMock: boolean; note: string; centsPerRequest: number };
