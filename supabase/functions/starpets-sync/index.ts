// Price Watch: read public marketplace HTML and extract prices explicitly shown in RUB.
// This does not call hidden/private endpoints or bypass access controls.
const CACHE_TABLE = "starpets_catalog_cache";
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ITEMS = 2500;
const SOURCES = [
  { url: "https://tradly.gg/catalog", label: "Tradly MM2 catalog" },
  { url: "https://rayara.ru/bazaar/game/murder-mystery-2", label: "RAYARA MM2" },
  { url: "https://gemx.store/", label: "GemX" },
];
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Max-Age": "86400" };
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }); }
function decode(s: string) { return s.replace(/&nbsp;|&#160;|&#xA0;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))); }
function cleanText(s: string) { return decode(s.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(); }
function norm(s: string) { return s.toLowerCase().replace(/\bchroma\b/g, " ").replace(/[’']/g, "").replace(/[^a-z0-9]+/g, "").trim(); }
function priceValue(raw: string): number | null { let s = raw.replace(/&nbsp;|&#160;|&#xA0;/gi, " ").replace(/\u00a0/g, " ").replace(/\s/g, "").replace(/^(?:от|от:)/i, "").replace(/(?:₽|руб(?:лей|ля|ль)?\.?)/gi, ""); if (!/\d/.test(s)) return null; if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, ""); else s = s.replace(",", "."); const n = Number(s); return Number.isFinite(n) && n > 0 && n < 1e9 ? n : null; }
function absUrl(raw: string, base: string) { try { return new URL(raw, base).href; } catch { return ""; } }
function lastCapture(html: string, re: RegExp, minPos = 0): string { re.lastIndex = 0; let result = ""; let m: RegExpExecArray | null; while ((m = re.exec(html))) if (m.index >= minPos) result = m[1] ?? m[0]; return result; }
function extractHtmlPrices(raw: string, pageUrl: string) {
  const html = decode(raw), out = new Map<string, Record<string, unknown>>();
  const priceRe = /(?:от\s*)?\d[\d\s\u00a0.,]{0,18}\s*(?:₽|руб(?:лей|ля|ль)?\.?)/giu; let m: RegExpExecArray | null;
  while ((m = priceRe.exec(html)) && out.size < MAX_ITEMS) {
    const price = priceValue(m[0]); if (price === null) continue;
    const end = m.index, start = Math.max(0, end - 2600), window = html.slice(start, end);
    const heading = lastCapture(window, /<h[2-6]\b[^>]*>([\s\S]*?)<\/h[2-6]>/gi);
    const alt = lastCapture(window, /\balt\s*=\s*["']([^"']{2,120})["']/gi);
    const attr = lastCapture(window, /\b(?:data-name|aria-label|title)\s*=\s*["']([^"']{2,120})["']/gi);
    let name = cleanText(heading || alt || attr || "");
    const lastHeadingPos = Math.max(window.lastIndexOf("</h2>"), window.lastIndexOf("</h3>"), window.lastIndexOf("</h4>"), window.lastIndexOf("</h5>"), window.lastIndexOf("</h6>"));
    const altAfter = lastCapture(window, /\balt\s*=\s*["']([^"']{2,120})["']/gi, Math.max(0, lastHeadingPos));
    if (altAfter) name = cleanText(altAfter);
    if (!name || name.length > 100 || /^(catalog|all items|murder mystery 2|mm2|items|products|price|купить|каталог)$/i.test(name)) continue;
    const key = norm(name); if (key.length < 2) continue;
    const imgRaw = lastCapture(window, /<img\b[^>]*?\b(?:src|data-src|data-lazy-src)\s*=\s*["']([^"']+)["']/gi, Math.max(0, lastHeadingPos));
    const entry = { name, price, currency: "RUB", chroma: /\bchroma\b/i.test(name), type: "MM2", image: imgRaw ? absUrl(imgRaw, pageUrl) || null : null, url: pageUrl, source: new URL(pageUrl).hostname };
    const prev = out.get(key); if (!prev || price < Number(prev.price)) out.set(key, entry);
  }
  return [...out.values()];
}
function extractJsonPrices(raw: string, pageUrl: string) {
  const html = decode(raw), out = new Map<string, Record<string, unknown>>();
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi; let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[1], body = m[2].trim(); if (!body || body.length > 12_000_000) continue;
    if (!/application\/(?:ld\+json|json)|__NEXT_DATA__|__NUXT__|INITIAL_STATE|dehydratedState/i.test(attrs + body.slice(0, 500))) continue;
    let root: unknown; try { root = JSON.parse(body); } catch { const a = body.indexOf("{"); const b = body.lastIndexOf("}"); if (a < 0 || b <= a) continue; try { root = JSON.parse(body.slice(a, b + 1)); } catch { continue; } }
    const walk = (v: unknown, depth = 0) => {
      if (depth > 16 || out.size > MAX_ITEMS * 2 || v == null) return;
      if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
      if (typeof v !== "object") return;
      const o = v as Record<string, unknown>, name = String(o.name ?? o.title ?? o.displayName ?? o.itemName ?? "").trim();
      const offers = o.offers && typeof o.offers === "object" ? o.offers as Record<string, unknown> : {};
      const rawPrice = o.price ?? o.minPrice ?? o.salePrice ?? o.cost ?? o.amount ?? offers.price;
      const currency = String(o.currency ?? o.currencyCode ?? o.priceCurrency ?? offers.priceCurrency ?? "").toUpperCase();
      const priceString = typeof rawPrice === "string" ? rawPrice : "";
      const explicitRub = /₽|руб/i.test(priceString) || currency === "RUB" || currency === "RUR";
      const price = typeof rawPrice === "number" ? rawPrice : priceValue(priceString);
      if (name.length > 1 && name.length <= 100 && explicitRub && price !== null && price > 0) {
        const key = norm(name), imgRaw = String(o.image ?? o.imageUrl ?? o.image_url ?? o.picture ?? o.icon ?? "");
        const entry = { name, price, currency: "RUB", chroma: /\bchroma\b/i.test(name), type: "MM2", image: imgRaw ? absUrl(imgRaw, pageUrl) || null : null, url: pageUrl, source: new URL(pageUrl).hostname };
        const prev = out.get(key); if (!prev || price < Number(prev.price)) out.set(key, entry);
      }
      for (const [k, x] of Object.entries(o)) if (!/description|html|svg|translations|locales/i.test(k)) walk(x, depth + 1);
    };
    walk(root);
  }
  return [...out.values()];
}
async function fetchCatalog() {
  const errors: string[] = [];
  for (const source of SOURCES) {
    try {
      const res = await fetch(source.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; PriceWatch/1.1; public catalog reader)", "Accept": "text/html,application/xhtml+xml", "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.7" }, signal: AbortSignal.timeout(18000) });
      if (!res.ok) { errors.push(`${source.label}: HTTP ${res.status}`); continue; }
      const html = await res.text(), merged = new Map<string, Record<string, unknown>>();
      for (const item of [...extractJsonPrices(html, source.url), ...extractHtmlPrices(html, source.url)]) { const key = norm(String(item.name)), prev = merged.get(key); if (!prev || Number(item.price) < Number(prev.price)) merged.set(key, item); }
      if (merged.size >= 3) return { updatedAt: Date.now(), source: source.url, items: [...merged.values()] };
      errors.push(`${source.label}: HTML получен (${html.length} символов), распознано цен: ${merged.size}`);
    } catch (e) { errors.push(`${source.label}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  throw new Error("Не удалось извлечь рублёвые цены из публичных страниц. " + errors.join("; "));
}
async function readCache(url: string, key: string) { const res = await fetch(`${url}/rest/v1/${CACHE_TABLE}?id=eq.1&select=payload,updated_at`, { headers: { apikey: key, Authorization: `Bearer ${key}` } }); if (!res.ok) throw new Error(`Supabase cache read ${res.status}`); const rows = await res.json(); return Array.isArray(rows) && rows.length ? rows[0] : null; }
async function writeCache(url: string, key: string, payload: Record<string, unknown>) { const res = await fetch(`${url}/rest/v1/${CACHE_TABLE}?on_conflict=id`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([{ id: 1, updated_at: new Date().toISOString(), payload }]) }); if (!res.ok) throw new Error(`Supabase cache write ${res.status}`); }
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL"), serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ error: "В Edge Function не найдены системные переменные Supabase" }, 500);
  let cached: Record<string, unknown> | null = null;
  try { cached = await readCache(supabaseUrl.replace(/\/+$/, ""), serviceKey); if (cached?.payload && cached?.updated_at) { const age = Date.now() - new Date(String(cached.updated_at)).getTime(), payload = cached.payload as Record<string, unknown>; if (age >= 0 && age < CACHE_TTL_MS && Array.isArray(payload.items)) return json({ ...payload, updatedAt: new Date(String(cached.updated_at)).getTime(), cached: true }); } } catch (e) { console.error("Cache read warning", e); }
  try { const payload = await fetchCatalog(); try { await writeCache(supabaseUrl.replace(/\/+$/, ""), serviceKey, payload); } catch (e) { console.error("Cache write warning", e); } return json({ ...payload, cached: false }); }
  catch (e) { const message = e instanceof Error ? e.message : String(e); if (cached?.payload && Array.isArray((cached.payload as Record<string, unknown>).items)) return json({ ...(cached.payload as Record<string, unknown>), updatedAt: new Date(String(cached.updated_at)).getTime(), cached: true, stale: true, warning: message }); return json({ error: message }, 502); }
});
