import type { GeocodeResult, PlaceCandidate, PlaceQuery, PlacesProvider } from '../types.ts';

const FIELDS = ['places.id', 'places.displayName', 'places.formattedAddress', 'places.postalAddress', 'places.location', 'places.nationalPhoneNumber', 'places.websiteUri',
  'places.googleMapsUri', 'places.rating', 'places.userRatingCount', 'places.regularOpeningHours.weekdayDescriptions', 'places.businessStatus', 'places.types', 'nextPageToken'].join(',');

/**
 * Google Places API (New) – Textsuche mit Kreis-Begrenzung, Geocoding über die Geocoding API.
 * Nicht gegen die echte API getestet. Hinweis Nutzungsbedingungen: Places-Inhalte dürfen nur begrenzt gespeichert werden
 * (dauerhaft nur place_id); die Aufbewahrungsdauer steuert config/retention.json.
 * Der Kreis ist auf 50 km begrenzt (API-Limit); größere Radien werden hier auf 50 km gekürzt.
 */
export class GooglePlacesProvider implements PlacesProvider {
  readonly name = 'google-places'; readonly isMock = false;
  private apiKey: string | undefined;
  private now: () => Date;
  constructor(apiKey: string | undefined = process.env.GOOGLE_PLACES_API_KEY, now: () => Date = () => new Date()) { this.apiKey = apiKey; this.now = now; }
  private key(): string { if (!this.apiKey) throw new Error('GOOGLE_PLACES_API_KEY fehlt'); return this.apiKey; }

  async geocode(query: string): Promise<GeocodeResult | null> {
    const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&region=de&language=de&key=${encodeURIComponent(this.key())}`);
    if (!res.ok) throw new Error(`Geocoding API ${res.status}`);
    const d = (await res.json()) as { status: string; results?: { formatted_address: string; geometry: { location: { lat: number; lng: number } } }[] };
    const r = d.results?.[0];
    if (d.status !== 'OK' || !r) return null;
    return { query, name: r.formatted_address, point: r.geometry.location, source: this.name };
  }

  async details(externalId: string): Promise<PlaceCandidate | null> {
    const id = externalId.replace(/^gp-/, '');
    const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}?languageCode=de`, { headers: { 'X-Goog-Api-Key': this.key(), 'X-Goog-FieldMask': FIELDS.replace(/places\./g, '').replace(',nextPageToken', '') } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Places API ${res.status}`);
    const p = (await res.json()) as any;
    return { externalId: `gp-${p.id}`, source: this.name, capturedAt: this.now().toISOString(), quality: 'high', name: p.displayName?.text ?? 'Unbekannt', categories: p.types ?? [], address: p.formattedAddress, postalCode: p.postalAddress?.postalCode, city: p.postalAddress?.locality,
      point: p.location ? { lat: p.location.latitude, lng: p.location.longitude } : undefined, phone: p.nationalPhoneNumber, website: p.websiteUri, mapsUrl: p.googleMapsUri, rating: p.rating, reviewCount: p.userRatingCount, openingHours: p.regularOpeningHours?.weekdayDescriptions, businessStatus: p.businessStatus };
  }

  async search(q: PlaceQuery) {
    const items: PlaceCandidate[] = [];
    let requests = 0, pageToken: string | undefined;
    const text = q.keywords.slice(0, 3).join(' ') || 'Unternehmen';
    while (items.length < q.limit && requests < Math.min(10, q.maxRequests ?? 10)) {
      const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST', headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': this.key(), 'X-Goog-FieldMask': FIELDS },
        body: JSON.stringify({ textQuery: text, languageCode: 'de', regionCode: 'DE', pageSize: Math.min(20, q.limit - items.length), pageToken,
          locationBias: { circle: { center: { latitude: q.center.lat, longitude: q.center.lng }, radius: Math.min(50000, q.radiusKm * 1000) } } }),
      });
      requests++;
      if (!res.ok) throw new Error(`Places API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { places?: any[]; nextPageToken?: string };
      const at = this.now().toISOString();
      for (const p of data.places ?? []) {
        items.push({
          externalId: `gp-${p.id}`, source: this.name, capturedAt: at, quality: 'high', name: p.displayName?.text ?? 'Unbekannt', categories: p.types ?? [],
          address: p.formattedAddress, postalCode: p.postalAddress?.postalCode, city: p.postalAddress?.locality,
          point: p.location ? { lat: p.location.latitude, lng: p.location.longitude } : undefined,
          phone: p.nationalPhoneNumber, website: p.websiteUri, mapsUrl: p.googleMapsUri, rating: p.rating, reviewCount: p.userRatingCount,
          openingHours: p.regularOpeningHours?.weekdayDescriptions, businessStatus: p.businessStatus,
        });
      }
      pageToken = data.nextPageToken;
      if (!pageToken || !data.places?.length) break;
    }
    return { items: items.slice(0, q.limit), requests };
  }
}
