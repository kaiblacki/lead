-- Web-Enrichment, Arbeitsstatus (DATA_NEEDED), Kontaktierbarkeit, Demo-Empfehlung und Freigaben (Approval-Workflow).
-- Bestehende Leads, Demos und Entscheidungen bleiben unverändert.

alter table public.leads
  add column if not exists work_status text not null default 'CONTACTABLE' check (work_status in ('DATA_NEEDED','CONTACTABLE')),
  add column if not exists contactability text check (contactability in ('READY','PHONE_ONLY','EMAIL_ONLY','WEB_FORM_ONLY','SOCIAL_ONLY','NO_CONTACT_DATA')),
  add column if not exists preferred_contact_channel text check (preferred_contact_channel in ('PHONE','EMAIL','WHATSAPP','WEB_FORM','SOCIAL')),
  add column if not exists demo_recommendation text check (demo_recommendation in ('DEMO_RECOMMENDED','DEMO_NOT_RECOMMENDED')),
  add column if not exists demo_recommendation_reason text,
  add column if not exists official_website_candidate text,
  add column if not exists official_website_confidence int check (official_website_confidence between 0 and 100),
  add column if not exists official_website_verified text check (official_website_verified in ('VERIFIED','LIKELY','UNCERTAIN','REJECTED')),
  add column if not exists enrichment_status text check (enrichment_status in ('pending','not_needed','provider_unavailable','budget_blocked','cached','website_found','contact_found','not_found','uncertain','skipped_priority')),
  add column if not exists last_enrichment_at timestamptz;
create index if not exists leads_work_status_idx on public.leads(owner_id, work_status);

-- Jede Websuche-Runde je Lead: Cache (Hash), Anfragen und Kosten (Grundlage für Budget und Anzeige)
create table public.enrichment_log (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  run_id uuid references public.lead_runs(id) on delete set null,
  hash text not null, queries jsonb not null default '[]', requests int not null default 0, cost_cents numeric(12,4) not null default 0,
  outcome text not null, found jsonb not null default '{}', provider text, created_at timestamptz not null default now()
);
create index enrichment_log_owner_idx on public.enrichment_log(owner_id, created_at);
create index enrichment_log_lead_idx on public.enrichment_log(lead_id, hash);

-- Allgemeine Freigaben: Das System darf analysieren, empfehlen, vorbereiten – ausführen erst nach Bestätigung durch den Nutzer.
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  action text not null check (action in ('DEMO_CREATE','EMAIL_SEND','FOLLOW_UP_SEND','PREMIUM_ANALYSIS','PUBLISH_WEBSITE')),
  state text not null check (state in ('NOT_REQUIRED','RECOMMENDED','AWAITING_APPROVAL','APPROVED','REJECTED','COMPLETED')),
  reason text, payload jsonb not null default '{}',
  requested_at timestamptz not null default now(), decided_at timestamptz, decided_by text, completed_at timestamptz
);
-- je Lead und Aktion höchstens ein offener Vorgang
create unique index approvals_one_open on public.approvals(lead_id, action) where state in ('RECOMMENDED','AWAITING_APPROVAL','APPROVED');
create index approvals_owner_idx on public.approvals(owner_id, action, state);

do $$ declare t text; begin
  foreach t in array array['enrichment_log','approvals'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('create policy "owner all" on public.%I for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t);
  end loop;
end $$;

-- Bestand: Arbeitsstatus/Kontaktierbarkeit aus vorhandenen Angaben ableiten
update public.leads l set
  work_status = case when l.phone is null and not exists (select 1 from public.lead_facts f where f.lead_id = l.id and f.key = 'email') then 'DATA_NEEDED' else 'CONTACTABLE' end,
  contactability = case
    when l.phone is not null and (l.email is not null or exists (select 1 from public.lead_facts f where f.lead_id = l.id and f.key = 'email')) then 'READY'
    when l.phone is not null then 'PHONE_ONLY'
    when l.email is not null or exists (select 1 from public.lead_facts f where f.lead_id = l.id and f.key = 'email') then 'EMAIL_ONLY'
    when exists (select 1 from public.lead_facts f where f.lead_id = l.id and f.key = 'contactForm') then 'WEB_FORM_ONLY'
    when exists (select 1 from public.lead_facts f where f.lead_id = l.id and f.key in ('whatsapp','social')) then 'SOCIAL_ONLY'
    else 'NO_CONTACT_DATA' end;
update public.leads set preferred_contact_channel = case contactability when 'READY' then 'PHONE' when 'PHONE_ONLY' then 'PHONE' when 'EMAIL_ONLY' then 'EMAIL' when 'WEB_FORM_ONLY' then 'WEB_FORM' when 'SOCIAL_ONLY' then 'SOCIAL' end;

-- Bestehende „Demo empfohlen“-Entscheidungen werden zu offenen Empfehlungen im neuen Freigabe-Workflow; vorhandene Demos bleiben unberührt.
insert into public.approvals(owner_id, lead_id, action, state, reason)
  select l.owner_id, l.id, 'DEMO_CREATE', 'RECOMMENDED', 'Übernommen aus früherer Empfehlung' from public.leads l
   where l.demo_decision = 'recommended' and not exists (select 1 from public.demos d where d.lead_id = l.id);

-- Frühere „Überspringen“-Entscheidungen bleiben als abgelehnte Freigaben erhalten
insert into public.approvals(owner_id, lead_id, action, state, reason, decided_at, decided_by)
  select l.owner_id, l.id, 'DEMO_CREATE', 'REJECTED', 'Übernommen: früher übersprungen', now(), 'user' from public.leads l where l.demo_decision = 'skipped';
