/**
 * Ein Befehl für die lokale Demo:  npm run demo:start | demo:status | demo:stop
 * Logik und Tests: scripts/demo/lib.ts, test/unit/demo-start.test.ts, test/db/demo-start.test.ts. Änderungen am Produktcode macht dieses Skript nicht.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DB, DEFAULT_PORT, DEMO_OWNER_ID, candidatePorts, clearState, dashboardCheck, diagnoseLog, ensureDatabase, ensureEnvLocal, ensureOwner, ensureSchema, findConnection, findFreePort,
  findPostgresInstalls, isOurServer, openBrowser, openPorts, parseEnv, pidAlive, readState, schemaStatus, startPostgres, startServer, stateFile, stopServer, tail, toUrl, migrationFiles,
  type Conn, type DemoState,
} from './demo/lib.ts';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
/** Ort von .env.local und .demo/ (Zustand, Log). Standard: Projektordner; DEMO_HOME ist für Tests, damit sie nie die echte Demo berühren. */
const HOME = process.env.DEMO_HOME || ROOT;
const N = 7;
const step = (i: number, t: string) => console.log(`[${i}/${N}] ${t}`);
const ok = (t: string) => console.log(`      ✓ ${t}`);
const info = (t: string) => console.log(`      · ${t}`);
class Stop extends Error { hint: string; constructor(msg: string, hint: string) { super(msg); this.hint = hint; } }

/** PostgreSQL finden (ggf. starten) und eine funktionierende Verbindung per echtem Query ermitteln. */
async function resolvePostgres(envFile: Record<string, string>, log: boolean, prefer?: { port?: number; user?: string }): Promise<{ conn: Conn; label: string; dbName: string }> {
  const installs = findPostgresInstalls();
  const explicit = envFile.DATABASE_URL ? new URL(envFile.DATABASE_URL) : null;
  let dbName = explicit ? explicit.pathname.slice(1) : process.env.DEMO_DB || envFile.DEMO_DB || DEFAULT_DB;
  let ports = explicit ? [Number(explicit.port || 5432)] : await candidatePorts();
  let open = await openPorts(ports);
  let started = '';
  if (!open.length) {
    const r = await startPostgres(installs);
    if (r.action) started = r.action;
    open = await openPorts(await candidatePorts(explicit ? ports : []));
    if (!open.length) {
      if (!installs.length) throw new Stop('PostgreSQL ist auf diesem Rechner nicht installiert.', 'Einziger manueller Schritt: Postgres.app von https://postgresapp.com installieren, einmal öffnen und „Initialize“ klicken. Danach nochmal: npm run demo:start');
      throw new Stop(`PostgreSQL ist installiert (${installs[0].label}), aber es läuft kein Server.`, r.note);
    }
  }
  if (prefer?.port && open.includes(prefer.port)) open = [prefer.port, ...open.filter((p) => p !== prefer.port)];
  const lab = installs[0]?.label ?? 'laufender Server (keine Programmdateien gefunden)';
  if (log) { info(`Installation: ${lab}`); if (started) info(`gestartet: ${started}`); info(`Server lauscht auf Port ${open.join(', ')}`); }
  const users = explicit ? [decodeURIComponent(explicit.username)] : prefer?.user ? [prefer.user] : undefined;
  const passwords = explicit ? [decodeURIComponent(explicit.password)] : undefined;
  const { conn, tried } = await findConnection({ ports: open, users, passwords, host: explicit?.hostname || '127.0.0.1' });
  if (!conn) throw new Stop(`PostgreSQL läuft (Port ${open.join(', ')}), aber keine Anmeldung klappt.`, `Versucht: ${tried.slice(0, 6).join('; ')}\nLösung: in .env.local eine Zeile DATABASE_URL=postgres://BENUTZER:PASSWORT@127.0.0.1:${open[0]}/${DEFAULT_DB} eintragen (bei Postgres.app ist der Benutzer dein Mac-Benutzername, ohne Passwort).`);
  return { conn, label: lab, dbName };
}

function loadConfig(): { envFile: Record<string, string>; created: boolean; password: string; ownerId: string; preferredPort: number } {
  const { env, created } = ensureEnvLocal(HOME);
  const preferredPort = Number(process.env.DEMO_PORT || env.PORT || DEFAULT_PORT);
  return { envFile: env, created, password: env.DASHBOARD_PASSWORD, ownerId: env.OWNER_ID || DEMO_OWNER_ID, preferredPort: Number.isInteger(preferredPort) && preferredPort > 0 ? preferredPort : DEFAULT_PORT };
}

async function start(): Promise<number> {
  const cfg = loadConfig();
  if (cfg.created) console.log('Lokale Konfiguration .env.local angelegt (Demo-Passwort darin; wird nicht ins Repository übertragen).');
  // Läuft die Demo schon? Dann keinen zweiten Server starten.
  const st = readState(HOME);
  if (st && pidAlive(st.pid) && (await isOurServer(st.url))) {
    const c = await dashboardCheck(st.url, cfg.password);
    if (c.ok) { console.log(`\nDEMO LÄUFT BEREITS\n\n  ${st.url}\n`); openBrowser(st.url); return 0; }
  }
  if (st) clearState(HOME);

  step(1, 'PostgreSQL prüfen');
  const { conn, dbName } = await resolvePostgres(cfg.envFile, true);
  ok(`${conn.version}, Benutzer „${conn.user}“${conn.password ? ' (mit Passwort)' : ' (ohne Passwort)'}`);

  step(2, 'Datenbank prüfen');
  const db = await ensureDatabase(conn, dbName); ok(db.created ? `„${dbName}“ neu angelegt` : `„${dbName}“ vorhanden`);
  const dbUrl = toUrl(conn, dbName);

  step(3, 'Migrationen');
  const mig = await ensureSchema(dbUrl, ROOT);
  ok(mig.applied.length ? `${mig.applied.length} eingespielt${mig.stub ? ' (inkl. lokales Supabase-Ersatzschema)' : ''}` : `alle ${mig.total} aktuell${mig.baselined.length ? ' (bestehende Datenbank übernommen)' : ''}`);

  step(4, 'Demo-Benutzer');
  const own = await ensureOwner(dbUrl, cfg.ownerId); ok(own.created ? 'angelegt' : 'vorhanden');

  step(5, 'Port wählen');
  const port = await findFreePort(cfg.preferredPort);
  ok(port === cfg.preferredPort ? `${port} ist frei` : `${cfg.preferredPort} ist belegt – nehme ${port}`);

  step(6, 'Server starten');
  mkdirSync(join(HOME, '.demo'), { recursive: true });
  const logFile = join(HOME, '.demo', 'server.log');
  const baseEnv = (p: number) => ({ APP_MODE: cfg.envFile.APP_MODE || 'live', OWNER_ID: cfg.ownerId, DASHBOARD_PASSWORD: cfg.password, DATABASE_URL: dbUrl, PUBLIC_BASE_URL: `http://127.0.0.1:${p}`,
    ...(cfg.envFile.BRAVE_SEARCH_API_KEY ? { BRAVE_SEARCH_API_KEY: cfg.envFile.BRAVE_SEARCH_API_KEY } : {}) });
  let usedPort = port; let res = await startServer({ root: ROOT, home: HOME, env: baseEnv(usedPort), port: usedPort, password: cfg.password, logFile });
  for (let attempt = 0; !res.ok && attempt < 2; attempt++) {                       // gezielte Wiederholung, nie endlos
    const d = diagnoseLog(res.log); if (d.code !== 'port') break;
    info(`Port ${usedPort} wurde inzwischen belegt – neuer Versuch auf einem anderen Port`);
    usedPort = await findFreePort(usedPort + 1); res = await startServer({ root: ROOT, home: HOME, env: baseEnv(usedPort), port: usedPort, password: cfg.password, logFile });
  }
  if (!res.ok) {
    const d = diagnoseLog(res.log);
    throw new Stop(`Der Server ${res.reason === 'timeout' ? 'antwortet nicht rechtzeitig' : 'ist direkt nach dem Start beendet worden'}. ${d.hint}`, `Letzte Log-Zeilen (${logFile}):\n${res.log || '(leer)'}`);
  }
  ok(`Prozess ${res.pid} läuft`);
  const url = `http://127.0.0.1:${usedPort}`;
  const state: DemoState = { pid: res.pid, port: usedPort, url, startedAt: new Date().toISOString(), db: dbName, dbUser: conn.user, dbPort: conn.port, log: logFile };
  writeFileSync(stateFile(HOME), JSON.stringify(state, null, 1));

  step(7, 'HTTP prüfen');
  const c = await dashboardCheck(url, cfg.password);
  if (!c.ok) throw new Stop(`Der Server läuft, aber die Startseite ist nicht in Ordnung (HTTP ${c.status}${c.error ? `, ${c.error}` : ''}).`, tail(logFile));
  ok(`HTTP ${c.status}, Startseite mit „Neue Suche“`);

  const brave = !!(cfg.envFile.BRAVE_SEARCH_API_KEY || process.env.BRAVE_SEARCH_API_KEY);
  console.log(`\n  DEMO BEREIT\n\n  ➜  ${url}\n\n  Login: beliebiger Benutzername, Passwort: ${cfg.password}\n  Beenden: npm run demo:stop   ·   Status: npm run demo:status\n`);
  if (!brave) console.log('  Hinweis: Web-Anreicherung (Brave) ist nicht aktiv – optional, die Demo läuft auch ohne (siehe docs/DEMO-START.md).\n');
  if (!openBrowser(url)) console.log('  (Browser bitte selbst öffnen und die Adresse oben eingeben.)');
  return 0;
}

async function status(): Promise<number> {
  const cfg = loadConfigQuiet(); const st = readState(HOME); let allOk = true;
  const line = (label: string, good: boolean, text: string) => { if (!good) allOk = false; console.log(`${label.padEnd(15)} ${good ? 'OK' : 'FEHLT'}${text ? ` – ${text}` : ''}`); };
  let conn: Conn | null = null; let dbName = process.env.DEMO_DB || cfg.envFile.DEMO_DB || DEFAULT_DB;
  try { const r = await resolvePostgresQuiet(cfg.envFile, st); conn = r.conn; dbName = r.dbName; line('PostgreSQL:', true, `${conn.version}, Port ${conn.port}, Benutzer ${conn.user}`); }
  catch (e) { line('PostgreSQL:', false, e instanceof Stop ? e.message : (e as Error).message); }
  if (conn) {
    try {
      const has = await (async () => { const { Client } = await import('pg'); const cl = new Client({ host: conn!.host, port: conn!.port, user: conn!.user, password: conn!.password || undefined, database: conn!.database }); cl.on('error', () => undefined); await cl.connect(); try { return (await cl.query('select 1 from pg_database where datname=$1', [dbName])).rowCount! > 0; } finally { await cl.end(); } })();
      line('Database:', has, has ? dbName : `${dbName} existiert nicht (npm run demo:start legt sie an)`);
      if (has) {
        const s = await schemaStatus(toUrl(conn, dbName), ROOT);
        line('Migrations:', s.ok, `${s.applied}/${s.total}`); line('Demo-Benutzer:', s.owner, '');
      }
    } catch (e) { line('Database:', false, (e as Error).message); }
  }
  let running = false;
  if (st && pidAlive(st.pid) && (await isOurServer(st.url))) { running = true; const c = await dashboardCheck(st.url, cfg.password); line('Server:', c.ok, c.ok ? `RUNNING (Prozess ${st.pid})` : `Prozess läuft, Startseite fehlerhaft (HTTP ${c.status})`); console.log(`${'Port:'.padEnd(15)} ${st.port}`); console.log(`${'URL:'.padEnd(15)} ${st.url}`); }
  else line('Server:', false, st ? 'STOPPED (veralteter Eintrag)' : 'STOPPED');
  console.log(`${'Brave:'.padEnd(15)} ${cfg.envFile.BRAVE_SEARCH_API_KEY || process.env.BRAVE_SEARCH_API_KEY ? 'Schlüssel gesetzt (Wert wird nie angezeigt)' : 'nicht gesetzt (optional)'}`);
  if (!running) console.log('\nStarten: npm run demo:start');
  return allOk ? 0 : 1;
}

/** Status ändert nichts: keine .env.local anlegen, keinen Server starten. */
function loadConfigQuiet() {
  const f = join(HOME, '.env.local'); const envFile = existsSync(f) ? parseEnv(readFileSync(f, 'utf8')) : {};
  return { envFile, password: envFile.DASHBOARD_PASSWORD ?? '' };
}
async function resolvePostgresQuiet(envFile: Record<string, string>, st: DemoState | null) {
  const installs = findPostgresInstalls(); const explicit = envFile.DATABASE_URL ? new URL(envFile.DATABASE_URL) : null;
  const open = await openPorts(explicit ? [Number(explicit.port || 5432)] : await candidatePorts());
  if (!open.length) throw new Stop(installs.length ? `Kein PostgreSQL-Server erreichbar (${installs[0].label})` : 'PostgreSQL nicht installiert', '');
  const ports = st && open.includes(st.dbPort) ? [st.dbPort, ...open.filter((p) => p !== st.dbPort)] : open;
  const { conn } = await findConnection({ ports, users: explicit ? [decodeURIComponent(explicit.username)] : st ? [st.dbUser] : undefined, passwords: explicit ? [decodeURIComponent(explicit.password)] : undefined });
  if (!conn) throw new Stop(`Server auf Port ${open.join(', ')} erreichbar, aber keine Anmeldung möglich`, '');
  return { conn, label: installs[0]?.label ?? 'laufender Server', dbName: explicit ? explicit.pathname.slice(1) : process.env.DEMO_DB || envFile.DEMO_DB || DEFAULT_DB };
}

async function stop(): Promise<number> {
  const r = await stopServer(HOME);
  const msg = { stopped: `Demo-Server beendet (Prozess ${r.pid}). PostgreSQL bleibt unangetastet.`, 'not-running': 'Die Demo läuft nicht.', stale: 'Die Demo lief nicht mehr – veralteten Eintrag entfernt.', refused: `Prozess ${r.pid} gehört nicht (mehr) zum Demo-Server – nichts beendet, Eintrag entfernt.` }[r.result];
  console.log(msg); return 0;
}

const cmd = process.argv[2] ?? 'start';
try {
  const code = cmd === 'start' ? await start() : cmd === 'status' ? await status() : cmd === 'stop' ? await stop() : (console.error('Nutzung: npm run demo:start | demo:status | demo:stop'), 2);
  process.exit(code);
} catch (e) {
  if (e instanceof Stop) { console.error(`\nFEHLER: ${e.message}\n${e.hint}\n`); }
  else console.error(`\nFEHLER: ${(e as Error).message}\n(Details: ${join(HOME, '.demo', 'server.log')} – bei Datenbankproblemen siehe docs/DEMO-START.md, Abschnitt „Wenn etwas nicht klappt“)\n`);
  process.exit(1);
}
