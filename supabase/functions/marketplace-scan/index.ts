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
  Starvell: "https://api.parse.bot/scraper/ab8a5cd8-8fbf-4c5f-8c27-05206d5db84b",
  PlayerOK: "https://api.parse.bot/scraper/4688010c-bf13-44a2-bef6-4db5e643b286",
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
  const raw=await res.text();
  // Preserve the provider's diagnostic message (422 validation errors, 502/503 upstream failures)
  // so a scan response tells us what failed without exposing request headers or API keys.
  if(!res.ok)throw new Error(source+": API HTTP "+res.status+": "+raw.slice(0,500));
  let json:unknown;try{json=JSON.parse(raw)}catch{throw new Error(source+": API вернул не JSON (HTTP "+res.status+")");}
  const root=asObj(json);if(root.status==="error"||root.error)throw new Error(source+": "+String(root.error||root.message||"ошибка API"));
  return json;
}
function payloadSummary(raw:unknown){
  const root=dataOf(raw);
  const arrays:Record<string,number>={};
  for(const [key,value] of Object.entries(root))if(Array.isArray(value))arrays[key]=value.length;
  const rows:unknown[]=[];
  for(const key of ["offers","listings","lots","products","items"])if(Array.isArray(root[key]))rows.push(...root[key] as unknown[]);
  return {
    rootKeys:Object.keys(root).slice(0,30),
    arrayCounts:arrays,
    sampleItemKeys:rows.slice(0,3).map(v=>Object.keys(asObj(v)).slice(0,25)),
    sampleTitles:rows.slice(0,5).map(v=>String(asObj(v).title??asObj(v).name??asObj(v).description??asObj(v).product_name??"").slice(0,100)),
  };
}
function searchableText(value:unknown,depth=0):string{
  if(depth>4||value==null)return "";
  if(typeof value==="string"||typeof value==="number")return String(value);
  if(Array.isArray(value))return value.map(v=>searchableText(v,depth+1)).join(" ");
  if(typeof value==="object")return Object.entries(value as Record<string,unknown>)
    .filter(([k])=>!["seller","seller_id","offer_id","id","url","offer_url","price","currency"].includes(k.toLowerCase()))
    .map(([k,v])=>k+" "+searchableText(v,depth+1)).join(" ");
  return "";
}
function numericPrice(value:unknown):number{
  if(typeof value==="number")return value;
  if(value&&typeof value==="object"){
    const p=asObj(value);
    for(const k of ["amount","value","rub","price","formatted"])if(p[k]!==undefined){
      const n=numericPrice(p[k]);if(Number.isFinite(n)&&n>0)return n;
    }
    return NaN;
  }
  const s=String(value??"").replace(/[^0-9,.-]/g,"").replace(/\s/g,"").replace(",",".");
  return s?Number(s):NaN;
}
function toOffers(raw:unknown,source:Source,wanted:string):Offer[]{
  const root=dataOf(raw);
  const candidates:unknown[]=[];
  for(const key of ["offers","listings","lots","products","items"])if(Array.isArray(root[key]))candidates.push(...root[key]);
  const out:Offer[]=[];
  for(const value of candidates){
    const o=asObj(value),seller=asObj(o.seller);
    const title=String(o.title??o.name??o.product_name??o.offer_title??o.brief_description??o.description??"").trim();
    const searchable=[title,o.brief_description,o.description,o.attributes,o.subcategory,o.category].map(v=>searchableText(v)).join(" ");
    if(!title||blocked(title)||blocked(searchable)||!matches(searchable,wanted))continue;
    const rawPrice=o.price??o.price_rub??o.price_amount??o.price_raw??o.priceRaw??o.raw_price??o.min_order_currency_amount;
    const price=numericPrice(rawPrice);
    const currency=String(o.currency??o.price_currency??asObj(rawPrice).currency??"RUB").toUpperCase();
    if(currency!=="RUB"||!Number.isFinite(price)||price<=0||price>=1e8)continue;
    // Reject Gingerscope quotes below the user-confirmed market floor.
    if(/gingerscope/i.test(wanted)&&price<26000)continue;
    let url=String(o.offer_url??o.public_url??o.url??o.link??"");
    if(!/^https:\/\//i.test(url)){
      const id=String(o.offer_id??o.id??o.slug??"");
      if(source==="FunPay"&&id)url="https://funpay.com/lots/offer?id="+encodeURIComponent(id);
      else if(source==="Starvell"&&id)url="https://starvell.com/offer/"+encodeURIComponent(id);
      else if(source==="PlayerOK"&&String(o.slug??""))url="https://playerok.com/products/"+encodeURIComponent(String(o.slug));
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
  const raw=await providerGet("Starvell","search_games",{keyword:"Roblox"});
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
async function scanBatch(names:string[]):Promise<ScanResult[]>{
  // Fetch each marketplace/category once per batch instead of repeating identical catalog
  // requests for every item. This reduces API usage significantly for the same batch.
  const sourceOffers:Record<Source,Offer[]>={FunPay:[],Starvell:[],PlayerOK:[]};
  const sourceErrors:Record<Source,string[]>={FunPay:[],Starvell:[],PlayerOK:[]};
  await Promise.all([
    (async()=>{try{
      const raw=await providerGet("FunPay","get_lots_by_category",{lot_id:925});
      sourceOffers.FunPay=names.flatMap(name=>toOffers(raw,"FunPay",name));
    }catch(e){sourceErrors.FunPay.push(e instanceof Error?e.message:String(e));}})(),
    (async()=>{try{
      const rawCatalog=await providerGet("Starvell","search_games",{keyword:"Roblox"});
      const root=dataOf(rawCatalog),games=Array.isArray(root.games)?root.games:[];
      const game=games.find((g:unknown)=>/roblox/i.test(String(asObj(g).name??asObj(g).game_slug??asObj(g).slug??"")));
      if(!game){
        sourceErrors.Starvell.push("diagnostic="+JSON.stringify({stage:"search_games",catalog:payloadSummary(rawCatalog)}).slice(0,1400));
        throw new Error("API не вернул каталог Roblox");
      }
      const g=asObj(game),categories=Array.isArray(g.categories)?g.categories:[];
      const categoryDebug=categories.map((c:unknown)=>({name:String(asObj(c).name??""),slug:String(asObj(c).category_slug??asObj(c).slug??""),keys:Object.keys(asObj(c)).slice(0,12)})).slice(0,40);
      const mm2=categories.filter((c:unknown)=>/mm2|murder mystery|murder-mystery/i.test(String(asObj(c).name??"")+" "+String(asObj(c).category_slug??asObj(c).slug??"")));
      // Some Starvell API versions don't label the MM2 category explicitly. In that case,
      // search Roblox item/knife categories rather than silently skipping Starvell entirely.
      const relevant=mm2.length?mm2:categories.filter((c:unknown)=>/item|предмет|knife|knives|weapon|оруж|godly|ancient/i.test(String(asObj(c).name??"")+" "+String(asObj(c).category_slug??asObj(c).slug??"")));
      if(!relevant.length){
        sourceErrors.Starvell.push("diagnostic="+JSON.stringify({stage:"categories",gameKeys:Object.keys(g).slice(0,25),gameName:String(g.name??""),gameSlug:String(g.game_slug??g.slug??""),categoryCount:categories.length,categories:categoryDebug}).slice(0,1800));
        throw new Error("не найдены категории MM2 или Roblox items для поиска");
      }
      const pages=[];
      const pageDebug=[];
      for(const cv of relevant.slice(0,6)){
        const cat=asObj(cv),slug=String(cat.category_slug??cat.slug??"");if(!slug)continue;
        // Walk multiple pages so rare items such as Gingerscope aren't missed after the first 150 offers.
        for(const offset of [0,150,300]){
          const page=await providerGet("Starvell","list_offers",{game_slug:String(g.game_slug??g.slug??"roblox"),category_slug:slug,offset,limit:150});
          pages.push(page);
          pageDebug.push({category:String(cat.name??""),slug,offset,payload:payloadSummary(page)});
          const pageRoot=dataOf(page);
          const listed=["offers","listings","lots","products","items"].map(k=>Array.isArray(pageRoot[k])?pageRoot[k].length:0).reduce((a,b)=>Math.max(a,b),0);
          if(listed<150)break;
        }
      }
      sourceOffers.Starvell=names.flatMap(name=>pages.flatMap(page=>toOffers(page,"Starvell",name)));
      // Successful diagnostics must not be recorded as source errors; otherwise the API
      // incorrectly reports Starvell as unavailable despite receiving offer pages.
    }catch(e){sourceErrors.Starvell.push(e instanceof Error?e.message:String(e));}})(),
    (async()=>{try{
      const raw=await providerGet("PlayerOK","search_games",{query:"Roblox",limit:10});
      const root=dataOf(raw),games=Array.isArray(root.games)?root.games:[];
      const game=games.find((g:unknown)=>/roblox/i.test(String(asObj(g).name??asObj(g).slug??"")));
      if(!game)throw new Error("API не вернул игру Roblox");
      const g=asObj(game),categories=Array.isArray(g.categories)?g.categories:[];
      const relevant=categories.filter((v:unknown)=>/mm2|murder mystery|предмет|items|item/i.test(String(asObj(v).name??"")+" "+String(asObj(v).slug??"")));
      const chosen=relevant.slice(0,2),queries=chosen.length?chosen:[null],pages=[];
      for(const cat of queries){
        const params:Record<string,string|number>={game_slug:String(g.slug??"roblox"),limit:50,sort_field:"price",sort_direction:"ASC"};
        if(cat?.slug)params.category_slug=String(cat.slug);
        pages.push(await providerGet("PlayerOK","list_items",params));
      }
      sourceOffers.PlayerOK=names.flatMap(name=>pages.flatMap(page=>toOffers(page,"PlayerOK",name)));
    }catch(e){sourceErrors.PlayerOK.push(e instanceof Error?e.message:String(e));}})()
  ]);
  return names.map(name=>{
    const all=[...sourceOffers.FunPay,...sourceOffers.Starvell,...sourceOffers.PlayerOK];
    const offers=all.filter(o=>matches(o.name,name))
      .filter((o,i,a)=>a.findIndex(x=>x.marketplace===o.marketplace&&x.url===o.url&&x.price===o.price)===i);
    const errors=(["FunPay","Starvell","PlayerOK"] as Source[]).flatMap(source=>sourceErrors[source].map(e=>source+": "+e));
    return {name,offers,count:offers.length,byMarketplace:{FunPay:offers.filter(o=>o.marketplace==="FunPay").length,Starvell:offers.filter(o=>o.marketplace==="Starvell").length,PlayerOK:offers.filter(o=>o.marketplace==="PlayerOK").length},medianRub:median(offers.map(o=>o.price)),updatedAt:new Date().toISOString(),errors};
  });
}
async function dbRequest(path:string,init:RequestInit={}){
  const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!url||!key)throw new Error("Supabase service credentials are not available");
  const res=await fetch(url.replace(/\/$/,"")+"/rest/v1/"+path,{...init,headers:{apikey:key,Authorization:"Bearer "+key,"Content-Type":"application/json",Prefer:"return=representation",...(init.headers||{})}});
  const body=await res.text();if(!res.ok)throw new Error("Supabase DB HTTP "+res.status+": "+body.slice(0,300));
  return body?JSON.parse(body):null;
}
async function saveShared(results:ScanResult[]):Promise<number>{
  if(!results.length)return 0;
  const valid=results.filter(r=>r.count>0&&r.medianRub!==null);
  const rows=valid.map(r=>({item_name:r.name,item_key:norm(r.name),median_rub:r.medianRub,low_rub:quantile(r.offers.map(o=>o.price),.25),high_rub:quantile(r.offers.map(o=>o.price),.75),offers:r.offers,source_counts:r.byMarketplace,updated_at:r.updatedAt}));
  if(rows.length)await dbRequest("marketplace_price_cache?on_conflict=item_key",{method:"POST",headers:{"Prefer":"resolution=merge-duplicates,return=minimal"},body:JSON.stringify(rows)});
  // Do not keep showing an older invalid Gingerscope quote when current scan finds no valid offers.
  for(const r of results.filter(r=>/gingerscope/i.test(r.name)&&!(r.count>0&&r.medianRub!==null))){
    await dbRequest("marketplace_price_cache?item_key=eq."+encodeURIComponent(norm(r.name)),{method:"DELETE",headers:{"Prefer":"return=minimal"}});
  }
  return rows.length;
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
  results.push(...await scanBatch(items));
  let persistence:{ok:boolean;savedItems?:number;error?:string}={ok:true,savedItems:0};
  try{persistence.savedItems=await saveShared(results)}catch(e){persistence={ok:false,error:e instanceof Error?e.message:String(e)}}
  const withOffers=results.filter(r=>r.count>0).length;
  return corsResponse({ok:true,status:withOffers===results.length?"offers_found":withOffers?"partial_results":"no_offers_found",updatedAt:new Date().toISOString(),itemCount:results.length,itemsWithOffers:withOffers,persistence,sourceStatus:["FunPay","Starvell","PlayerOK"].map(source=>({source,status:results.some(r=>r.byMarketplace[source]>0)?"offers_found":results.every(r=>r.errors.some(e=>e.startsWith(source+":")) )?"unavailable":"no_matching_offers"})),results,note:"Каждый источник запрашивается один раз на партию (с отдельными запросами к категориям), затем предложения сопоставляются локально. Сканирование сейчас покрывает MM2/Roblox; остальные игры требуют собственных категорий источников. Цены берутся только из API-ответов."});
});
