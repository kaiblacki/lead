#!/usr/bin/env bash
# Legt eine frische lokale Test-DB an (Supabase-Stub + Migrationen) und startet die DB-Tests.
set -euo pipefail
cd "$(dirname "$0")/.."
PSQL=(psql -q -v ON_ERROR_STOP=1)
[ "$(id -u)" = 0 ] && PSQL=(su postgres -c "psql -q -v ON_ERROR_STOP=1 -d dbtest -f /dev/stdin")
admin() { if [ "$(id -u)" = 0 ]; then su postgres -c "psql -q -c \"$1\""; else psql -q -c "$1"; fi; }
run() { if [ "$(id -u)" = 0 ]; then su postgres -c "psql -q -v ON_ERROR_STOP=1 -d dbtest -f $PWD/$1"; else psql -q -v ON_ERROR_STOP=1 -d dbtest -f "$1"; fi; }
admin "drop database if exists dbtest" >/dev/null 2>&1
admin "create database dbtest"
run test/stub_supabase.sql
for f in supabase/migrations/*.sql; do run "$f"; done
if [ "$(id -u)" = 0 ]; then
  su postgres -c "psql -q -d dbtest -c \"alter user postgres password 'pw'\""
fi
export TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgres://postgres:pw@localhost:5432/dbtest}"
node --test test/db.test.ts test/orders.db.test.ts
