// Price Watch — structured API adapters. No HTML parsing and no invented prices.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
type Source = "FunPay" | "Starvell" | "PlayerOK";
type Offer = { name:string; price:number; currency:"RUB"; marketplace:Source; url:string; image?:string };
type ScanResult = { name:string; offers:Offer[]; count:number; byMarketplace:Record<string,number>; medianRub:number|null; updatedAt:string; errors:string[] };
const PROVIDERS = {
  FunPay: "https://api.parse.bot/scraper/b07b6749-5fbe-4b92-ac50-82aab4087ce5",
  Starvell: "https://api.parse.bot/scraper/ab8a5cd8-8fbf-4c5f-8c27-05206d5db84b",\n  PlayerOK: "https://api.parse.bot/scraper/4688010c-bf13-44a2-bef6-4db5e643b286",
};
const corsResponse = (data:unknown,status=200) => new Response(JSON.stringify(data),{status,headers:{...cors,"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
const norm=(s:string)=>s.normalize("NFKC").toLowerCase().replace(/[’']/g,"").replace(/[^a-zа-яё0-9]+/gi," ").trim().replace(/\s+/g," ");
const blocked=(s:string)=>/\b(аккаунт|account|акк|набор|bundle|пакет|комплект|инвентарь|inventory)\b/i.test(s);
function matches(title:string,wanted:string){
  const a=norm(title),b=norm(wanted); if(!a||!b)return false;
  if(a===b||(" "+a+" ").includes(" "+b+" "))return true;
  const tokens=b.split(" ").filter(t=>t.length>1);
  return tokens.length>0&&tokens.every(t=>(" "+a+" ").includes(" "+t+" "));
}
function median(values:number[]){const a=[...values].sort((x,y)=>x-y);if(!a.length)return null;const m=Math.floor(a.length/2);return a.length%2?a[m]:Math.round((a[m-1]+a[m])/2*100)/100;}
function asObj(x:unknown):Record<string,any>{return x&&typeof x==="object"?x as Record<string,any>:{}}
function dataOf(x:unknown):Record<string,any>{const o=asObj(x);return asObj(o.data??o.result??o)}
async function providerGet(source:Source,endpoint:string,params:Record<string,string|number>={}){
  const key=Deno.env.get("PARSE_API_KEY");
  if(!key)throw new Error("Не задан секрет PARSE_API_KEY в Supabase");
  const url=new URL(PROVIDERS[source]+"/"+endpoint);
  for(const [k,v] of Object.entries(params))url.searchParams.set(k,String(v));
  const res=await fetch(url,{headers:{"X-API-Key":key,"Accept":"application/json"},signal:AbortSignal.timeout(18000)});
  const raw=await res.text(); let json:unknown;try{json=JSON.parse(raw)}catch{throw new Error(source+": API вернул не JSON (HTTP "+res.status+")")}
  if(!res.ok)throw new Error(source+": API HTTP "+res.status);
  const root=asObj(json);if(root.status==="error"||root.error)throw new Error(source+": "+String(root.error||root.message||"ошибка API"));
  return json;
}
function toOffers(raw:unknown,source:Source,wanted:string):Offer[]{
  const root=dataOf(raw);
  const candidates:unknown[]=[];
  for(const key of ["offers","listings","lots","products","items"])if(Array.isArray(root[key]))candidates.push(...root[key]);
  const out:Offer[]=[];
  for(const value of candidates){
    const o=asObj(value),seller=asObj(o.seller);
    const title=String(o.title??o.name??o.description??o.brief_description??o.product_name??"").trim();
    if(!title||blocked(title)||!matches(title,wanted))continue;
    const rawPrice=o.price??o.price_raw??o.priceRaw??o.raw_price;
    const price=typeof rawPrice==="number"?rawPrice:Number(String(rawPrice??"").replace(/\s/g,"").replace(",","."));
    const currency=String(o.currency??o.price_currency??"RUB").toUpperCase();
    if(currency!=="RUB"||!Number.isFinite(price)||price<=0||price>=1e8)continue;
    let url=String(o.offer_url??o.url??o.link??"");
    if(!/^https:\/\//i.test(url)){
      const id=String(o.offer_id??o.id??o.slug??"");
      if(source==="FunPay"&&id)url="https://funpay.com/lots/offer?id="+encodeURIComponent(id);
      else if(source==="Starvell"&&id)url="https://starvell.com/offer/"+encodeURIComponent(id);\n      else if(source==="PlayerOK"&&String(o.slug??""))url="https://playerok.com/products/"+encodeURIComponent(String(o.slug));
    }
    if(!/^https:\/\//i.test(url))continue;
    const image=String(o.image??o.image_url??(Array.isArray(o.images)?asObj(o.images[0]).url:"")??"");
    out.push({name:title,price,currency:"RUB",marketplace:source,url,...(/^https:\/\//i.test(image)?{image}:{})});
  }
  const seen=new Set<string>();
  return out.filter(o=>{const k=o.marketplace+"|"+o.url+"|"+o.price;if(seen.has(k))return false;seen.add(k);return true;});
}
async function scanFunPay(name:string):Promise<Offer[]>{
  // Lot 925 is the project's existing public FunPay MM2 category. The API filters by listing text.
  const raw=await providerGet("FunPay","get_lots_by_category",{lot_id:925,query:name});
  return toOffers(raw,"FunPay",name);
}
async function scanStarvell(name:string):Promise<Offer[]>{
  // Resolve Roblox categories via structured API, then query the relevant MM2 category offers.
  const raw=await providerGet("Starvell","search_games",{query:"Roblox"});
  const root=dataOf(raw), games=Array.isArray(root.games)?root.games:[];
  const roblox=games.find((g:unknown)=>/roblox/i.test(String(asObj(g).name??asObj(g).game_slug??"")));
  if(!roblox)throw new Error("Starvell: API не вернул каталог Roblox");
  const game=asObj(roblox), categories=Array.isArray(game.categories)?game.categories:[];
  const mm2=categories.filter((c:unknown)=>/mm2|murder mystery|murder-mystery/i.test(String(asObj(c).name??"")+" "+String(asObj(c).category_slug??"")));
  if(!mm2.length)throw new Error("Starvell: в API не найдена категория MM2 для Roblox");
  const results:Offer[]=[];
  // Keep within the free provider quota; scan only a few explicitly relevant categories per item.
  for(const catValue of mm2.slice(0,4)){
    const cat=asObj(catValue),slug=String(cat.category_slug??"");
    if(!slug)continue;
    const offers=await providerGet("Starvell","list_offers",{game_slug:String(game.game_slug??"roblox"),category_slug:slug,offset:0,limit:150});
    results.push(...toOffers(offers,"Starvell",name));
  }
  return results;
}
async function scanPlayerOK(name:string):Promise<Offer[]>{
  const raw=await providerGet("PlayerOK","search_games",{query:"Roblox",limit:10});
  const root=dataOf(raw), games=Array.isArray(root.games)?root.games:[];
  const game=games.find((g:unknown)=>/roblox/i.test(String(asObj(g).name??asObj(g).slug??"")));
  if(!game)throw new Error("PlayerOK: API не вернул игру Roblox");
  const g=asObj(game), categories=Array.isArray(g.categories)?g.categories:[];
  const relevant=categories.filter((v:unknown)=>/mm2|murder mystery|предмет|items|item/i.test(String(asObj(v).name??"")+" "+String(asObj(v).slug??"")));
  const chosen=relevant.slice(0,2);
  const queries=chosen.length?chosen:[null];
  const pages=await Promise.all(queries.map(async (cat:Record<string,any>|null)=>{
    const params:Record<string,string|number>={game_slug:String(g.slug??"roblox"),limit:50,sort_field:"price",sort_direction:"ASC"};
    if(cat?.slug)params.category_slug=String(cat.slug);
    return await providerGet("PlayerOK","list_items",params);
  }));
  return pages.flatMap(page=>toOffers(page,"PlayerOK",name));
}
async function scanOne(name:string):Promise<ScanResult>{
  const errors:string[]=[], offers:Offer[]=[];
  const results=await Promise.allSettled([scanFunPay(name),scanStarvell(name)]);
  const sources:Source[]=["FunPay","Starvell"];
  results.forEach((r,i)=>{if(r.status==="fulfilled")offers.push(...r.value);else errors.push(sources[i]+": "+(r.reason instanceof Error?r.reason.message:String(r.reason)))});
  const unique=[...new Map(offers.map(o=>[o.marketplace+"|"+o.url+"|"+o.price,o])).values()];
  const prices=unique.map(o=>o.price);
  return {name,offers:unique,count:unique.length,byMarketplace:{FunPay:unique.filter(o=>o.marketplace==="FunPay").length,Starvell:unique.filter(o=>o.marketplace==="Starvell").length,PlayerOK:unique.filter(o=>o.marketplace==="PlayerOK").length},medianRub:median(prices),updatedAt:new Date().toISOString(),errors};
}
async function dbRequest(path:string,init:RequestInit={}){
  const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!url||!key)throw new Error("Supabase service credentials are not available");
  const res=await fetch(url.replace(/\/$/,"")+"/rest/v1/"+path,{...init,headers:{apikey:key,Authorization:"Bearer "+key,"Content-Type":"application/json",Prefer:"return=representation",...(init.headers||{})}});
  const body=await res.text();if(!res.ok)throw new Error("Supabase DB HTTP "+res.status+": "+body.slice(0,300));
  return body?JSON.parse(body):null;
}
async function saveShared(results:ScanResult[]){
  if(!results.length)return;
  const rows=results.filter(r=>r.count>0&&r.medianRub!==null).map(r=>({item_name:r.name,item_key:norm(r.name),median_rub:r.medianRub,low_rub:quantile(r.offers.map(o=>o.price),.25),high_rub:quantile(r.offers.map(o=>o.price),.75),offers:r.offers,source_counts:r.byMarketplace,updated_at:r.updatedAt}));
  if(rows.length)await dbRequest("marketplace_price_cache?on_conflict=item_key",{method:"POST",headers:{"Prefer":"resolution=merge-duplicates,return=minimal"},body:JSON.stringify(rows)});
}
function quantile(values:number[],q:number){const a=[...values].sort((x,y)=>x-y);return a.length?a[Math.min(a.length-1,Math.max(0,Math.floor((a.length-1)*q)))]:null;}
async function readShared(){
  const rows=await dbRequest("marketplace_price_cache?select=item_name,median_rub,low_rub,high_rub,offers,source_counts,updated_at&order=updated_at.desc&limit=500");
  return Array.isArray(rows)?rows:[];
}
Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  if(req.method==="GET"){
    try{return corsResponse({ok:true,service:"price-watch-api-adapters",sources:["FunPay API","Starvell API","PlayerOK API"],cachedResults:await readShared(),storage:"Supabase shared database"});}
    catch(e){return corsResponse({ok:false,service:"price-watch-api-adapters",sources:["FunPay API","Starvell API"],cachedResults:[],configurationError:e instanceof Error?e.message:String(e),note:"Для общей базы нужно применить SQL migration; для поиска — добавить PARSE_API_KEY в секреты Supabase."},200);}
  }
  if(req.method!=="POST")return corsResponse({error:"Method not allowed"},405);
  let body:unknown;try{body=await req.json()}catch{return corsResponse({error:"Ожидается JSON"},400)}
  const raw=asObj(body).items;
  if(!Array.isArray(raw)||!raw.length)return corsResponse({error:"Передай items: ['название предмета']"},400);
  if(raw.length>6)return corsResponse({error:"За запрос можно проверить максимум 6 предметов, чтобы не исчерпать бесплатную квоту API"},400);
  const items=[...new Set(raw.map(v=>String(v??"").trim()).filter(v=>v.length>1&&v.length<=100&&!blocked(v)))];
  if(!items.length)return corsResponse({error:"Нет корректных названий предметов"},400);
  const results:ScanResult[]=[];
  for(const name of items)results.push(await scanOne(name));
  let persistence:{ok:boolean;error?:string}={ok:true};
  try{await saveShared(results)}catch(e){persistence={ok:false,error:e instanceof Error?e.message:String(e)}}
  const withOffers=results.filter(r=>r.count>0).length;
  return corsResponse({ok:true,status:withOffers===results.length?"offers_found":withOffers?"partial_results":"no_offers_found",updatedAt:new Date().toISOString(),itemCount:results.length,itemsWithOffers:withOffers,persistence,sourceStatus:["FunPay","Starvell","PlayerOK"].map(source=>({source,status:results.some(r=>r.byMarketplace[source]>0)?"offers_found":results.every(r=>r.errors.some(e=>e.startsWith(source+":")) )?"unavailable":"no_matching_offers"})),results,note:"Цены берутся только из API-ответов. Если адаптер не настроен или API не вернул совпадения, старые значения не выдаются за свежие."});
});
