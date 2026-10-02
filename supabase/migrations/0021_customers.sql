-- Phase H: Kundenprofil, Portal-Grundlage (Token-Link), Änderungswünsche. Nichts wird automatisch gesendet oder abgerechnet.
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  partner_id uuid references public.partners(id) on delete set null,
  company_name text not null, contact_name text, phone text, email text,
  package text, care text, website_url text, domain text, hosting_note text,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','PAUSED','ENDED')),
  portal_token text unique check (portal_token is null or char_length(portal_token) >= 32),
  notes text check (notes is null or char_length(notes) <= 20000),
  customer_since timestamptz not null default now(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (owner_id, lead_id)
);
create table public.customer_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200), detail text check (detail is null or char_length(detail) <= 4000),
  status text not null default 'NEW' check (status in ('NEW','IN_REVIEW','APPROVED','IN_PROGRESS','DONE','DECLINED')),
  scope text check (scope in ('IN_PLAN','EXTRA')), extra_price_cents int check (extra_price_cents is null or extra_price_cents >= 0),
  source text not null default 'manual' check (source in ('manual','portal')),
  created_at timestamptz not null default now(), decided_at timestamptz, done_at timestamptz
);
create index customer_requests_idx on public.customer_requests(owner_id, customer_id, status);
alter table public.tasks add constraint tasks_customer_fk foreign key (customer_id) references public.customers(id) on delete cascade;
do $$ declare t text; begin
  foreach t in array array['customers','customer_requests'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('create policy "owner all" on public.%I for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t);
  end loop;
end $$;
