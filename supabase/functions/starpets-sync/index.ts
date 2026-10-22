// Public Russian-marketplace HTML scraper. Prices are accepted only when explicitly shown in RUB (₽).
// No private endpoints or third-party catalog API are used. Legacy function name is kept for compatibility. The site may change its HTML at any time.
const CACHE_TABLE = "starpets_catalog_cache";
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ITEMS = 2500;
const PAGES = [
  "https://rayara.ru/bazaar/game/murder-mystery-2",
  "https://gemx.store/",
];
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
function norm(v: unknown) { return String(v ?? "").trim().toLowerCase().replace(/\bchroma\b/g, " ").replace(/[^a-z0-9]+/g, "").trim(); }
function decode(s: string) { return s.replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/\\u0026/gi,"&").replace(/\\u003c/gi,"<").replace(/\\u003e/gi,">").replace(/\\\//g,"/"); }
function toPrice(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s/g,"").replace(/[€$₽]/g,"");
  if (!s || !/\d/.test(s)) return null;
  const normalized = s.includes(",") && s.includes(".") ? (s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g,"").replace(",", ".") : s.replace(/,/g,"")) : s.replace(",", ".");
  const n = Number(normalized); return Number.isFinite(n) && n >= 0 && n < 1e9 ? n : null;
}
function collectObjects(root: unknown, out: Record<string, unknown>[], depth = 0) {
  if (depth > 18 || out.length >= MAX_ITEMS * 4 || root == null) return;
  if (Array.isArray(root)) { for (const v of root) collectObjects(v, out, depth + 1); return; }
  if (typeof root !== "object") return;
  const o = root as Record<string, unknown>;
  const name = o.name ?? o.title ?? o.displayName ?? o.itemName;
  const price = o.price ?? o.minPrice ?? o.salePrice ?? o.cost ?? o.amount;
  if (typeof name === "string" && name.trim().length > 1 && typeof price === "string" && /₽|руб/i.test(price) && toPrice(price) !== null) out.push(o);
  for (const [k,v] of Object.entries(o)) if (!/description|html|svg|translations|locales/i.test(k)) collectObjects(v, out, depth + 1);
}
function fromHtml(htmlRaw: string, pageUrl: string) {
  const html = decode(htmlRaw);
  const candidates: Record<string, unknown>[] = [];
  // JSON blobs commonly used by React/Vue/Next/Nuxt storefronts.
  const scripts = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const tag of scripts) {
    const body = tag.replace(/^<script\b[^>]*>/i, "").replace(/<\/script>$/i, "").trim();
    if (!body || body.length > 15_000_000) continue;
    const type = /type=["']application\/ld\+json["']/i.test(tag);
    const likely = type || /__NEXT_DATA__|__NUXT__|__INITIAL_STATE__|__APOLLO_STATE__|dehydratedState|products|items|catalog|store/i.test(tag);
    if (!likely) continue;
    try { collectObjects(JSON.parse(body), candidates); } catch { /* scripts may be JS rather than strict JSON */ }
    // Some sites assign a JSON object to a global variable.
    const start = body.indexOf("{"); const end = body.lastIndexOf("}");
    if (start >= 0 && end > start && end - start < 12_000_000) {
      try { collectObjects(JSON.parse(body.slice(start, end + 1)), candidates); } catch { /* ignore non-JSON script */ }
    }
  }
  // Also inspect HTML product-card elements with embedded attributes and text.
  const cards = html.match(/<(?:article|li|div)\b[^>]*(?:product|item-card|catalog-item)[^>]*>[\s\S]{0,9000}?<\/(?:article|li|div)>/gi) ?? [];
  for (const card of cards) {
    const name = card.match(/(?:data-name|aria-label|alt)=["']([^"']{2,100})["']/i)?.[1] ?? card.match(/<h[1-6]\b[^>]*>([\s\S]{2,120}?)<\/h[1-6]>/i)?.[1]?.replace(/<[^>]+>/g, " ");
    const priceText = card.match(/(?:data-price|data-amount)=["']([^"']*₽[^"']*)["']/i)?.[1] ?? card.match(/\d[\d\s\u00a0]*(?:[.,]\d{1,2})?\s*₽|₽\s*\d[\d\s\u00a0]*(?:[.,]\d{1,2})?/i)?.[0];
    const price = toPrice(priceText);
    if (name && price !== null && /₽|руб/i.test(priceText || "")) candidates.push({ name: decode(name).trim(), price, url: pageUrl, image: card.match(/<img\b[^>]*(?:src|data-src)=["']([^"']+)["']/i)?.[1] });
  }
  const merged = new Map<string, Record<string, unknown>>();
  for (const o of candidates) {
    const rawName = String(o.name ?? o.title ?? o.displayName ?? o.itemName ?? "").trim().replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const price = toPrice(o.price ?? o.minPrice ?? o.salePrice ?? o.cost ?? o.amount);
    if (!rawName || price === null || rawName.length > 100 || /^(price|catalog|mm2 market|market)$/i.test(rawName)) continue;
    const key = norm(rawName) + "|" + (/\bchroma\b/i.test(rawName) ? "1" : "0");
    if (!key || key === "|0") continue;
    const imageRaw = String(o.image ?? o.imageUrl ?? o.image_url ?? o.picture ?? o.icon ?? "");
    let image = "";
    try { if (imageRaw) image = new URL(imageRaw, pageUrl).href; } catch {}
    const entry = { name: rawName, price, chroma: /\bchroma\b/i.test(rawName), rarity: String(o.rarity ?? o.rare ?? "").toLowerCase(), type: String(o.type ?? o.category ?? "MM2"), currency: "RUB", image: image || null, url: String(o.url ?? o.href ?? pageUrl).startsWith("http") ? String(o.url ?? o.href ?? pageUrl) : new URL(String(o.url ?? o.href), pageUrl).href };
    const old = merged.get(key); if (!old || price < Number(old.price)) merged.set(key, entry);
  }
  return [...merged.values()];
}
async function fetchCatalog() {
  const errors: string[] = [];
  for (const url of PAGES) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; PriceWatch/1.0)", "Accept": "text/html,application/xhtml+xml", "Accept-Language": "ru,en;q=0.8" }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) { errors.push(`${new URL(url).hostname}: HTTP ${res.status}`); continue; }
      const html = await res.text();
      const items = fromHtml(html, url);
      if (items.length >= 3) return { updatedAt: Date.now(), source: url, items };
      errors.push(`${new URL(url).hostname}: HTML получен (${html.length} символов), цены не найдены — вероятно, каталог создаётся JavaScript-кодом`);
    } catch (e) { errors.push(`${new URL(url).hostname}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  throw new Error("Не удалось извлечь рублёвые цены из HTML публичных страниц. " + errors.join("; "));
}
async function readCache(url: string, key: string) {
  const res = await fetch(`${url}/rest/v1/${CACHE_TABLE}?id=eq.1&select=payload,updated_at`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Supabase cache read ${res.status}`); const rows = await res.json(); return Array.isArray(rows) && rows.length ? rows[0] : null;
}
async function writeCache(url: string, key: string, payload: Record<string, unknown>) {
  const res = await fetch(`${url}/rest/v1/${CACHE_TABLE}?on_conflict=id`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([{ id: 1, updated_at: new Date().toISOString(), payload }]) });
  if (!res.ok) throw new Error(`Supabase cache write ${res.status}`);
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL"), serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ error: "В Edge Function не найдены переменные Supabase" }, 500);
  let cached: Record<string, unknown> | null = null;
  try {
    cached = await readCache(supabaseUrl.replace(/\/+$/, ""), serviceKey);
    if (cached?.payload && cached?.updated_at) {
      const age = Date.now() - new Date(String(cached.updated_at)).getTime(), payload = cached.payload as Record<string, unknown>;
      if (age >= 0 && age < CACHE_TTL_MS && Array.isArray(payload.items)) return json({ ...payload, updatedAt: new Date(String(cached.updated_at)).getTime(), cached: true });
    }
  } catch (e) { console.error("Cache read warning", e); }
  try {
    const payload = await fetchCatalog();
    try { await writeCache(supabaseUrl.replace(/\/+$/, ""), serviceKey, payload); } catch (e) { console.error("Cache write warning", e); }
    return json({ ...payload, cached: false });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (cached?.payload && Array.isArray((cached.payload as Record<string, unknown>).items)) return json({ ...(cached.payload as Record<string, unknown>), updatedAt: new Date(String(cached.updated_at)).getTime(), cached: true, stale: true, warning: message });
    return json({ error: message }, 502);
  }
});
