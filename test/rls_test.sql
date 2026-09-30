-- Läuft gegen eine leere lokale Postgres-DB. Stubt die Supabase-Umgebung (auth, Rollen).
\set ON_ERROR_STOP on
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true), '')::uuid $$;
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
grant usage on schema public, auth to anon, authenticated;
-- wie bei Supabase: neue Tabellen bekommen standardmäßig alle Rechte, die Migration nimmt sie zurück
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
\i supabase/migrations/0001_core.sql
insert into auth.users values ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b');

-- Nutzer A legt Lead + Event an
set role authenticated; set request.jwt.sub = '00000000-0000-0000-0000-00000000000a';
insert into leads(company_name, source) values ('Salon A', 'csv');
insert into events(type) values ('x');
do $$ begin assert (select count(*) from leads) = 1, 'A sieht eigenen Lead'; end $$;
-- Events: Update/Löschen verboten
do $$ begin
  begin update events set type='y'; raise exception 'update erlaubt!'; exception when insufficient_privilege then null; end;
  begin delete from events; raise exception 'delete erlaubt!'; exception when insufficient_privilege then null; end;
end $$;
-- Ungültiger Status
do $$ begin
  begin update leads set status='QUALIFIED_XYZ'; raise exception 'status erlaubt!'; exception when check_violation then null; end;
end $$;

-- Nutzer B sieht nichts von A und kann nicht in fremdem Namen schreiben
set request.jwt.sub = '00000000-0000-0000-0000-00000000000b';
do $$ begin assert (select count(*) from leads) = 0, 'B sieht keine Leads von A'; end $$;
do $$ begin
  begin insert into leads(owner_id, company_name, source) values ('00000000-0000-0000-0000-00000000000a','Fremd','csv'); raise exception 'fremd-insert erlaubt!';
  exception when insufficient_privilege then null; end;
end $$;

-- anon hat keinen Zugriff
reset role; set role anon;
do $$ begin
  begin perform count(*) from leads; raise exception 'anon liest!'; exception when insufficient_privilege then null; end;
  begin insert into leads(company_name, source) values ('x','y'); raise exception 'anon schreibt!'; exception when insufficient_privilege then null; end;
end $$;
\echo RLS-TESTS OK
