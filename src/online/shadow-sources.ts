import type {Database} from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {discoverPublicSignals,assertPublicEndpoint,validateTopic,SOURCE_LIMITS,type PublicFetch} from './sources.js';
import {inferencePhaseSnapshot,observeInferencePhase} from '../inference/phase-budget.js';
import {actionContextDigest,assertActionGate,securityTransaction,type ActionScope} from '../security/action-gate.js';
import {assertModelPrivacy} from '../security/privacy-egress.js';
import {HORIZON_TOPIC} from './discovery.js';
import {fixedPublicFetch} from './fixed-public-fetch.js';

const REQUIRED=['public-source-egress','public-source-terms'] as const;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** A scope descriptor is not approval. Approval comes only from the existing
 * trusted review ledger; no review is manufactured or registered here. */
export function shadowSourceScope(topic:string,broad:boolean):ActionScope{
 const clean=validateTopic(topic);if(typeof broad!=='boolean'||broad&&clean!==HORIZON_TOPIC)throw Error('Explicit broad discovery scope required');
 assertModelPrivacy({topic:clean});
 return {activity:'shadow-public-research',component:'founder-shadow',dataClass:'PUBLIC',contextDigest:actionContextDigest({
  topic:clean,broad,policy:'fixed-public-source-v1',hosts:['api.github.com','hacker-news.firebaseio.com'],limits:SOURCE_LIMITS,maxAgeDays:90,
 })};
}
function check(db:Database,scope:ActionScope){
 // No constructor/migration fallback to create a missing workspace or permission.
 const control=db.prepare('SELECT mode,status FROM online_control WHERE id=1').get() as {mode:string;status:string}|undefined;
 if(control?.mode!=='online-research'||control.status!=='running')throw Error('Running separate research workspace required');
 if(!inferencePhaseSnapshot(db))throw Error('Shadow source phase required');
 const phase=inferencePhaseSnapshot(db)!;
 if(phase.halted||Date.now()<phase.starts_ms||Date.now()>=phase.ends_ms)throw Error('Shadow source phase inactive');
 assertActionGate(db,scope,Date.now(),REQUIRED);
}
/** Actual fixed-endpoint adapter, never called with real fetch in local tests.
 * Fetch credentials are absent; requests retain existing quotas and no retries.
 * A successful read is unreviewed public evidence, not a payment or demand proof. */
export async function collectReviewedShadowSources(db:Database,topic:string,broad:boolean,signal:AbortSignal,request:PublicFetch=fixedPublicFetch){
 const scope=shadowSourceScope(topic,broad);
 const admit=()=>{observeInferencePhase(db);securityTransaction(db,()=>check(db,scope)).immediate();};
 signal.throwIfAborted();admit();
 const guarded:PublicFetch=async(input,init)=>{
  const url=assertPublicEndpoint(input instanceof Request?input.url:String(input));
  admit();
  if(init?.method!=='GET'||init.redirect!=='error'||init.credentials!=='omit'||new Headers(init.headers).has('authorization'))throw Error('Public request contract violated');
  const response=await request(url,init);
  try{admit();return response;}catch(error){void response.body?.cancel().catch(()=>{});throw error;}
 };
 // Bypass cached data: source age and approval must be checked on this read.
 const signals=await discoverPublicSignals(db,topic,signal,guarded,broad,true);
 signal.throwIfAborted();admit();
 const retrievedAt=Date.now(),seen=new Set<string>();
 const rejected:{id:string;reason:string}[]=[];
 const accepted=signals.filter(item=>{
  const date=Date.parse(item.observedAt),age=retrievedAt-date;
  if(!Number.isFinite(date)||age<0||age>90*86400000){rejected.push({id:item.id,reason:'stale_or_future_source'});return false;}
  try{assertModelPrivacy(item);}catch{rejected.push({id:item.id,reason:'privacy_review_required'});return false;}
  const fingerprint=hash(item.excerpt.trim().toLowerCase().replace(/\s+/g,' '));
  if(seen.has(fingerprint)){rejected.push({id:item.id,reason:'duplicate_excerpt'});return false;}
  seen.add(fingerprint);return true;
 });
 // Keep source-provided publication date distinct from actual retrieval time.
 const result={mode:'unreviewed-public-research',scopeDigest:scope.contextDigest,retrievedAt:new Date(retrievedAt).toISOString(),
  sources:accepted.map(s=>({...s,publishedAt:s.observedAt,contentDigest:hash(s),reviewed:false as const,untrusted:true as const})),rejected,
  verifiedDemand:false,verifiedRevenue:false,liveReady:false,productionAccepted:false};
 // Audit failure blocks delivery. Persist hashes and provenance, not raw excerpts
 // or rejected personal content. This is not a legal or factual source review.
 db.prepare("INSERT INTO online_audit(action,detail) VALUES('shadow_source_receipt',?)").run(JSON.stringify({
  scopeDigest:result.scopeDigest,retrievedAt:result.retrievedAt,
  sources:result.sources.map(({id,sourceUrl,publishedAt,contentDigest})=>({id,sourceUrl,publishedAt,contentDigest})),rejected,
  verifiedDemand:false,verifiedRevenue:false,
 }));
 return result;
}
