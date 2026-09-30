import type { Lead } from '../core/types.ts';
import type { LeadSource, SearchQuery } from './types.ts';

/**
 * Google Places (New) Text Search. Nur mit API-Key aktiv. Feldmaske hält die Kosten niedrig.
 * Hinweis Nutzungsbedingungen: Places-Inhalte dürfen nicht unbegrenzt gespeichert werden
 * (dauerhaft nur place_id). Daher werden hier nur Felder für die aktuelle Analyse geholt.
 */
export class GooglePlacesSource implements LeadSource {
  readonly name = 'google-places';
  private apiKey: string | undefined;
  constructor(apiKey: string | undefined = process.env.GOOGLE_PLACES_API_KEY) { this.apiKey = apiKey; }

  async search(q: SearchQuery): Promise<Lead[]> {
    if (!this.apiKey) throw new Error('GOOGLE_PLACES_API_KEY fehlt – Connector ist deaktiviert. CSV-Import nutzen oder Key setzen.');
    const out: Lead[] = [];
    let pageToken: string | undefined;
    while (out.length < q.limit) {
      const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Goog-Api-Key': this.apiKey,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.googleMapsUri,nextPageToken',
        },
        body: JSON.stringify({ textQuery: `${q.industry} ${q.region}`, languageCode: 'de', pageSize: Math.min(20, q.limit - out.length), pageToken }),
      });
      if (!res.ok) throw new Error(`Places API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { places?: any[]; nextPageToken?: string };
      for (const p of data.places ?? []) {
        out.push({
          id: `gp-${p.id}`, companyName: p.displayName?.text ?? 'Unbekannt', industry: q.industry, address: p.formattedAddress,
          region: q.region, phone: p.nationalPhoneNumber, websiteUrl: p.websiteUri, mapsUrl: p.googleMapsUri, source: this.name,
        });
      }
      pageToken = data.nextPageToken;
      if (!pageToken || !data.places?.length) break;
    }
    return out.slice(0, q.limit);
  }
}
