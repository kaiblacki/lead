-- Phase D/E: Preis-Konfigurator (je Lead eine Konfiguration) und erweiterte Angebots-Statuskette.
-- Bestehende Angebote bleiben unverändert (DRAFT/APPROVED/SENT gelten weiter).

create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  package text not null check (package in ('STARTER','BUSINESS','PRO')),
  selection jsonb not null default '{}',
  partner_discount_approved boolean not null default false,
  partner_status text,
  computed jsonb not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (owner_id, lead_id)
);

alter table public.offers drop constraint if exists offers_status_check;
alter table public.offers add constraint offers_status_check check (status in ('DRAFT','READY_FOR_REVIEW','APPROVED','SENT','ACCEPTED','DECLINED','EXPIRED'));
alter table public.offers
  add column if not exists quote_snapshot jsonb,
  add column if not exists partner_discount_cents int not null default 0 check (partner_discount_cents >= 0),
  add column if not exists valid_until date,
  add column if not exists accepted_at timestamptz,
  add column if not exists declined_at timestamptz;

alter table public.quotes enable row level security;
revoke all on public.quotes from anon;
create policy "owner all" on public.quotes for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
