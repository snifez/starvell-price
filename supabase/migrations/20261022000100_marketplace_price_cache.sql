-- Shared marketplace prices written only by the marketplace-scan Edge Function.
create table if not exists public.marketplace_price_cache (
  item_key text primary key,
  item_name text not null,
  median_rub numeric(14,2) not null check (median_rub > 0),
  low_rub numeric(14,2),
  high_rub numeric(14,2),
  offers jsonb not null default '[]'::jsonb,
  source_counts jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint marketplace_price_cache_range_check
    check (low_rub is null or high_rub is null or low_rub <= high_rub)
);

create index if not exists marketplace_price_cache_updated_at_idx
  on public.marketplace_price_cache (updated_at desc);

alter table public.marketplace_price_cache enable row level security;

-- No anon/authenticated policies: the Edge Function accesses this table with
-- SUPABASE_SERVICE_ROLE_KEY; browser clients read cached values through that function.
