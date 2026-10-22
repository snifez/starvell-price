# Marketplace API adapters

The scanner no longer parses marketplace HTML. It uses structured JSON adapters hosted by Parse for FunPay and Starvell, then stores valid offers and price summaries in the shared Supabase table `public.marketplace_price_cache`.

## Free setup required

These marketplace wrappers are third-party APIs, not official APIs from the marketplaces. Parse advertises a free tier of 200 credits/month and a rate limit of 5 requests/minute. It requires an API key, so scanning is not active until a key is configured.

1. Create a free Parse account and obtain an API key: https://parse.bot/
2. In the Supabase project `jmahfpaxurmsamxbtvzj`, add the Edge Function secret `PARSE_API_KEY`. Do not put the key in `index.html`, source control, or a public variable.
3. Apply `supabase/migrations/202610220001_marketplace_price_cache.sql` in the Supabase SQL Editor.
4. Push the branch / wait for the GitHub Actions workflow `Deploy marketplace-scan` to finish. The repository also needs the existing GitHub Actions secret `SUPABASE_ACCESS_TOKEN`.

## Scope and limitations

- Active adapters: FunPay, Starvell and PlayerOK (via Parse, MM2/Roblox categories only) and Plati.market (public JSON search `plati.io/api/search.ashx`, no key, any game; unofficial, so its format may change).
- GGSEL and Tradly are shown as «не подключён»: no public search API for third-party apps was confirmed. No HTML fallback is used.
- Errors 429/500/502/503/504 and timeouts are retried up to 3 times with backoff. If a source still fails, it is reported as `unavailable` with its HTTP code, never as «no lots».
- `no_matching_offers` means «N lots were scanned, none matched». It is not proof that no lot exists.
- Request body: `{items:[...≤6], context:"mm2"|"generic"}`. For `generic` only Plati is queried, the other sources are `skipped`.
- Gingerscope quotes below 26 000 ₽ are discarded on the server and in the UI.
- A source may return no matching offers or become unavailable. The scanner reports this rather than inventing a price.
- Shared prices are updated only when at least one real, valid RUB offer is found. Existing shared prices are not overwritten by empty results.
- The free API quota is limited. Avoid repeatedly running a full-catalog scan; prefer selected-item scans and refresh only what is needed.
- Supabase migration and secret configuration are external project settings and cannot be completed by a Git commit alone.
