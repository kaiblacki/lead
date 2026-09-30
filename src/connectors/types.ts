import type { Lead } from '../core/types.ts';

export type SearchQuery = { industry: string; region: string; radiusKm: number; limit: number };

/** Jede Datenquelle implementiert dieses Interface. Keine Kopplung an eine einzelne Quelle. */
export interface LeadSource {
  readonly name: string;
  search(q: SearchQuery): Promise<Lead[]>;
}
