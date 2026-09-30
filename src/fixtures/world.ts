import type { EmployeeBucket, GeoPoint } from '../providers/types.ts';
import { slugify } from '../core/text.ts';
import { rng, pick, weighted } from './rng.ts';
import { TOWNS, STREETS } from './towns.ts';
import { SUB_PROFILES, LAST_NAMES, FIRST_NAMES } from './sub-profiles.ts';

export type SiteVariant = 'none' | 'modern' | 'modern-nobooking' | 'outdated' | 'nomobile' | 'slow' | 'nohttps' | 'spa' | 'unreachable' | 'social-only';
export type FixtureSocial = { handle: string; followers: number; lastPostDaysAgo: number };

export type FixtureBusiness = {
  id: string; name: string; subKey: string; townKey: string;
  address: string; postalCode: string; city: string; point: GeoPoint;
  phone?: string; email?: string; domain?: string; variant: SiteVariant;
  instagram?: FixtureSocial; facebook?: FixtureSocial; socialUnverifiable: boolean;
  rating?: number; reviewCount: number; hours: string[];
  employeeBucket: EmployeeBucket; employeesKnown: boolean; locations: number; founded: number; legalForm: string;
  services: string[]; description: string; inPlaces: boolean; inDirectory: boolean; isChain: boolean;
  status: 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY';
};

const VARIANTS: Record<SiteVariant, number> = { none: 0.2, modern: 0.17, 'modern-nobooking': 0.13, outdated: 0.2, nomobile: 0.1, slow: 0.04, nohttps: 0.06, spa: 0.03, unreachable: 0.02, 'social-only': 0.05 };
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

let cached: FixtureBusiness[] | null = null;

/** Die Testwelt: rund 400 erfundene Unternehmen rund ums Saarland. Gleiche Version → gleiche Daten. */
export function getWorld(): FixtureBusiness[] {
  if (cached) return cached;
  const out: FixtureBusiness[] = [];
  const usedNames = new Set<string>();
  for (const town of TOWNS) {
    for (const sub of SUB_PROFILES) {
      const rn = rng(`${town.key}/${sub.key}/count`);
      const n = Math.round(town.weight * sub.density * (0.7 + 0.6 * rn()));
      for (let i = 0; i < n; i++) {
        const r = rng(`${town.key}/${sub.key}/${i}`);
        const L = pick(r, LAST_NAMES), F = pick(r, FIRST_NAMES);
        let name = pick(r, sub.names).replace('{L}', L).replace('{F}', F).replace('{T}', town.name.split('/')[0]);
        if (usedNames.has(`${name}|${town.key}`)) name = `${name} ${i + 2}`;
        usedNames.add(`${name}|${town.key}`);
        const variantW = { ...VARIANTS };
        variantW.none += sub.noSiteBias; variantW['social-only'] += sub.noSiteBias / 3;
        const variant = weighted(r, variantW);
        const townSlug = slugify(town.name.split('/')[0]);
        const nameSlug = slugify(name);
        const slug = nameSlug.includes(townSlug) ? nameSlug : `${nameSlug}-${townSlug}`;
        const hasSite = !['none', 'social-only'].includes(variant);
        const emp = weighted(r, sub.emp);
        const isChain = r() < 0.05;
        const locations = isChain ? 4 + Math.floor(r() * 9) : r() < 0.12 ? 2 + Math.floor(r() * 2) : 1;
        const reviewCount = r() < 0.07 ? 0 : Math.min(650, Math.floor(Math.exp(2.6 + 1.2 * (r() + r() + r() - 1.5) * 2)));
        const inDirectory = r() < 0.72, inPlaces = r() < 0.93 || !inDirectory;
        const mkSocial = (p: number): FixtureSocial | undefined => {
          if (r() > p) return undefined;
          const k = r();
          const days = k < 0.5 ? Math.floor(r() * 30) : k < 0.75 ? 31 + Math.floor(r() * 59) : 91 + Math.floor(r() * 500);
          return { handle: slug.replace(/-/g, '_'), followers: Math.floor(Math.exp(4.5 + r() * 3.5)), lastPostDaysAgo: days };
        };
        const street = pick(r, STREETS);
        const zip = pick(r, town.zips);
        const phoneMissing = r() < 0.08;
        const b: FixtureBusiness = {
          id: `fx-${town.key}-${sub.key}-${i}`, name, subKey: sub.key, townKey: town.key,
          address: `${street} ${1 + Math.floor(r() * 90)}`, postalCode: zip, city: town.name,
          point: { lat: round(town.lat + (r() - 0.5) * 0.05), lng: round(town.lng + (r() - 0.5) * 0.07) },
          // Mock-Rufnummern haben eine Teilnehmernummer mit führender 0 und sind in Deutschland nicht vergeben.
          phone: phoneMissing ? undefined : `${town.area} 0${String(Math.floor(r() * 90000) + 10000)}`,
          email: r() < 0.55 ? `${hasSite ? 'info' : 'kontakt'}@${hasSite ? `${slug}.example` : 'mail.example'}`.replace('kontakt@mail.example', `${slug}@mail.example`) : undefined,
          domain: hasSite ? `www.${slug}.example` : undefined, variant,
          instagram: mkSocial(sub.socialBias), facebook: mkSocial(sub.socialBias * 0.6), socialUnverifiable: r() < 0.12,
          rating: reviewCount ? Math.round((3.3 + 1.7 * Math.sqrt(r())) * 10) / 10 : undefined, reviewCount,
          hours: pick(r, sub.hours), employeeBucket: isChain ? '50+' : emp, employeesKnown: r() < 0.7, locations, founded: 1985 + Math.floor(r() * 39),
          legalForm: weighted(r, { Einzelunternehmen: 0.6, GmbH: 0.3, UG: 0.1 }),
          services: sub.services.filter(() => r() < 0.75).slice(0, 5), description: '', inPlaces, inDirectory, isChain,
          status: r() < 0.03 ? 'CLOSED_PERMANENTLY' : 'OPERATIONAL',
        };
        if (!b.services.length) b.services = [sub.services[0]];
        b.description = `${name} ist ${sub.key === 'zahnarzt' ? 'eine' : 'ein'} Betrieb in ${b.city}. Angebot: ${b.services.join(', ')}.`;
        out.push(b);
      }
    }
  }
  cached = out;
  return out;
}

export const findByDomain = (host: string) => getWorld().find((b) => b.domain && b.domain.replace(/^www\./, '') === host.replace(/^www\./, ''));
export const findById = (id: string) => getWorld().find((b) => b.id === id);
export const websiteUrlOf = (b: FixtureBusiness): string | undefined =>
  b.variant === 'none' ? undefined : b.variant === 'social-only' ? `https://www.facebook.com/${b.facebook?.handle ?? b.instagram?.handle ?? slugify(b.name)}` : `${b.variant === 'nohttps' || b.variant === 'outdated' ? 'http' : 'https'}://${b.domain}`;
