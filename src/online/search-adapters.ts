import {isIP} from 'node:net';
import {assertModelPrivacy} from '../security/privacy-egress.js';
import {registerLogSecrets} from '../observability/redaction.js';

export const SEARCH_PROVIDERS=['serper','tavily','exa','ted','brave','firecrawl'] as const;
export type SearchProvider=typeof SEARCH_PROVIDERS[number];
export const SEARCH_ENDPOINTS=Object.freeze({serper:'https://google.serper.dev/search',tavily:'https://api.tavily.com/search',exa:'https://api.exa.ai/search',ted:'https://api.ted.europa.eu/v3/notices/search',brave:'https://api.search.brave.com/res/v1/web/search',firecrawl:'https://api.firecrawl.dev/v2/search'});
export interface SearchTask {provider:SearchProvider;query:string;limit:number}
export interface SearchResult {url:string;title:string;publishedAt:string|null;provider:SearchProvider;observedAt:number;evidence:'PUBLIC_INDICATOR';trusted:false}
export function validSearchCredential(provider:SearchProvider,value:unknown):value is string{
 return provider!=='ted'&&SEARCH_PROVIDERS.includes(provider)&&typeof value==='string'&&/^[A-Za-z0-9_-]{16,4096}$/.test(value)&&!value.startsWith('sk-')&&
  (provider==='tavily'?value.startsWith('tvly-'):!value.startsWith('tvly-'))&&
  (provider==='firecrawl'?value.startsWith('fc-'):!value.startsWith('fc-'));
}
export function validateSearchTask(task:SearchTask){
 if(!task||Object.keys(task).sort().join(',')!=='limit,provider,query'||!SEARCH_PROVIDERS.includes(task.provider)||
 typeof task.query!=='string'||!/^\p{L}[\p{L}\p{N} -]{2,199}$/u.test(task.query)||!Number.isInteger(task.limit)||task.limit<1||task.limit>5)throw Error('Invalid bounded public search task');
 assertModelPrivacy(task);
}
/** Only the trusted transport receives credentials; this is not an agent tool. */
export function searchRequest(task:SearchTask,credential?:string){
 validateSearchTask(task);
 const headers:Record<string,string>={'content-type':'application/json','accept':'application/json'};
 if(task.provider!=='ted'){
  if(!validSearchCredential(task.provider,credential))throw Error('Search credential unavailable or mismatched');
  registerLogSecrets([credential]);
  const bearer=task.provider==='tavily'||task.provider==='firecrawl';
  headers[bearer?'authorization':task.provider==='brave'?'x-subscription-token':'x-api-key']=bearer?`Bearer ${credential}`:credential;
 }else if(credential!==undefined)throw Error('TED search must be anonymous');
 if(task.provider==='brave'){
  const url=new URL(SEARCH_ENDPOINTS.brave);
  url.search=new URLSearchParams({q:task.query,count:String(task.limit),result_filter:'web',text_decorations:'false',extra_snippets:'false',safesearch:'strict'}).toString();
  return {url:url.href,method:'GET' as const,headers,body:''};
 }
 const body=task.provider==='firecrawl'?{query:task.query,limit:task.limit,sources:['web'],domainTools:false,highlights:false,timeout:10000}:task.provider==='serper'?{q:task.query,num:task.limit}:task.provider==='tavily'?{
  query:task.query,max_results:task.limit,search_depth:'basic',auto_parameters:false,include_answer:false,include_raw_content:false,include_images:false,include_usage:true
 }:task.provider==='exa'?{query:task.query,numResults:task.limit,type:'instant'}:{
  query:`FT ~ "${task.query}"`,fields:['publication-number','notice-title','publication-date'],limit:task.limit,page:1,scope:'ACTIVE',checkQuerySyntax:true
 };
 return {url:SEARCH_ENDPOINTS[task.provider],method:'POST' as const,headers,body:JSON.stringify(body)};
}
export function safeSearchUrl(value:unknown):string{
 if(typeof value!=='string'||value.length>1500)throw Error('Invalid result URL');
 const u=new URL(value);
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||isIP(u.hostname)||
 !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(u.hostname)||/(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(u.hostname))throw Error('Unsafe result URL');
 assertModelPrivacy(value);return u.href;
}
function metadataText(value:unknown):unknown{
 if(Array.isArray(value))return value.length===1&&typeof value[0]==='string'?value[0]:undefined;
 if(value&&typeof value==='object'){
  const record=value as Record<string,unknown>;
  for(const language of ['eng','deu','fra','ita','en','de','fr','it']){
   const candidate=record[language];if(typeof candidate==='string')return candidate;
   if(Array.isArray(candidate)&&candidate.length===1&&typeof candidate[0]==='string')return candidate[0];
  }return undefined;
 }return value;
}
/** No returned link is fetched. Extra fields, snippets, contact data and raw pages are discarded. */
export function inspectSearchResults(task:SearchTask,raw:unknown,now:number){
 validateSearchTask(task);
 if(!Number.isSafeInteger(now)||now<0||!raw||typeof raw!=='object')throw Error('Invalid search response');
 const root=raw as Record<string,unknown>;
 if(task.provider==='firecrawl'&&root.success!==true)throw Error('Search provider did not confirm success');
 const items=task.provider==='brave'?(root.web as Record<string,unknown>|undefined)?.results:
  task.provider==='firecrawl'?(root.data as Record<string,unknown>|undefined)?.web:root[task.provider==='serper'?'organic':task.provider==='ted'?'notices':'results'];
 if(!Array.isArray(items)||items.length>100)throw Error('Search result schema rejected');
 const results:SearchResult[]=[],seen=new Set<string>();
 const diagnostics={rawRecords:items.length,examined:Math.min(items.length,task.limit),beyondLimit:Math.max(0,items.length-task.limit),accepted:0,rejected:0,missingOrInvalidDates:0,futureDates:0};
 for(const item of items.slice(0,task.limit)){
  try{
   if(!item||typeof item!=='object')continue;
   const r=item as Record<string,unknown>;
   const number=metadataText(r['publication-number']);
   const url=safeSearchUrl(task.provider==='ted'&&typeof number==='string'&&/^\d{1,8}-\d{4}$/.test(number)?`https://ted.europa.eu/en/notice/-/detail/${number}`:task.provider==='serper'?r.link:r.url);
   const title=metadataText(r.title??r['notice-title']);
   if(typeof title!=='string'||title.length<1||title.length>500||/[<>]/.test(title)||[...title].some(c=>c.charCodeAt(0)<32))continue;
   assertModelPrivacy(title);
   if(/\b(ignore.{0,30}instructions|system prompt|seed phrase|private key|guaranteed profit|execute.{0,15}command)\b/i.test(title))continue;
   if(seen.has(url))continue;seen.add(url);
   const date=metadataText(r.publishedDate??r.published_date??r['publication-date']);
   let publishedAt=typeof date==='string'&&/^\d{4}-\d{2}-\d{2}(?:T[0-9:.+-]+Z?)?$/.test(date)&&Number.isFinite(Date.parse(date))?new Date(date).toISOString():null;
   if(publishedAt&&typeof date==='string'){
    const day=date.slice(0,10),calendar=new Date(day+'T00:00:00Z');
    if(!Number.isFinite(calendar.getTime())||calendar.toISOString().slice(0,10)!==day)publishedAt=null;
   }
   if(publishedAt&&Date.parse(publishedAt)>now){diagnostics.futureDates++;publishedAt=null;}
   if(!publishedAt)diagnostics.missingOrInvalidDates++;
   results.push({url,title,publishedAt,provider:task.provider,observedAt:now,evidence:'PUBLIC_INDICATOR',trusted:false});
  }catch{/* Reject individual unsafe metadata; never log provider content. */}
 }
 diagnostics.accepted=results.length;diagnostics.rejected=diagnostics.examined-results.length;
 return {results,diagnostics,state:items.length===0?'UPSTREAM_EMPTY':results.length===0?'ALL_EXAMINED_REJECTED':'METADATA_ACCEPTED'};
}

/** Compatibility API; callers needing diagnosis must retain the detailed result. */
export function parseSearchResults(task:SearchTask,raw:unknown,now:number):SearchResult[]{
 return inspectSearchResults(task,raw,now).results;
}
/** Offline formulations only. Topics come from discovered evidence, never a fixed niche.
 * TED retains its existing expert-query syntax; shorter topics test phrase sensitivity.
 * This does not grant permission, reserve quota or perform a search. */
export function planBuyerSearches(provider:SearchProvider,topic:string):SearchTask[]{
 const queries=provider==='ted'?[topic]:[
  `${topic} request for proposal submission deadline`,
  `${topic} invitation to tender scope budget`,
  `${topic} procurement notice requirements closing date`,
 ];
 const tasks=queries.map(query=>({provider,query,limit:5}));
 for(const task of tasks)validateSearchTask(task);
 return tasks;
}
