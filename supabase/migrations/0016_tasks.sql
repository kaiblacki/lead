-- Phase B: Aufgaben-Engine (Follow-ups aus Anruf-Ergebnissen, manuelle Aufgaben). Bestehende lead_tasks (z. B. „Demo fertig – anrufen“) bleiben unverändert.
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  partner_id uuid references public.partners(id) on delete cascade,
  customer_id uuid,
  type text not null check (type in ('CALL','CALL_RETRY','CALLBACK','PREPARE_DEMO','CREATE_DEMO','DEMO_FOLLOW_UP','PREPARE_OFFER','OFFER_FOLLOW_UP','NEEDS_ANALYSIS_APPOINTMENT','PARTNER_CONVERSATION','CUSTOMER_REQUEST','PAYMENT_CHECK','CUSTOM')),
  title text not null check (char_length(title) between 1 and 300),
  due_at timestamptz not null default now(),
  status text not null default 'OPEN' check (status in ('OPEN','DONE','CANCELLED','SNOOZED')),
  priority text not null default 'NORMAL' check (priority in ('HIGH','NORMAL','LOW')),
  source text not null default 'manual' check (source in ('manual','followup','system')),
  notes text check (notes is null or char_length(notes) <= 4000),
  snoozed_until timestamptz,
  created_at timestamptz not null default now(), done_at timestamptz
);
create index tasks_due_idx on public.tasks(owner_id, status, due_at);
create index tasks_lead_idx on public.tasks(lead_id);
-- aus Follow-up-Regeln höchstens eine offene Aufgabe je Lead und Typ (erneute Regel aktualisiert Termin/Notiz)
create unique index tasks_followup_open_uidx on public.tasks(lead_id, type) where source = 'followup' and status in ('OPEN','SNOOZED') and lead_id is not null;

alter table public.tasks enable row level security;
revoke all on public.tasks from anon;
create policy "owner all" on public.tasks for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
