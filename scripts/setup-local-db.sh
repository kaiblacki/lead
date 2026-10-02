#!/usr/bin/env bash
# Legt eine lokale Postgres-Datenbank für den Demo-Modus an (Supabase-Ersatzschema + alle Migrationen).
# Nutzung:  bash scripts/setup-local-db.sh [datenbankname] [--reset]
# Voraussetzung: ein lokal laufendes PostgreSQL (psql im PATH). Verbindung über die üblichen PG*-Variablen (PGHOST, PGUSER, PGPASSWORD).
# Für echtes Supabase wird dieses Skript NICHT gebraucht – dort die Migrationen im SQL-Editor ausführen (SETUP.md).
set -euo pipefail
cd "$(dirname "$0")/.."
DB="agency_os"; RESET=0
for a in "$@"; do case "$a" in --reset) RESET=1 ;; *) DB="$a" ;; esac; done
[[ "$DB" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "Ungültiger Datenbankname: $DB" >&2; exit 1; }
# Als root (z. B. Container) über den Systembenutzer „postgres“, sonst direkt.
# Der Aufruf übergibt die psql-Argumente als EINEN String (Anführungszeichen darin gelten) – deshalb auch ohne root über eval, sonst wird der ganze String als Datenbankname gelesen.
psql_do() { if [ "$(id -u)" = 0 ] && id postgres >/dev/null 2>&1; then su postgres -c "psql -v ON_ERROR_STOP=1 -q $*"; else eval "psql -v ON_ERROR_STOP=1 -q $*"; fi; }
psql_file() { local db="$1" f="$2"; if [ "$(id -u)" = 0 ] && id postgres >/dev/null 2>&1; then su postgres -c "psql -v ON_ERROR_STOP=1 -q -d $db -f $PWD/$f"; else psql -v ON_ERROR_STOP=1 -q -d "$db" -f "$f"; fi; }
exists=$(psql_do "-d postgres -tAc \"select 1 from pg_database where datname='$DB'\"" || true)
if [ "$exists" = "1" ]; then
  if [ "$RESET" = "1" ]; then psql_do "-d postgres -c \"drop database $DB\""; else echo "Datenbank „${DB}“ existiert bereits (mit --reset neu anlegen)."; exit 0; fi
fi
psql_do "-d postgres -c \"create database $DB\""
psql_file "$DB" test/stub_supabase.sql
for f in supabase/migrations/*.sql; do
  # ein Fehler in einer Migration bricht ab (sonst bliebe ein halbes Schema zurück); Hinweise (NOTICE) sind harmlos
  out=$(psql_file "$DB" "$f" 2>&1) || { printf '%s\n' "$out" | grep -v NOTICE >&2 || true; echo "Migration $f ist fehlgeschlagen – Datenbank „${DB}“ unvollständig (mit --reset neu anlegen)." >&2; exit 1; }
done
echo "Fertig: Datenbank „${DB}“ ist bereit."
echo "Weiter mit:  DATABASE_URL=postgres://<benutzer>:<passwort>@localhost:5432/$DB npm run demo"
