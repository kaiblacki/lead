/**
 * Schnittstellen aller externen Dienste. Die Geschäftslogik kennt nur diese Typen.
 * Jede Schnittstelle hat einen Mock-Adapter (lokal, ohne Key) und – soweit gebaut – einen echten Adapter.
 * Wird später ein echter Key eingetragen, ändert sich nur, welcher Adapter die Registry zurückgibt.
 */
export type Quality = 'high' | 'medium' | 'low';
export type GeoPoint = { lat: number; lng: number };
export type ProviderKind = 'places' | 'directory' | 'crawler' | 'render' | 'social' | 'ai' | 'payments' | 'email' | 'whatsapp' | 'hosting';

export interface ProviderBase { readonly name: string; readonly isMock: boolean }

// ---------- Orte / Unternehmensdaten ----------
export type PlaceCandidate = {
  externalId: string; source: string; capturedAt: string; quality: Quality;
  name: string; categories: string[];
  address?: string; postalCode?: string; city?: string; point?: GeoPoint;
  phone?: string; website?: string; mapsUrl?: string;
  rating?: number; reviewCount?: number; openingHours?: string[];
  businessStatus?: 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY';
  fixture?: boolean;
};
export type GeocodeResult = { query: string; name: string; point: GeoPoint; source: string };
export type PlaceQuery = { center: GeoPoint; radiusKm: number; keywords: string[]; limit: number; /** Obergrenze für API-Aufrufe (Budget). */ maxRequests?: number };
export interface PlacesProvider extends ProviderBase {
  geocode(query: string): Promise<GeocodeResult | null>;
  /** `requests` = Anzahl der API-Aufrufe (für Budget-Limits). */
  search(q: PlaceQuery): Promise<{ items: PlaceCandidate[]; requests: number }>;
  /** Aktuelle Daten zu einer bekannten externen ID (für erneute Analysen). */
  details(externalId: string): Promise<PlaceCandidate | null>;
}

export type EmployeeBucket = '1-4' | '5-9' | '10-49' | '50+';
export type DirectoryRecord = {
  externalId: string; source: string; capturedAt: string; quality: Quality;
  name: string; address?: string; postalCode?: string; city?: string; point?: GeoPoint; phone?: string; website?: string; email?: string;
  subIndustry?: string; employeeBucket?: EmployeeBucket; locationsCount?: number; legalForm?: string; foundedYear?: number;
  description?: string; services?: string[]; isChain?: boolean; fixture?: boolean;
};
export interface DirectoryProvider extends ProviderBase {
  search(q: PlaceQuery): Promise<{ items: DirectoryRecord[]; requests: number }>;
  lookup(name: string, city?: string, phone?: string): Promise<DirectoryRecord | null>;
}

// ---------- Website ----------
export type CrawledPage = { url: string; status: number; html: string; loadMs: number; bytes: number };
export type CrawlResult = {
  ok: boolean; startUrl: string; finalUrl?: string; pages: CrawledPage[]; error?: string; robotsBlocked?: boolean;
  hasSitemap?: boolean; capturedAt: string; requests: number; source: string;
};
export interface CrawlerProvider extends ProviderBase { crawl(url: string, opts?: { maxPages?: number }): Promise<CrawlResult> }

export type ViewportMetrics = { width: number; scrollWidth: number; clientWidth: number; smallTapTargets: number; minFontPx: number | null; hasMenuToggle: boolean };
export type RenderMetrics = { source: string; estimated: boolean; viewports: ViewportMetrics[]; consoleErrors: string[] };
/** Browser-Messung (Playwright). Der Mock schätzt aus dem HTML und kennzeichnet das als `estimated`. */
export interface RenderProvider extends ProviderBase { measure(target: { url?: string; html?: string }): Promise<RenderMetrics | null> }

// ---------- Social Media ----------
export type SocialProfile = { platform: 'instagram' | 'facebook' | 'linkedin' | 'tiktok'; url: string; handle?: string; followers?: number; lastPostAt?: string; source: string; capturedAt: string; quality: Quality };
/** `complete=false`: Die Quelle konnte nicht zuverlässig prüfen (kein "nicht vorhanden"-Beleg). */
export type SocialResult = { profiles: SocialProfile[]; complete: boolean; source: string; capturedAt: string };
export interface SocialDataProvider extends ProviderBase { lookup(q: { name: string; city?: string; website?: string; knownUrls?: string[] }): Promise<SocialResult> }

// ---------- KI ----------
export type AiTask = 'sales_opener' | 'interpret_change' | 'social_post' | 'classify' | 'analyze_lead' | 'premium_concept' | 'generic';
export type AiTierName = 'MASS' | 'DEEP' | 'PREMIUM';
/** `tier` wählt Modell/Limits aus config/ai.json; `model` überschreibt einzeln (vom Gateway gesetzt). `purpose` ordnet die Kosten zu (analysis | demo | contact). */
export type AiRequest = { task: AiTask; system?: string; prompt: string; maxTokens?: number; tier?: AiTierName; model?: string; purpose?: 'analysis' | 'demo' | 'contact' | 'other' };
export type AiResponse = { text: string; model: string; inputTokens?: number; outputTokens?: number };
export interface AIProvider extends ProviderBase { readonly model: string; complete(r: AiRequest): Promise<AiResponse> }

// ---------- Zahlung ----------
export type CheckoutRequest = {
  amountCents: number; currency: string; description: string; mode: 'payment' | 'subscription';
  orderId: string; paymentId: string; successUrl: string; cancelUrl: string; customerEmail?: string;
};
export type CheckoutSession = { id: string; url: string };
export type PaymentEvent =
  | { id: string; kind: 'paid'; sessionId: string; amountCents: number; currency: string; mode: string }
  | { id: string; kind: 'expired'; sessionId: string }
  | { id: string; kind: 'subscription_problem'; reason: 'canceled' | 'payment_failed'; orderId: string }
  | { id: string; kind: 'ignored' };
export interface PaymentProvider extends ProviderBase {
  createCheckout(r: CheckoutRequest): Promise<CheckoutSession>;
  /** Wirft bei ungültiger Signatur. */
  parseWebhook(rawBody: string, signatureHeader: string | undefined, now?: number): PaymentEvent;
}

// ---------- Nachrichten (nur Schnittstelle + Mock; es wird nichts automatisch gesendet) ----------
export type OutboundMessage = { to: string; subject?: string; text: string; metadata?: Record<string, string> };
export type SendResult = { id: string; status: 'sent' | 'mock_recorded' };
export interface EmailProvider extends ProviderBase { send(m: OutboundMessage): Promise<SendResult> }
export interface WhatsAppProvider extends ProviderBase { send(m: OutboundMessage): Promise<SendResult> }

// ---------- Hosting ----------
export type SiteFiles = Record<string, string>;
export interface HostingProvider extends ProviderBase {
  deploy(slug: string, files: SiteFiles): Promise<{ url: string }>;
  /** Liest eine veröffentlichte Datei zurück (für Wartungsprüfungen des Mocks). */
  exists?(slug: string): Promise<boolean>;
}

export type Providers = {
  places: PlacesProvider; directory: DirectoryProvider; crawler: CrawlerProvider; render: RenderProvider; social: SocialDataProvider;
  ai: AIProvider; payments: PaymentProvider; email: EmailProvider; whatsapp: WhatsAppProvider; hosting: HostingProvider;
};
export type ProviderStatus = { kind: ProviderKind; name: string; mode: 'mock' | 'real'; note: string };
