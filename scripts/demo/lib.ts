/**
 * Lokaler Demo-Launcher: PostgreSQL finden/starten, Datenbank + Migrationen + Demo-Benutzer sicherstellen, freien Port wählen, Server starten und per HTTP prüfen.
 * Reine Entwickler-Hilfe – verändert keine Produktfunktion. Läuft auf macOS (Postgres.app, Homebrew) und Linux. Alle Funktionen sind einzeln testbar (Pfade/Ports/Befehle injizierbar).
 * Es werden nie fremde PostgreSQL-Server gestoppt oder gelöscht; `stop` beendet nur den von `start` gestarteten Demo-Server.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, accessSync, constants, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import pg from 'pg';

export const DEMO_OWNER_ID = '00000000-0000-0000-0000-00000000b002';
export const DEFAULT_PORT = 3055;
export const DEFAULT_DB = 'agency_demo';
const DB_NAME_RE = /^[a-z_][a-z0-9_]*$/;
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 1. PostgreSQL-Installationen erkennen
// ---------------------------------------------------------------------------------------------------------------------------------------------
export type PgInstall = { kind: 'path' | 'postgres-app' | 'homebrew' | 'linux'; label: string; binDir: string | null; appPath?: string; formula?: string };
export type FindOpts = { pathDirs?: string[]; appDirs?: string[]; brewPrefixes?: string[]; linuxDirs?: string[] };

const isExec = (f: string) => { try { accessSync(f, constants.X_OK); return statSync(f).isFile(); } catch { return false; } };
const subdirs = (d: string) => { try { return readdirSync(d); } catch { return []; } };
const vnum = (s: string) => Number((/(\d+(?:\.\d+)?)/.exec(s) ?? [])[1] ?? 0);

/** Reihenfolge: psql im PATH → Postgres.app → Homebrew → Linux-Paketinstallation. Gibt alle gefundenen zurück (nichts wird gestartet). */
export function findPostgresInstalls(o: FindOpts = {}): PgInstall[] {
  const out: PgInstall[] = [];
  const pathDirs = o.pathDirs ?? (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const d of pathDirs) if (isExec(join(d, 'psql')) || isExec(join(d, 'pg_isready'))) { out.push({ kind: 'path', label: `PATH (${d})`, binDir: d }); break; }
  for (const app of o.appDirs ?? ['/Applications/Postgres.app', join(homedir(), 'Applications', 'Postgres.app')]) {
    if (!existsSync(app)) continue;
    const vdir = join(app, 'Contents', 'Versions');
    const versions = subdirs(vdir).filter((v) => v === 'latest' || /^\d/.test(v)).sort((a, b) => (a === 'latest' ? -1 : b === 'latest' ? 1 : vnum(b) - vnum(a)));
    const bin = versions.map((v) => join(vdir, v, 'bin')).find((b) => isExec(join(b, 'psql')) || isExec(join(b, 'pg_ctl'))) ?? null;
    out.push({ kind: 'postgres-app', label: `Postgres.app${bin ? ` (${bin})` : ''}`, binDir: bin, appPath: app });
  }
  for (const prefix of o.brewPrefixes ?? ['/opt/homebrew', '/usr/local']) {
    const opt = join(prefix, 'opt');
    for (const f of subdirs(opt).filter((n) => /^postgresql(@\d+)?$/.test(n)).sort((a, b) => vnum(b) - vnum(a))) {
      const bin = join(opt, f, 'bin'); if (isExec(join(bin, 'psql')) || isExec(join(bin, 'pg_ctl'))) out.push({ kind: 'homebrew', label: `Homebrew ${f} (${bin})`, binDir: bin, formula: f });
    }
  }
  for (const root of o.linuxDirs ?? ['/usr/lib/postgresql']) for (const v of subdirs(root).sort((a, b) => vnum(b) - vnum(a))) { const bin = join(root, v, 'bin'); if (isExec(join(bin, 'psql'))) out.push({ kind: 'linux', label: `PostgreSQL ${v} (${bin})`, binDir: bin }); }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 2. Server finden, ggf. starten, funktionierende Verbindung ermitteln (echter Query)
// ---------------------------------------------------------------------------------------------------------------------------------------------
export const tcpOpen = (port: number, host = '127.0.0.1', timeout = 800) => new Promise<boolean>((resolve) => {
  const s = net.connect({ port, host }); let done = false; const fin = (v: boolean) => { if (!done) { done = true; s.destroy(); resolve(v); } };
  s.setTimeout(timeout, () => fin(false)); s.once('connect', () => fin(true)); s.once('error', () => fin(false));
});

/** Ports, auf denen ein PostgreSQL lauscht oder lauschen könnte (Standardports + laufende postgres-Prozesse laut lsof). */
export async function candidatePorts(extra: number[] = []): Promise<number[]> {
  const ports = new Set<number>([5432, 5433, 5434, 5435, 5436, 5437, ...extra]);
  const l = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 4000 });
  if (l.status === 0) for (const line of l.stdout.split('\n')) if (/^postgres|^Postgres/i.test(line)) { const m = /:(\d+)\s+\(LISTEN\)/.exec(line); if (m) ports.add(Number(m[1])); }
  return [...ports];
}
export async function openPorts(ports: number[]): Promise<number[]> { const r = await Promise.all(ports.map(async (p) => ((await tcpOpen(p)) ? p : 0))); return r.filter(Boolean); }

export type Conn = { host: string; port: number; user: string; password: string; database: string; version: string; canCreateDb: boolean };
export const toUrl = (c: { host: string; port: number; user: string; password: string }, db: string) =>
  `postgres://${encodeURIComponent(c.user)}${c.password ? `:${encodeURIComponent(c.password)}` : ''}@${c.host}:${c.port}/${db}`;

async function tryConnect(c: { host: string; port: number; user: string; password: string }, database: string) {
  const cl = new pg.Client({ host: c.host, port: c.port, user: c.user, password: c.password || undefined, database, connectionTimeoutMillis: 3000 });
  cl.on('error', () => undefined);
  try {
    await cl.connect();
    const r = await cl.query('select version() v, (select rolcreatedb or rolsuper from pg_roles where rolname = current_user) can');
    return { version: String(r.rows[0].v).split(' ').slice(0, 2).join(' '), canCreateDb: !!r.rows[0].can };
  } finally { await cl.end().catch(() => undefined); }
}

export type FindConnOpts = { ports: number[]; users?: string[]; passwords?: string[]; host?: string };
/** Probiert Benutzer/Passwörter an offenen Ports durch (Mac-Benutzer ohne Passwort zuerst – so läuft Postgres.app/Homebrew). */
export async function findConnection(o: FindConnOpts): Promise<{ conn: Conn | null; tried: string[] }> {
  const host = o.host ?? '127.0.0.1'; const tried: string[] = [];
  const users = [...new Set((o.users ?? [process.env.PGUSER, userInfo().username, 'postgres']).filter(Boolean) as string[])];
  const pws = [...new Set((o.passwords ?? [process.env.PGPASSWORD, '', 'postgres']).filter((x) => x !== undefined) as string[])];
  for (const port of o.ports) for (const user of users) for (const password of pws) {
    for (const database of ['postgres', 'template1']) {
      try { const info = await tryConnect({ host, port, user, password }, database); return { conn: { host, port, user, password, database, ...info }, tried }; }
      catch (e) { const code = (e as { code?: string }).code ?? ''; tried.push(`${user}@${port}/${database}: ${code || (e as Error).message}`); if (code === '28P01' || code === '28000' || /password|authentication/i.test((e as Error).message)) break; }
    }
  }
  return { conn: null, tried };
}

/** Startet – falls kein Server läuft – die vorhandene Installation mit normalen Mitteln (macOS: `open`, Homebrew: `brew services`). Nur ein Server, nie mehrere. */
export async function startPostgres(installs: PgInstall[], o: { probe?: () => Promise<number[]>; timeoutMs?: number; run?: typeof spawnSync; platform?: string } = {}): Promise<{ action: string | null; note: string }> {
  const run = o.run ?? spawnSync; const platform = o.platform ?? process.platform; const timeout = o.timeoutMs ?? 45_000;
  const probe = o.probe ?? (async () => openPorts(await candidatePorts()));
  const waitUp = async () => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if ((await probe()).length) return true; await sleep(o.timeoutMs && o.timeoutMs < 5000 ? 100 : 1000); } return false; };
  const app = installs.find((i) => i.kind === 'postgres-app'), brew = installs.find((i) => i.kind === 'homebrew');
  if (platform === 'darwin' && app?.appPath) {
    run('open', ['-a', app.appPath], { encoding: 'utf8' });
    if (await waitUp()) return { action: 'Postgres.app geöffnet', note: 'Server läuft.' };
    return { action: 'Postgres.app geöffnet', note: 'Postgres.app ist geöffnet, aber es lauscht kein Server. Einmalig in Postgres.app auf „Initialize“ bzw. „Start“ klicken (Fenster der App).' };
  }
  if (platform === 'darwin' && brew?.formula) {
    const bin = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(isExec) ?? 'brew';
    const r = run(bin, ['services', 'start', brew.formula], { encoding: 'utf8' });
    if (r.status === 0 && (await waitUp())) return { action: `brew services start ${brew.formula}`, note: 'Server läuft.' };
    return { action: `brew services start ${brew.formula}`, note: `Homebrew-PostgreSQL ließ sich nicht starten: ${String(r.stderr ?? '').trim().slice(0, 200) || 'kein Fehlertext'}` };
  }
  if (platform === 'linux') {
    const l = run('pg_lsclusters', ['-h'], { encoding: 'utf8' });
    if (l.status === 0) {
      const down = String(l.stdout).split('\n').map((x) => x.trim().split(/\s+/)).find((c) => c[3] === 'down');
      if (down) { run('pg_ctlcluster', [down[0], down[1], 'start'], { encoding: 'utf8' }); if (await waitUp()) return { action: `pg_ctlcluster ${down[0]} ${down[1]} start`, note: 'Server läuft.' }; }
    }
  }
  return { action: null, note: 'Es ist keine startbare PostgreSQL-Installation gefunden worden.' };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 3. Datenbank, Migrationen, Demo-Benutzer
// ---------------------------------------------------------------------------------------------------------------------------------------------
export async function ensureDatabase(conn: Conn, name: string): Promise<{ created: boolean }> {
  if (!DB_NAME_RE.test(name)) throw new Error(`Ungültiger Datenbankname: ${name}`);
  const cl = new pg.Client({ host: conn.host, port: conn.port, user: conn.user, password: conn.password || undefined, database: conn.database });
  cl.on('error', () => undefined); await cl.connect();
  try {
    if ((await cl.query('select 1 from pg_database where datname=$1', [name])).rowCount) return { created: false };
    if (!conn.canCreateDb) throw new Error(`Der Datenbank-Benutzer „${conn.user}“ darf keine Datenbank anlegen.`);
    await cl.query(`create database ${name}`); return { created: true };
  } finally { await cl.end().catch(() => undefined); }
}

/** Erkennungs-Abfragen für Datenbanken, die vom alten Skript (ohne Protokolltabelle) angelegt wurden. */
const PROBES: Record<string, string> = {
  '0011_pipeline.sql': "exists (select 1 from information_schema.columns where table_schema='public' and table_name='leads' and column_name='effective_priority')",
  '0012_enrichment_approvals.sql': "exists (select 1 from information_schema.columns where table_schema='public' and table_name='leads' and column_name='work_status')",
  '0013_provider_cost_currency.sql': "exists (select 1 from information_schema.columns where table_schema='public' and table_name='enrichment_log' and column_name='provider_cost_currency')",
  '0014_sales_copilot.sql': "to_regclass('public.sales_copilot') is not null",
  '0015_partners_strategy.sql': "to_regclass('public.partners') is not null",
  '0016_tasks.sql': "to_regclass('public.tasks') is not null",
  '0017_demo_stage.sql': "exists (select 1 from information_schema.columns where table_schema='public' and table_name='leads' and column_name='demo_stage')",
  '0018_quotes_offers.sql': "to_regclass('public.quotes') is not null",
  '0019_manual_payments.sql': "exists (select 1 from information_schema.columns where table_schema='public' and table_name='payments' and column_name='reference')",
  '0020_growth_scores.sql': "exists (select 1 from information_schema.columns where table_schema='public' and table_name='leads' and column_name='growth_scores')",
  '0021_customers.sql': "to_regclass('public.customers') is not null",
  '0023_team.sql': "to_regclass('public.staff_users') is not null",
  '0022_community.sql': "to_regclass('public.community_members') is not null",
};
export const migrationFiles = (root: string) => readdirSync(join(root, 'supabase', 'migrations')).filter((f) => /^\d+.*\.sql$/.test(f)).sort();

export type MigrateResult = { applied: string[]; baselined: string[]; total: number; stub: boolean };
/** Supabase-Ersatzschema (nur lokal, falls `auth` fehlt) + alle noch fehlenden Projekt-Migrationen. Bereits eingespielte werden nicht wiederholt. */
export async function ensureSchema(url: string, root: string): Promise<MigrateResult> {
  const cl = new pg.Client({ connectionString: url }); cl.on('error', () => undefined); await cl.connect();
  const res: MigrateResult = { applied: [], baselined: [], total: 0, stub: false };
  try {
    const files = migrationFiles(root); res.total = files.length;
    if (!(await cl.query("select to_regclass('auth.users') as t")).rows[0].t) {
      if ((await cl.query("select to_regclass('public.leads') as t")).rows[0].t) throw new Error('Die Datenbank hat Projekt-Tabellen, aber kein „auth“-Schema (Supabase). Für Supabase die Migrationen im SQL-Editor ausführen (SETUP.md).');
      await cl.query(readFileSync(join(root, 'test', 'stub_supabase.sql'), 'utf8')); res.stub = true;
    }
    await cl.query('create table if not exists public.demo_migrations (file text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await cl.query('select file from public.demo_migrations')).rows.map((r) => r.file as string));
    // Altbestand ohne Protokoll: vorhandene Struktur erkennen, nichts doppelt einspielen
    if (!done.size && (await cl.query("select to_regclass('public.leads') as t")).rows[0].t) {
      for (const f of files) {
        const probe = PROBES[f]; const present = probe ? !!(await cl.query(`select ${probe} as ok`)).rows[0].ok : Number(f.slice(0, 4)) <= 10;  // ohne Erkennungs-Abfrage: nur die ältesten (≤ 0010) gelten als vorhanden
        if (present) { await cl.query('insert into public.demo_migrations(file) values ($1) on conflict do nothing', [f]); done.add(f); res.baselined.push(f); }
      }
    }
    for (const f of files) {
      if (done.has(f)) continue;
      try { await cl.query(readFileSync(join(root, 'supabase', 'migrations', f), 'utf8')); }
      catch (e) { throw new Error(`Migration ${f} ist fehlgeschlagen: ${(e as Error).message}`); }
      await cl.query('insert into public.demo_migrations(file) values ($1)', [f]); res.applied.push(f);
    }
    return res;
  } finally { await cl.end().catch(() => undefined); }
}

export async function ensureOwner(url: string, ownerId: string): Promise<{ created: boolean }> {
  if (!/^[0-9a-f-]{36}$/i.test(ownerId)) throw new Error('OWNER_ID ist keine UUID.');
  const cl = new pg.Client({ connectionString: url }); cl.on('error', () => undefined); await cl.connect();
  try { const r = await cl.query('insert into auth.users(id) values ($1) on conflict do nothing', [ownerId]); return { created: (r.rowCount ?? 0) > 0 }; }
  finally { await cl.end().catch(() => undefined); }
}

export async function schemaStatus(url: string, root: string): Promise<{ ok: boolean; applied: number; total: number; owner: boolean }> {
  const cl = new pg.Client({ connectionString: url }); cl.on('error', () => undefined); await cl.connect();
  try {
    const total = migrationFiles(root).length;
    const has = (await cl.query("select to_regclass('public.demo_migrations') as t")).rows[0].t;
    const applied = has ? (await cl.query('select count(*)::int n from public.demo_migrations')).rows[0].n as number : 0;
    const owner = !!(await cl.query("select to_regclass('auth.users') as t")).rows[0].t && (await cl.query('select 1 from auth.users where id=$1', [process.env.OWNER_ID ?? DEMO_OWNER_ID])).rowCount! > 0;
    return { ok: applied >= total, applied, total, owner };
  } finally { await cl.end().catch(() => undefined); }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 4. Lokale Konfiguration (.env.local)
// ---------------------------------------------------------------------------------------------------------------------------------------------
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2'); }
  return out;
}
/** Legt `.env.local` an, falls sie fehlt (nur lokal, steht in .gitignore). Ein zu kurzes/fehlendes Passwort wird ergänzt, nichts anderes überschrieben. */
export function ensureEnvLocal(root: string): { created: boolean; env: Record<string, string>; file: string } {
  const file = join(root, '.env.local'); let created = false;
  if (!existsSync(file)) {
    const pw = `demo-${randomBytes(6).toString('hex')}`;
    writeFileSync(file, `# Lokale Demo-Einstellungen (nur auf diesem Rechner, nicht im Repository). Werte ändern und \`npm run demo:start\` erneut ausführen.\nAPP_MODE=live\nOWNER_ID=${DEMO_OWNER_ID}\nDASHBOARD_PASSWORD=${pw}\nPORT=${DEFAULT_PORT}\nDEMO_DB=${DEFAULT_DB}\n# Optional: Web-Anreicherung mit Brave (kostenpflichtig, nie ins Repository):\n# BRAVE_SEARCH_API_KEY=\n# Optional: feste Datenbankverbindung statt automatischer Erkennung:\n# DATABASE_URL=postgres://benutzer@127.0.0.1:5432/agency_demo\n`, { mode: 0o600 });
    created = true;
  }
  let env = parseEnv(readFileSync(file, 'utf8'));
  if (!env.DASHBOARD_PASSWORD || env.DASHBOARD_PASSWORD.length < 12) { const pw = `demo-${randomBytes(6).toString('hex')}`; writeFileSync(file, `${readFileSync(file, 'utf8').replace(/^DASHBOARD_PASSWORD=.*\n?/m, '')}\nDASHBOARD_PASSWORD=${pw}\n`); env = parseEnv(readFileSync(file, 'utf8')); }
  return { created, env, file };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 5. Port, Server, HTTP
// ---------------------------------------------------------------------------------------------------------------------------------------------
/** Ein Port gilt als belegt, wenn irgendetwas auf IPv4/IPv6-Loopback antwortet oder das Binden scheitert (auch macOS-Doppelbelegung `*:port`). */
export async function portBusy(port: number): Promise<boolean> {
  if (await tcpOpen(port, '127.0.0.1') || await tcpOpen(port, '::1')) return true;
  return new Promise<boolean>((resolve) => { const s = net.createServer(); s.once('error', () => resolve(true)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(false))); });
}
export async function findFreePort(preferred: number, tries = 25, busy: (p: number) => Promise<boolean> = portBusy): Promise<number> {
  for (let p = preferred; p < preferred + tries; p++) if (!(await busy(p))) return p;
  throw new Error(`Kein freier Port zwischen ${preferred} und ${preferred + tries - 1} gefunden.`);
}

export function httpGet(url: string, o: { auth?: string; timeout?: number } = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: o.auth ? { authorization: `Basic ${Buffer.from(`demo:${o.auth}`).toString('base64')}` } : {}, timeout: o.timeout ?? 4000 }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { if (b.length < 400_000) b += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung'))); req.on('error', reject);
  });
}
/** Ist unter der URL wirklich dieses Dashboard? (ohne Passwort: 401 mit Realm „Agency OS“) */
export async function isOurServer(url: string): Promise<boolean> {
  try { const r = await httpGet(url); return r.status === 401 && String(r.headers['www-authenticate'] ?? '').includes('Agency OS'); } catch { return false; }
}
/** Startseite mit Passwort: HTTP 200, HTML und das Suchformular „Neue Suche“. */
export async function dashboardCheck(url: string, password: string): Promise<{ ok: boolean; status: number; html: boolean; searchForm: boolean; error?: string }> {
  try { const r = await httpGet(url, { auth: password }); return { ok: r.status === 200 && /<html/i.test(r.body) && r.body.includes('Neue Suche'), status: r.status, html: /<html/i.test(r.body), searchForm: r.body.includes('Neue Suche') }; }
  catch (e) { return { ok: false, status: 0, html: false, searchForm: false, error: (e as Error).message }; }
}

export type DemoState = { pid: number; port: number; url: string; startedAt: string; db: string; dbUser: string; dbPort: number; log: string };
export const stateFile = (root: string) => join(root, '.demo', 'state.json');
export function readState(root: string): DemoState | null { try { return JSON.parse(readFileSync(stateFile(root), 'utf8')) as DemoState; } catch { return null; } }
export const clearState = (root: string) => rmSync(stateFile(root), { force: true });
export function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === 'EPERM'; } }
/** Schutz vor wiederverwendeten PIDs: nur beenden, was wirklich nach unserem Demo-Server aussieht. */
export function pidLooksLikeDemo(pid: number, marker = 'serve.ts'): boolean { const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }); return r.status === 0 && String(r.stdout).includes(marker); }

export const tail = (file: string, n = 15) => { try { return readFileSync(file, 'utf8').trim().split('\n').slice(-n).join('\n'); } catch { return ''; } };
/** Ursachenhinweise zu bekannten Startfehlern im Serverlog. */
export function diagnoseLog(log: string): { code: 'port' | 'db' | 'password' | 'auth' | 'other'; hint: string } {
  if (/EADDRINUSE/.test(log)) return { code: 'port', hint: 'Der Port wurde zwischenzeitlich von einem anderen Programm belegt.' };
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT/.test(log)) return { code: 'db', hint: 'PostgreSQL ist nicht erreichbar.' };
  if (/DASHBOARD_PASSWORD/.test(log)) return { code: 'password', hint: 'DASHBOARD_PASSWORD fehlt oder ist kürzer als 12 Zeichen (.env.local).' };
  if (/password authentication failed|28P01|28000/.test(log)) return { code: 'auth', hint: 'PostgreSQL lehnt die Anmeldung ab.' };
  return { code: 'other', hint: 'Unbekannter Fehler – siehe Log.' };
}

export type StartOpts = { root: string; home?: string; env: Record<string, string>; port: number; password: string; logFile: string; command?: { exe: string; args: string[] }; timeoutMs?: number };
/** Startet den Server losgelöst im Hintergrund und wartet, bis HTTP wirklich antwortet – oder der Prozess stirbt. */
export async function startServer(o: StartOpts): Promise<{ ok: boolean; pid: number; reason?: 'crashed' | 'timeout'; log: string; exitCode?: number | null }> {
  mkdirSync(join(o.home ?? o.root, '.demo'), { recursive: true });
  const fd = openSync(o.logFile, 'w');
  const cmd = o.command ?? { exe: process.execPath, args: [join(o.root, 'src', 'serve.ts')] };
  const url = `http://127.0.0.1:${o.port}`;
  const child = spawn(cmd.exe, cmd.args, { cwd: o.root, env: { ...process.env, ...o.env, PORT: String(o.port), HOST: '127.0.0.1' }, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  let exited = false; let exitCode: number | null = null; child.on('exit', (c) => { exited = true; exitCode = c; }); child.unref();
  const t0 = Date.now(); const timeout = o.timeoutMs ?? 25_000;
  while (Date.now() - t0 < timeout) {
    if (exited) return { ok: false, pid: child.pid ?? 0, reason: 'crashed', log: tail(o.logFile), exitCode };
    if (await portBusy(o.port) && (await dashboardCheck(url, o.password)).ok) { await sleep(800); if (!exited) return { ok: true, pid: child.pid ?? 0, log: tail(o.logFile) }; }
    await sleep(300);
  }
  try { process.kill(-(child.pid ?? 0), 'SIGTERM'); } catch { try { if (child.pid) process.kill(child.pid, 'SIGTERM'); } catch { /* schon beendet */ } }
  return { ok: false, pid: child.pid ?? 0, reason: exited ? 'crashed' : 'timeout', log: tail(o.logFile), exitCode };
}

export async function stopServer(root: string, o: { graceMs?: number } = {}): Promise<{ result: 'stopped' | 'not-running' | 'stale' | 'refused'; pid?: number }> {
  const st = readState(root); if (!st) return { result: 'not-running' };
  if (!pidAlive(st.pid)) { clearState(root); return { result: 'stale', pid: st.pid }; }
  if (!pidLooksLikeDemo(st.pid)) { clearState(root); return { result: 'refused', pid: st.pid }; }   // PID wurde von etwas anderem übernommen – nichts anfassen
  try { process.kill(st.pid, 'SIGTERM'); } catch { /* schon weg */ }
  const t0 = Date.now(); while (pidAlive(st.pid) && Date.now() - t0 < (o.graceMs ?? 6000)) await sleep(150);
  if (pidAlive(st.pid)) { try { process.kill(st.pid, 'SIGKILL'); } catch { /* ok */ } await sleep(200); }
  clearState(root); return { result: 'stopped', pid: st.pid };
}

export function openBrowser(url: string, platform = process.platform): boolean {
  if (process.env.DEMO_NO_OPEN === '1') return false;
  const cmd = platform === 'darwin' ? 'open' : platform === 'linux' && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) ? 'xdg-open' : null;
  if (!cmd) return false;
  const r = spawnSync(cmd, [url], { stdio: 'ignore', timeout: 5000 }); return r.status === 0;
}
