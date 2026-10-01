#!/usr/bin/env bash
# Kontrollierter Echttest der Datenanreicherung (höchstens 5 Leads, harte Obergrenze für Websuche-Anfragen, Bericht VORHER → NACHHER).
# Keine Demo, keine Nachricht, keine Kontaktaufnahme. Der Brave-Schlüssel kommt nur aus der Umgebungsvariable BRAVE_SEARCH_API_KEY.
#   export BRAVE_SEARCH_API_KEY='…'          # im selben Terminalfenster; nie in Chat oder Repository
#   npm run enrich:check -- --ensure-run     # Suchlauf Saarlouis/Friseur/SMALL anlegen (kostenlos), dann die 5 Leads prüfen
#   npm run enrich:check -- --dry-run        # ohne Schlüssel: nur Auswahl und Zustand VORHER
# Ist DATABASE_URL nicht gesetzt, wird eine lokale Datenbank „agency_live“ verwendet (und bei Bedarf angelegt).
set -euo pipefail
cd "$(dirname "$0")/.."
DRY=0; for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; --help|-h) exec node src/enrich/check-cli.ts --help ;; esac; done
[ -d node_modules/pg ] || { echo "Abhängigkeiten fehlen – npm install …" >&2; npm install --no-audit --no-fund >&2; }
# Ohne Schlüssel (und ohne --dry-run) erklärt das Prüfskript, wo er hingehört – ohne Datenbank oder Netz anzufassen.
if [ "$DRY" = 0 ] && [ -z "${BRAVE_SEARCH_API_KEY:-}" ]; then exec node src/enrich/check-cli.ts "$@"; fi
if [ -z "${DATABASE_URL:-}" ]; then
  if [ "$(id -u)" = 0 ]; then
    # Container: lokales Postgres starten und dem Benutzer „postgres“ ein Passwort geben
    if command -v pg_lsclusters >/dev/null 2>&1; then pg_lsclusters | grep -q online || pg_ctlcluster 16 main start 2>/dev/null || true; sleep 1; fi
    su postgres -c "psql -q -c \"alter user postgres password 'pw'\"" >/dev/null 2>&1 || true
    export DATABASE_URL="postgres://postgres:pw@localhost:5432/agency_live"
  else
    # Lokales PostgreSQL finden (psql nötig): zuerst postgres/postgres (Projektstandard der Demo), dann der Mac-Benutzer ohne Passwort (Homebrew/Postgres.app)
    command -v psql >/dev/null 2>&1 || { printf '%s\n' "psql nicht gefunden – PostgreSQL installieren und starten (macOS: brew install postgresql@16 && brew services start postgresql@16) oder DATABASE_URL setzen." >&2; exit 2; }
    for cred in "postgres:postgres" "$(id -un):"; do
      u="${cred%%:*}"; p="${cred#*:}"
      if PGCONNECT_TIMEOUT=3 PGPASSWORD="$p" psql -h localhost -U "$u" -d postgres -Atqc 'select 1' >/dev/null 2>&1; then
        export PGHOST=localhost PGUSER="$u"; if [ -n "$p" ]; then export PGPASSWORD="$p"; fi
        export DATABASE_URL="postgres://$u${p:+:$p}@localhost:5432/agency_live"; break
      fi
    done
    if [ -z "${DATABASE_URL:-}" ]; then
      printf '%s\n' "Kein lokales PostgreSQL erreichbar (versucht auf localhost:5432: Benutzer postgres/postgres und $(id -un) ohne Passwort)." \
        "Starten: brew services start postgresql@16 (oder Postgres.app öffnen), danach den Befehl wiederholen." \
        "Hat dein PostgreSQL andere Zugangsdaten: export DATABASE_URL='postgres://BENUTZER:PASSWORT@localhost:5432/agency_live' und wiederholen (Datenbank vorher anlegen: createdb agency_live)." >&2
      exit 2
    fi
  fi
  bash scripts/setup-local-db.sh agency_live
fi
export OWNER_ID="${OWNER_ID:-00000000-0000-0000-0000-00000000a0c0}"
exec node src/enrich/check-cli.ts "$@"
