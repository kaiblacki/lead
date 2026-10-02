-- Phase C: Demo-Stufen. Das System empfiehlt (demo_recommendation), Kai entscheidet; hier steht nur Kais manuelle Auswahl.
alter table public.leads
  add column if not exists demo_stage text check (demo_stage in ('NO_DEMO','DEMO_RECOMMENDED','DEMO_SELECTED','DEMO_CREATED','DEMO_SHOWN')),
  add column if not exists demo_shown_at timestamptz;
