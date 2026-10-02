/** Betrieb: Backup, Wiederherstellungs-Prüfung, Migrationsplan (Trockenlauf), Freigabe, Anwendung. Läuft nur auf ausdrücklichen Aufruf; gibt nie Zugangsdaten aus. */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { appliedList, applyPending, approve, assertMayApply, latestBackup, makePlan, writePlan } from '../src/ops/migrate.ts';

const ROOT = process.cwd(), MIG = join(ROOT, 'supabase', 'migrations'), OUT = join(ROOT, 'out'), BACKUPS = join(ROOT, 'backups');
const url = process.env.DATABASE_URL ?? ''; const cmd = process.argv[2] ?? 'help'; const arg = process.argv[3];
const die = (m: string): never => { console.error(m); process.exit(1); };
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

async function withDb<T>(f: (c: pg.Client) => Promise<T>): Promise<T> {
  if (!url) die('DATABASE_URL ist nicht gesetzt (Umgebungsvariable, siehe SETUP.md). Der Wert wird nie ausgegeben.');
  const c = new pg.Client({ connectionString: url }); await c.connect(); try { return await f(c); } finally { await c.end(); }
}
const tool = (name: string) => spawnSync(name, ['--version'], { encoding: 'utf8' }).status === 0;

switch (cmd) {
  case 'backup': {
    if (!url) die('DATABASE_URL ist nicht gesetzt.'); if (!tool('pg_dump')) die('pg_dump ist nicht installiert (Paket postgresql-client).');
    mkdirSync(BACKUPS, { recursive: true }); const file = join(BACKUPS, `backup-${stamp()}.sql`);
    const r = spawnSync('pg_dump', ['--no-owner', '--no-privileges', '--file', file, url], { encoding: 'utf8' });
    if (r.status !== 0) die(`pg_dump fehlgeschlagen: ${String(r.stderr).replace(url, '***').slice(0, 400)}`);
    chmodSync(file, 0o600); console.log(`Backup geschrieben: ${file} (${Math.round(statSync(file).size / 1024)} KB). Enthält Kundendaten – nicht committen, sicher aufbewahren.`); break;
  }
  case 'restore-check': {
    const f = arg ?? latestBackup(BACKUPS)?.file; if (!f || !existsSync(f)) die('Keine Backup-Datei angegeben/gefunden.');
    if (!url || !tool('psql')) die('DATABASE_URL und psql werden benötigt.');
    const name = `restore_check_${Date.now()}`; const admin = new URL(url); const target = new URL(url); target.pathname = `/${name}`;
    await withDb((c) => c.query(`create database ${name}`));
    try {
      const r = spawnSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-f', f!, target.toString()], { encoding: 'utf8' });
      if (r.status !== 0) die(`Wiederherstellung fehlgeschlagen: ${String(r.stderr).replace(url, '***').slice(0, 400)}`);
      const c = new pg.Client({ connectionString: target.toString() }); await c.connect();
      const n = (await c.query("select count(*)::int n from information_schema.tables where table_schema = 'public'")).rows[0].n; const l = (await c.query("select to_regclass('public.leads') as t")).rows[0].t; await c.end();
      if (!l) die('Wiederherstellung unvollständig: Tabelle leads fehlt.'); console.log(`Wiederherstellung geprüft: ${n} Tabellen, leads vorhanden. Test-Datenbank wird wieder gelöscht. (Server: ${admin.hostname})`);
    } finally { await withDb((c) => c.query(`drop database if exists ${name}`)); }
    break;
  }
  case 'migrate:plan': { const p = await withDb(async (c) => makePlan(MIG, await appliedList(c))); writePlan(OUT, p); console.log(readFileSync(join(OUT, 'migrate-plan.md'), 'utf8')); break; }
  case 'migrate:approve': {
    if (!arg) die('Bitte den Plan-Hash angeben (steht im Plan).'); const p = await withDb(async (c) => makePlan(MIG, await appliedList(c)));
    try { approve(OUT, arg!, p); } catch (e) { die(e instanceof Error ? e.message : String(e)); } console.log(`Freigegeben: ${p.pending.length} Migration(en).`); break;
  }
  case 'migrate:apply': {
    await withDb(async (c) => {
      const p = makePlan(MIG, await appliedList(c));
      try { assertMayApply(OUT, BACKUPS, p); } catch (e) { return die(e instanceof Error ? e.message : String(e)); }
      const done = await applyPending(c, MIG, p).catch((e) => die(e instanceof Error ? e.message : String(e))); console.log(`Angewendet: ${done.join(', ')}`);
    }); break;
  }
  default: console.log('Befehle: backup | restore-check [Datei] | migrate:plan | migrate:approve <Hash> | migrate:apply  (siehe docs/PRODUKTION.md)');
}
