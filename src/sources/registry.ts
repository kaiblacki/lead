import type { AppConfig } from '../core/config.ts';
import type { Providers } from '../providers/types.ts';
import type { SourceStatus, WebSearchProvider } from './types.ts';
import { BraveSearchProvider } from '../providers/real/websearch.ts';
import { MockWebSearchProvider } from '../providers/mock/websearch.ts';

type Env = Record<string, string | undefined>;
/** Live ohne Schlüssel: keine Websuche (nichts wird erfunden). */
class NoWebSearch implements WebSearchProvider {
  readonly name = 'keine-quelle'; readonly isMock = false;
  async search() { return { hits: [], requests: 0, source: this.name, retrievedAt: new Date().toISOString(), costCents: 0 }; }
}

export type Sources = { webSearch: WebSearchProvider; status: SourceStatus[] };

/** Zusätzliche Quellen neben den Providern aus `createProviders`: Websuche (Brave/Mock) und die Statusübersicht aller Quellen (OSM, WEB_SEARCH, DIRECT_WEBSITE, GOOGLE_PLACES). */
export function createSources(env: Env, cfg: AppConfig, providers: Providers, o: { now?: () => Date } = {}): Sources {
  const S = cfg.pipeline.sources; const live = env.APP_MODE === 'live';
  const forced = env.PROVIDER_WEBSEARCH;
  const wantReal = forced === 'real' || (forced !== 'mock' && live);
  let webSearch: WebSearchProvider; let note: string;
  if (!S.WEB_SEARCH.enabled) { webSearch = new NoWebSearch(); note = 'in config/pipeline.json ausgeschaltet'; }
  else if (wantReal && env.BRAVE_SEARCH_API_KEY) { webSearch = new BraveSearchProvider(env.BRAVE_SEARCH_API_KEY, S.WEB_SEARCH.centsPerRequest, o.now); note = 'Brave Search API'; }
  else if (wantReal) { webSearch = new NoWebSearch(); note = 'BRAVE_SEARCH_API_KEY fehlt – keine Websuche (es wird nichts erfunden)'; }
  else { webSearch = new MockWebSearchProvider({ now: o.now }); note = 'Mock (Testwelt, keine echten Daten)'; }
  const placesName = providers.places.name;
  const osmMode = (providers.places as { mode?: string }).mode ?? (env.OSM_MODE || S.OSM.mode);
  const status: SourceStatus[] = [
    { id: 'OSM', provider: placesName === 'osm' ? 'osm' : placesName, mode: placesName === 'osm' ? String(osmMode) : providers.places.isMock ? 'MOCK' : '–', enabled: placesName === 'osm' || providers.places.isMock, isMock: providers.places.isMock,
      note: placesName === 'osm' ? (osmMode === 'PUBLIC_DEMO' ? 'Öffentliche Server – nur Demo/kleine Läufe (1 Anfrage/s, Zwischenspeicher)' : String(osmMode)) : providers.places.isMock ? 'Mock-Testwelt' : `Aktive Ortsquelle: ${placesName}`, centsPerRequest: S.OSM.centsPerRequest },
    { id: 'WEB_SEARCH', provider: webSearch.name, mode: webSearch.isMock ? 'MOCK' : webSearch.name === 'keine-quelle' ? 'AUS' : 'LIVE', enabled: webSearch.name !== 'keine-quelle', isMock: webSearch.isMock, note, centsPerRequest: S.WEB_SEARCH.centsPerRequest },
    { id: 'DIRECT_WEBSITE', provider: providers.crawler.name, mode: providers.crawler.isMock ? 'MOCK' : 'LIVE', enabled: true, isMock: providers.crawler.isMock, note: `bis zu ${S.DIRECT_WEBSITE.maxPages} Seiten je Domain, robots.txt wird beachtet`, centsPerRequest: S.DIRECT_WEBSITE.centsPerRequest },
    { id: 'GOOGLE_PLACES', provider: 'google-places', mode: placesName === 'google-places' ? 'LIVE' : 'AUS', enabled: placesName === 'google-places', isMock: false, note: placesName === 'google-places' ? 'Aktiv (isoliert, Quelle „google-places“)' : 'Optional, standardmäßig aus (kein GOOGLE_PLACES_API_KEY / PLACES_SOURCE=google)', centsPerRequest: 0 },
  ];
  return { webSearch, status };
}
