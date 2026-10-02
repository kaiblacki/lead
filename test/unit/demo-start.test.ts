import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { DEMO_OWNER_ID, clearState, diagnoseLog, ensureEnvLocal, findFreePort, findPostgresInstalls, isOurServer, parseEnv, pidAlive, portBusy, startPostgres, startServer, stateFile, stopServer, readState } from '../../scripts/demo/lib.ts';

/** Start-Launcher (ohne Datenbank): Erkennung von PostgreSQL-Installationen, Konfiguration, Ports, Serverstart/-absturz, Stop. Alles in Temp-Ordnern – keine echte Installation wird angefasst. */
const tmp = () => mkdtempSync(join(tmpdir(), 'demo-test-'));
const fakeBin = (dir: string, names: string[]) => { mkdirSync(dir, { recursive: true }); for (const n of names) { const f = join(dir, n); writeFileSync(f, '#!/bin/sh\nexit 0\n'); chmodSync(f, 0o755); } return dir; };
const listen = (port = 0) => new Promise<net.Server & { port: number }>((resolve) => { const s = net.createServer(); s.listen(port, '127.0.0.1', () => resolve(Object.assign(s, { port: (s.address() as net.AddressInfo).port }))); });
const freeBase = async () => { const s = await listen(); const p = s.port; await new Promise((r) => s.close(r)); return p; };

test('Resolver: psql nicht im PATH, aber Postgres.app vorhanden → Programmordner der neuesten Version wird gefunden', () => {
  const r = tmp(); const app = join(r, 'Postgres.app');
  fakeBin(join(app, 'Contents', 'Versions', '15', 'bin'), ['psql', 'pg_isready']); fakeBin(join(app, 'Contents', 'Versions', '16', 'bin'), ['psql', 'pg_isready', 'pg_ctl']);
  const found = findPostgresInstalls({ pathDirs: [join(r, 'leer')], appDirs: [app], brewPrefixes: [], linuxDirs: [] });
  assert.equal(found.length, 1); assert.equal(found[0].kind, 'postgres-app'); assert.equal(found[0].appPath, app); assert.equal(found[0].binDir, join(app, 'Contents', 'Versions', '16', 'bin'));
  // „latest“ (Symlink) wird bevorzugt, wenn vorhanden
  symlinkSync(join(app, 'Contents', 'Versions', '16'), join(app, 'Contents', 'Versions', 'latest'));
  assert.equal(findPostgresInstalls({ pathDirs: [], appDirs: [app], brewPrefixes: [], linuxDirs: [] })[0].binDir, join(app, 'Contents', 'Versions', 'latest', 'bin'));
});

test('Resolver: Reihenfolge PATH → Postgres.app → Homebrew; Homebrew-Formel mit höchster Version zuerst; nichts installiert → leere Liste', () => {
  const r = tmp(); const app = join(r, 'Postgres.app'); fakeBin(join(app, 'Contents', 'Versions', '16', 'bin'), ['psql']);
  const brew = join(r, 'brew'); fakeBin(join(brew, 'opt', 'postgresql@14', 'bin'), ['psql']); fakeBin(join(brew, 'opt', 'postgresql@16', 'bin'), ['psql', 'pg_ctl']); fakeBin(join(brew, 'opt', 'libpq', 'bin'), ['psql']);
  const inPath = fakeBin(join(r, 'bin'), ['psql']);
  const all = findPostgresInstalls({ pathDirs: [inPath], appDirs: [app], brewPrefixes: [brew], linuxDirs: [] });
  assert.deepEqual(all.map((x) => x.kind), ['path', 'postgres-app', 'homebrew', 'homebrew']);
  assert.deepEqual(all.filter((x) => x.kind === 'homebrew').map((x) => x.formula), ['postgresql@16', 'postgresql@14'], 'libpq (nur Client) zählt nicht');
  assert.deepEqual(findPostgresInstalls({ pathDirs: [join(r, 'nix')], appDirs: [join(r, 'nix2')], brewPrefixes: [join(r, 'nix3')], linuxDirs: [] }), []);
});

test('PostgreSQL starten: macOS mit Postgres.app → `open -a <App>`; ohne Server danach klarer Hinweis auf „Initialize“; Homebrew → brew services; nichts installiert → keine Aktion', async () => {
  const calls: string[][] = []; const run = ((cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { status: 0, stdout: '', stderr: '' }; }) as never;
  const app = { kind: 'postgres-app' as const, label: 'Postgres.app', binDir: null, appPath: '/Applications/Postgres.app' };
  let up = false; const probe = async () => (up ? [5432] : []);
  const a = await startPostgres([app], { run, platform: 'darwin', probe, timeoutMs: 300 });
  assert.deepEqual(calls[0], ['open', '-a', '/Applications/Postgres.app']); assert.match(a.note, /Initialize/);
  up = true; const b = await startPostgres([app], { run, platform: 'darwin', probe, timeoutMs: 300 }); assert.equal(b.note, 'Server läuft.');
  calls.length = 0; const brew = { kind: 'homebrew' as const, label: 'Homebrew', binDir: '/x', formula: 'postgresql@16' };
  await startPostgres([brew], { run, platform: 'darwin', probe, timeoutMs: 300 }); assert.ok(calls[0].join(' ').endsWith('services start postgresql@16'));
  calls.length = 0; const none = await startPostgres([], { run, platform: 'darwin', probe: async () => [], timeoutMs: 100 }); assert.equal(none.action, null); assert.equal(calls.length, 0);
});

test('.env.local: wird angelegt (0600, Passwort ≥ 12 Zeichen, Demo-Benutzer), bleibt bei erneutem Start unverändert, zu kurzes Passwort wird ersetzt; Brave-Schlüssel ist optional', () => {
  const d = tmp(); const a = ensureEnvLocal(d);
  assert.equal(a.created, true); assert.equal(statSync(a.file).mode & 0o777, 0o600); assert.ok(a.env.DASHBOARD_PASSWORD.length >= 12); assert.equal(a.env.OWNER_ID, DEMO_OWNER_ID); assert.equal(a.env.APP_MODE, 'live'); assert.equal(a.env.PORT, '3055');
  assert.equal(a.env.BRAVE_SEARCH_API_KEY, undefined, 'ohne Schlüssel – nur als Kommentar');
  const before = readFileSync(a.file, 'utf8'); const b = ensureEnvLocal(d); assert.equal(b.created, false); assert.equal(readFileSync(a.file, 'utf8'), before);
  writeFileSync(a.file, 'DASHBOARD_PASSWORD=kurz\nPORT=4000\n'); const c = ensureEnvLocal(d); assert.ok(c.env.DASHBOARD_PASSWORD.length >= 12); assert.equal(c.env.PORT, '4000', 'andere Werte bleiben');
  assert.deepEqual(parseEnv('# k\nA=1\nB="x y"\n  C = 3 \n'), { A: '1', B: 'x y', C: '3' });
});

test('Ports: frei → 3055-Logik nimmt den bevorzugten; belegt (auch von fremdem Programm) → nächster freier; alles belegt → klarer Fehler', async () => {
  const base = await freeBase(); assert.equal(await portBusy(base), false); assert.equal(await findFreePort(base), base);
  const s = await listen(base); assert.equal(await portBusy(base), true); assert.equal(await findFreePort(base), base + 1);
  assert.equal(await findFreePort(base, 5, async (p) => p < base + 4), base + 4);
  await assert.rejects(findFreePort(base, 3, async () => true), /Kein freier Port/); await new Promise((r) => s.close(r));
});

const FAKE_SERVER = `const http=require('http');const port=Number(process.env.PORT);
http.createServer((q,r)=>{const ok=/^Basic /.test(q.headers.authorization||'');if(!ok){r.writeHead(401,{'www-authenticate':'Basic realm="Agency OS"'});return r.end('Anmeldung erforderlich');}r.writeHead(200,{'content-type':'text/html'});r.end('<html><body>Neue Suche</body></html>');}).listen(port,'127.0.0.1');`;

test('Server startet: HTTP 401 ohne / 200 mit Passwort und „Neue Suche“; als Demo erkennbar; stop beendet NUR diesen Prozess und räumt den Zustand auf', async () => {
  const d = tmp(); writeFileSync(join(d, 'serve.ts'), FAKE_SERVER); const port = await freeBase(); const logFile = join(d, '.demo', 'server.log');
  const r = await startServer({ root: d, home: d, env: {}, port, password: 'demo-passwort-123', logFile, command: { exe: process.execPath, args: [join(d, 'serve.ts')] }, timeoutMs: 8000 });
  assert.equal(r.ok, true); assert.ok(pidAlive(r.pid)); assert.equal(await isOurServer(`http://127.0.0.1:${port}`), true);
  // ein fremdes Programm mit anderem Inhalt gilt nicht als „unsere“ Demo
  const other = net.createServer((c) => c.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nhi')); await new Promise<void>((x) => other.listen(0, '127.0.0.1', x)); assert.equal(await isOurServer(`http://127.0.0.1:${(other.address() as net.AddressInfo).port}`), false); other.close();
  mkdirSync(join(d, '.demo'), { recursive: true }); writeFileSync(stateFile(d), JSON.stringify({ pid: r.pid, port, url: `http://127.0.0.1:${port}`, startedAt: '', db: 'x', dbUser: 'u', dbPort: 1, log: logFile }));
  const bystander = spawn('sleep', ['30'], { stdio: 'ignore' });                         // unbeteiligter Prozess muss unberührt bleiben
  const s = await stopServer(d); assert.equal(s.result, 'stopped'); assert.equal(pidAlive(r.pid), false); assert.equal(readState(d), null); assert.ok(pidAlive(bystander.pid!), 'andere Prozesse bleiben');
  assert.equal((await stopServer(d)).result, 'not-running');
  // Zustand zeigt auf einen Prozess, der nicht (mehr) unser Server ist → nichts beenden
  writeFileSync(stateFile(d), JSON.stringify({ pid: bystander.pid, port, url: '', startedAt: '', db: '', dbUser: '', dbPort: 0, log: '' }));
  assert.equal((await stopServer(d)).result, 'refused'); assert.ok(pidAlive(bystander.pid!)); bystander.kill();
  writeFileSync(stateFile(d), JSON.stringify({ pid: 999999, port, url: '', startedAt: '', db: '', dbUser: '', dbPort: 0, log: '' })); assert.equal((await stopServer(d)).result, 'stale'); clearState(d);
});

test('Server crasht beim Start: kein „bereit“, Log wird geliefert, Ursache erkannt (Port, Datenbank, Passwort)', async () => {
  const d = tmp(); const port = await freeBase(); const logFile = join(d, 'server.log');
  const crash = (msg: string) => startServer({ root: d, home: d, env: {}, port, password: 'x'.repeat(12), logFile, command: { exe: process.execPath, args: ['-e', `console.error(${JSON.stringify(msg)});process.exit(1)`] }, timeoutMs: 6000 });
  const a = await crash('Error: listen EADDRINUSE: address already in use'); assert.equal(a.ok, false); assert.equal(a.reason, 'crashed'); assert.match(a.log, /EADDRINUSE/); assert.equal(diagnoseLog(a.log).code, 'port');
  assert.equal(diagnoseLog('AggregateError [ECONNREFUSED]').code, 'db'); assert.equal(diagnoseLog('DASHBOARD_PASSWORD fehlt oder ist kürzer als 12 Zeichen.').code, 'password');
  assert.equal(diagnoseLog('error: password authentication failed for user').code, 'auth'); assert.equal(diagnoseLog('etwas anderes').code, 'other');
  // Prozess lebt, antwortet aber nie → Zeitüberschreitung, Prozess wird beendet
  const t = await startServer({ root: d, home: d, env: {}, port, password: 'x'.repeat(12), logFile, command: { exe: process.execPath, args: ['-e', 'setTimeout(()=>{},60000)'] }, timeoutMs: 1500 });
  assert.equal(t.ok, false); assert.equal(t.reason, 'timeout'); await new Promise((r) => setTimeout(r, 400)); assert.equal(pidAlive(t.pid), false, 'hängender Server wird aufgeräumt');
});
