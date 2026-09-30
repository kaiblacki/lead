import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appSetup, skip, AUTH, PASSWORD, type App } from './helpers.ts';

const OWNER = '00000000-0000-0000-0000-0000000000c1';
let app: App;
before(async () => { if (!skip) app = await appSetup(OWNER); });
after(async () => { if (!skip) await app.close(); });

const PAGES = ['/', '/search', '/leads', '/calls', '/pipeline', '/orders', '/maintenance', '/analytics', '/settings', '/audit'];

test('Alle Seiten erreichbar (leere Datenbank), gültiges HTML, Sicherheits-Header, Mock-Hinweis', { skip }, async () => {
  for (const p of PAGES) {
    const r = await app.get(p); assert.equal(r.status, 200, p);
    const h = await r.text();
    assert.match(h, /<!doctype html>/); assert.match(h, /name="viewport"/); assert.match(h, /MOCK-MODUS/); assert.match(h, /<h1>/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY'); assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.ok(!/<script/i.test(h), p);
  }
  assert.equal(await (await app.get('/healthz', false)).text(), 'ok');
  assert.equal((await app.get('/gibts-nicht')).status, 404);
  assert.equal((await app.get('/leads/00000000-0000-0000-0000-000000000000')).status, 404);
});

test('Login Pflicht, falsches Passwort, CSRF-Schutz, fremde Herkunft', { skip }, async () => {
  assert.equal((await app.get('/', false)).status, 401);
  assert.equal((await fetch(app.base + '/', { headers: { authorization: 'Basic ' + Buffer.from('u:falsch').toString('base64') } })).status, 401);
  const noCsrf = await fetch(app.base + '/settings/limits', { method: 'POST', headers: { ...AUTH, 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrf=falsch' });
  assert.equal(noCsrf.status, 403);
  const evil = await app.post('/settings/limits', {}, { origin: 'http://evil.example' });
  assert.equal(evil.status, 403);
  void PASSWORD; void AUTH;
});

test('Fehler bei Formularen erscheinen als Hinweis auf der Seite, nicht als Absturz', { skip }, async () => {
  const r = await app.post('/search/quick', { q: 'Blablubb 123' });
  assert.equal(r.status, 303);
  const page = app.text(await app.follow(r));
  assert.match(page, /Nicht verstanden: Blablubb 123/);
  const bad = app.text(await app.follow(await app.post('/search', { _form: '1', location: '', radiusKm: '0', maxLeads: '0' })));
  assert.match(bad, /Ort fehlt/); assert.match(bad, /Radius/); assert.match(bad, /Branche, Unterbranche oder ein Stichwort/);
  assert.equal((await app.pool.query('select count(*)::int n from lead_runs where owner_id=$1', [OWNER])).rows[0].n, 0);   // ungültige Eingaben starten nichts
});

test('Kill Switch im Dashboard: Banner, stoppt Suche und Wartungsläufe, wieder aufhebbar', { skip }, async () => {
  let r = await app.post('/killswitch', { on: '1' }); assert.equal(r.status, 303);
  assert.match(await (await app.get('/')).text(), /KILL SWITCH AKTIV/);
  const s = app.text(await app.follow(await app.post('/search/quick', { q: 'Völklingen + 30 km + Nagelstudios' })));
  assert.match(s, /Kill Switch ist aktiv/);
  assert.deepEqual(await app.ctx.maintenance.runDue(), { checked: 0, failed: 0 });
  r = await app.post('/killswitch', { on: '0' });
  assert.doesNotMatch(await (await app.get('/')).text(), /KILL SWITCH AKTIV/);
});

test('Rate Limits: Anmeldung sperrt nach 10 Fehlversuchen; öffentliche Seiten begrenzt', { skip }, async () => {
  const bad = { authorization: 'Basic ' + Buffer.from('u:falsch-falsch-1').toString('base64') };
  let blockedAt = 0;
  for (let i = 1; i <= 14 && !blockedAt; i++) { const st = (await fetch(app.base + '/leads', { headers: bad })).status; if (st === 429) blockedAt = i; else assert.equal(st, 401); }
  assert.ok(blockedAt > 0 && blockedAt <= 12, `gesperrt bei ${blockedAt}`);
  assert.equal((await app.get('/leads')).status, 429);        // auch mit richtigem Passwort gesperrt
});
