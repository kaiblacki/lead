-- Phase F: manuelle Zahlungsbestätigung (keine eigenmächtige Zahlungsintegration) und ausdrückliche Veröffentlichungsfreigabe.
alter table public.payments add column if not exists reference text check (reference is null or char_length(reference) <= 200), add column if not exists confirmed_by text;
alter table public.orders add column if not exists deploy_approved_at timestamptz;
