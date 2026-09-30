create table public.orders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  offer_id uuid not null unique references public.offers(id),
  status text not null default 'PAYMENT_PENDING' check (status in ('PAYMENT_PENDING','DEPOSIT_PAID','IN_PRODUCTION','CUSTOMER_REVIEW','APPROVED','FINAL_PAYMENT_PENDING','FULLY_PAID','DEPLOYED','MAINTENANCE_ACTIVE')),
  deposit_cents int not null check (deposit_cents >= 0), final_cents int not null check (final_cents >= 0), maintenance_cents int not null check (maintenance_cents >= 0),
  currency text not null default 'eur', review_token text unique check (review_token is null or char_length(review_token) >= 32),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  kind text not null check (kind in ('deposit','final','maintenance')),
  amount_cents int not null check (amount_cents > 0), currency text not null default 'eur',
  status text not null default 'pending' check (status in ('pending','paid','failed','expired','refunded')),
  provider text not null, provider_ref text unique, checkout_url text,
  paid_at timestamptz, created_at timestamptz not null default now()
);
create unique index payments_one_paid_per_kind on public.payments(order_id, kind) where status = 'paid';

create table public.webhook_events (
  id text primary key, owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  type text not null, received_at timestamptz not null default now()
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  order_id uuid not null unique references public.orders(id) on delete cascade,
  template text not null, content jsonb not null, legal_confirmed boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table public.builds (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  version int not null, files jsonb not null check (octet_length(files::text) <= 5000000),
  qa_passed boolean not null default false, qa_issues jsonb not null default '[]',
  created_at timestamptz not null default now(), unique (project_id, version)
);

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  build_id uuid not null references public.builds(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','approved','changes_requested')),
  note text check (note is null or char_length(note) <= 2000),
  created_at timestamptz not null default now(), decided_at timestamptz
);

create table public.deployments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  build_id uuid not null references public.builds(id),
  adapter text not null, url text not null, created_at timestamptz not null default now()
);

create table public.maintenance_checks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  ok boolean not null, details jsonb not null default '{}', created_at timestamptz not null default now()
);

do $$ declare t text; begin
  foreach t in array array['orders','payments','webhook_events','projects','builds','reviews','deployments','maintenance_checks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('create policy "owner all" on public.%I for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t);
  end loop;
end $$;
