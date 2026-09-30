-- Kern-Schema Phase 1. Alle Tabellen: RLS an, Zugriff nur für den Eigentümer.
create extension if not exists pgcrypto;

create table public.lead_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  industry text not null, region text not null, radius_km int, run_limit int not null check (run_limit between 1 and 1000),
  status text not null default 'PENDING', counters jsonb not null default '{}', created_at timestamptz not null default now()
);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  run_id uuid references public.lead_runs(id) on delete set null,
  company_name text not null, industry text, address text, city text, region text, phone text,
  website_url text, google_maps_url text, opening_hours text, description text,
  socials jsonb not null default '[]',
  source text not null, source_url text, source_ref text,
  status text not null default 'NEW' check (status in ('NEW','ANALYZING','QUALIFIED','IGNORED','RECHECK','DEMO_CREATED','CONTACTED','REPLIED','INTERESTED','OFFER_SENT','DEPOSIT_PENDING','DEPOSIT_PAID','PRODUCTION','CUSTOMER_REVIEW','APPROVED','FINAL_PAYMENT','DEPLOYED','MAINTENANCE')),
  paused boolean not null default false, contact_blocked boolean not null default false,
  created_at timestamptz not null default now(), last_analyzed_at timestamptz,
  unique (owner_id, source, source_ref)
);

create table public.audits (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  status text not null check (status in ('NO_WEBSITE','UNREACHABLE','ANALYZED')),
  scores jsonb, created_at timestamptz not null default now()
);

create table public.findings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  audit_id uuid not null references public.audits(id) on delete cascade,
  category text not null, code text not null, severity text not null check (severity in ('low','medium','high')),
  summary text not null, evidence text not null
);

create table public.scoring_configs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  config jsonb not null, is_active boolean not null default false, created_at timestamptz not null default now()
);

create table public.opportunities (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  audit_id uuid references public.audits(id) on delete set null,
  score int check (score between 0 and 100), category text, factors jsonb not null default '[]', why text,
  created_at timestamptz not null default now()
);

create table public.sales_packages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  problems jsonb not null, chance text, offer_name text, price_cents int, opener text,
  opener_source text check (opener_source in ('template','ai')),
  approved_at timestamptz, created_at timestamptz not null default now()
);

create table public.events (
  id bigint generated always as identity primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  type text not null, payload jsonb not null default '{}', created_at timestamptz not null default now()
);

create table public.ai_usage (
  id bigint generated always as identity primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  model text not null, est_cents numeric not null, created_at timestamptz not null default now()
);

create table public.budgets (
  owner_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  max_leads_per_run int not null default 100, max_audits_per_run int not null default 100,
  max_ai_requests_per_lead int not null default 3, max_daily_cents int not null default 500,
  max_monthly_cents int not null default 5000, kill_switch boolean not null default false
);

create table public.suppression_list (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (kind in ('email','phone','domain','company')), value text not null, reason text,
  created_at timestamptz not null default now(), unique (owner_id, kind, value)
);

-- Events sind append-only: kein Ändern, kein Löschen über die API.
do $$
declare t text;
begin
  foreach t in array array['lead_runs','leads','audits','findings','scoring_configs','opportunities','sales_packages','events','ai_usage','budgets','suppression_list']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
  foreach t in array array['lead_runs','leads','audits','findings','scoring_configs','opportunities','sales_packages','ai_usage','budgets','suppression_list']
  loop
    execute format('create policy "owner all" on public.%I for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t);
  end loop;
end $$;

create policy "owner read events" on public.events for select to authenticated using (owner_id = auth.uid());
create policy "owner insert events" on public.events for insert to authenticated with check (owner_id = auth.uid());
revoke update, delete on public.events from authenticated;
