// Price Watch — structured API adapters. No HTML parsing and no invented prices.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
type Source = "FunPay" | "Starvell" | "PlayerOK" | "Plati";
type Offer = { name:string; price:number; currency:"RUB"; marketplace:Source; url:string; image?:string };
type SrcStatus = "offers_found" | "no_matching_offers" | "unavailable" | "skipped" | "not_connected";
type Stat = { status:SrcStatus; httpStatus?:number; message?:string; scanned:number; requests:number; retries:number };
type ItemSrc = { source:string; status:SrcStatus; count:number; httpStatus?:number; message?:string };
type ScanResult = { name:string; offers:Offer[]; count:number; byMarketplace:Record<string,number>; medianRub:number|null; updatedAt:string; errors:string[]; sources:ItemSrc[] };
const PLATI_SEARCH = "https://plati.io/api/search.ashx";
const GINGERSCOPE_FLOOR_RUB = 26000;
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
class SourceError extends Error{status?:number;attempts:number;constructor(m:string,status:number|undefined,attempts:number){super(m);this.status=status;this.attempts=attempts}}
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const RETRY=new Set([429,500,502,503,504]);
// Retries transient failures (429/5xx/timeouts) with backoff; 4xx other than 429 fail immediately.
async function fetchRetry(label:string,url:URL|string,init:RequestInit,stat:Stat,tries=3):Promise<string>{
  let last:SourceError|null=null;
  for(let i=1;i<=tries;i++){
    stat.requests++;
    try{
      const res=await fetch(url,{...init,signal:AbortSignal.timeout(15000)});
      const raw=await res.text();
      if(res.ok)return raw;
      const hint=res.status===502||res.status===503?" (источник временно недоступен)":res.status===429?" (лимит запросов)":"";
      last=new SourceError(label+": HTTP "+res.status+hint+": "+raw.slice(0,160).replace(/\s+/g," "),res.status,i);
      if(!RETRY.has(res.status))throw last;
    }catch(e){
      if(e instanceof SourceError&&!RETRY.has(e.status??0))throw e;
      if(!(e instanceof SourceError))last=new SourceError(label+": сеть или таймаут: "+(e instanceof Error?e.message:String(e)),undefined,i);
    }
    if(i<tries){stat.retries++;await sleep(500*i*i+Math.floor(Math.random()*250))}
  }
  throw last!;
}
async function providerGet(source:Exclude<Source,"Plati">,endpoint:string,params:Record<string,string|number>,stat:Stat){
  const key=Deno.env.get("PARSE_API_KEY");
  if(!key)throw new SourceError(source+": не задан секрет PARSE_API_KEY в Supabase",undefined,0);
  const url=new URL(PROVIDERS[source]+"/"+endpoint);
  for(const [k,v] of Object.entries(params))url.searchParams.set(k,String(v));
  const raw=await fetchRetry(source,url,{headers:{"X-API-Key":key,"Accept":"application/json"}},stat);
  let json:unknown;try{json=JSON.parse(raw)}catch{throw new SourceError(source+": API вернул не JSON",undefined,1)}
  const root=asObj(json);if(root.status==="error"||root.error)throw new SourceError(source+": "+String(root.error||root.message||"ошибка API"),undefined,1);
  return json;
}
function rowCount(raw:unknown){const r=dataOf(raw);let n=0;for(const k of ["offers","listings","lots","products","items"])if(Array.isArray(r[k]))n=Math.max(n,(r[k] as unknown[]).length);return n}
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
    if(/gingerscope/i.test(wanted)&&price<GINGERSCOPE_FLOOR_RUB)continue;
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
function findRows(x:unknown,depth=0):Record<string,any>[]{
  if(depth>5||x==null||typeof x!=="object")return [];
  if(Array.isArray(x)){
    const objs=x.filter(v=>v&&typeof v==="object"&&!Array.isArray(v)) as Record<string,any>[];
    if(objs.some(o=>o.price_rur!==undefined||o.price!==undefined))return objs;
    return x.flatMap(v=>findRows(v,depth+1));
  }
  const o=x as Record<string,any>;
  if(o.price_rur!==undefined&&(o.name!==undefined||o.title!==undefined))return [o];
  return Object.values(o).flatMap(v=>findRows(v,depth+1));
}
// Plati.market public JSON search (plati.io/api/search.ashx): unofficial but unauthenticated, no HTML parsing.
async function scanPlati(name:string,mm2:boolean,stat:Stat):Promise<Offer[]>{
  const url=new URL(PLATI_SEARCH);
  url.searchParams.set("query",mm2?name+" MM2":name);url.searchParams.set("pagesize","50");url.searchParams.set("visibleOnly","true");url.searchParams.set("response","json");
  const raw=await fetchRetry("Plati",url,{headers:{"Accept":"application/json"}},stat);
  let json:unknown;try{json=JSON.parse(raw)}catch{throw new SourceError("Plati: ответ не JSON",undefined,1)}
  const rows=findRows(json);stat.scanned+=rows.length;
  const out:Offer[]=[];
  for(const o of rows){
    const title=String(o.name??o.title??"").trim(),price=numericPrice(o.price_rur??o.price);
    const link=String(o.url??"");
    if(!title||blocked(title)||!matches(title,name)||!Number.isFinite(price)||price<=0||price>=1e8||!/^https:\/\//i.test(link))continue;
    if(/gingerscope/i.test(name)&&price<GINGERSCOPE_FLOOR_RUB)continue;
    out.push({name:title,price,currency:"RUB",marketplace:"Plati",url:link});
  }
  return out;
}
const newStat=():Stat=>({status:"no_matching_offers",scanned:0,requests:0,retries:0});
async function scanBatch(names:string[],mm2:boolean){
  const stats:Record<string,Stat>={FunPay:newStat(),Starvell:newStat(),PlayerOK:newStat(),Plati:newStat()};
  const offers:Record<Source,Offer[]>={FunPay:[],Starvell:[],PlayerOK:[],Plati:[]};
  const fail=(src:Source,e:unknown)=>{const st=stats[src];st.status="unavailable";st.httpStatus=e instanceof SourceError?e.status:undefined;st.message=e instanceof Error?e.message:String(e)};
  const tasks:Promise<void>[]=[];
  if(mm2){
    tasks.push((async()=>{try{
      const raw=await providerGet("FunPay","get_lots_by_category",{lot_id:925},stats.FunPay);
      stats.FunPay.scanned+=rowCount(raw);
      offers.FunPay=names.flatMap(n=>toOffers(raw,"FunPay",n));
    }catch(e){fail("FunPay",e)}})());
    tasks.push((async()=>{try{
      const st=stats.Starvell;
      const rawCatalog=await providerGet("Starvell","search_games",{keyword:"Roblox"},st);
      const games=Array.isArray(dataOf(rawCatalog).games)?dataOf(rawCatalog).games:[];
      const game=games.find((g:unknown)=>/roblox/i.test(String(asObj(g).name??asObj(g).game_slug??asObj(g).slug??"")));
      if(!game)throw new SourceError("Starvell: каталог Roblox не получен",undefined,1);
      const g=asObj(game),cats=Array.isArray(g.categories)?g.categories:[];
      const label=(c:unknown)=>String(asObj(c).name??"")+" "+String(asObj(c).category_slug??asObj(c).slug??"");
      const mm2c=cats.filter((c:unknown)=>/mm2|murder mystery|murder-mystery/i.test(label(c)));
      const rel=mm2c.length?mm2c:cats.filter((c:unknown)=>/item|предмет|knife|knives|weapon|оруж|godly|ancient/i.test(label(c)));
      if(!rel.length)throw new SourceError("Starvell: не найдены категории MM2/Roblox items",undefined,1);
      const pages:unknown[]=[];
      for(const cv of rel.slice(0,6)){
        const cat=asObj(cv),slug=String(cat.category_slug??cat.slug??"");if(!slug)continue;
        for(const offset of [0,150,300]){
          const page=await providerGet("Starvell","list_offers",{game_slug:String(g.game_slug??g.slug??"roblox"),category_slug:slug,offset,limit:150},st);
          pages.push(page);const n=rowCount(page);st.scanned+=n;if(n<150)break;
        }
      }
      offers.Starvell=names.flatMap(n=>pages.flatMap(p=>toOffers(p,"Starvell",n)));
    }catch(e){fail("Starvell",e)}})());
    tasks.push((async()=>{try{
      const st=stats.PlayerOK;
      const raw=await providerGet("PlayerOK","search_games",{query:"Roblox",limit:10},st);
      const games=Array.isArray(dataOf(raw).games)?dataOf(raw).games:[];
      const game=games.find((g:unknown)=>/roblox/i.test(String(asObj(g).name??asObj(g).slug??"")));
      if(!game)throw new SourceError("PlayerOK: игра Roblox не найдена",undefined,1);
      const g=asObj(game),cats=Array.isArray(g.categories)?g.categories:[];
      const rel=cats.filter((v:unknown)=>/mm2|murder mystery|предмет|items|item/i.test(String(asObj(v).name??"")+" "+String(asObj(v).slug??"")));
      const queries=(rel.length?rel.slice(0,2):[null]) as (Record<string,any>|null)[];
      const pages:unknown[]=[];
      for(const cat of queries){
        const params:Record<string,string|number>={game_slug:String(g.slug??"roblox"),limit:50,sort_field:"price",sort_direction:"ASC"};
        if(cat?.slug)params.category_slug=String(cat.slug);
        const page=await providerGet("PlayerOK","list_items",params,st);pages.push(page);st.scanned+=rowCount(page);
      }
      offers.PlayerOK=names.flatMap(n=>pages.flatMap(p=>toOffers(p,"PlayerOK",n)));
    }catch(e){fail("PlayerOK",e)}})());
  }else{
    for(const s of ["FunPay","Starvell","PlayerOK"]){stats[s].status="skipped";stats[s].message="Сканер этой площадки настроен только на категорию MM2; для других игр нужна своя категория."}
  }
  tasks.push((async()=>{
    // Plati is queried per item (generic text search, works for any game); partial failures still count as unavailable.
    const st=stats.Plati;let okAny=false,lastErr:unknown=null;
    for(const n of names){try{offers.Plati.push(...await scanPlati(n,mm2,st));okAny=true}catch(e){lastErr=e}}
    if(!okAny&&lastErr)fail("Plati",lastErr);
  })());
  await Promise.all(tasks);
  for(const src of ["FunPay","Starvell","PlayerOK","Plati"] as Source[]){
    const st=stats[src];if(st.status==="unavailable"||st.status==="skipped")continue;
    st.status=offers[src].length?"offers_found":"no_matching_offers";
    if(!offers[src].length)st.message="Просмотрено лотов: "+st.scanned+". Совпадений нет; это не доказывает отсутствие лотов.";
  }
  const updatedAt=new Date().toISOString();
  const results:ScanResult[]=names.map(name=>{
    const all=[...offers.FunPay,...offers.Starvell,...offers.PlayerOK,...offers.Plati];
    const found=all.filter(o=>matches(o.name,name)).filter((o,i,a)=>a.findIndex(x=>x.marketplace===o.marketplace&&x.url===o.url&&x.price===o.price)===i).sort((a,b)=>a.price-b.price);
    const by=(m:string)=>found.filter(o=>o.marketplace===m).length;
    const sources:ItemSrc[]=(["FunPay","Starvell","PlayerOK","Plati"] as Source[]).map(src=>{
      const st=stats[src],count=by(src);
      return {source:src,status:st.status==="unavailable"||st.status==="skipped"?st.status:(count?"offers_found":"no_matching_offers"),count,httpStatus:st.httpStatus,message:st.message};
    });
    sources.push({source:"GGSEL",status:"not_connected",count:0,message:"Публичного API поиска для сторонних приложений не подтверждено."});
    sources.push({source:"Tradly",status:"not_connected",count:0,message:"Публичного API поиска игровых лотов не подтверждено."});
    const errors=sources.filter(x=>x.status==="unavailable").map(x=>x.source+": "+(x.message||"недоступен"));
    return {name,offers:found,count:found.length,byMarketplace:{FunPay:by("FunPay"),Starvell:by("Starvell"),PlayerOK:by("PlayerOK"),Plati:by("Plati")},medianRub:median(found.map(o=>o.price)),updatedAt,errors,sources};
  });
  return {results,stats};
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
  const SOURCES=["FunPay API","Starvell API","PlayerOK API","Plati.market search"];
  if(req.method==="GET"){
    try{return corsResponse({ok:true,service:"price-watch-api-adapters",sources:SOURCES,notConnected:["GGSEL","Tradly"],cachedResults:await readShared(),storage:"Supabase shared database"});}
    catch(e){return corsResponse({ok:false,service:"price-watch-api-adapters",sources:SOURCES,cachedResults:[],configurationError:e instanceof Error?e.message:String(e),note:"Для общей базы нужно применить SQL migration; для FunPay/Starvell/PlayerOK добавь PARSE_API_KEY в секреты Supabase."},200);}
  }
  if(req.method!=="POST")return corsResponse({error:"Method not allowed"},405);
  let body:unknown;try{body=await req.json()}catch{return corsResponse({error:"Ожидается JSON"},400)}
  const raw=asObj(body).items;
  if(!Array.isArray(raw)||!raw.length)return corsResponse({error:"Передай items: ['название предмета']"},400);
  if(raw.length>6)return corsResponse({error:"За запрос можно проверить максимум 6 предметов, чтобы не исчерпать бесплатную квоту API"},400);
  const items=[...new Set(raw.map(v=>String(v??"").trim()).filter(v=>v.length>1&&v.length<=100&&!blocked(v)))];
  if(!items.length)return corsResponse({error:"Нет корректных названий предметов"},400);
  const mm2=String(asObj(body).context??"mm2").toLowerCase()==="mm2";
  const {results,stats}=await scanBatch(items,mm2);
  let persistence:{ok:boolean;savedItems?:number;error?:string}={ok:true,savedItems:0};
  try{persistence.savedItems=await saveShared(results)}catch(e){persistence={ok:false,error:e instanceof Error?e.message:String(e)}}
  const withOffers=results.filter(r=>r.count>0).length;
  const sourceStatus=[...Object.entries(stats).map(([source,st])=>({source,...st})),{source:"GGSEL",status:"not_connected",scanned:0,requests:0,retries:0,message:"Публичного API поиска не подтверждено."},{source:"Tradly",status:"not_connected",scanned:0,requests:0,retries:0,message:"Публичного API поиска не подтверждено."}];
  return corsResponse({ok:true,status:withOffers===results.length?"offers_found":withOffers?"partial_results":"no_offers_found",updatedAt:new Date().toISOString(),context:mm2?"mm2":"generic",itemCount:results.length,itemsWithOffers:withOffers,persistence,sourceStatus,results,note:"Каждый источник запрашивается один раз на партию; 429/502/503/504 повторяются с паузой. Статус «нет совпадений» не доказывает отсутствие лотов. Цены берутся только из ответов источников."});
});
