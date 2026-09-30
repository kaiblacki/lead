-- Änderungswünsche der Kunden werden interpretiert und angewendet (oder zur manuellen Bearbeitung markiert).
alter table public.reviews
  add column if not exists change_status text check (change_status in ('OPEN','APPLIED','MANUAL')),
  add column if not exists change_patch jsonb,
  add column if not exists change_unclear jsonb,
  add column if not exists resolved_at timestamptz;
