import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import pg from 'pg';
import { skip, DB_URL } from './helpers.ts';
import { parseEnv, readState } from '../../scripts/demo/lib.ts';
const migTotal = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).length;

/**
 * Start-Launcher gegen einen echten PostgreSQL-Server (dem Test-Server): vollständiger Ablauf über `node scripts/demo.ts start|status|stop`.
 * Sicherheit: eigener Zustandsordner (DEMO_HOME) und eigene, zufällig benannte Datenbanken – die echte Demo (.env.local, .demo, agency_demo) wird nie berührt.
 */
const u = DB_URL ? new URL(DB_URL) : null;
const pgEnv = u ? { PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password) } : {};
const rand = () => Math.random().toString(36).slice(2, 8);
const dbs: string[] = []; const homes: string[] = [];
const admin = async () => { const c = new pg.Client({ connectionString: DB_URL!.replace(/\/[^/]*$/, '/postgres') }); await c.connect(); return c; };
const freePort = () => new Promise<number>((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });

function cli(cmd: string, home: string, db: string, port: number, extra: Record<string, string> = {}) {
  const env = { ...process.env, ...pgEnv, DEMO_HOME: home, DEMO_DB: db, DEMO_PORT: String(port), DEMO_NO_OPEN: '1', ...extra } as Record<string, string>;
  delete env.BRAVE_SEARCH_API_KEY; delete env.DATABASE_URL; delete env.PORT; delete env.PUBLIC_BASE_URL;
  const r = spawnSync(process.execPath, ['scripts/demo.ts', cmd], { env, encoding: 'utf8', timeout: 120_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
after(async () => {
  for (const h of homes) cli('stop', h, 'x', 1);
  const c = await admin().catch(() => null); if (!c) return;
  for (const d of dbs) await c.query(`drop database if exists ${d}`).catch(() => undefined); await c.end();
});

test('demo:start/status/stop: neue Datenbank + Demo-Benutzer + Migrationen, Server mit HTTP, Brave-Hinweis; zweiter Start startet keinen zweiten Server; Stop/Neustart ohne erneutes Einspielen', { skip, timeout: 400_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'demo-home-')); homes.push(home); const db = `demo_t_${rand()}`; dbs.push(db); const port = await freePort();
  const a = cli('start', home, db, port); assert.equal(a.code, 0, a.out);
  for (const t of ['[1/7] PostgreSQL prüfen', '[2/7] Datenbank prüfen', `„${db}“ neu angelegt`, '[3/7] Migrationen', 'inkl. lokales Supabase-Ersatzschema', '[4/7] Demo-Benutzer', '✓ angelegt', '[5/7] Port wählen', '[6/7] Server starten', '[7/7] HTTP prüfen', 'DEMO BEREIT', `http://127.0.0.1:${port}`, 'Brave) ist nicht aktiv']) assert.ok(a.out.includes(t), `${t}\n${a.out}`);
  const env = parseEnv(readFileSync(join(home, '.env.local'), 'utf8')); const st = readState(home)!; assert.equal(st.port, port); assert.equal(st.url, `http://127.0.0.1:${port}`);
  const res = await fetch(st.url, { headers: { authorization: `Basic ${Buffer.from(`x:${env.DASHBOARD_PASSWORD}`).toString('base64')}` } }); const body = await res.text();
  assert.equal(res.status, 200); assert.match(body, /Neue Suche/); for (const f of ['location', 'radiusKm', 'sub']) assert.ok(body.includes(`name="${f}"`), f); assert.match(body, /SMALL/); assert.match(body, /Leads suchen/);
  assert.equal((await fetch(st.url)).status, 401);
  // zweiter Start: derselbe Prozess, kein zweiter Server
  const b = cli('start', home, db, port); assert.equal(b.code, 0, b.out); assert.match(b.out, /DEMO LÄUFT BEREITS/); assert.equal(readState(home)!.pid, st.pid);
  // Status
  const s1 = cli('status', home, db, port); assert.equal(s1.code, 0, s1.out); for (const t of ['PostgreSQL:', 'Database:', 'Migrations:', `OK – ${migTotal}/${migTotal}`, 'Demo-Benutzer:', 'RUNNING', `${port}`, st.url]) assert.ok(s1.out.includes(t), `${t}\n${s1.out}`);
  assert.match(s1.out, /Brave:\s+nicht gesetzt/);
  // Stop → Status zeigt STOPPED; Neustart: Datenbank/Migrationen/Benutzer vorhanden, nichts wird wiederholt
  const stop = cli('stop', home, db, port); assert.match(stop.out, /Demo-Server beendet/); assert.equal(cli('status', home, db, port).code, 1);
  const c = cli('start', home, db, port); assert.equal(c.code, 0, c.out); assert.ok(c.out.includes(`„${db}“ vorhanden`) && c.out.includes(`alle ${migTotal} aktuell`) && c.out.includes('✓ vorhanden'), c.out); assert.ok(!c.out.includes('neu angelegt'));
  assert.notEqual(readState(home)!.pid, st.pid); cli('stop', home, db, port);
  // Zugangsdaten werden nie ausgegeben außer dem Demo-Passwort; der Datenbank-Schlüssel steht nicht in der Ausgabe
  assert.ok(!(a.out + c.out).includes(pgEnv.PGPASSWORD || '\u0000'));
});

test('demo:start: Port belegt → nächster freier Port (richtige URL); Datenbank existiert bereits mit Tabellen, aber ohne Protokoll (älteres Skript) → wird übernommen, nur Fehlendes eingespielt', { skip, timeout: 400_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'demo-home-')); homes.push(home); const db = `demo_t_${rand()}`; dbs.push(db); const port = await freePort();
  // Altbestand nachstellen: Ersatzschema + alle Migrationen außer der letzten, ohne Protokolltabelle
  const c = await admin(); await c.query(`create database ${db}`); await c.end();
  const cl = new pg.Client({ connectionString: DB_URL!.replace(/\/[^/]*$/, `/${db}`) }); await cl.connect();
  await cl.query(readFileSync('test/stub_supabase.sql', 'utf8'));
  const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort(); for (const f of files.slice(0, -1)) await cl.query(readFileSync(join('supabase/migrations', f), 'utf8'));
  const before = (await cl.query("select to_regclass('public.demo_migrations') t")).rows[0].t; assert.equal(before, null); await cl.end();
  const blocker = net.createServer(); await new Promise<void>((r) => blocker.listen(port, '127.0.0.1', r));
  const a = cli('start', home, db, port); blocker.close(); assert.equal(a.code, 0, a.out);
  assert.match(a.out, /vorhanden/); assert.match(a.out, /1 eingespielt/); assert.match(a.out, new RegExp(`${port} ist belegt – nehme ${port + 1}`)); assert.match(a.out, new RegExp(`http://127\\.0\\.0\\.1:${port + 1}`));
  assert.equal(readState(home)!.port, port + 1); assert.ok(!a.out.includes(`➜  http://127.0.0.1:${port}\n`));
  const c2 = new pg.Client({ connectionString: DB_URL!.replace(/\/[^/]*$/, `/${db}`) }); await c2.connect();
  assert.equal((await c2.query('select count(*)::int n from public.demo_migrations')).rows[0].n, files.length); assert.ok((await c2.query("select to_regclass('public.sales_copilot') t")).rows[0].t); await c2.end();
});

test('demo:start: Datenbank-Anmeldung unmöglich → klare Diagnose mit EINEM Lösungsweg, kein Server, kein Absturz', { skip, timeout: 120_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'demo-home-')); homes.push(home); const db = `demo_t_${rand()}`; dbs.push(db); const port = await freePort();
  const r = cli('start', home, db, port, { PGPASSWORD: 'falsches-passwort', PGUSER: 'gibt_es_nicht' });
  // Der Launcher probiert als Rückfall Mac-Benutzer/`postgres` ohne Passwort. Akzeptiert der Server das (trust-Auth, z. B. Postgres.app),
  // lässt sich „Anmeldung unmöglich“ nicht herstellen; Server und Datenbank räumt der after-Hook auf.
  if (r.code === 0) return t.skip('Server nimmt Rückfall-Anmeldungen ohne Passwort an (trust-Auth) – „Anmeldung unmöglich“ nicht herstellbar');
  assert.equal(r.code, 1); assert.match(r.out, /FEHLER: PostgreSQL läuft/); assert.match(r.out, /DATABASE_URL=postgres:\/\//); assert.equal(readState(home), null);
});
