-- Strukturierte Lead-Analyse (je Stufe), KI-Kostenprotokoll, E-Mail-Versandstatus, Aufgaben/Erinnerungen, Demo-Entscheidung.
create table public.lead_analysis (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  tier text not null default 'MASS' check (tier in ('MASS','DEEP','PREMIUM')),
  website_status text not null check (website_status in ('NO_WEBSITE','ANALYZED','BLOCKED','UNREACHABLE','NOT_VERIFIED')),
  website_score int check (website_score between 0 and 100),          -- 100 = sehr gute Website; NULL bei NO_WEBSITE / nicht prüfbar
  sales_opportunity int check (sales_opportunity between 0 and 100),   -- 100 = sehr interessante Verkaufschance
  analysis_summary text not null default '',
  positive_points jsonb not null default '[]', weaknesses jsonb not null default '[]', sales_reasons jsonb not null default '[]',
  recommended_improvements jsonb not null default '[]', recommended_demo_features jsonb not null default '[]', recommended_contact_angle text not null default '',
  telephone_talking_points jsonb not null default '[]', email_talking_points jsonb not null default '[]',
  missing_information jsonb not null default '[]', manual_checks jsonb not null default '[]', evidence jsonb not null default '[]', sources jsonb not null default '[]',
  concept jsonb,                                                      -- nur PREMIUM: Website-Konzept
  confidence numeric(4,3) not null default 0, content_hash text not null,
  analyzed_at timestamptz not null default now(), ai_model_used text not null default 'rules', estimated_ai_cost numeric(10,4) not null default 0,   -- Cent
  created_at timestamptz not null default now()
);
create index lead_analysis_lead_idx on public.lead_analysis(lead_id, tier, created_at desc);
alter table public.lead_analysis enable row level security;
revoke all on public.lead_analysis from anon;
create policy "owner all" on public.lead_analysis for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

alter table public.ai_usage
  add column if not exists task text, add column if not exists tier text, add column if not exists purpose text,
  add column if not exists input_tokens int, add column if not exists output_tokens int;
create index if not exists ai_usage_lead_idx on public.ai_usage(lead_id, created_at);

alter table public.leads
  add column if not exists ai_tier text not null default 'MASS' check (ai_tier in ('MASS','DEEP','PREMIUM')),
  add column if not exists email_send_status text not null default 'draft' check (email_send_status in ('draft','review_required','legally_cleared','sent','follow_up_due','do_not_contact')),
  add column if not exists email_sent_at timestamptz,
  add column if not exists demo_decision text check (demo_decision in ('skipped'));

create table public.lead_tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  kind text not null check (kind in ('CALL_DEMO_READY','CALL_BACK','FOLLOW_UP','REVIEW')),
  title text not null check (char_length(title) <= 200),
  due_at timestamptz not null default now(), status text not null default 'OPEN' check (status in ('OPEN','DONE','DISMISSED')),
  created_at timestamptz not null default now(), done_at timestamptz
);
create unique index lead_tasks_one_open on public.lead_tasks(lead_id, kind) where status = 'OPEN';
create index lead_tasks_owner_idx on public.lead_tasks(owner_id, status, due_at);
alter table public.lead_tasks enable row level security;
revoke all on public.lead_tasks from anon;
create policy "owner all" on public.lead_tasks for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
