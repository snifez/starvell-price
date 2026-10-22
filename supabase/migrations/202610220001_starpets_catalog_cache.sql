-- Private cache for the StarPets catalog. Access is performed only by the Edge Function
-- using the service role key; no public policies are created.
create table if not exists public.starpets_catalog_cache (
  id integer primary key check (id = 1),
  updated_at timestamptz not null default now(),
  payload jsonb not null
);

alter table public.starpets_catalog_cache enable row level security;
revoke all on table public.starpets_catalog_cache from anon, authenticated;
