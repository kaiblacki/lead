-- Phase A: Partnernetzwerk (eigenständiges Kooperationsmodell – nie an Versicherungsabschlüsse gekoppelt), Referrals (geprüfte Weitergabe) und manuelle Kontaktstrategie.
-- Bestehende Daten bleiben unverändert.

alter table public.leads
  add column if not exists contact_strategy text check (contact_strategy in ('CALL','EMAIL_DRAFT','DEMO_FIRST','CALL_AND_DEMO','FOLLOW_UP','MANUAL_RESEARCH','NO_CONTACT')),
  add column if not exists recommended_contact_strategy text check (recommended_contact_strategy in ('CALL','EMAIL_DRAFT','DEMO_FIRST','CALL_AND_DEMO','FOLLOW_UP','MANUAL_RESEARCH','NO_CONTACT')),
  add column if not exists contact_strategy_set_at timestamptz,
  add column if not exists conversation_strategy text check (conversation_strategy in ('WEBSITE_FIRST','PARTNER_FIRST','NEEDS_ANALYSIS_FIRST','WEBSITE_AND_PARTNER','GENERAL_DISCOVERY','FOLLOW_UP','NO_ACTION'));

create table public.partners (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  company_name text not null check (char_length(company_name) between 1 and 200),
  contact_person text, industry text, region text, radius_km int check (radius_km is null or radius_km between 0 and 1000),
  services text, preferred_customer_types text, interesting_leads text, uninteresting_leads text,
  lead_industries text[] not null default '{}',
  phone text, email text, website text,
  status text not null default 'PARTNER_CANDIDATE' check (status in ('NONE','PARTNER_CANDIDATE','PARTNER_DISCUSSION','PARTNER_APPROVED','ACTIVE_PARTNER','PAUSED_PARTNER','ENDED_PARTNER')),
  started_at date,
  referral_preferences text,
  community_status text not null default 'NONE' check (community_status in ('NONE','INVITED','MEMBER')),
  criteria jsonb not null default '{}',
  notes text check (notes is null or char_length(notes) <= 20000),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index partners_lead_uidx on public.partners(owner_id, lead_id) where lead_id is not null;
create index partners_status_idx on public.partners(owner_id, status);

create table public.partner_status_log (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  partner_id uuid not null references public.partners(id) on delete cascade,
  from_status text, to_status text not null, reason text, actor text not null default 'user',
  at timestamptz not null default now()
);

-- Referral: Weitergabe eines Leads an einen Partner (oder Empfehlung eines Partners an uns). Nichts wird automatisch weitergegeben:
-- erst nach Bestätigung durch Kai mit dokumentierter Rechtsgrundlage und ausdrücklich gewählten Daten.
create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  direction text not null check (direction in ('OUTGOING','INCOMING')),
  source_partner_id uuid references public.partners(id) on delete set null,
  destination_partner_id uuid references public.partners(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  company_name text,
  status text not null default 'PROPOSED' check (status in ('PROPOSED','CONFIRMED','SENT','CLOSED','CANCELLED')),
  accepted boolean not null default false, contacted boolean not null default false, converted boolean not null default false,
  estimated_value_cents int check (estimated_value_cents is null or estimated_value_cents >= 0),
  shared_fields jsonb not null default '{}', legal_basis text,
  confirmed_at timestamptz, sent_at timestamptz,
  notes text check (notes is null or char_length(notes) <= 4000),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index referrals_partner_idx on public.referrals(owner_id, destination_partner_id, source_partner_id);

do $$ declare t text; begin
  foreach t in array array['partners','partner_status_log','referrals'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('create policy "owner all" on public.%I for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t);
  end loop;
end $$;
