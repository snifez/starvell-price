# Marketplace API scanner setup

The scanner no longer parses marketplace HTML. It uses structured API adapters for FunPay, Starvell and PlayerOK and only stores prices that came from returned offers. Each scan batch now fetches each source/category listing once where possible and matches the requested item names locally, reducing duplicate API calls.

## Free-tier constraint

The current adapters use Parse.bot as a structured third-party API provider, not an official marketplace API. Its published free tier is limited to 200 credits/month and 5 requests/minute; each endpoint consumes credits. A free API key is required. This is not an unlimited or guaranteed-free feed. Do not add paid billing unless you intentionally change the budget.

## Required setup

1. Create a free API key with the provider and add it to Supabase Edge Function secrets as `PARSE_API_KEY`. Never put this key in `index.html` or commit it to Git.
2. Apply `supabase/migrations/20261022000100_marketplace_price_cache.sql` to the linked Supabase project. For example, from a trusted local environment with Supabase CLI configured: `supabase db push`. Review the migration before applying.
3. Deploy the Edge Function: `supabase functions deploy marketplace-scan --project-ref jmahfpaxurmsamxbtvzj --no-verify-jwt`.
4. Open `GET https://jmahfpaxurmsamxbtvzj.supabase.co/functions/v1/marketplace-scan` with the site's Supabase API key. It should return `service: price-watch-api-adapters` and the shared cache.
5. Test one item with a POST body such as `{"items":["Gingerscope"]}`. Check the response's per-source status and errors before scanning the whole catalog.

## Important behavior

- The shared price table is protected by RLS and is accessed server-side by the Edge Function.
- Only actual API offers are saved. A failed or empty search does not overwrite a previously stored price with zero or a guessed value.
- The cache is shared across visitors, but this does not automatically mean all catalog prices are refreshed: a scan must run and the APIs must return matching offers. Current adapter coverage is MM2 items in Roblox-related categories only; it is not yet a universal scanner for CS2, Rust, Dota 2, Fortnite, or every game in the site catalog.
- A third-party API response or an HTTP 200 does not prove a matching listing exists. Check `results[].offers`, `results[].errors`, and `sourceStatus`.
- The provider endpoints are not official APIs published by FunPay, Starvell, or PlayerOK. Availability, schema, rate limits, and free-tier quotas can change.
