#!/usr/bin/env bash
# Legt eine frische lokale Test-DB an (Supabase-Stub + Migrationen) und startet die DB-Tests.
set -euo pipefail
cd "$(dirname "$0")/.."
admin() { if [ "$(id -u)" = 0 ]; then su postgres -c "psql -q -c \"$1\""; else psql -q -c "$1"; fi; }
run() { if [ "$(id -u)" = 0 ]; then su postgres -c "psql -q -v ON_ERROR_STOP=1 -d dbtest -f $PWD/$1"; else psql -q -v ON_ERROR_STOP=1 -d dbtest -f "$1"; fi; }
if [ "$(id -u)" = 0 ]; then pg_lsclusters | grep -q online || pg_ctlcluster 16 main start 2>/dev/null || true; sleep 1; fi
admin "drop database if exists dbtest" >/dev/null 2>&1
admin "create database dbtest"
run test/stub_supabase.sql
for f in supabase/migrations/*.sql; do run "$f"; done
if [ "$(id -u)" = 0 ]; then
  su postgres -c "psql -q -d dbtest -c \"alter user postgres password 'pw'\""
fi
export TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgres://postgres:pw@localhost:5432/dbtest}"
FILES=${DB_TEST_FILES:-test/db/*.test.ts}
node --test --test-concurrency=1 $FILES
