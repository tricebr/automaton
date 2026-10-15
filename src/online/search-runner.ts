import type {Database} from 'better-sqlite3';
import {actionContextDigest,assertActionGate,evaluateActionGate,securityTransaction} from '../security/action-gate.js';
import {inferencePhaseSnapshot,observeInferencePhase} from '../inference/phase-budget.js';
import {SEARCH_ENDPOINTS,SEARCH_PROVIDERS,validateSearchTask,inspectSearchResults,type SearchProvider,type SearchTask} from './search-adapters.js';
import {SOURCE_LIMITS} from './sources.js';
import {fixedSearchTransport,type SearchTransport} from './search-transport.js';

export interface SearchAllowance {expiresAt:number;total:number;perProvider:Record<Exclude<SearchProvider,'brave'|'firecrawl'>,number>&Partial<Record<'brave'|'firecrawl',number>>;paidCalls:false}
// Missing newly added providers mean zero authority. Do not normalize stored
// policies: their historical digests and existing scoped reviews must survive.
function providerQuota(p:SearchAllowance,k:SearchProvider){return Object.hasOwn(p.perProvider,k)?p.perProvider[k]!:0;}
function validateAllowance(p:SearchAllowance){
 if(!p||Object.keys(p).sort().join(',')!=='expiresAt,paidCalls,perProvider,total'||p.paidCalls!==false||!Number.isSafeInteger(p.expiresAt)||p.expiresAt<0||
 !Number.isSafeInteger(p.total)||p.total<1||p.total>SOURCE_LIMITS.dailyRequests||!p.perProvider||
 ['serper','tavily','exa','ted'].some(k=>!Object.hasOwn(p.perProvider,k))||Object.keys(p.perProvider).some(k=>!SEARCH_PROVIDERS.includes(k as SearchProvider))||SEARCH_PROVIDERS.some(k=>!Number.isSafeInteger(providerQuota(p,k))||providerQuota(p,k)<0||providerQuota(p,k)>p.total))throw Error('Explicit bounded search allowance required');
 // Technical ceilings, NOT grants. Reviewed remaining free balance may require
 // a much smaller allowance. No monthly reset or cross-workspace replenishment.
 if(providerQuota(p,'brave')>1000||providerQuota(p,'firecrawl')>500)throw Error('Free search technical ceiling exceeded');
}
export function searchScope(policy:SearchAllowance,provider:SearchProvider){
 validateAllowance(policy);if(!SEARCH_PROVIDERS.includes(provider))throw Error('Unknown search provider');
 return {activity:'public-source-search',component:`search-${provider}`,dataClass:'PUBLIC' as const,
 contextDigest:actionContextDigest({version:2,policy,provider,endpoint:SEARCH_ENDPOINTS[provider],maxResults:5,mode:'metadata-only',paidCalls:false})};
}
/** Trusted operator only. No defaults or automatic allowance replenishment. */
export function initializeSearchAllowance(db:Database,policy:SearchAllowance){
 validateAllowance(policy);
 db.transaction(()=>{
  db.exec(`CREATE TABLE IF NOT EXISTS source_search_policy(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL,digest TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS source_search_runs(id TEXT PRIMARY KEY,digest TEXT NOT NULL,provider TEXT NOT NULL,status TEXT NOT NULL,started_ms INTEGER NOT NULL,finished_ms INTEGER,request_id INTEGER NOT NULL,result TEXT);
   CREATE TABLE IF NOT EXISTS source_search_diagnostics(id TEXT PRIMARY KEY REFERENCES source_search_runs(id),payload TEXT NOT NULL);
   CREATE TRIGGER IF NOT EXISTS search_diagnostics_update BEFORE UPDATE ON source_search_diagnostics BEGIN SELECT RAISE(ABORT,'Search diagnostics immutable'); END;
   CREATE TRIGGER IF NOT EXISTS search_diagnostics_delete BEFORE DELETE ON source_search_diagnostics BEGIN SELECT RAISE(ABORT,'Search diagnostics retained'); END;
   CREATE TRIGGER IF NOT EXISTS search_policy_update BEFORE UPDATE ON source_search_policy BEGIN SELECT RAISE(ABORT,'Search allowance immutable'); END;
   CREATE TRIGGER IF NOT EXISTS search_policy_delete BEFORE DELETE ON source_search_policy BEGIN SELECT RAISE(ABORT,'Search allowance immutable'); END;
   CREATE TRIGGER IF NOT EXISTS search_run_delete BEFORE DELETE ON source_search_runs BEGIN SELECT RAISE(ABORT,'Search reservations retained'); END;`);
  const existing=db.prepare('SELECT digest FROM source_search_policy WHERE id=1').get() as {digest:string}|undefined;
  const digest=actionContextDigest(policy);
  if(existing&&existing.digest!==digest)throw Error('Existing search allowance cannot be changed');
  if(!existing)db.prepare('INSERT INTO source_search_policy VALUES(1,?,?)').run(JSON.stringify(policy),digest);
 }).immediate();
}
function policyFor(db:Database){
 const row=db.prepare('SELECT payload,digest FROM source_search_policy WHERE id=1').get() as {payload:string;digest:string}|undefined;
 if(!row)throw Error('Search allowance absent');
 let p=JSON.parse(row.payload) as SearchAllowance;validateAllowance(p);
 if(actionContextDigest(p)!==row.digest)throw Error('Search allowance integrity failure');
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='source_search_extensions'").get()){
  const extensions=db.prepare('SELECT payload,previous_digest,digest FROM source_search_extensions ORDER BY sequence').all() as {payload:string;previous_digest:string;digest:string}[];
  for(const e of extensions){
   const next=JSON.parse(e.payload) as SearchAllowance;validateAllowance(next);
   if(e.previous_digest!==actionContextDigest(p)||e.digest!==actionContextDigest(next)||next.total<p.total||SEARCH_PROVIDERS.some(k=>providerQuota(next,k)<providerQuota(p,k)))throw Error('Search extension integrity failure');
   p=next;
  }
 }return p;
}
/** Read-only technical metrics, not a demand or profitability claim. */
export function searchConnectorSnapshot(db:Database){
 const availability=searchAvailability(db);
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='source_search_policy'").get())return {state:'BLOCKED',reason:'SEARCH_ALLOWANCE_ABSENT',providers:SEARCH_PROVIDERS,availability};
 const policy=policyFor(db);
 const hasDiagnostics=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='source_search_diagnostics'").get();
 const diagnostics=hasDiagnostics?db.prepare('SELECT id,payload FROM source_search_diagnostics').all() as {id:string;payload:string}[]:[];
 const runs=db.prepare('SELECT provider,status,started_ms,finished_ms,result FROM source_search_runs').all() as {provider:SearchProvider;status:string;started_ms:number;finished_ms:number|null;result:string|null}[];
 return {policy,availability,reservedRequests:runs.length,diagnostics:diagnostics.map(r=>({id:r.id,...JSON.parse(r.payload)})),legacyOrUnfinishedWithoutDiagnostics:runs.length-diagnostics.length,providers:SEARCH_PROVIDERS.map(provider=>{
  const rows=runs.filter(r=>r.provider===provider);
  return {provider,review:evaluateActionGate(db,searchScope(policy,provider),Date.now(),['public-source-egress','public-source-terms','search-free-credit-ceiling']),
   attempts:rows.length,completed:rows.filter(r=>r.status==='done').length,unresolved:rows.filter(r=>r.status!=='done').length,
   metadataResults:rows.reduce((n,r)=>n+(r.result?(JSON.parse(r.result) as unknown[]).length:0),0),
   elapsedMs:rows.reduce((n,r)=>n+(r.finished_ms===null?0:r.finished_ms-r.started_ms),0),verifiedPayments:0};
 })};
}
/** Content-free read projection. Readiness never grants dispatch authority. */
export function searchAvailability(db:Database,now=Date.now()){
 const explanations:Record<string,string>={
  INVALID_CLOCK:'Die lokale Zeit ist ungültig.',SEARCH_ALLOWANCE_ABSENT:'Für diesen Arbeitsbereich fehlt ein Suchkontingent.',
  ALLOWANCE_EXPIRED:'Das Suchkontingent ist abgelaufen.',UNRESOLVED_REQUEST:'Ein früherer Abruf ist ungeklärt; keine automatische Wiederholung.',
  QUOTA_EXHAUSTED:'Das freigegebene Suchkontingent ist verbraucht.',SHARED_SOURCE_QUOTA_EXHAUSTED:'Das gemeinsame Quellenkontingent ist verbraucht.',
  PHASE_INACTIVE:'Die Paper-Phase fehlt, ist gestoppt oder liegt außerhalb ihres Zeitfensters.',
  CONTROLLER_NOT_RUNNING:'Der Controller läuft nicht.',STATE_UNVERIFIABLE:'Der gespeicherte Zustand ist nicht verlässlich prüfbar.',
  CREDENTIALS_AND_REMOTE_FREE_BALANCE_UNVERIFIED:'Lokale Voraussetzungen erfüllt; Zugang und verbleibendes Gratisguthaben beim Anbieter sind ungeprüft.'
 };
 return SEARCH_PROVIDERS.map(provider=>{
  const result=(state:string,reason:string)=>({provider,adapterPresent:true,state,reason,
   stage:state==='LOCALLY_ELIGIBLE'?'READY_LOCAL':reason.includes('QUOTA')?'QUOTA_EXHAUSTED':reason==='STATE_UNVERIFIABLE'?'UNAVAILABLE':
    reason==='CONTROLLER_NOT_RUNNING'||reason==='PHASE_INACTIVE'?'NOT_RUNNING':reason==='UNRESOLVED_REQUEST'?'REVIEW_REQUIRED':'APPROVAL_MISSING',
   explanation:explanations[reason]??'Eine erforderliche Quellen-, Sicherheits- oder Nutzungsprüfung fehlt, ist veraltet oder sperrt diesen Abruf.',
   credentialsVerified:false,executionAuthorized:false});
  try{
   if(!Number.isSafeInteger(now)||now<0)return result('BLOCKED','INVALID_CLOCK');
   if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='source_search_policy'").get())return result('BLOCKED','SEARCH_ALLOWANCE_ABSENT');
   const p=policyFor(db);
   if(now>=p.expiresAt)return result('BLOCKED','ALLOWANCE_EXPIRED');
   const rows=db.prepare('SELECT provider,status FROM source_search_runs').all() as {provider:string;status:string}[];
   if(rows.some(r=>r.provider===provider&&r.status!=='done'))return result('BLOCKED','UNRESOLVED_REQUEST');
   if(rows.length>=p.total||rows.filter(r=>r.provider===provider).length>=providerQuota(p,provider))return result('BLOCKED','QUOTA_EXHAUSTED');
     const spent=db.prepare("SELECT SUM(created_at>=datetime('now','-1 hour')) hourly,SUM(date(created_at)=date('now')) daily FROM online_requests").get() as {hourly:number;daily:number};
     if(spent.hourly>=SOURCE_LIMITS.hourlyRequests||spent.daily>=SOURCE_LIMITS.dailyRequests)return result('BLOCKED','SHARED_SOURCE_QUOTA_EXHAUSTED');
   const review=evaluateActionGate(db,searchScope(p,provider),now,['public-source-egress','public-source-terms','search-free-credit-ceiling']);
   if(review.state!=='APPROVED')return result('BLOCKED',`${review.state}:${review.reason}`);
   const phase=inferencePhaseSnapshot(db);
   if(!phase||phase.halted||now<phase.starts_ms||now<phase.last_ms||now>=phase.ends_ms)return result('BLOCKED','PHASE_INACTIVE');
   const control=db.prepare('SELECT status FROM online_control WHERE id=1').get() as {status:string}|undefined;
   if(control?.status!=='running')return result('BLOCKED','CONTROLLER_NOT_RUNNING');
   return result('LOCALLY_ELIGIBLE','CREDENTIALS_AND_REMOTE_FREE_BALANCE_UNVERIFIED');
  }catch{return result('BLOCKED','STATE_UNVERIFIABLE');}
 });
}
function admit(db:Database,p:SearchAllowance,provider:SearchProvider){
 const now=Date.now();observeInferencePhase(db,now);const phase=inferencePhaseSnapshot(db);
 if(!phase||phase.halted||now<phase.starts_ms||now>=phase.ends_ms||now>=p.expiresAt)throw Error('Active search phase and allowance required');
 if((db.prepare('SELECT status FROM online_control WHERE id=1').get() as {status:string}|undefined)?.status!=='running')throw Error('Search research stopped');
 assertActionGate(db,searchScope(p,provider),now,['public-source-egress','public-source-terms','search-free-credit-ceiling']);
}
/** Persistent at-most-once dispatch. Pending/failed requests consume allowance
 * and block their provider until trusted investigation; crashes never refund.
 * A provider review must establish no paid overage and a sufficient free balance.
 * Local counts cannot verify a provider's remotely changed billing settings. */
export async function runSourceSearch(db:Database,id:string,task:SearchTask,transport:SearchTransport=fixedSearchTransport){
 validateSearchTask(task);if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id))throw Error('Bounded request ID required');
 task=Object.freeze({...task});
 const p=policyFor(db),digest=actionContextDigest(task);
 const admission=securityTransaction(db,()=>{
  admit(db,p,task.provider);
  const old=db.prepare('SELECT digest,status FROM source_search_runs WHERE id=?').get(id) as {digest:string;status:string}|undefined;
  if(old){if(old.digest!==digest)throw Error('Conflicting search request ID');throw Error('Search request already reserved; no automatic redispatch');}
  const rows=db.prepare('SELECT provider,status FROM source_search_runs').all() as {provider:string;status:string}[];
  if(rows.length>=p.total||rows.filter(r=>r.provider===task.provider).length>=providerQuota(p,task.provider))throw Error('Search allowance exhausted');
  if(rows.some(r=>r.provider===task.provider&&r.status!=='done'))throw Error('Search provider requires review after unresolved request');
  const spent=db.prepare("SELECT SUM(created_at>=datetime('now','-1 hour')) hourly,SUM(date(created_at)=date('now')) daily FROM online_requests").get() as {hourly:number;daily:number};
  if(spent.hourly>=SOURCE_LIMITS.hourlyRequests||spent.daily>=SOURCE_LIMITS.dailyRequests)throw Error('Shared source quota exhausted');
  const requestId=db.prepare("INSERT INTO online_requests(source,status) VALUES(?,'reserved')").run(new URL(SEARCH_ENDPOINTS[task.provider]).hostname).lastInsertRowid;
  db.prepare("INSERT INTO source_search_runs VALUES(?,?,?,'pending',?,NULL,?,NULL)").run(id,digest,task.provider,Date.now(),requestId);
  return requestId;
 }).immediate();
 const controller=new AbortController();
 let timeout:ReturnType<typeof setTimeout>|undefined;
 try{
  const raw=await Promise.race([transport(task,controller.signal,()=>securityTransaction(db,()=>admit(db,p,task.provider)).immediate()),new Promise<never>((_resolve,reject)=>{
   timeout=setTimeout(()=>{controller.abort();reject(Error('Search timeout'));},15000);
  })]);
  const encoded=JSON.stringify(raw);if(typeof encoded!=='string'||Buffer.byteLength(encoded)>SOURCE_LIMITS.responseBytes)throw Error('Search response too large');
  const inspection=inspectSearchResults(task,raw,Date.now()),results=inspection.results;
  securityTransaction(db,()=>{
   admit(db,p,task.provider);
   db.prepare("UPDATE source_search_runs SET status='done',finished_ms=?,result=? WHERE id=? AND status='pending'").run(Date.now(),JSON.stringify(results),id);
   db.prepare('INSERT INTO source_search_diagnostics VALUES(?,?)').run(id,JSON.stringify({state:inspection.state,...inspection.diagnostics}));
   db.prepare("UPDATE online_requests SET status='received',bytes=? WHERE id=?").run(Buffer.byteLength(encoded),admission);
  }).immediate();
  return results;
 }catch{
  db.transaction(()=>{
   db.prepare("UPDATE source_search_runs SET status='failed',finished_ms=? WHERE id=? AND status='pending'").run(Date.now(),id);
   db.prepare("UPDATE online_requests SET status='failed' WHERE id=?").run(admission);
  }).immediate();
  throw Error('Search failed or approval changed; reservation retained and provider blocked');
 }finally{clearTimeout(timeout);controller.abort();}
}

/** Trusted operator entry only, never exposed as an agent tool. Explicit Founder
 * authorization adds a new immutable receipt; historical reservations survive. */
export function extendSearchAllowance(db:Database,id:string,additional:SearchAllowance,authorization:string){
 validateAllowance(additional);
 if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id)||!/^founder:[a-zA-Z0-9_-]{8,100}$/.test(authorization))throw Error('Explicit Founder receipt required');
 return db.transaction(()=>{
  db.exec(`CREATE TABLE IF NOT EXISTS source_search_extensions(sequence INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,previous_digest TEXT NOT NULL,digest TEXT NOT NULL,request_digest TEXT NOT NULL,authorization TEXT NOT NULL);
   CREATE TRIGGER IF NOT EXISTS search_extension_update BEFORE UPDATE ON source_search_extensions BEGIN SELECT RAISE(ABORT,'Search extension immutable'); END;
   CREATE TRIGGER IF NOT EXISTS search_extension_delete BEFORE DELETE ON source_search_extensions BEGIN SELECT RAISE(ABORT,'Search extension retained'); END;`);
  const requestDigest=actionContextDigest({additional,authorization});
  const old=db.prepare('SELECT request_digest FROM source_search_extensions WHERE id=?').get(id) as {request_digest:string}|undefined;
  if(old){if(old.request_digest!==requestDigest)throw Error('Conflicting search extension');return policyFor(db);}
  const now=Date.now();
  if(additional.expiresAt<=now||additional.expiresAt>now+86400000)throw Error('Search extension must expire within 24 hours');
  if(db.prepare("SELECT 1 FROM source_search_runs WHERE status!='done'").get())throw Error('Unresolved search holds require investigation');
  const p=policyFor(db),next:SearchAllowance={...p,total:p.total+additional.total,expiresAt:additional.expiresAt,perProvider:{...p.perProvider}};
  for(const provider of SEARCH_PROVIDERS){if(Object.hasOwn(p.perProvider,provider)||Object.hasOwn(additional.perProvider,provider))next.perProvider[provider]=providerQuota(p,provider)+providerQuota(additional,provider);}
  validateAllowance(next);
  db.prepare('INSERT INTO source_search_extensions(id,payload,previous_digest,digest,request_digest,authorization) VALUES(?,?,?,?,?,?)').run(id,JSON.stringify(next),actionContextDigest(p),actionContextDigest(next),requestDigest,authorization);
  return next;
 }).immediate();
}
