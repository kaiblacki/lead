import type { Flash, NavKey } from '../ui.ts';
import { layout } from '../ui.ts';
import type { Safe } from '../html.ts';
import type { Req, Res } from '../types.ts';
import { OSM_ATTRIBUTION } from '../../core/enrichment.ts';
import { findPlaceholders } from '../../core/text.ts';
import { html } from '../html.ts';

export function render(r: Req, o: { title: string; nav: NavKey; body: Safe; status?: number }): Res {
  return { status: o.status, body: layout({ title: o.title, nav: o.nav, body: o.body, csrf: r.app.csrf, killSwitch: r.killSwitch, mock: r.app.mock, flash: r.flash, liveData: !r.ctx.registry.providers.places.isMock, attribution: r.ctx.registry.providers.places.name === 'osm' ? OSM_ATTRIBUTION : undefined }) };
}
export const redirect = (path: string, flash?: Flash): Res => ({ redirect: path, flash: flash ?? undefined });
export const okFlash = (text: string): Flash => ({ kind: 'ok', text });
export const errFlash = (text: string): Flash => ({ kind: 'err', text });
export const uuid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;
export const hasPlaceholders = (o: unknown) => findPlaceholders(o).length > 0;

/** Ruhiger Hinweis (kein Fehler), solange die Web-Anreicherung (Brave) nicht aktiviert ist. */
export const webNotice = (r: Req): Safe => (r.ctx.enrichment.available ? html`` : html`<div class="note" id="web-hinweis"><b>Web-Anreicherung nicht aktiviert</b><br>Die Demo verwendet aktuell OpenStreetMap und direkt verfügbare Unternehmensdaten. Zusätzliche Website-, E-Mail- und Kontaktdaten können später über Web-Enrichment ergänzt werden (optional, <code>BRAVE_SEARCH_API_KEY</code>). „Keine Website gefunden“ heißt deshalb nur: in den aktuell verfügbaren Daten ist keine hinterlegt.</div>`);
