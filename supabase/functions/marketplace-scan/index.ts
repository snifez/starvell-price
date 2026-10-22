// Price Watch — public marketplace search by exact item name.
// Reads public HTML only. Does not bypass login, CAPTCHA, anti-bot controls, or site access restrictions.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const SOURCES = [
  { name: "PlayerOK", url: (q: string) => "https://playerok.com/products?search=" + encodeURIComponent(q), hosts: /playerok\.com/i },
  { name: "Plati", url: (q: string) => "https://plati.market/search/" + encodeURIComponent(q), hosts: /plati\.market/i },
  { name: "GGSEL", url: (q: string) => "https://ggsel.net/catalog?search=" + encodeURIComponent(q), hosts: /ggsel\.net/i },
  { name: "Tradly", url: (_q: string) => "https://tradly.gg/catalog", hosts: /tradly\.gg/i },
];
const FUNPAY_MM2 = "https://funpay.com/lots/925/";
const STARVELL_CATEGORIES = ["knives","guns","sets","pets","misc"].map(x => `https://starvell.com/roblox/mm2/${x}`);
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; PriceWatch/1.0; public listing reader)",
  "Accept": "text/html,application/xhtml+xml",
  "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.7",
};
type Source = "FunPay" | "PlayerOK" | "Plati" | "GGSEL" | "Tradly" | "Starvell";
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
function decode(s: string) {
  return s.replace(/&nbsp;|&#160;|&#xA0;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}
function text(s: string) {
  return decode(s.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim();
}
function norm(s: string) { return s.normalize("NFKC").toLowerCase().replace(/[’']/g, "").replace(/[^a-zа-яё0-9]+/gi, " ").trim().replace(/\s+/g, " "); }
function money(s: string): number | null {
  const m = s.match(/(?:₽|руб(?:лей|ля|ль)?\.?|RUB)\s*([\d\s\u00a0.,]+)|([\d\s\u00a0.,]+)\s*(?:₽|руб(?:лей|ля|ль)?\.?|RUB)/i);
  if (!m) return null;
  let v = (m[1] || m[2] || "").replace(/[\s\u00a0]/g, "");
  if (v.includes(",") && v.includes(".")) v = v.lastIndexOf(",") > v.lastIndexOf(".") ? v.replace(/\./g, "").replace(",", ".") : v.replace(/,/g, "");
  else v = v.replace(",", ".");
  const n = Number(v); return Number.isFinite(n) && n > 0 && n < 1e8 ? n : null;
}
function blocked(s: string) { return /\b(аккаунт|account|акк|набор|bundle|пакет|комплект|лотом|лотами|set of|full set|инвентарь|inventory)\b/i.test(s); }
function nameMatches(title: string, wanted: string) {
  const a = norm(title), b = norm(wanted);
  if (!a || !b) return false;
  // Require all meaningful item-name tokens; avoid matching a different item just because one word overlaps.
  const tokens = b.split(" ").filter(x => x.length > 1);
  return a === b || ((" " + a + " ").includes(" " + b + " ")) ||
    (tokens.length > 0 && tokens.every(token => (" " + a + " ").includes(" " + token + " ")));
}
async function getHtml(url: string) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(9000), redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status} (${new URL(url).hostname})`);
  const html = await r.text();
  if (!html || html.length < 250) throw new Error(`Пустая или слишком короткая страница (${new URL(url).hostname})`);
  return html;
}
function anchors(html: string, base: string, source: Source, wanted: string) {
  const out: Array<Record<string, unknown>> = [];
  const re = /<a\b([^>]*\bhref\s*=\s*(["'])(.*?)\2[^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 1800) {
    const attrs = m[1], rawUrl = m[3], body = m[4];
    let url = ""; try { url = new URL(rawUrl, base).href; } catch { continue; }
    if (source === "FunPay" && !/funpay\.com\/lots\/offer\?id=\d+/i.test(url)) continue;
    if (source === "PlayerOK" && !/playerok\.com\/products\//i.test(url)) continue;
    if (source === "Starvell" && (!/starvell\.com\/roblox\/mm2\//i.test(url) || /\/(?:knives|guns|sets|pets|misc)\/?(?:\?|$)/i.test(url))) continue;
    if (source === "Plati" && !/plati\.market\//i.test(url)) continue;
    if (source === "GGSEL" && !/ggsel\.net\//i.test(url)) continue;
    if (source === "Tradly" && !/tradly\.gg\//i.test(url)) continue;
    const titleAttr = attrs.match(/\b(?:title|aria-label)\s*=\s*(["'])(.*?)\1/i)?.[2] || "";
    const titleNode = body.match(/<[^>]*class=["'][^"']*(?:tc-desc-text|product-card__title|product-title|product-name|item-title|title)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1] || "";
    const imgAlt = body.match(/<img\b[^>]*\balt\s*=\s*(["'])(.*?)\1/i)?.[2] || "";
    const bodyText = text(body);
    const title = text(titleAttr || titleNode || imgAlt || bodyText).slice(0, 180);
    if (!title || blocked(title) || !nameMatches(title, wanted)) continue;
    const priceNode = body.match(/<[^>]*class=["'][^"']*(?:tc-price|tc-amount|price|amount|cost)[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/i)?.[0] || "";
    let price: number | null = null;
    if (source === "FunPay") {
      const dataS = priceNode.match(/\bdata-s\s*=\s*(["'])([\d.,]+)\1/i)?.[2];
      if (dataS) { const n = Number(dataS.replace(",", ".")); if (Number.isFinite(n) && n > 0 && n < 1e8) price = n; }
    }
    if (price === null) price = money(text(priceNode || bodyText));
    if (price === null || price <= 0) continue;
    const imgMatch = body.match(/<img\b[^>]*(?:src|data-src|data-original)\s*=\s*(["'])(.*?)\1/i);
    let image = ""; try { const p = new URL(imgMatch?.[2] || "", base); if (p.protocol === "https:" && !/avatar|logo|emoji|icon/i.test(p.href)) image = p.href; } catch {}
    out.push({ name: title, price, currency: "RUB", marketplace: source, url, image, sourceUrl: base });
  }
  const seen = new Set<string>();
  return out.filter(x => { const k = String(x.url) + "|" + String(x.price); if (seen.has(k)) return false; seen.add(k); return true; });
}
function median(nums: number[]) { const a = [...nums].sort((x,y)=>x-y); if (!a.length) return null; const m=Math.floor(a.length/2); return a.length%2?a[m]:Math.round((a[m-1]+a[m])/2*100)/100; }
async function scanOne(name: string, pages: Array<{source:Source;url:string;html:string|null;error:string|null}>) {
  const offers: Array<Record<string, unknown>> = [], errors: string[] = [];
  for (const p of pages) {
    if (!p.html) { if (p.error) errors.push(`${p.source}: ${p.error}`); continue; }
    const found = anchors(p.html, p.url, p.source, name);
    offers.push(...found);
    if (!found.length) errors.push(`${p.source}: точный лот не найден в доступном HTML; выдача может быть динамической, пагинированной или ограниченной`);
  }
  const unique = [...new Map(offers.map(o=>[`${o.marketplace}|${o.url}|${o.price}`,o])).values()];
  const prices = unique.map(o=>Number(o.price)).filter(n=>Number.isFinite(n)&&n>0);
  const names = ["FunPay","PlayerOK","Starvell","Plati","GGSEL","Tradly"];
  const byMarketplace = Object.fromEntries(names.map(k=>[k,unique.filter(o=>o.marketplace===k).length]));
  return { name, offers:unique, count:unique.length, byMarketplace, medianRub:median(prices), updatedAt:new Date().toISOString(), errors };
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method === "GET") return response({ok:true,service:"price-watch-marketplace-scan",usage:"POST JSON { items: ['Gingerscope', 'AWP | Medusa'] }",sources:["FunPay (MM2 category)","PlayerOK","Starvell (MM2 categories)","Plati.market","GGSEL","Tradly"],limitations:"Searches public HTML only. Each marketplace has its own markup; JavaScript-rendered, paginated, blocked, login-only or non-RUB offers can be missed. No anti-bot bypass."});
  if (req.method !== "POST") return response({error:"Method not allowed"},405);
  let body: unknown; try { body=await req.json(); } catch { return response({error:"Ожидается JSON в теле запроса"},400); }
  const raw=(body as {items?:unknown})?.items;
  if (!Array.isArray(raw)||raw.length<1) return response({error:"Передай массив items, например ['Gingerscope']"},400);
  if (raw.length>80) return response({error:"За один запрос можно проверить не более 80 предметов"},400);
  const items=[...new Set(raw.map(x=>String(x??"").trim()).filter(x=>x.length>1&&x.length<=100&&!blocked(x)))];
  if (!items.length) return response({error:"Нет корректных названий предметов после фильтрации"},400);
  const pages: Array<{source:Source;url:string;html:string|null;error:string|null}> = [];
  // Generic game-item sources, searched by name where the site exposes a public search URL.
  for (const source of SOURCES) {
    for (const name of items) {
      const url=source.url(name);
      try { pages.push({source:source.name as Source,url,html:await getHtml(url),error:null}); }
      catch(e) { pages.push({source:source.name as Source,url,html:null,error:e instanceof Error?e.message:String(e)}); }
    }
  }
  // Public category pages for MM2 sources are also checked; matching is still by item name.
  try { pages.push({source:"FunPay",url:FUNPAY_MM2,html:await getHtml(FUNPAY_MM2),error:null}); }
  catch(e) { pages.push({source:"FunPay",url:FUNPAY_MM2,html:null,error:e instanceof Error?e.message:String(e)}); }
  const sv=await Promise.all(STARVELL_CATEGORIES.map(async url=>{try{return {source:"Starvell" as Source,url,html:await getHtml(url),error:null};}catch(e){return {source:"Starvell" as Source,url,html:null,error:e instanceof Error?e.message:String(e)};}}));
  pages.push(...sv);
  const results: Array<Record<string,unknown>>=[];
  for(let i=0;i<items.length;i+=3){
    const batch=items.slice(i,i+3);
    results.push(...await Promise.all(batch.map(name=>scanOne(name,pages.filter(p=>{
      if(p.source==="FunPay"||p.source==="Starvell") return true;
      return p.url===SOURCES.find(s=>s.name===p.source)?.url(name);
    }))));
  }
  return response({ok:true,updatedAt:new Date().toISOString(),itemCount:results.length,sourceStatus:Object.fromEntries(["PlayerOK","Plati","GGSEL","Tradly","FunPay","Starvell"].map(source=>[source, pages.filter(p=>p.source===source&&p.html).length ? "public HTML fetched; see per-item results" : "no readable public HTML"])),results,note:"Только лоты, которые удалось прочитать из публичного HTML. Пустой результат не означает, что предмета нет на площадке."});
});
