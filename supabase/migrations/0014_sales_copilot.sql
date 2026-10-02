-- Sales Copilot: individuelle Gesprächsvorbereitung je Lead (regelbasiert, kostenlos; optional vertieft per DEEP).
-- Bestehende Daten bleiben unverändert. Es wird nichts gesendet; die Potenziale sind keine Vertrags- oder Produktentscheidungen.

alter table public.leads
  add column if not exists website_potential text check (website_potential in ('HIGH','MEDIUM','LOW','UNKNOWN')),
  add column if not exists needs_analysis_potential text check (needs_analysis_potential in ('HIGH','MEDIUM','LOW','UNKNOWN')),
  add column if not exists partnership_potential text check (partnership_potential in ('HIGH','MEDIUM','LOW','UNKNOWN')),
  add column if not exists recommended_next_action text check (recommended_next_action in ('CALL','CREATE_DEMO','SHOW_DEMO','CALLBACK','NEEDS_ANALYSIS','PARTNERSHIP_DISCUSSION','MANUAL_RESEARCH','NO_ACTION')),
  add column if not exists call_goal text,
  add column if not exists interest_topics text[] not null default '{}',
  add column if not exists next_step text;
create index if not exists leads_potentials_idx on public.leads(owner_id, website_potential, needs_analysis_potential, partnership_potential);

alter table public.contact_history
  add column if not exists next_step text,
  add column if not exists topics text[] not null default '{}';

create table public.sales_copilot (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  tier text not null check (tier in ('MASS','DEEP')),
  input_hash text not null,
  content jsonb not null,
  ai_model text, cost_cents numeric(12,4) not null default 0,
  created_at timestamptz not null default now(),
  unique (lead_id, tier)
);
create index sales_copilot_owner_idx on public.sales_copilot(owner_id, tier);

alter table public.sales_copilot enable row level security;
revoke all on public.sales_copilot from anon;
create policy "owner all" on public.sales_copilot for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
