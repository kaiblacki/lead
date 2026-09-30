create table public.social_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  plan_id uuid not null,
  profile text not null,
  scheduled_for date not null, platform text not null check (platform in ('instagram','facebook','linkedin','blog','newsletter')),
  format text not null check (format in ('post','story','reel','artikel','newsletter')),
  title text not null, body text not null check (char_length(body) <= 20000), hashtags jsonb not null default '[]', notes jsonb not null default '[]',
  status text not null default 'DRAFT' check (status in ('DRAFT','APPROVED','REJECTED')),
  created_at timestamptz not null default now(), approved_at timestamptz
);
create index social_items_lead_idx on public.social_items(lead_id, scheduled_for);
alter table public.social_items enable row level security;
revoke all on public.social_items from anon;
create policy "owner all" on public.social_items for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
