-- Lead Intelligence: Fakten mit Herkunft, vollständiger Audit, Scores mit Dimensionen, Kontaktstrategie, Suchläufe, Kontakt-Historie,
-- Learning Loop, Wartung, Einstellungen. Alle Tabellen mit RLS (nur Eigentümer).

alter table public.leads
  add column if not exists sub_industry text,
  add column if not exists postal_code text,
  add column if not exists email text,
  add column if not exists employee_bucket text check (employee_bucket in ('1-4','5-9','10-49','50+')),
  add column if not exists distance_km numeric,
  add column if not exists lat double precision,
  add column if not exists lng double precision,
  add column if not exists rating numeric,
  add column if not exists review_count int,
  add column if not exists website_state text,
  add column if not exists contact_readiness text check (contact_readiness in ('READY_FOR_MANUAL_CALL','EMAIL_PERMISSION_REQUIRED','WHATSAPP_OPT_IN_REQUIRED','MANUAL_REVIEW','DO_NOT_CONTACT')),
  add column if not exists contact_channel text check (contact_channel in ('PHONE','EMAIL','WHATSAPP','MANUAL','DO_NOT_CONTACT')),
  add column if not exists contact_reason text,
  add column if not exists callback_at timestamptz,
  add column if not exists last_contact_at timestamptz,
  add column if not exists call_count int not null default 0,
  add column if not exists is_mock boolean not null default false;

alter table public.leads drop constraint if exists leads_status_check;
alter table public.leads add constraint leads_status_check check (status in ('NEW','ANALYZING','QUALIFIED','IGNORED','RECHECK','DEMO_CREATED','CONTACTED','REPLIED','INTERESTED',
  'OFFER_SENT','OFFER_ACCEPTED','DEPOSIT_PENDING','DEPOSIT_PAID','PRODUCTION','QA','CUSTOMER_REVIEW','APPROVED','FINAL_PAYMENT','DEPLOYED','MAINTENANCE'));
create index if not exists leads_readiness_idx on public.leads(owner_id, contact_readiness, status);

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check check (status in ('PAYMENT_PENDING','DEPOSIT_PAID','IN_PRODUCTION','QA','CUSTOMER_REVIEW','APPROVED','FINAL_PAYMENT_PENDING','FULLY_PAID','DEPLOYED','MAINTENANCE_ACTIVE'));
alter table public.offers drop constraint if exists offers_status_check;
alter table public.offers add constraint offers_status_check check (status in ('DRAFT','APPROVED','SENT','ACCEPTED','DECLINED'));
alter table public.offers add column if not exists accepted_at timestamptz, add column if not exists demo_id uuid references public.demos(id) on delete set null;

alter table public.audits
  add column if not exists final_url text, add column if not exists pages_analyzed int, add column if not exists coverage numeric, add column if not exists render_dependent boolean,
  add column if not exists notes jsonb not null default '[]', add column if not exists quality jsonb, add column if not exists overall_quality int, add column if not exists source text,
  add column if not exists captured_at timestamptz, add column if not exists render_source jsonb;
alter table public.findings
  add column if not exists status text not null default 'fail' check (status in ('pass','warn','fail','unknown'));
alter table public.findings drop constraint if exists findings_category_check;

alter table public.opportunities
  add column if not exists digital_need int, add column if not exists dimensions jsonb, add column if not exists contributions jsonb,
  add column if not exists data_quality_factor numeric, add column if not exists config_version int, add column if not exists upsells jsonb, add column if not exists missing jsonb, add column if not exists note text;
alter table public.sales_packages add column if not exists brief jsonb;

alter table public.lead_runs
  add column if not exists criteria jsonb, add column if not exists description text, add column if not exists summary jsonb, add column if not exists error text,
  add column if not exists finished_at timestamptz;
alter table public.lead_runs alter column industry drop not null, alter column region drop not null, alter column run_limit drop not null;

alter table public.budgets
  add column if not exists max_places_requests_per_run int not null default 20,
  add column if not exists max_crawl_pages_per_run int not null default 400;

create table public.lead_facts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  key text not null, value jsonb not null, source text not null, source_url text, note text,
  quality text not null check (quality in ('high','medium','low')), captured_at timestamptz not null, created_at timestamptz not null default now()
);
create index lead_facts_lead_idx on public.lead_facts(lead_id, key);

create table public.run_results (
  run_id uuid not null references public.lead_runs(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  matched boolean not null, rank int, fail_reasons jsonb not null default '[]', sales_opportunity int, digital_need int,
  primary key (run_id, lead_id)
);

create table public.contact_history (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  at timestamptz not null default now(),
  channel text not null check (channel in ('PHONE','EMAIL','WHATSAPP','NOTE','OTHER')),
  direction text not null default 'outbound' check (direction in ('outbound','inbound','internal')),
  result text, note text check (note is null or char_length(note) <= 4000), callback_at timestamptz,
  actor text not null default 'user', provider_message_id text
);
create index contact_history_lead_idx on public.contact_history(lead_id, at desc);

create table public.score_snapshots (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  config_version int, features jsonb not null, scores jsonb not null, created_at timestamptz not null default now()
);
create index score_snapshots_lead_idx on public.score_snapshots(lead_id, created_at desc);

create table public.lead_outcomes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  snapshot_id uuid references public.score_snapshots(id) on delete set null,
  kind text not null check (kind in ('call','stage','final')), value text not null,
  at timestamptz not null default now(), payload jsonb not null default '{}'
);
create index lead_outcomes_lead_idx on public.lead_outcomes(lead_id, at);

create table public.maintenance_plans (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  order_id uuid not null unique references public.orders(id) on delete cascade,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','PAUSED','CANCELED')),
  monthly_cents int not null check (monthly_cents >= 0), interval_days int not null default 7 check (interval_days between 1 and 90),
  next_check_at timestamptz not null, last_check_at timestamptz, activated_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create table public.maintenance_tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200), detail text, source text not null default 'manual' check (source in ('check','manual','customer')),
  status text not null default 'OPEN' check (status in ('OPEN','DONE')), created_at timestamptz not null default now(), done_at timestamptz
);
create index maintenance_tasks_order_idx on public.maintenance_tasks(order_id, status);

create table public.owner_settings (
  owner_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  phone_enabled boolean not null default false, phone_ack_at timestamptz, daily_call_target int not null default 20 check (daily_call_target between 1 and 200),
  caller_name text, channels jsonb not null default '{}', updated_at timestamptz not null default now()
);

create table public.provider_usage (
  id bigint generated always as identity primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  run_id uuid references public.lead_runs(id) on delete set null,
  provider text not null, operation text not null, requests int not null default 1, at timestamptz not null default now()
);

do $$ declare t text; begin
  foreach t in array array['lead_facts','run_results','contact_history','score_snapshots','lead_outcomes','maintenance_plans','maintenance_tasks','owner_settings','provider_usage'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('create policy "owner all" on public.%I for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t);
  end loop;
end $$;
