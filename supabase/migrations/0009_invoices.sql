-- Rechnungen zu bezahlten Zahlungen (fortlaufende Nummer je Jahr; Inhalt als unveränderlicher Schnappschuss).
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  payment_id uuid not null unique references public.payments(id) on delete cascade,
  number text not null, issued_at timestamptz not null default now(), data jsonb not null,
  unique (owner_id, number)
);
create index invoices_order_idx on public.invoices(order_id);
alter table public.invoices enable row level security;
revoke all on public.invoices from anon;
create policy "owner all" on public.invoices for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
