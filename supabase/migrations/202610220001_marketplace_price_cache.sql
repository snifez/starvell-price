-- Shared marketplace prices for all visitors.
create table if not exists public.marketplace_price_cache (
  item_key text primary key,
  item_name text not null,
  median_rub numeric(14,2) not null check (median_rub > 0),
  low_rub numeric(14,2) not null check (low_rub > 0),
  high_rub numeric(14,2) not null check (high_rub >= low_rub),
  offers jsonb not null default '[]'::jsonb,
  source_counts jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists marketplace_price_cache_updated_at_idx
  on public.marketplace_price_cache (updated_at desc);
alter table public.marketplace_price_cache enable row level security;
-- Visitors may read shared prices, but only the Edge Function service role writes them.
drop policy if exists "Public can read shared marketplace prices" on public.marketplace_price_cache;
create policy "Public can read shared marketplace prices"
  on public.marketplace_price_cache for select to anon, authenticated using (true);
revoke insert, update, delete on public.marketplace_price_cache from anon, authenticated;
grant select on public.marketplace_price_cache to anon, authenticated;
