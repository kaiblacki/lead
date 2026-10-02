#!/usr/bin/env bash
# Startet die lokale Demo: prüft Node + Postgres, legt die Demo-Datenbank an (falls sie fehlt) und startet das Dashboard.
# Nutzung:  npm run demo:start        (Einstellungen optional in .env.local, siehe .env.example)
set -uo pipefail
cd "$(dirname "$0")/.."
fail() { echo "FEHLER: $*" >&2; exit 1; }

# Lokale Einstellungen (nie im Repository): .env.local
if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi
DB="${DEMO_DB:-agency_demo}"; PORT="${PORT:-3055}"; HOST="${HOST:-127.0.0.1}"
OWNER_ID="${OWNER_ID:-00000000-0000-0000-0000-00000000b002}"
DASHBOARD_PASSWORD="${DASHBOARD_PASSWORD:-mein-demo-passwort-123}"

# 1. Node
command -v node >/dev/null || fail "Node.js fehlt (nodejs.org, Version 22.18 oder neuer)."
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' || fail "Node $(node -v) ist zu alt – Version 22.18 oder neuer nötig."
[ -d node_modules/pg ] || { echo "Abhängigkeiten fehlen – npm install …"; npm install || fail "npm install ist fehlgeschlagen."; }

# 2. psql finden (PATH, Postgres.app, Homebrew)
if ! command -v psql >/dev/null; then
  for d in /Applications/Postgres.app/Contents/Versions/latest/bin /opt/homebrew/opt/postgresql@*/bin /opt/homebrew/bin /usr/local/opt/postgresql@*/bin /usr/local/bin /usr/lib/postgresql/*/bin; do
    for p in $d; do [ -x "$p/psql" ] && { export PATH="$p:$PATH"; break 2; }; done
  done
fi
command -v psql >/dev/null || fail "PostgreSQL ist auf diesem Rechner nicht installiert (kein psql gefunden).
Einmalig: Postgres.app von https://postgresapp.com laden, in „Programme“ ziehen, öffnen und „Initialize“ klicken. Danach nochmal: npm run demo:start"

# 3. Funktionierende Verbindung ermitteln (erst .env.local/PG*-Variablen, dann Mac-Benutzer, dann postgres/postgres)
export PGHOST="${PGHOST:-localhost}" PGPORT="${PGPORT:-5432}"
works() { PGUSER="$1" PGPASSWORD="$2" psql -d postgres -tAc 'select 1' >/dev/null 2>&1; }
found=""
if [ -n "${PGUSER:-}" ] && works "$PGUSER" "${PGPASSWORD:-}"; then found=1; fi
if [ -z "$found" ]; then
  for pair in "$(whoami):" "postgres:postgres" "postgres:"; do
    u="${pair%%:*}"; pw="${pair#*:}"
    if works "$u" "$pw"; then PGUSER="$u"; PGPASSWORD="$pw"; found=1; break; fi
  done
fi
if [ -z "$found" ]; then
  if ! (exec 3<>/dev/tcp/"$PGHOST"/"$PGPORT") 2>/dev/null; then
    fail "PostgreSQL läuft nicht (Port $PGPORT). Postgres.app öffnen und warten, bis der Server „Running“ zeigt (Homebrew: brew services start postgresql@16). Danach nochmal: npm run demo:start"
  fi
  fail "PostgreSQL läuft, aber keine Anmeldung klappt. Zugangsdaten in .env.local eintragen (PGUSER=… und PGPASSWORD=…, siehe .env.example)."
fi
export PGUSER PGPASSWORD="${PGPASSWORD:-}"
echo "PostgreSQL: Benutzer „$PGUSER“, Port $PGPORT – OK"

# 4. Datenbank + Migrationen (nur wenn sie fehlt) und Testbenutzer
bash scripts/setup-local-db.sh "$DB" || fail "Datenbank „$DB“ konnte nicht vorbereitet werden (siehe oben)."
psql -d "$DB" -qc "insert into auth.users(id) values ('$OWNER_ID') on conflict do nothing" || fail "Testbenutzer konnte nicht angelegt werden."

# 5. Port prüfen
if (exec 3<>/dev/tcp/"$HOST"/"$PORT") 2>/dev/null; then
  fail "Port $PORT ist belegt (läuft die Demo schon, oder ein anderes Programm?). Anderen Port wählen: PORT=3056 npm run demo:start"
fi

# 6. Server starten (Vordergrund; Fenster offen lassen)
urlenc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
export DATABASE_URL="postgres://$(urlenc "$PGUSER")${PGPASSWORD:+:$(urlenc "$PGPASSWORD")}@localhost:$PGPORT/$DB"
export APP_MODE=live OWNER_ID DASHBOARD_PASSWORD PORT HOST
echo; echo "Dashboard:  http://$HOST:$PORT   (Benutzername beliebig, Passwort aus DASHBOARD_PASSWORD, Standard: mein-demo-passwort-123)"
echo "Beenden mit Strg+C."; echo
exec node src/serve.ts
