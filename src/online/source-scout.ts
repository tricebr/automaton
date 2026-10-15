import {createHash} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {DIVERSE_SOURCES,opportunitySourceCandidates,type SourceKind} from './source-catalog.js';
import {assertModelPrivacy} from '../security/privacy-egress.js';
import {searchAvailability} from './search-runner.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exists=(db:Database,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const demandKinds:readonly SourceKind[]=['procurement_notice','problem_report','bounty_program'];
const intents=[
 {id:'buyer-requests',query:'public buyer requests requests for proposals budget deadline API terms',purpose:'Find explicit purchase intent with scope, budget and date'},
 {id:'recurring-problems',query:'public customer feature requests recurring problems alternatives API terms',purpose:'Find recurring unmet needs and counterevidence; not proof of willingness to pay'},
 {id:'paid-opportunities',query:'public procurement subcontract research quality assurance open opportunities API',purpose:'Find bounded paid work across sectors; check eligibility and rights'},
 {id:'better-delivery-methods',query:'official documentation reliable data software automation validation performance methods',purpose:'Discover better quality, speed and reuse methods; require matched independent validation before adoption'},
 {id:'safer-cheaper-methods',query:'official documentation automation isolation security context caching cost benchmarks',purpose:'Discover security and cash-efficiency candidates; verify threat relevance, complete costs and quality independently'},
 {id:'new-recurring-business-paths',query:'public recurring buyer requests service problems alternatives willingness to pay',purpose:'Explore new repeatable business paths across sectors; verify payer, reachable channel, eligibility and conservative economics'},
] as const;
export interface SourceHint {url:string;originUrl:string;observedAt:number;excerpt:string}
/** Canonical hostname only. A hint is never fetched, resolved or added to the allowlist. */
function publicOrigin(value:string){
 const u=new URL(value);
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||value.length>1500||
   !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(u.hostname)||
   /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(u.hostname))throw Error('Unusable source hint');
 return u.origin;
}
function schema(db:Database){db.exec(`CREATE TABLE IF NOT EXISTS source_scout_hints(id TEXT PRIMARY KEY,origin TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS source_scout_searches(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS source_scout_hint_no_update BEFORE UPDATE ON source_scout_hints BEGIN SELECT RAISE(ABORT,'Source provenance immutable'); END;`);}
/** Already-read, minimized public evidence only. No caller can approve the source. */
export function recordSourceHints(db:Database,hints:readonly SourceHint[],now=Date.now()){
 if(!Array.isArray(hints)||hints.length>30||!Number.isSafeInteger(now)||now<0)throw Error('Bounded source hints required');
 return db.transaction(()=>{schema(db);let inserted=0;
  for(const hint of hints){
   if(!hint||Object.keys(hint).sort().join(',')!=='excerpt,observedAt,originUrl,url'||typeof hint.excerpt!=='string'||hint.excerpt.length>1000||
    !Number.isSafeInteger(hint.observedAt)||hint.observedAt>now||hint.observedAt<now-30*86400000)throw Error('Invalid source provenance');
   assertModelPrivacy(hint);const origin=publicOrigin(hint.url);publicOrigin(hint.originUrl);
   if(DIVERSE_SOURCES.some(s=>new URL(s.endpoint).origin===origin))continue;
   const payload=JSON.stringify(hint),digest=hash(hint),id=hash([origin,hint.originUrl]);
   const old=db.prepare('SELECT digest FROM source_scout_hints WHERE id=?').get(id) as {digest:string}|undefined;
   if(old){if(old.digest!==digest)continue;continue;}
   if((db.prepare('SELECT COUNT(*) n FROM source_scout_hints').get() as {n:number}).n>=200)throw Error('Source hint capacity requires review');
   inserted+=db.prepare('INSERT INTO source_scout_hints VALUES(?,?,?,?)').run(id,origin,payload,digest).changes;
  }return inserted;
 }).immediate();
}
/** Generates bounded, sector-open search objectives. No pretend search execution. */
export function planSourceSearches(db:Database){
 db.transaction(()=>{schema(db);for(const task of intents)db.prepare('INSERT OR IGNORE INTO source_scout_searches VALUES(?,?)').run(task.id,JSON.stringify(task));}).immediate();
}
/** Extract literal references from permitted, filtered text; never follow them. */
export function collectSourceHints(db:Database,signals:readonly {sourceUrl:string;excerpt:string}[],now=Date.now()){
 if(signals.length>8)throw Error('Bounded signal batch required');
 let inserted=0;
 for(const signal of signals){
  for(const url of (signal.excerpt.match(/https:\/\/[^\s<>"']+/g)??[]).slice(0,3)){
   const hint={url,originUrl:signal.sourceUrl,observedAt:now,excerpt:signal.excerpt.slice(0,1000)};
   try{publicOrigin(url);publicOrigin(hint.originUrl);assertModelPrivacy(hint);}catch{continue;}
   inserted+=recordSourceHints(db,[hint],now);
  }
 }return inserted;
}
export function sourceLearning(db:Database){
 if(!exists(db,'source_diversity_runs'))return [];
 const rows=db.prepare("SELECT source_id,COUNT(*) attempts,SUM(status='done') successes,SUM(status='failed') failures,SUM(seen) seen,SUM(accepted) accepted,SUM(bytes) bytes,SUM(elapsed_ms) elapsedMs FROM source_diversity_runs WHERE status IN ('done','failed') GROUP BY source_id").all() as {source_id:string;attempts:number;successes:number;failures:number;seen:number;accepted:number;bytes:number;elapsedMs:number}[];
 return rows.map(r=>({...r,signalYield:r.seen>0?r.accepted/r.seen:0,
  // Bounded shrinkage: one lucky read must not dominate indefinitely.
  technicalUtility:(r.accepted+1)/(r.seen+4)*(r.successes+1)/(r.attempts+2),
  evidenceLevel:'technical-prefilter-only',verifiedCustomers:0,verifiedPayments:0,
  lesson:r.attempts<3?'Insufficient sample; preserve exploration':r.failures>r.successes?'Frequent failures; prefer reliable alternatives':r.accepted===0?'No fresh usable signals; deprioritize without declaring no demand':'Useful prefiltered signals; validate actual demand separately'}));
}
/** Only called AFTER permission/cooldown filters. Learning never creates permission. */
export function prioritizeSourceIds(db:Database,ids:readonly string[]){
 const learning=sourceLearning(db),known=new Map(DIVERSE_SOURCES.map(s=>[s.id,s]));
 if(ids.some(id=>!known.has(id))||new Set(ids).size!==ids.length)throw Error('Known unique sources required');
 return [...ids].sort((a,b)=>{
  const x=learning.find(r=>r.source_id===a),y=learning.find(r=>r.source_id===b);
  // Fewer attempts first prevents permanent source starvation; within one
  // exploration round, prefer direct demand signals and measured technical yield.
  return Math.floor((x?.attempts??0)/3)-Math.floor((y?.attempts??0)/3)||
   Number(demandKinds.includes(known.get(b)!.kind))-Number(demandKinds.includes(known.get(a)!.kind))||
   (y?.technicalUtility??0.5)-(x?.technicalUtility??0.5)||a.localeCompare(b);
 });
}
export function sourceScoutSnapshot(db:Database,now=Date.now()){
 const hints=exists(db,'source_scout_hints')?(db.prepare('SELECT payload,digest,origin FROM source_scout_hints ORDER BY id LIMIT 200').all() as {payload:string;digest:string;origin:string}[]).map(row=>{
  const hint=JSON.parse(row.payload) as SourceHint;
  if(hash(hint)!==row.digest||publicOrigin(hint.url)!==row.origin)throw Error('Source provenance integrity mismatch');
  return {origin:row.origin,originUrl:hint.originUrl,observedAt:hint.observedAt,state:now-hint.observedAt>30*86400000?'STALE_EVIDENCE':'REVIEW_REQUIRED',
   blockers:['Transport adapter/allowlist absent','Purpose-specific terms/privacy/security review absent'],fetchAuthorized:false};
 }):[];
 const availability=searchAvailability(db,now);
 return {opportunitySources:opportunitySourceCandidates(now),agentListingPreparation:prepareAgentListingSearch({type:'project',take:5},now),searches:intents.map(t=>({...t,state:availability.some(p=>p.state==='LOCALLY_ELIGIBLE')?'PLAN_ONLY':'BLOCKED',reason:'Planning only; inspect providerAvailability for scoped admission',providerAvailability:availability,executed:false})),hints,
  catalogueCandidates:DIVERSE_SOURCES.map(s=>({id:s.id,kind:s.kind,demandRelevance:demandKinds.includes(s.kind)?'potential-demand-indicator':'context-only',docs:s.docs})),
  learning:sourceLearning(db),externalSearchPerformed:false,paidCalls:0,
  limitation:'Search planning and technical source learning, not independent web search, customer validation or realized profitability'};
}

/** Offline request preparation only. Never passed to a transport or approval store. */
export function prepareCandidateSearch(input:{sourceId:'simap-opportunities'|'freelancer-projects';query:string},now=Date.now()){
 if(!input||Object.keys(input).sort().join(',')!=='query,sourceId'||!['simap-opportunities','freelancer-projects'].includes(input.sourceId)||typeof input.query!=='string'||!Number.isSafeInteger(now)||now<0)throw Error('Invalid candidate search');
 const query=input.query.trim();
 if(query.length<3||query.length>200||([...query].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127)||/https?:|www\./i.test(query)))throw Error('Bounded public search terms required');
 assertModelPrivacy(query);
 const source=opportunitySourceCandidates(now).find(c=>c.id===input.sourceId)!;
 const simap=input.sourceId==='simap-opportunities';
 const parameters=simap?{search:query}:{query,limit:'5'};
 return {sourceId:input.sourceId,method:'GET' as const,path:simap?'/api/publications/v2/project/project-search':'/projects/0.1/projects/active/',parameters,
  mode:'OFFLINE_PREPARATION' as const,state:source.state,fetchAuthorized:false,executionAuthorized:false,allocatedRequests:0,
  authentication:simap?'Anonymous publication search described in API terms section 6; purpose review still required':'OAuth basic scope required; credential not requested or loaded',
  blockers:[...source.blockers],persistResponse:false,followPagination:false};
}

/** Documented request shape only; deliberately cannot register, submit or fetch.
 * Free-text search is not in the provider contract, so no invented query parameter. */
export function prepareAgentListingSearch(input:{type:'bounty'|'project'|'hackathon';take:number},now=Date.now()){
 if(!input||Object.keys(input).sort().join(',')!=='take,type'||!['bounty','project','hackathon'].includes(input.type)||
  !Number.isSafeInteger(input.take)||input.take<1||input.take>5||!Number.isSafeInteger(now)||now<0||now>8_640_000_000_000_000)throw Error('Invalid bounded agent listing request');
 const source=opportunitySourceCandidates(now).find(s=>s.id==='superteam-agent-tasks')!;
 return {sourceId:source.id,origin:'https://superteam.fun',method:'GET' as const,path:'/api/agents/listings/live',
  parameters:{type:input.type,take:String(input.take),deadline:new Date(now).toISOString()},
  state:source.state,mode:'OFFLINE_PREPARATION' as const,fetchAuthorized:false,executionAuthorized:false,allocatedRequests:0,
  credentialLoaded:false,persistResponse:false,followPagination:false,
  requiredListingChecks:['AGENT_ALLOWED_OR_AGENT_ONLY','CURRENT_DEADLINE','PRIMARY_TERMS','RIGHTS','ACCEPTANCE','PAYOUT','CASH_COSTS','HUMAN_PAYOUT_CLAIM'],
  blockers:[...source.blockers]};
}
