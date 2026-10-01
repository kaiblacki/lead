/**
 * Kontrollierter Echttest der Datenanreicherung: `npm run enrich:check -- [--ensure-run] [--dry-run] [--lead "Name"]… [--max-leads 5] [--max-requests 15] [--run <id>] [--out <ordner>] [--json] [--migrate]`
 * Höchstens 5 bestehende DATA_NEEDED-Leads, harte Obergrenze für Websuche-Anfragen, Bericht VORHER → NACHHER. Keine Demo, keine Nachricht, keine Kontaktaufnahme.
 * Der Brave-Schlüssel kommt nur aus der Umgebungsvariable BRAVE_SEARCH_API_KEY (nie in Chat, Repository oder Client-Code) und wird nie ausgegeben.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Repo } from '../db/repo.ts';
import { buildContext } from '../context.ts';
import { CHECK_HARD_MAX_LEADS, CHECK_LEADS, ensureRun, renderReport, runEnrichmentCheck } from './check.ts';

const args = process.argv.slice(2);
const has = (n: string) => args.includes(`--${n}`);
const val = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const vals = (n: string) => args.flatMap((a, i) => (a === `--${n}` && args[i + 1] ? [args[i + 1]] : []));
const HELP = `Nutzung: npm run enrich:check -- [Optionen]
  --ensure-run         Suchlauf „Saarlouis · 6 km · Friseur · SMALL“ kostenlos (ohne Websuche) anlegen, falls es ihn noch nicht gibt
  --dry-run            nichts abfragen: nur Auswahl und Zustand VORHER zeigen (braucht keinen Schlüssel)
  --lead "Name"        Testlead (mehrfach möglich; Standard: ${CHECK_LEADS.join(', ')})
  --max-leads N        höchstens N Leads (1–${CHECK_HARD_MAX_LEADS}, Standard ${CHECK_HARD_MAX_LEADS})
  --max-requests N     harte Obergrenze für Websuche-Anfragen (Standard: Leads × Anfragen je Lead)
  --run <id>           anderen Suchlauf verwenden
  --ignore-cache       dieselbe Suche trotz Zwischenspeicher wiederholen (kostet erneut Anfragen; sonst gilt: gleiche Suche wird 30/14 Tage nicht wiederholt)
  --out <ordner>       Berichte (.md und .json) ablegen (Standard: out/enrich-check)
  --json               JSON statt Markdown ausgeben
  --migrate            fehlende Migrationen (0011–0013) in der Datenbank einspielen (nur lokale Test-/Demo-Datenbanken)
Umgebung: DATABASE_URL, OWNER_ID; für den echten Lauf BRAVE_SEARCH_API_KEY.`;

const KEY_HELP = `BRAVE_SEARCH_API_KEY ist in diesem Prozess nicht gesetzt – es wurde KEINE Anfrage gesendet und nichts verändert.
Wo der Schlüssel hingehört (nie in den Chat, ins Repository oder in Client-Code):
  • Lokal (Mac/Linux), im Projektordner und im SELBEN Terminalfenster, in dem der Test läuft:
        export BRAVE_SEARCH_API_KEY='…'        # Schlüssel aus dem Brave-Dashboard
        test -n "$BRAVE_SEARCH_API_KEY" && echo "Brave-Key ist gesetzt"
        npm run enrich:check -- --ensure-run
  • Claude-Code-Cloud-Sitzung: ein Export auf dem Mac erreicht die Cloud-Umgebung nicht. Dort in den Einstellungen der Cloud-Umgebung
    (Menü der Umgebung in der Titelleiste → Bearbeiten → „API credentials“ bzw. Umgebungsvariable) die Variable BRAVE_SEARCH_API_KEY anlegen
    und danach eine NEUE Sitzung auf diesem Branch starten (eine laufende Sitzung sieht neue Variablen nicht).
Ohne Schlüssel geht: npm run enrich:check -- --dry-run   (zeigt Auswahl und Zustand VORHER, ohne Anfrage).`;

type Probe = { file: string; table: string; column: string };
const PROBES: Probe[] = [{ file: '0011_pipeline.sql', table: 'leads', column: 'effective_priority' }, { file: '0012_enrichment_approvals.sql', table: 'leads', column: 'work_status' }, { file: '0013_provider_cost_currency.sql', table: 'enrichment_log', column: 'provider_cost_currency' }];

/** Sicherheitsnetz: der Schlüssel darf in keiner Ausgabe (auch nicht in Fehlermeldungen) vorkommen. */
const scrub = (t: string) => { const k = process.env.BRAVE_SEARCH_API_KEY; return k && k.length >= 8 ? t.split(k).join('***') : t; };

async function main() {
  if (has('help') || has('h')) { console.log(HELP); return 0; }
  const env = process.env; const dry = has('dry-run');
  if (!dry && !env.BRAVE_SEARCH_API_KEY) { console.error(KEY_HELP); return 2; }
  if (!env.DATABASE_URL || !env.OWNER_ID) { console.error('DATABASE_URL und OWNER_ID fehlen (siehe SETUP.md; lokal: bash scripts/setup-local-db.sh agency_live).'); return 2; }
  // Dieser Befehl arbeitet immer mit den echten Datenquellen (OSM, Brave, Websites) – aber er ruft nur Anreicherung und Analyse auf, nie Versand, Demo oder Zahlung.
  env.APP_MODE = 'live'; env.PROVIDER_WEBSEARCH = 'real';
  const repo = Repo.fromEnv();
  try {
    // Schema prüfen (die Migrationen 0011–0013 müssen eingespielt sein)
    const missing: Probe[] = [];
    for (const p of PROBES) if (!(await repo.pool.query('select 1 from information_schema.columns where table_schema=$1 and table_name=$2 and column_name=$3', ['public', p.table, p.column])).rowCount) missing.push(p);
    if (missing.length && has('migrate')) {
      for (const p of missing) { console.error(`Migration ${p.file} wird eingespielt …`); await repo.pool.query(readFileSync(join('supabase', 'migrations', p.file), 'utf8')); }
    } else if (missing.length) {
      console.error(`In der Datenbank fehlen Migrationen: ${missing.map((p) => p.file).join(', ')}.\nEinspielen: ${missing.map((p) => `psql "$DATABASE_URL" -f supabase/migrations/${p.file}`).join(' && ')}\n(oder dieses Skript mit --migrate; ist die Datenbank ganz neu: bash scripts/setup-local-db.sh <name> --reset)`); return 2;
    }
    if (has('ensure-run')) await repo.pool.query('insert into auth.users(id) values ($1) on conflict do nothing', [env.OWNER_ID]).catch(() => undefined);   // lokale Stub-Datenbank; bei Supabase existiert der Nutzer bereits
    const ctx = buildContext(repo, { baseUrl: env.PUBLIC_BASE_URL ?? 'http://127.0.0.1:3000' });
    if (!dry && (!ctx.enrichment.available || ctx.enrichment.provider.isMock)) { console.error(`Websuche ist nicht live (Anbieter „${ctx.enrichment.provider.name}“). ${KEY_HELP}`); return 2; }
    let runId = val('run');
    if (!runId) { const r = await ensureRun(ctx, { start: has('ensure-run') }); runId = r.runId; console.error(r.created ? `Suchlauf neu angelegt (ohne Websuche): ${r.leads} Leads, ${runId}` : `Vorhandener Suchlauf: ${r.leads} Leads, ${runId}`); }
    const names = vals('lead');
    const report = await runEnrichmentCheck(ctx, { runId, names: names.length ? names : undefined, maxLeads: val('max-leads') ? Number(val('max-leads')) : undefined, maxRequests: val('max-requests') ? Number(val('max-requests')) : undefined, dryRun: dry, ignoreCache: has('ignore-cache'), onProgress: (m) => console.error(scrub(m)) });
    const md = scrub(renderReport(report)), json = scrub(JSON.stringify(report, null, 1));
    const dir = val('out') ?? join('out', 'enrich-check'); mkdirSync(dir, { recursive: true }); const stamp = report.startedAt.replace(/[:.]/g, '-');
    const base = join(dir, `enrich-check-${dry ? 'dry-' : ''}${stamp}`); writeFileSync(`${base}.md`, md); writeFileSync(`${base}.json`, json);
    console.log(has('json') ? json : md); console.error(`\nBericht gespeichert: ${base}.md und ${base}.json`);
    return report.safety.ok ? 0 : 3;
  } finally { await repo.close(); }
}
/** Verständliche Hilfe bei typischen Datenbankfehlern (lokal: Postgres nicht gestartet, falsche Zugangsdaten, Datenbank fehlt). */
const dbHelp = (e: unknown): string => {
  const code = String((e as { code?: string })?.code ?? '');
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(code)) return 'PostgreSQL ist nicht erreichbar. Lokal starten (macOS: brew services start postgresql@16 oder Postgres.app öffnen) und den Befehl wiederholen; DATABASE_URL prüfen.';
  if (code === '28P01' || code === '28000') return 'PostgreSQL lehnt die Zugangsdaten ab – Benutzer/Passwort in DATABASE_URL prüfen.';
  if (code === '3D000') return 'Die Datenbank existiert nicht. Anlegen: bash scripts/setup-local-db.sh agency_live (mit gesetzten PGHOST/PGUSER/PGPASSWORD, falls nötig) und den Befehl wiederholen.';
  return '';
};
main().then((c) => process.exit(c), (e) => { const h = dbHelp(e); console.error(scrub(`Fehler: ${e instanceof Error ? e.message : String(e)}${h ? `\n${h}` : ''}`)); process.exit(1); });
