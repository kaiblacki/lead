-- Manuell bearbeitete Gesprächseinstiege erlauben, Index für Listenansicht.
alter table public.sales_packages drop constraint if exists sales_packages_opener_source_check;
alter table public.sales_packages add constraint sales_packages_opener_source_check check (opener_source in ('template','ai','manual'));
create index if not exists leads_owner_status_idx on public.leads(owner_id, status);
create index if not exists opportunities_lead_idx on public.opportunities(lead_id, created_at desc);
create index if not exists audits_lead_idx on public.audits(lead_id, created_at desc);
create index if not exists sales_packages_lead_idx on public.sales_packages(lead_id, created_at desc);
