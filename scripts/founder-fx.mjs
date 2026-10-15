import fs from 'node:fs';
import path from 'node:path';
export const FX_SOURCE='https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml';
export function parseEcbRates(xml){
 if(typeof xml!=='string'||xml.length>10000000)throw Error('Invalid exchange-rate feed');
 const rates=[],seen=new Set();
 for(const match of xml.matchAll(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>([\s\S]*?)<\/Cube>/g)){
  const day=match[1];if(seen.has(day)||new Date(day+'T12:00Z').toISOString().slice(0,10)!==day)throw Error('Invalid rate date');seen.add(day);
  const values={EUR:1};for(const r of match[2].matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]\s*\/>/g)){const value=Number(r[2]);if(!Number.isFinite(value)||value<=0||values[r[1]])throw Error('Invalid exchange rate');values[r[1]]=value;}
  if(!values.CHF||!values.USD)throw Error('Missing CHF/USD rates');rates.push({day,USD:values.CHF/values.USD,EUR:values.CHF});
 }
 if(!rates.length)throw Error('Empty exchange-rate feed');return rates.sort((a,b)=>b.day.localeCompare(a.day));
}
export function convertToCHF(amount,currency,day,rates){
 if(!Number.isFinite(amount)||!/^\d{4}-\d{2}-\d{2}$/.test(day??''))return null;
 if(currency.toUpperCase()==='CHF')return {amountCHF:amount,rate:1,rateDay:day,rateSource:'Original CHF-Betrag'};
 const row=rates.find(r=>r.day<=day&&Number.isFinite(r[currency.toUpperCase()])&&r[currency.toUpperCase()]>0);
 if(!row||Date.parse(day)-Date.parse(row.day)>7*86400000)return null;
 return {amountCHF:amount*row[currency.toUpperCase()],rate:row[currency.toUpperCase()],rateDay:row.day,rateSource:FX_SOURCE};
}
export async function readFounderFX(base,{request=fetch,now=Date.now()}={}){
 const file=path.join(base,'artifacts/founder-integration-20261012/billing-fx.json');let cache;
 try{cache=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
 if(cache&&Array.isArray(cache.rates)&&now-Date.parse(cache.checkedAt)<6*3600000)return cache;
 try{
  const response=await request(FX_SOURCE,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000),headers:cache?.etag?{'If-None-Match':cache.etag}:{}});
  if(response.status===304&&cache){cache.checkedAt=new Date(now).toISOString();fs.writeFileSync(file,JSON.stringify(cache));return cache;}
  if(!response.ok)throw Error('FX unavailable');const rates=parseEcbRates(await response.text()).filter(r=>Date.parse(r.day)>=now-1100*86400000);
  cache={checkedAt:new Date(now).toISOString(),source:FX_SOURCE,etag:response.headers.get('etag'),rates};fs.writeFileSync(file,JSON.stringify(cache));return cache;
 }catch{return cache?{...cache,stale:true}:{checkedAt:null,source:FX_SOURCE,rates:[],unavailable:true};}
}
