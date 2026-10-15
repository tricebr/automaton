import fs from 'node:fs';
import path from 'node:path';
import {readFounderFX,convertToCHF} from './founder-fx.mjs';
export const NUMARON_PROJECT='proj_3tQeMqMjQTAFkQG46xhCnTnB';
const ACCOUNT='da816784a570dcec0320ba309cc0c2e2';
async function get(url,key,request){
 const response=await request(url,{method:'GET',headers:{Authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Error('HTTP '+response.status);
 return response.json();
}
export async function readOpenAIBilling(key,{request=fetch,now=Date.now()}={}){
 const dayStart=Math.floor(now/86400000)*86400,start=dayStart-365*86400,end=dayStart+86400;
 const rows=[];let page;const seen=new Set();
 for(let n=0;n<12;n++){
  const url=new URL('https://api.openai.com/v1/organization/costs');
  for(const [k,v] of Object.entries({start_time:start,end_time:end,limit:180,bucket_width:'1d','project_ids[]':NUMARON_PROJECT,'group_by[]':'project_id',...(page?{page}:{})}))url.searchParams.set(k,String(v));
  const data=await get(url,key,request);if(!Array.isArray(data.data))throw Error('Invalid costs');
  for(const bucket of data.data){if(!Number.isFinite(bucket.start_time)||!Array.isArray(bucket.results))throw Error('Invalid bucket');for(const r of bucket.results){if(r.project_id!==NUMARON_PROJECT||typeof r.amount?.value!=='number'||!Number.isFinite(r.amount.value)||r.amount.value<0||r.amount.currency?.toLowerCase()!=='usd')throw Error('Unverified project cost');rows.push({day:new Date(bucket.start_time*1000).toISOString().slice(0,10),amount:r.amount.value,currency:'USD'});}}
  if(!data.has_more)return {provider:'OpenAI',status:'connected',scope:'numaron-Projekt',from:new Date(start*1000).toISOString().slice(0,10),rows,dayBasis:'UTC',note:'Tatsächliche Nutzung in USD; CHF-Abgleich und Rechnung können zeitlich abweichen.'};
  if(typeof data.next_page!=='string'||seen.has(data.next_page))throw Error('Invalid pagination');page=data.next_page;seen.add(page);
 }
 throw Error('Incomplete costs');
}
export async function readCloudflareBilling(key,{request=fetch}={}){
 const rows=[],seen=new Set();
 for(let page=1;page<=20;page++){
  const data=await get(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/billing/history?per_page=50&page=${page}`,key,request);
  if(data.success!==true||!Array.isArray(data.result))throw Error('Invalid billing history');
  for(const r of data.result){if(typeof r.id!=='string'||seen.has(r.id))continue;seen.add(r.id);if(!Number.isFinite(r.amount)||!['USD','CHF','EUR'].includes(r.currency?.toUpperCase())||!Number.isFinite(Date.parse(r.occurred_at)))throw Error('Invalid billing entry');rows.push({reference:'cloudflare-history:'+r.id,day:new Date(r.occurred_at).toISOString().slice(0,10),amount:r.amount,currency:r.currency.toUpperCase(),type:String(r.type??''),action:String(r.action??''),status:String(r.status??''),description:String(r.description??'').slice(0,160)});}
  const info=data.result_info??{};
  if(info.next_page===false||(Number.isFinite(info.total_count)&&page*50>=info.total_count)||(!info.next_page&&data.result.length<50))return {provider:'Cloudflare',status:'connected',scope:'Gesamtes Cloudflare-Konto',rows,dayBasis:'UTC',note:'Abrechnungseinträge sind kontoweit; Zahlungen und Rechnungen werden nicht doppelt als Ausgabe gebucht.'};
 }
 throw Error('Incomplete billing history');
}
export function openFounderBilling(base,{request=fetch,now=()=>Date.now(),isEnabled=()=>true}={}){
 const file=path.join(base,'artifacts/founder-integration-20261012/billing-feed.json');
 let state={checkedAt:null,providers:[]};try{state=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
 let running=false,timer,abort=new AbortController();
 const gatedRequest=(url,options={})=>{if(!isEnabled())throw Error('Numaron ausgeschaltet');return request(url,{...options,signal:AbortSignal.any([options.signal,abort.signal].filter(Boolean))});};
 async function refresh(){if(running||!isEnabled())return;running=true;try{
  const envFile=path.join(base,'.env.local');if(fs.lstatSync(envFile).isSymbolicLink())throw Error('Invalid credentials file');
  const env=fs.readFileSync(envFile,'utf8');const key=name=>env.match(new RegExp('^'+name+'=([^\\r\\n]+)$','m'))?.[1];
  const providers=await Promise.all([['OpenAI','OPENAI_BILLING_ADMIN_KEY',readOpenAIBilling],['Cloudflare','CLOUDFLARE_BILLING_TOKEN',readCloudflareBilling]].map(async([provider,name,read])=>{try{const secret=key(name);if(!secret)return {provider,status:'not-configured',rows:[]};return {...await read(secret,{request:gatedRequest,now:now()}),observedAt:new Date(now()).toISOString()};}catch{const prior=state.providers?.find(p=>p.provider===provider&&['connected','stale'].includes(p.status));return prior?{...prior,status:'stale',note:'Abruf fehlgeschlagen; letzter gespeicherter Kostenstand verwendet.'}:{provider,status:'unavailable',rows:[],note:'Abruf fehlgeschlagen; fehlende Daten werden nicht als Nullkosten gewertet.'};}}));
  const fx=await readFounderFX(base,{request:gatedRequest,now:now()});
  for(const provider of providers)provider.rows=provider.rows.map(r=>({...r,reference:provider.provider==='OpenAI'?`openai-usage:${NUMARON_PROJECT}:${r.day}:${r.amount.toFixed(10)}`:r.reference,...(convertToCHF(r.amount,r.currency,r.day,fx.rates)??{amountCHF:null})}));
  state={checkedAt:new Date(now()).toISOString(),providers,fx:{checkedAt:fx.checkedAt,source:fx.source,stale:!!fx.stale,unavailable:!!fx.unavailable}};fs.writeFileSync(file,JSON.stringify(state,null,2));
 }catch{state={checkedAt:new Date(now()).toISOString(),providers:[{provider:'OpenAI',status:'unavailable',rows:[]},{provider:'Cloudflare',status:'unavailable',rows:[]}]};}finally{running=false;}}
 return {refresh,snapshot:()=>structuredClone(state),start(){if(timer)return;abort=new AbortController();void refresh();timer=setInterval(()=>void refresh(),15*60*1000);timer.unref();},pause(){abort.abort();clearInterval(timer);timer=null;},close(){clearInterval(timer);timer=null;}};
}
