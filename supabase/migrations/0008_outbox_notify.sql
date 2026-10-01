-- Postausgang (alle gesendeten bzw. im Mock aufgezeichneten E-Mails) und Benachrichtigungs-Einstellungen.
alter table public.owner_settings
  add column if not exists notify_email text check (notify_email is null or char_length(notify_email) <= 200),
  add column if not exists notify_enabled boolean not null default true;

create table public.outbox (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (char_length(kind) <= 60),
  to_addr text not null check (char_length(to_addr) <= 200),
  subject text not null check (char_length(subject) <= 300),
  body text not null check (char_length(body) <= 20000),
  status text not null check (status in ('sent','mock_recorded','failed')),
  provider text not null, error text,
  lead_id uuid references public.leads(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  created_at timestamptz not null default now()
);
create index outbox_owner_idx on public.outbox(owner_id, created_at desc);
alter table public.outbox enable row level security;
revoke all on public.outbox from anon;
create policy "owner all" on public.outbox for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
