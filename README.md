# Price Watch — GitHub Pages + Supabase + StarPets MM2

The frontend is a static `index.html` for GitHub Pages. StarPets data is fetched through a Supabase Edge Function, so the browser does not need a local Python server and GitHub Pages does not try to proxy `/api/starpets`.

## 1. Set up the Supabase cache table (once)

1. Open your Supabase project: `https://supabase.com/dashboard/project/jmahfpaxurmsamxbtvzj`.
2. Open **SQL Editor → New query**.
3. Paste and run the contents of `supabase/migrations/202610220001_starpets_catalog_cache.sql`.

The table has Row Level Security enabled and no public access policies. The Edge Function accesses it using Supabase's server-side service role key; never put a service-role/secret key into `index.html` or GitHub.

## 2. Add GitHub Actions secrets

In the GitHub repository open **Settings → Secrets and variables → Actions → New repository secret** and add:

- `SUPABASE_ACCESS_TOKEN` — create a personal access token in the Supabase dashboard account settings.
- `SUPABASE_PROJECT_ID` — project reference, currently `jmahfpaxurmsamxbtvzj` for the Supabase URL configured in `index.html`.

The token is used only by GitHub Actions to deploy the Edge Function. It is not embedded in the website.

## 3. Upload to GitHub

Put the contents of this folder at the **root** of the repository, including `index.html`, `.github/`, and `supabase/`, and push them to the `main` branch.

In GitHub open **Settings → Pages** and set **Build and deployment → Source → GitHub Actions**. The `Deploy Price Watch to GitHub Pages` workflow publishes `index.html` automatically.

The `Deploy StarPets Edge Function` workflow deploys `supabase/functions/starpets-sync/index.ts` when files in `supabase/` change. It requires the two GitHub Actions secrets above.

## 4. Test the StarPets endpoint

After the Edge Function workflow succeeds, the website will call `https://jmahfpaxurmsamxbtvzj.supabase.co/functions/v1/starpets-sync` automatically. The function is configured as public (`verify_jwt = false`) because it is called by the static website; it returns catalog data only. The database cache is private. The public endpoint is cached for 10 minutes to reduce load on the upstream service.

To test from a terminal, send a GET request with your project publishable key in the `apikey` header. A successful response should be JSON with `items` and `updatedAt. Do not use a service-role or secret key in the browser or GitHub Pages.

## Important limitations

- The function now tries to read public HTML pages on StarPets-owned domains (`starpets.gg` and `starpets.me`) and extract item names/prices from embedded JSON or product-card markup. It does not call a third-party catalog API. However, the official website may build its catalog entirely in client-side JavaScript or change its HTML; in that case scraping will return an explicit error and, if available, serve the last cached catalog. This has not been live-verified from the current runtime, so check the endpoint response after deployment.
- Prices returned by this endpoint are shown as USD and do not overwrite the app's existing RUB price estimates.
- Item matching is based on normalized names and Chroma variants, so check matches for similarly named items.
- The SQL migration is intentionally not run automatically by GitHub Actions. Run it once in Supabase SQL Editor before testing the function.
