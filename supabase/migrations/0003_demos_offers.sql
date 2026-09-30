create table public.demos (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  template text not null,
  token text not null unique check (char_length(token) >= 32),
  html text not null check (octet_length(html) <= 500000),
  expires_at timestamptz not null,
  revoked boolean not null default false,
  view_count int not null default 0, last_viewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index demos_lead_idx on public.demos(lead_id, created_at desc);

create table public.offers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  content jsonb not null,
  price_cents int not null check (price_cents >= 0),
  deposit_cents int not null check (deposit_cents >= 0),
  final_cents int not null check (final_cents >= 0),
  maintenance_cents int not null check (maintenance_cents >= 0),
  status text not null default 'DRAFT' check (status in ('DRAFT','APPROVED','SENT')),
  created_at timestamptz not null default now(), approved_at timestamptz, sent_at timestamptz,
  check (deposit_cents + final_cents = price_cents)
);
create index offers_lead_idx on public.offers(lead_id, created_at desc);

do $$ declare t text; begin
  foreach t in array array['demos','offers'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('create policy "owner all" on public.%I for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t);
  end loop;
end $$;
