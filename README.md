# Price Watch — GitHub Pages + Supabase + StarPets MM2

The frontend is a static `index.html` for GitHub Pages. StarPets data is fetched through the existing Supabase Edge Function `starpets-sync`; public marketplace scanning uses the separate `marketplace-scan` function. The existing `starpets-sync` function must not be replaced.

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

- The function tries public HTML pages from Tradly, RAYARA, and GemX, extracting only prices explicitly marked in rubles (₽/руб.) or structured data marked RUB. It does not call hidden/private endpoints or bypass access controls. Page markup may change, so verify the endpoint after deployment; if extraction fails, it returns a clear error and serves an existing cache if available.
- Prices are treated as RUB and remain separate from the existing manual price estimates.
- Item matching is based on normalized names and Chroma variants, so check matches for similarly named items.
- The SQL migration is intentionally not run automatically by GitHub Actions. Run it once in Supabase SQL Editor before testing the function.


## Currency and marketplace images

- All catalog price fields are shown in Russian rubles (₽).
- StarPets source prices are USD, so the frontend converts them to RUB using the public USD/RUB exchange-rate endpoint. If the exchange rate cannot be loaded, the StarPets price is shown as unavailable rather than displayed in dollars or converted using a made-up rate.
- Item images are centered in their cards. The frontend prefers the image returned by StarPets and may use an image returned with a marketplace listing as a fallback.
- The marketplace scanner shows only public listings that its HTML parser can actually extract. A health-check response proves the function is responding, not that every listing was found. Dynamic pages, anti-bot responses, pagination, and site changes can cause missed listings.

## Deploy marketplace-scan

The function's source should be kept at `supabase/functions/marketplace-scan/index.ts`. `supabase/config.toml` now includes `verify_jwt = false` for this function while preserving the existing `starpets-sync` configuration. Deploy only `marketplace-scan`; do not overwrite `starpets-sync`.

With Supabase CLI installed and linked to this project, deploy:

```sh
supabase functions deploy marketplace-scan --no-verify-jwt
```

Then test the GET health endpoint:

`https://jmahfpaxurmsamxbtvzj.supabase.co/functions/v1/marketplace-scan`

For an actual scan, send a POST request with JSON such as `{"items":["Gingerscope"]}`. A successful health check alone does not verify listing extraction.

## Robux: цена по Starvell (медиана)

- Запрос `marketplace-scan` с `{"items":["1000 Robux","1200 Robux"],"context":"robux"}` (до 15 позиций) делает один проход по категории Robux на Starvell. Остальные площадки для Robux пропускаются (`skipped`).
- Для каждого количества берутся лоты Starvell именно на это количество (если их 3 и больше). Иначе лоты соседних размеров (от N/2 до 2N) пересчитываются по курсу ₽ за Robux. Выбросы отсекаются по IQR. Лоты с ценой «за 1 Robux» и продажа аккаунтов в расчёт не входят.
- Если лотов недостаточно, медианы нет: сайт показывает старый диапазон с пометкой «медианы Starvell ещё нет». Цена не выдумывается.
- Позиции «1 000 Robux» и «1000 Robux» в списке объединены в одну.
- Автообновление цен раз в 2 минуты отключено: оно быстро исчерпывало бесплатную квоту Parse (200 кредитов в месяц) и давало HTTP 429. Лоты обновляются кнопкой «↻ Лоты» (Robux или MM2 — по текущему списку) или из панели «Поиск лотов». Общий кэш в Supabase доступен всем посетителям.
- После обновления нужно заново задеплоить функцию: `supabase functions deploy marketplace-scan --no-verify-jwt` (или push — сработает workflow).
