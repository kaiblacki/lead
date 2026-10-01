-- Lokale Akquise-Pipeline: Suchgrößen, Laufstatus/-kosten, Dedupe, Priorität A–D, Notizen, Website-Module.

alter table public.lead_runs
  add column if not exists size text check (size in ('SMALL','MEDIUM','LARGE')),
  add column if not exists search_term text,
  add column if not exists requested_count int,
  add column if not exists found_count int,                       -- tatsächlich gespeicherte (deduplizierte) Leads
  add column if not exists raw_count int,                         -- Roh-Treffer aller Quellen vor Dedupe
  add column if not exists started_at timestamptz not null default now(),
  add column if not exists phase text not null default 'queued' check (phase in ('queued','discovering','enriching','analyzing','complete','partial','failed')),
  add column if not exists sources jsonb not null default '[]',
  add column if not exists costs jsonb not null default '{}',     -- Cent: osm, web_search, ai, demo, total
  add column if not exists errors jsonb not null default '[]';

alter table public.leads
  add column if not exists auto_priority text check (auto_priority in ('A','B','C','D')),
  add column if not exists manual_priority text check (manual_priority in ('A','B','C','D')),
  add column if not exists effective_priority text check (effective_priority in ('A','B','C','D')),
  add column if not exists priority_reason text,
  add column if not exists priority_updated_at timestamptz,
  add column if not exists demo_family text check (demo_family in ('SERVICE','APPOINTMENT','GASTRO_RETAIL')),
  add column if not exists modules_recommended jsonb not null default '[]',
  add column if not exists modules_selected jsonb,                 -- null = noch nicht gewählt (dann gilt die Empfehlung)
  add column if not exists review_flag text;                        -- z. B. 'possible_duplicate'
alter table public.leads drop constraint if exists leads_demo_decision_check;
alter table public.leads add constraint leads_demo_decision_check check (demo_decision in ('skipped','recommended'));
create index if not exists leads_priority_idx on public.leads(owner_id, effective_priority);

-- Notizen von Kai (getrennt von den automatischen System-/KI-Hinweisen)
create table public.lead_notes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  body text not null default '' check (char_length(body) <= 20000),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (lead_id)
);

-- Weitere Quellen-Kennungen eines zusammengeführten Leads (damit derselbe Betrieb später nicht erneut als neuer Lead erscheint)
create table public.lead_aliases (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  source text not null, source_ref text not null, created_at timestamptz not null default now(),
  unique (owner_id, source, source_ref)
);

-- Mögliche Dubletten zur manuellen Prüfung (nie automatisch zerstörerisch zusammengeführt)
create table public.lead_match_candidates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  other_lead_id uuid not null references public.leads(id) on delete cascade,
  score int not null, reasons jsonb not null default '[]',
  status text not null default 'open' check (status in ('open','merged','dismissed')),
  created_at timestamptz not null default now(), resolved_at timestamptz,
  unique (lead_id, other_lead_id)
);

do $$ declare t text; begin
  foreach t in array array['lead_notes','lead_aliases','lead_match_candidates'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('create policy "owner all" on public.%I for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t);
  end loop;
end $$;

-- Standard-Limits so, dass auch eine LARGE-Suche (500 Firmen) ohne Anpassung durchläuft (bestehende Einstellungen bleiben unverändert)
alter table public.budgets alter column max_leads_per_run set default 500, alter column max_audits_per_run set default 500, alter column max_crawl_pages_per_run set default 4000;
