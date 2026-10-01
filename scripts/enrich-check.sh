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
    export DATABASE_URL="postgres://postgres:postgres@localhost:5432/agency_live"
  fi
  bash scripts/setup-local-db.sh agency_live
fi
export OWNER_ID="${OWNER_ID:-00000000-0000-0000-0000-00000000a0c0}"
exec node src/enrich/check-cli.ts "$@"
