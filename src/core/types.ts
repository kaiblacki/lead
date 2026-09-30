import type { EmployeeBucket, GeoPoint, Quality } from '../providers/types.ts';

/** Bestwerte-Sicht auf einen Lead (aus den Fakten abgeleitet). Die Herkunft jedes Wertes steht in den Fakten. */
export type Lead = {
  id: string;                       // externe Referenz (Quelle + ID), stabil für Wiederholungen
  companyName: string;
  industry?: string;                // Hauptbranche (Schlüssel) oder Freitext
  subIndustry?: string;
  address?: string; postalCode?: string; city?: string; region?: string;
  phone?: string; email?: string;
  websiteUrl?: string;
  socials?: { platform: string; url: string; lastActivityAt?: string }[];
  source: string; sourceUrl?: string; mapsUrl?: string;
  openingHours?: string; description?: string;
  employeeBucket?: EmployeeBucket; distanceKm?: number; rating?: number; reviewCount?: number;
  point?: GeoPoint;
  isMock?: boolean;
};

export type { Quality };
