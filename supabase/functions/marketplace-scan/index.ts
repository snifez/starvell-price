// Price Watch — public MM2 marketplace scanner.
// Reads public HTML only; does not bypass login, CAPTCHA, or anti-bot controls.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const FUNPAY_CATEGORY = "https://funpay.com/lots/925/";
const PLAYEROK_SEARCH = "https://playerok.com/products?search=";
const STARVELL_CATEGORIES = ["knives","guns","sets","pets","misc"].map(x => `https://starvell.com/roblox/mm2/${x}`);
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; PriceWatch/1.0; public listing reader)",
  "Accept": "text/html,application/xhtml+xml",
  "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.7",
};
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
function decode(s: string) {
  return s.replace(/&nbsp;|&#160;|&#xA0;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}
function text(s: string) {
  return decode(s.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim();
}
function norm(s: string) {
  return s.normalize("NFKC").toLowerCase().replace(/\bchroma\b/g, " chroma ")
    .replace(/[^a-zа-яё0-9]+/gi, " ").trim().replace(/\s+/g, " ");
}
function money(s: string): number | null {
  // Accept only prices explicitly labelled in rubles; never guess currency from a bare number.
  const m = s.match(/(?:₽|руб(?:лей|ля|ль)?\.?|RUB)\s*([\d\s\u00a0.,]+)|([\d\s\u00a0.,]+)\s*(?:₽|руб(?:лей|ля|ль)?\.?|RUB)/i);
  if (!m) return null;
  let v = (m[1] || m[2] || "").replace(/[\s\u00a0]/g, "");
  if (v.includes(",") && v.includes(".")) v = v.lastIndexOf(",") > v.lastIndexOf(".") ? v.replace(/\./g, "").replace(",", ".") : v.replace(/,/g, "");
  else v = v.replace(",", ".");
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 1e8 ? n : null;
}
function blocked(s: string) {
  return /\b(аккаунт|account|акк|набор|bundle|пакет|комплект|лотом|лотами|set of|full set|инвентарь|inventory|robux|робукс)\b/i.test(s);
}
function nameMatches(title: string, wanted: string) {
  const a = norm(title), b = norm(wanted);
  if (!a || !b) return false;
  return a === b || ((" " + a + " ").includes(" " + b + " ")) ||
    (b.split(" ").filter(x => x.length > 2).length > 0 &&
      b.split(" ").filter(x => x.length > 2).every(token => (" " + a + " ").includes(" " + token + " ")));
}
async function getHtml(url: string) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(9000), redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status} (${new URL(url).hostname})`);
  const html = await r.text();
  if (!html || html.length < 300) throw new Error(`Пустая или слишком короткая страница (${new URL(url).hostname})`);
  return html;
}
function anchors(html: string, base: string, source: "FunPay" | "PlayerOK" | "Starvell", wanted: string) {
  const out: Array<Record<string, unknown>> = [];
  // Match product cards and read title/price from the card itself, never from neighbouring cards.
  const re = /<a\b([^>]*\bhref\s*=\s*(["'])(.*?)\2[^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 1500) {
    const attrs = m[1], rawUrl = m[3], body = m[4];
    let url = "";
    try { url = new URL(rawUrl, base).href; } catch { continue; }
    if (source === "FunPay" ? !/funpay\.com\/lots\/offer\?id=\d+/i.test(url) : source === "PlayerOK" ? !/playerok\.com\/products\//i.test(url) : !/starvell\.com\/roblox\/mm2\//i.test(url) || /\/(?:knives|guns|sets|pets|misc)\/?(?:\?|$)/i.test(url)) continue;

    const titleAttr = attrs.match(/\b(?:title|aria-label)\s*=\s*(["'])(.*?)\1/i)?.[2] || "";
    const titleNode = body.match(/<[^>]*class=["'][^"']*(?:tc-desc-text|product-card__title|product-title)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1] || "";
    const imgAlt = body.match(/<img\b[^>]*\balt\s*=\s*(["'])(.*?)\1/i)?.[2] || "";
    const bodyText = text(body);
    const title = text(titleAttr || titleNode || imgAlt || bodyText).slice(0, 180);
    // Exclude accounts/bundles by the item title, not the seller/card's unrelated surrounding text.
    if (!title || blocked(title) || !nameMatches(title, wanted)) continue;

    let price: number | null = null;
    if (source === "FunPay") {
      const priceNode = body.match(/<[^>]*class=["'][^"']*(?:tc-price|tc-amount)[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/i)?.[0] || "";
      const priceText = text(priceNode);
      const dataS = priceNode.match(/\bdata-s\s*=\s*(["'])([\d.,]+)\1/i)?.[2];
      // FunPay's RUB category renders prices in rubles; prefer its numeric amount attribute.
      if (dataS) {
        const n = Number(dataS.replace(",", "."));
        if (Number.isFinite(n) && n > 0 && n < 1e8) price = n;
      }
      if (price === null) price = money(priceText);
    } else {
      // PlayerOK results are accepted only when actual product-card HTML is present.
      const priceNode = body.match(/<[^>]*class=["'][^"']*(?:price|amount)[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/i)?.[0] || "";
      price = money(text(priceNode || bodyText));
    }
    if (price === null || price <= 0) continue;

    const imgMatch = body.match(/<img\b[^>]*(?:src|data-src|data-original)\s*=\s*(["'])(.*?)\1/i);
    let image = "";
    try {
      const parsed = new URL(imgMatch?.[2] || "", base);
      if (parsed.protocol === "https:" && !/avatar|logo|emoji|icon/i.test(parsed.href)) image = parsed.href;
    } catch { /* no usable listing image */ }
    out.push({ name: title, price, currency: "RUB", marketplace: source, url, image, sourceUrl: base });
  }
  const seen = new Set<string>();
  return out.filter(x => {
    const key = String(x.url) + "|" + String(x.price);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
function median(nums: number[]) {
  const a = [...nums].sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round(((a[mid - 1] + a[mid]) / 2) * 100) / 100;
}
async function scanOne(name: string, categoryHtml: string | null, funpayError: string | null, starvellPages: Array<{url:string;html:string|null;error:string|null}>) {
  const offers: Array<Record<string, unknown>> = [], errors: string[] = [];
  if (categoryHtml) {
    const found = anchors(categoryHtml, FUNPAY_CATEGORY, "FunPay", name);
    offers.push(...found);
    if (!found.length) errors.push("FunPay: страница получена, но подходящий лот не найден в HTML; полный каталог не гарантирован");
  } else errors.push(`FunPay: ${funpayError || "страница раздела недоступна"}`);
  try {
    const url = PLAYEROK_SEARCH + encodeURIComponent(name);
    const html = await getHtml(url);
    const found = anchors(html, url, "PlayerOK", name);
    offers.push(...found);
    if (!found.length) errors.push("PlayerOK: страница получена, но подходящий лот не найден в HTML; выдача может загружаться JavaScript");
  } catch (e) {
    errors.push(`PlayerOK: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const page of starvellPages) { if (!page.html) continue; offers.push(...anchors(page.html, page.url, "Starvell", name)); }
  if (!offers.some(o => o.marketplace === "Starvell")) errors.push("Starvell: подходящий лот не найден в загруженных публичных категориях; динамические карточки могут быть недоступны");
  const unique = [...new Map(offers.map(o => [`${o.marketplace}|${o.url}|${o.price}`, o])).values()];
  const prices = unique.map(o => Number(o.price)).filter(n => Number.isFinite(n) && n > 0);
  return {
    name, offers: unique, count: unique.length,
    byMarketplace: { FunPay: unique.filter(o => o.marketplace === "FunPay").length, Starvell: unique.filter(o => o.marketplace === "Starvell").length, PlayerOK: unique.filter(o => o.marketplace === "PlayerOK").length },
    medianRub: median(prices), updatedAt: new Date().toISOString(), errors,
  };
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method === "GET") return response({
    ok: true, service: "price-watch-marketplace-scan",
    usage: "POST JSON { items: ['Gingerscope', 'Harvester'] }",
    limitations: "Scans public HTML from FunPay, Starvell MM2 categories and PlayerOK; dynamic, paginated or blocked listings may be missed.",
  });
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);
  let body: unknown;
  try { body = await req.json(); } catch { return response({ error: "Ожидается JSON в теле запроса" }, 400); }
  const raw = (body as { items?: unknown })?.items;
  if (!Array.isArray(raw) || raw.length < 1) return response({ error: "Передай массив items, например ['Gingerscope']" }, 400);
  if (raw.length > 80) return response({ error: "За один запрос можно проверить не более 80 предметов" }, 400);
  const items = [...new Set(raw.map(x => String(x ?? "").trim()).filter(x => x.length > 1 && x.length <= 100 && !blocked(x)))];
  if (!items.length) return response({ error: "Нет корректных названий предметов после фильтрации" }, 400);
  let categoryHtml: string | null = null, funpayError: string | null = null;
  try { categoryHtml = await getHtml(FUNPAY_CATEGORY); } catch (e) { funpayError = e instanceof Error ? e.message : String(e); }
  const starvellPages = await Promise.all(STARVELL_CATEGORIES.map(async url => { try { return { url, html: await getHtml(url), error: null }; } catch (e) { return { url, html: null, error: e instanceof Error ? e.message : String(e) }; } }));
  const results: Array<Record<string, unknown>> = [];
  for (let i = 0; i < items.length; i += 3) {
    const batch = items.slice(i, i + 3);
    const part = await Promise.all(batch.map(name => scanOne(name, categoryHtml, funpayError, starvellPages)));
    results.push(...part);
  }
  return response({
    ok: true, updatedAt: new Date().toISOString(), itemCount: results.length,
    sourceStatus: { FunPay: categoryHtml ? "page fetched" : `unavailable: ${funpayError}`, Starvell: `${starvellPages.filter(p => p.html).length}/${starvellPages.length} category pages fetched`, PlayerOK: "queried per item; see individual errors" },
    results,
    note: "Результат отражает только подходящие публичные лоты, найденные в HTML. Нулевое число объявлений не доказывает отсутствие лотов.",
  });
});
