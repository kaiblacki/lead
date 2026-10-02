-- Phase I: Community-MVP. Internes Verzeichnis nur mit ausdrücklichem Opt-in; Gebühr aus config/packages.json; aktive Partner kostenlos. Keine Veröffentlichung, keine Abbuchung.
create table public.community_members (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  partner_id uuid references public.partners(id) on delete set null,
  customer_id uuid references public.customers(id) on delete set null,
  company_name text not null check (char_length(company_name) between 1 and 200),
  industry text, region text, offer_text text check (offer_text is null or char_length(offer_text) <= 1000),
  contact_public text check (contact_public is null or char_length(contact_public) <= 300),
  status text not null default 'INVITED' check (status in ('INVITED','ACTIVE','ENDED')),
  billing text not null default 'MONTHLY' check (billing in ('MONTHLY','YEARLY')),
  opt_in boolean not null default false, opt_in_at timestamptz, opt_in_note text check (opt_in_note is null or char_length(opt_in_note) <= 500),
  listed boolean not null default false,
  joined_at timestamptz, ended_at timestamptz, notes text check (notes is null or char_length(notes) <= 4000),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (not listed or opt_in)
);
create unique index community_partner_uq on public.community_members(owner_id, partner_id) where partner_id is not null;
create unique index community_customer_uq on public.community_members(owner_id, customer_id) where customer_id is not null;
alter table public.community_members enable row level security;
revoke all on public.community_members from anon;
create policy "owner all" on public.community_members for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
