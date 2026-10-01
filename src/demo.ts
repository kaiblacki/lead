/**
 * Demo-Modus: startet das gesamte System ohne externe Konten – alle Dienste sind Mocks, Preise/Agenturdaten kommen aus config.mock/.
 * Braucht nur ein lokales Postgres (bash scripts/setup-local-db.sh). Es wird nichts Echtes gesendet, bezahlt oder veröffentlicht.
 */
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const env = process.env;
env.APP_MODE = 'mock';                                   // die Demo läuft nie gegen echte Dienste, auch wenn Schlüssel in der Umgebung stehen
for (const k of Object.keys(env)) if (k.startsWith('PROVIDER_')) delete env[k];
env.CONFIG_DIR ||= 'config.mock';
env.DATABASE_URL ||= 'postgres://postgres:postgres@localhost:5432/agency_os';
const DEMO_LOGIN = 'demo-passwort-123';                  // öffentlich bekannter Demo-Zugang, nur für lokale Mock-Daten
const demoLogin = !env.DASHBOARD_PASSWORD;
if (demoLogin) env.DASHBOARD_PASSWORD = DEMO_LOGIN;
env.HOST ||= '127.0.0.1';
const ownOwner = !env.OWNER_ID;
env.OWNER_ID ||= '00000000-0000-0000-0000-00000000de00';

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
try {
  if (ownOwner) await pool.query('insert into auth.users(id) values ($1) on conflict do nothing', [env.OWNER_ID]);
  const n = (await pool.query('select count(*)::int n from leads where owner_id=$1', [env.OWNER_ID])).rows[0].n as number;
  if (n === 0) {
    console.log('Demo-Daten werden angelegt (Mock-Suchläufe) …');
    try { execFileSync(process.execPath, ['src/cli.ts', 'seed'], { stdio: 'inherit', env }); }
    catch { console.warn('Hinweis: Die Beispielsuchen sind fehlgeschlagen – das Dashboard startet trotzdem; Suchen lassen sich dort von Hand starten.'); }
  }
} catch (e) {
  console.error(`Datenbank nicht erreichbar oder nicht eingerichtet: ${e instanceof Error ? e.message : e}\nEinrichten: bash scripts/setup-local-db.sh   (danach DATABASE_URL setzen, falls nötig)`);
  process.exit(1);
} finally { await pool.end(); }

console.log(`\nDEMO-MODUS – Mock-Dienste, Testdaten. Login: Benutzername beliebig, ${demoLogin ? `Passwort „${DEMO_LOGIN}“` : 'Passwort wie in DASHBOARD_PASSWORD'}.`);
console.log('Telefonakquise ist bewusst gesperrt: Einstellungen → Telefonakquise freigeben, um „Heute anrufen“ zu füllen.\n');
await import('./serve.ts');
