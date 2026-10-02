-- Phase G: Scoring-Dimensionen und Handlungspriorität (abgeleitete Werte, jederzeit neu berechenbar)
alter table public.leads
  add column if not exists growth_scores jsonb,
  add column if not exists action_priority int check (action_priority is null or action_priority between 0 and 100),
  add column if not exists growth_updated_at timestamptz;
create index if not exists leads_action_priority_idx on public.leads (owner_id, action_priority desc nulls last);
