-- Providerkosten eindeutig mit Währung: USD-Kosten des Anbieters (z. B. Brave: 5 USD / 1.000 Anfragen) werden getrennt vom internen EUR-Budget gespeichert.
alter table public.enrichment_log
  add column if not exists provider_cost_amount numeric(14,6) not null default 0,
  add column if not exists provider_cost_currency text not null default 'EUR' check (provider_cost_currency in ('USD','EUR')),
  add column if not exists fx_eur_per_usd numeric(10,6);
comment on column public.enrichment_log.cost_cents is 'EUR-Cent (umgerechnet) – Grundlage für das interne Enrichment-Budget';
comment on column public.enrichment_log.provider_cost_amount is 'Kosten laut Anbieter in provider_cost_currency (Betrag, keine Cent)';
-- bisherige Zeilen wurden in EUR-Cent geführt
update public.enrichment_log set provider_cost_amount = cost_cents / 100, provider_cost_currency = 'EUR' where cost_cents > 0 and provider_cost_amount = 0;
alter table public.enrichment_log drop constraint if exists enrichment_log_outcome_check;
