import type { AIProvider, CrawlerProvider, DirectoryProvider, EmailProvider, HostingProvider, PaymentProvider, PlacesProvider, ProviderKind, ProviderStatus, Providers, RenderProvider, SocialDataProvider, WhatsAppProvider } from './types.ts';
import { MockGooglePlacesProvider, MockDirectoryProvider } from './mock/places.ts';
import { MockCrawlerProvider, MockRenderProvider } from './mock/crawler.ts';
import { MockSocialDataProvider } from './mock/social.ts';
import { MockAIProvider } from './mock/ai.ts';
import { MockStripeProvider } from './mock/payment.ts';
import { MockEmailProvider, MockWhatsAppProvider } from './mock/messaging.ts';
import { MockHostingProvider } from './mock/hosting.ts';
import { GooglePlacesProvider } from './real/places.ts';
import { HttpCrawlerProvider } from './real/crawler.ts';
import { PlaywrightRenderProvider, findChromium } from './real/render.ts';
import { AnthropicProvider } from './real/ai.ts';
import { StripeProvider } from './real/stripe.ts';
import { SmtpEmailProvider } from './real/smtp.ts';
import { OsmPlacesProvider } from './real/osm.ts';
import { WhatsAppCloudProvider } from './real/whatsapp.ts';
import { FolderHostingProvider, VercelHostingProvider } from './real/hosting.ts';

type Env = Record<string, string | undefined>;
export type RegistryOptions = { baseUrl: string; now?: () => Date; hostingRoot?: string };
export type Registry = { providers: Providers; status: ProviderStatus[]; mockHosting?: MockHostingProvider; mode: 'mock' | 'live' };

/**
 * Wählt je Dienst den Adapter. APP_MODE=mock (Standard) nutzt überall Mocks; APP_MODE=live nutzt echte Adapter, wo sie gebaut sind und ein Key vorliegt.
 * Einzeln überschreibbar: PROVIDER_PLACES=mock|real, PROVIDER_AI, PROVIDER_PAYMENTS, PROVIDER_HOSTING, PROVIDER_CRAWLER, PROVIDER_RENDER …
 * Fordert man "real" ohne Key an, bleibt der Mock aktiv und der Status nennt den Grund – es wird nie stillschweigend vermischt.
 */
export function createProviders(env: Env, o: RegistryOptions): Registry {
  const mode: 'mock' | 'live' = env.APP_MODE === 'live' ? 'live' : 'mock';
  const want = (k: ProviderKind): 'mock' | 'real' => {
    const v = env[`PROVIDER_${k.toUpperCase()}`];
    return v === 'mock' || v === 'real' ? v : mode === 'live' ? 'real' : 'mock';
  };
  const now = o.now;
  const status: ProviderStatus[] = [];
  const note = (kind: ProviderKind, name: string, m: 'mock' | 'real', n: string) => status.push({ kind, name, mode: m, note: n });

  const mockHosting = new MockHostingProvider(o.baseUrl, o.hostingRoot);
  const pick = <T>(kind: ProviderKind, real: { ok: boolean; why: string; make: () => T } | null, mock: () => T, realName: string): T => {
    if (want(kind) === 'real') {
      if (!real) { const m = mock(); note(kind, (m as any).name, 'mock', 'Echter Adapter noch nicht gebaut – Mock aktiv'); return m; }
      if (!real.ok) { const m = mock(); note(kind, (m as any).name, 'mock', `${real.why} – Mock aktiv`); return m; }
      const r = real.make(); note(kind, (r as any).name, 'real', realName); return r;
    }
    const m = mock(); note(kind, (m as any).name, 'mock', 'Mock (lokal, keine echten Daten)'); return m;
  };

  // Google Places, wenn ein Key da ist; sonst (oder mit PLACES_SOURCE=osm) die keyfreie OpenStreetMap-Quelle
  const useOsm = env.PLACES_SOURCE === 'osm' || (!env.GOOGLE_PLACES_API_KEY && env.PLACES_SOURCE !== 'google');
  const places = pick<PlacesProvider>('places', { ok: true, why: '', make: () => (useOsm ? new OsmPlacesProvider(env.OSM_CONTACT, now) : new GooglePlacesProvider(env.GOOGLE_PLACES_API_KEY, now)) }, () => new MockGooglePlacesProvider({ now }), useOsm ? 'OpenStreetMap (Nominatim/Overpass, ohne Key)' : 'Google Places API');
  const directory = pick<DirectoryProvider>('directory', null, () => new MockDirectoryProvider({ now }), '');
  const placesReal = !places.isMock;
  // Der echte Crawler macht nur Sinn, wenn echte Unternehmensdaten kommen; bei Mock-Daten gibt es die Websites nicht.
  const crawler = pick<CrawlerProvider>('crawler', { ok: placesReal || env.PROVIDER_CRAWLER === 'real', why: 'Mock-Unternehmensdaten verweisen auf nicht existierende Websites', make: () => new HttpCrawlerProvider({ now }) },
    () => new MockCrawlerProvider({ now, hosted: mockHosting }), 'HTTP-Crawler (robots.txt, SSRF-Schutz)');
  const render = pick<RenderProvider>('render', { ok: !!findChromium() && placesReal, why: 'Chromium nicht gefunden oder Mock-Daten', make: () => new PlaywrightRenderProvider() }, () => new MockRenderProvider(), 'Playwright/Chromium');
  const social = pick<SocialDataProvider>('social', null, () => new MockSocialDataProvider({ now }), '');
  const ai = pick<AIProvider>('ai', { ok: !!env.ANTHROPIC_API_KEY, why: 'ANTHROPIC_API_KEY fehlt', make: () => new AnthropicProvider(env.ANTHROPIC_MODEL, env.ANTHROPIC_API_KEY) }, () => new MockAIProvider(), 'Anthropic Messages API');
  const payments = pick<PaymentProvider>('payments', { ok: !!env.STRIPE_SECRET_KEY && !!env.STRIPE_WEBHOOK_SECRET, why: 'STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET fehlen', make: () => new StripeProvider(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET) }, () => new MockStripeProvider(o.baseUrl), 'Stripe Checkout');
  const email = pick<EmailProvider>('email', { ok: !!env.SMTP_HOST && !!env.SMTP_FROM, why: 'SMTP_HOST/SMTP_FROM fehlen', make: () => new SmtpEmailProvider({ host: env.SMTP_HOST!, port: Number(env.SMTP_PORT || 587), secure: env.SMTP_SECURE === '1' || env.SMTP_PORT === '465', user: env.SMTP_USER || undefined, pass: env.SMTP_PASS || undefined, from: env.SMTP_FROM! }) }, () => new MockEmailProvider(), 'SMTP');
  const whatsapp = pick<WhatsAppProvider>('whatsapp', { ok: !!env.WHATSAPP_TOKEN && !!env.WHATSAPP_PHONE_ID, why: 'WHATSAPP_TOKEN/WHATSAPP_PHONE_ID fehlen', make: () => new WhatsAppCloudProvider(env.WHATSAPP_TOKEN!, env.WHATSAPP_PHONE_ID!) }, () => new MockWhatsAppProvider(), 'WhatsApp Cloud API');
  const hosting = pick<HostingProvider>('hosting', { ok: true, why: '', make: () => (env.VERCEL_TOKEN ? new VercelHostingProvider(env.VERCEL_TOKEN, env.VERCEL_TEAM_ID) : new FolderHostingProvider(env.HOSTING_DIR || 'out/sites')) },
    () => mockHosting, env.VERCEL_TOKEN ? 'Vercel' : 'Ordner out/sites');

  return { providers: { places, directory, crawler, render, social, ai, payments, email, whatsapp, hosting }, status, mockHosting: (hosting as unknown) === mockHosting ? mockHosting : undefined, mode };
}
