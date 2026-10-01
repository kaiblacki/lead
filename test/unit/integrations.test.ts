import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OsmPlacesProvider, overpassQuery } from '../../src/providers/real/osm.ts';
import { WhatsAppCloudProvider, toE164 } from '../../src/providers/real/whatsapp.ts';
import { amounts } from '../../src/orders/invoice.ts';

const withFetch = async (fn: (calls: { url: string; init?: RequestInit }[]) => Promise<void>, answer: (url: string) => unknown, status = 200) => {
  const orig = globalThis.fetch; const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(answer(String(url))), { status, headers: { 'content-type': 'application/json' } }); }) as typeof fetch;
  try { await fn(calls); } finally { globalThis.fetch = orig; }
};

test('OSM: Overpass-Anfrage aus Schlagwörtern (Branchen-Tags, Namenssuche, Radiusdeckel), Injektionen entschärft', () => {
  const q = overpassQuery({ center: { lat: 49.25, lng: 6.85 }, radiusKm: 80, keywords: ['Nagelstudio', 'Friseur', 'Müller" ];out;//'], limit: 20 });
  assert.match(q, /around:50000,49\.25,6\.85/); assert.match(q, /"shop"="hairdresser"/); assert.match(q, /"beauty"~"nails"/);
  assert.ok(!/";|\]\;out;\/\//.test(q.replace(/\[out:json\]\[timeout:25\];/, '').split(';out center')[0]), q);
  assert.match(overpassQuery({ center: { lat: 1, lng: 2 }, radiusKm: 5, keywords: [], limit: 5 }), /"shop"/);
});

test('OSM: Orte und Firmen werden übernommen (Qualität „mittel“, fehlende Angaben bleiben leer), Namenlose und Dubletten fallen weg', async () => {
  const p = new OsmPlacesProvider('test@beispiel.example', () => new Date('2026-06-01T10:00:00Z'));
  (p as any).throttle = async () => {};
  await withFetch(async (calls) => {
    const g = await p.geocode('Völklingen'); assert.deepEqual(g!.point, { lat: 49.25, lng: 6.85 });
    assert.match(calls[0].url, /nominatim\.openstreetmap\.org/); assert.match(String((calls[0].init!.headers as any)['user-agent']), /AI-Agency-OS.*test@beispiel\.example/);
    const r = await p.search({ center: g!.point, radiusKm: 10, keywords: ['Friseur'], limit: 10 });
    assert.equal(r.requests, 1); assert.equal(r.items.length, 2);
    const a = r.items[0]; assert.equal(a.externalId, 'osm-node-1'); assert.equal(a.quality, 'medium'); assert.equal(a.phone, '06898 1234'); assert.equal(a.website, undefined); assert.equal(a.address, 'Hauptstraße 5'); assert.equal(a.rating, undefined);
    assert.equal(r.items[1].point!.lat, 49.3, 'Weg: Mittelpunkt');
  }, (url) => url.includes('nominatim') ? [{ lat: '49.25', lon: '6.85', display_name: 'Völklingen' }] : { elements: [
    { type: 'node', id: 1, lat: 49.25, lon: 6.85, tags: { name: 'Salon A', shop: 'hairdresser', phone: '06898 1234', 'addr:street': 'Hauptstraße', 'addr:housenumber': '5', 'addr:city': 'Völklingen' } },
    { type: 'way', id: 2, center: { lat: 49.3, lon: 6.9 }, tags: { name: 'Salon B', shop: 'hairdresser', 'contact:website': 'https://b.example' } },
    { type: 'node', id: 3, lat: 1, lon: 1, tags: { shop: 'hairdresser' } }, { type: 'node', id: 1, lat: 49.25, lon: 6.85, tags: { name: 'Salon A' } }] });
  await withFetch(async () => { await assert.rejects(p.search({ center: { lat: 1, lng: 1 }, radiusKm: 5, keywords: ['x'], limit: 5 }), /Overpass 429/); }, () => ({}), 429);
});

test('WhatsApp: Nummern-Normalisierung und API-Aufruf (Bearer, Text, Fehlertext), keine Nachricht bei ungültiger Nummer', async () => {
  assert.equal(toE164('0681 123456'), '49681123456'); assert.equal(toE164('+49 (681) 123-456'), '49681123456'); assert.equal(toE164('0049 681 123456'), '49681123456'); assert.equal(toE164('123'), null); assert.equal(toE164('abc'), null);
  const p = new WhatsAppCloudProvider('tok', '123456789');
  await withFetch(async (calls) => {
    const r = await p.send({ to: '0681 123456', text: 'Hallo' });
    assert.deepEqual(r, { id: 'wamid.1', status: 'sent' }); assert.match(calls[0].url, /graph\.facebook\.com\/v20\.0\/123456789\/messages/);
    assert.equal((calls[0].init!.headers as any).authorization, 'Bearer tok'); const b = JSON.parse(String(calls[0].init!.body)); assert.equal(b.to, '49681123456'); assert.equal(b.text.body, 'Hallo');
    await assert.rejects(p.send({ to: 'xyz', text: 'a' }), /Ungültige Telefonnummer/); assert.equal(calls.length, 1);
  }, () => ({ messages: [{ id: 'wamid.1' }] }));
  await withFetch(async () => { await assert.rejects(p.send({ to: '0681 123456', text: 'a' }), /WhatsApp API 400: Template required/); }, () => ({ error: { message: 'Template required' } }), 400);
});

test('Rechnungsbeträge: netto (USt kommt hinzu, Rest offen), brutto (USt herausgerechnet), Kleinunternehmer', () => {
  assert.deepEqual(amounts(39000, 19, { gross: false, small: false }), { netCents: 39000, vatCents: 7410, grossCents: 46410, openCents: 7410, rate: 19 });
  assert.deepEqual(amounts(46410, 19, { gross: true, small: false }), { netCents: 39000, vatCents: 7410, grossCents: 46410, openCents: 0, rate: 19 });
  assert.deepEqual(amounts(39000, 19, { gross: false, small: true }), { netCents: 39000, vatCents: 0, grossCents: 39000, openCents: 0, rate: 0 });
  for (const c of [1, 99, 12345]) { const a = amounts(c, 19, { gross: true, small: false }); assert.equal(a.netCents + a.vatCents, c); }
});
