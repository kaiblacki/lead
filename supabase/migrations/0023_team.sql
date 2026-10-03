-- Mitarbeiter-Vertriebssystem: Benutzer/Rollen, Lead-Zuweisung, Kontaktversuche, Übergaben, Kampagnen, Audit.
create table public.staff_users (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  login text not null check (login ~ '^[a-z0-9._@-]{2,80}$'),
  password_hash text not null,
  role text not null default 'SALES' check (role in ('ADMIN','TEAM_LEAD','SALES')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','PAUSED','DISABLED')),
  active_since timestamptz not null default now(),
  team text, industries text[] not null default '{}', regions text[] not null default '{}', preferred_categories text[] not null default '{}',
  goal_calls int not null default 40 check (goal_calls between 0 and 1000), goal_reached int not null default 12 check (goal_reached between 0 and 1000),
  goal_qualified int not null default 5 check (goal_qualified between 0 and 1000), goal_followups int not null default 6 check (goal_followups between 0 and 1000),
  admin_notes text check (admin_notes is null or char_length(admin_notes) <= 4000),
  last_login_at timestamptz, last_activity_at timestamptz, created_at timestamptz not null default now(),
  unique (owner_id, login)
);
create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  rules jsonb not null default '{}', playbook text, assignee_id uuid references public.staff_users(id) on delete set null,
  target_count int not null default 0 check (target_count >= 0), assigned_count int not null default 0,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','PAUSED','DONE')), created_by text, created_at timestamptz not null default now()
);
alter table public.leads
  add column if not exists assigned_to_user_id uuid references public.staff_users(id) on delete set null,
  add column if not exists assigned_at timestamptz, add column if not exists assigned_by text,
  add column if not exists assignment_source text check (assignment_source in ('MANUAL','BATCH_ASSIGNMENT','ROUND_ROBIN','AUTO_RULE')),
  add column if not exists assignment_status text not null default 'UNASSIGNED' check (assignment_status in ('UNASSIGNED','ASSIGNED','IN_PROGRESS','COMPLETED','RETURNED','TRANSFERRED')),
  add column if not exists working_user_id uuid references public.staff_users(id) on delete set null,
  add column if not exists locked_at timestamptz, add column if not exists lock_expires_at timestamptz,
  add column if not exists contact_status text not null default 'NOT_CONTACTED' check (contact_status in ('NOT_CONTACTED','CONTACT_ATTEMPTED','REACHED','QUALIFIED','INTERESTED','FOLLOW_UP','NO_INTEREST','DO_NOT_CONTACT')),
  add column if not exists campaign_id uuid references public.campaigns(id) on delete set null;
create index if not exists leads_assigned_idx on public.leads(owner_id, assigned_to_user_id, assignment_status);
alter table public.tasks add column if not exists for_admin boolean not null default false;

create table public.contact_attempts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  user_id uuid references public.staff_users(id) on delete set null, user_name text not null,
  channel text not null check (channel in ('PHONE','EMAIL','WHATSAPP','IN_PERSON','OTHER')),
  status text not null default 'DONE' check (status in ('DONE','DRAFT','SENT')),
  started_at timestamptz not null default now(), ended_at timestamptz,
  result text not null, note text check (note is null or char_length(note) <= 4000),
  next_action text check (next_action is null or char_length(next_action) <= 300), next_action_at timestamptz,
  campaign_id uuid references public.campaigns(id) on delete set null, playbook_id text,
  created_at timestamptz not null default now()
);
create index contact_attempts_idx on public.contact_attempts(owner_id, user_id, started_at);
create index contact_attempts_lead_idx on public.contact_attempts(lead_id, started_at);
create function public.forbid_update() returns trigger language plpgsql as $$ begin raise exception 'Eintrag ist unveränderlich (Historie wird nur ergänzt).'; end $$;
create trigger contact_attempts_no_update before update on public.contact_attempts for each row execute function public.forbid_update();

create table public.handoffs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  from_user_id uuid references public.staff_users(id) on delete set null, from_name text not null,
  reason text not null check (reason in ('WEBSITE_ANGEBOT','PARTNER_GESPRAECH','BEDARFSANALYSE','GROSSKUNDE','SONDERFALL','MEHRERE_THEMEN')),
  company_name text, contact_person text, last_contact_at timestamptz, last_result text, note text not null check (char_length(note) between 1 and 4000),
  interest text, callback_wanted_at timestamptz, next_step text,
  status text not null default 'OPEN' check (status in ('OPEN','ACCEPTED','DONE')), handled_note text, handled_at timestamptz, created_at timestamptz not null default now()
);
create table public.team_audit (
  id bigint generated always as identity primary key,
  owner_id uuid not null, at timestamptz not null default now(),
  user_id uuid, user_name text not null, role text, event text not null, lead_id uuid, meta jsonb not null default '{}'
);
create index team_audit_idx on public.team_audit(owner_id, at desc);
create trigger team_audit_no_update before update on public.team_audit for each row execute function public.forbid_update();
create function public.forbid_delete() returns trigger language plpgsql as $$ begin raise exception 'Audit-Einträge können nicht gelöscht werden.'; end $$;
create trigger team_audit_no_delete before delete on public.team_audit for each row execute function public.forbid_delete();
create table public.team_feedback (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  attempt_id uuid references public.contact_attempts(id) on delete cascade, lead_id uuid references public.leads(id) on delete cascade,
  staff_id uuid references public.staff_users(id) on delete cascade, author text not null, text text not null check (char_length(text) between 1 and 2000), created_at timestamptz not null default now()
);

do $$ declare t text; begin
  foreach t in array array['staff_users','campaigns','contact_attempts','handoffs','team_feedback'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('create policy "owner all" on public.%I for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t);
  end loop;
  alter table public.team_audit enable row level security; revoke all on public.team_audit from anon;
  create policy "owner read insert" on public.team_audit for select to authenticated using (owner_id = auth.uid());
  create policy "owner insert" on public.team_audit for insert to authenticated with check (owner_id = auth.uid());
end $$;
