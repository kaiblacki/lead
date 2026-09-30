import type { DirectoryProvider, DirectoryRecord, GeocodeResult, PlaceCandidate, PlaceQuery, PlacesProvider } from '../types.ts';
import { getWorld, websiteUrlOf, type FixtureBusiness } from '../../fixtures/world.ts';
import { SUB_PROFILES } from '../../fixtures/sub-profiles.ts';
import { TOWNS } from '../../fixtures/towns.ts';
import { distanceKm } from '../../core/geo.ts';
import { loadConfig } from '../../core/config.ts';
import { norm, normPhone } from '../../core/text.ts';
import { hash32 } from '../../fixtures/rng.ts';

/** Wie eine semantische Textsuche: Begriffe treffen Unterbranche oder Namen. */
function matchesKeywords(b: FixtureBusiness, keywords: string[]): boolean {
  if (!keywords.length) return true;
  const tax = loadConfig().taxonomy;
  const sub = tax.sub(b.subKey);
  const hay = norm([b.name, sub?.label ?? '', ...(sub?.keywords ?? [])].join(' '));
  return keywords.some((k) => { const nk = norm(k); return nk.length >= 3 && (hay.includes(nk) || nk.includes(norm(sub?.key ?? '~'))); });
}

function inArea(b: FixtureBusiness, q: PlaceQuery): number | null {
  const d = distanceKm(q.center, b.point);
  return d <= q.radiusKm ? d : null;
}

export class MockGooglePlacesProvider implements PlacesProvider {
  readonly name = 'mock-google-places'; readonly isMock = true;
  private now: () => Date;
  constructor(opts: { now?: () => Date } = {}) { this.now = opts.now ?? (() => new Date()); }

  async geocode(query: string): Promise<GeocodeResult | null> {
    const q = norm(query);
    if (!q) return null;
    const town = TOWNS.find((t) => norm(t.name) === q || t.zips.includes(query.trim())) ?? TOWNS.find((t) => norm(t.name).startsWith(q) || q.startsWith(norm(t.name.split('/')[0])));
    return town ? { query, name: town.name, point: { lat: town.lat, lng: town.lng }, source: this.name } : null;
  }

  private toCandidate(b: FixtureBusiness): PlaceCandidate {
    return {
      externalId: b.id, source: this.name, capturedAt: this.now().toISOString(), quality: 'high', name: b.name, categories: [SUB_PROFILES.find((s) => s.key === b.subKey)!.placesCategory],
      address: `${b.address}, ${b.postalCode} ${b.city}`, postalCode: b.postalCode, city: b.city, point: b.point, phone: b.phone, website: websiteUrlOf(b),
      mapsUrl: `https://maps.example/?q=${b.id}`, rating: b.rating, reviewCount: b.reviewCount, openingHours: b.hours, businessStatus: b.status, fixture: true,
    };
  }
  async details(externalId: string): Promise<PlaceCandidate | null> { const b = getWorld().find((x) => x.id === externalId && x.inPlaces); return b ? this.toCandidate(b) : null; }

  async search(q: PlaceQuery) {
    const hits = getWorld().filter((b) => b.inPlaces && matchesKeywords(b, q.keywords))
      .map((b) => ({ b, d: inArea(b, q) })).filter((x): x is { b: FixtureBusiness; d: number } => x.d !== null)
      .sort((a, c) => a.d - c.d).slice(0, q.limit);
    const items: PlaceCandidate[] = hits.map(({ b }) => this.toCandidate(b));
    return { items, requests: Math.max(1, Math.ceil(items.length / 20)) };
  }
}

export class MockDirectoryProvider implements DirectoryProvider {
  readonly name = 'mock-directory'; readonly isMock = true;
  private now: () => Date;
  constructor(opts: { now?: () => Date } = {}) { this.now = opts.now ?? (() => new Date()); }

  private record(b: FixtureBusiness): DirectoryRecord {
    // Jedes zehnte Verzeichnis führt eine abweichende Nummer – so entstehen realistische Quellenkonflikte.
    const conflict = b.phone && hash32(b.id) % 10 === 0;
    const phone = conflict ? b.phone!.replace(/\d$/, (d) => String((Number(d) + 3) % 10)) : b.phone;
    return {
      externalId: b.id, source: this.name, capturedAt: this.now().toISOString(), quality: 'medium', name: b.name,
      address: b.address, postalCode: b.postalCode, city: b.city, point: b.point, phone, website: websiteUrlOf(b), email: b.email,
      subIndustry: b.subKey, employeeBucket: b.employeesKnown ? b.employeeBucket : undefined, locationsCount: b.locations, legalForm: b.legalForm,
      foundedYear: b.founded, description: b.description, services: b.services, isChain: b.isChain, fixture: true,
    };
  }
  async search(q: PlaceQuery) {
    const items = getWorld().filter((b) => b.inDirectory && matchesKeywords(b, q.keywords))
      .map((b) => ({ b, d: inArea(b, q) })).filter((x): x is { b: FixtureBusiness; d: number } => x.d !== null)
      .sort((a, c) => a.d - c.d).slice(0, q.limit).map((x) => this.record(x.b));
    return { items, requests: Math.max(1, Math.ceil(items.length / 25)) };
  }
  async lookup(name: string, city?: string, phone?: string): Promise<DirectoryRecord | null> {
    const n = norm(name), c = city ? norm(city) : '';
    const np = phone ? normPhone(phone) : '';
    const b = getWorld().find((x) => x.inDirectory && ((norm(x.name) === n && (!c || norm(x.city) === c)) || (np && x.phone && normPhone(x.phone) === np)));
    return b ? this.record(b) : null;
  }
}
