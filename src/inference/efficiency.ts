import {createHash} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import type {InferenceRequest,ModelEntry} from '../types.js';
import {optimizationModelDigest} from '../revenue/optimization-recipe.js';
import {assertNoKnownSecrets} from '../observability/redaction.js';
import {optimizationSession,optimizationCaseSpec} from '../revenue/optimization-trials.js';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const integer=(n:number)=>Number.isSafeInteger(n)&&n>=0;
const requestDigest=(request:InferenceRequest)=>digest({messages:request.messages,tools:request.tools??[],taskType:request.taskType,
 temperature:request.temperature??null,maxTokens:request.maxTokens??null,toolChoice:request.toolChoice??null,responseFormat:request.responseFormat??null});
export function efficiencySchema(db:Database){
 db.exec(`CREATE TABLE IF NOT EXISTS efficiency_observations(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,task_type TEXT NOT NULL,model TEXT NOT NULL,pricing_digest TEXT NOT NULL,created_ms INTEGER NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS efficiency_session ON efficiency_observations(session_id);
 CREATE INDEX IF NOT EXISTS efficiency_task_time ON efficiency_observations(task_type,created_ms DESC);
 CREATE TABLE IF NOT EXISTS efficiency_results(id TEXT PRIMARY KEY,payload TEXT NOT NULL,digest TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS efficiency_verifications(id TEXT PRIMARY KEY,trial_id TEXT NOT NULL,result_digest TEXT NOT NULL,passed INTEGER NOT NULL CHECK(passed IN(0,1)));
 CREATE TRIGGER IF NOT EXISTS efficiency_verification_update BEFORE UPDATE ON efficiency_verifications BEGIN SELECT RAISE(ABORT,'Verified outcome immutable'); END;
 CREATE TRIGGER IF NOT EXISTS efficiency_verification_delete BEFORE DELETE ON efficiency_verifications BEGIN SELECT RAISE(ABORT,'Verified outcome immutable'); END;
 CREATE TRIGGER IF NOT EXISTS efficiency_observation_update BEFORE UPDATE ON efficiency_observations BEGIN SELECT RAISE(ABORT,'Efficiency evidence immutable'); END;
 CREATE TRIGGER IF NOT EXISTS efficiency_observation_delete BEFORE DELETE ON efficiency_observations BEGIN SELECT RAISE(ABORT,'Efficiency evidence immutable'); END;
 CREATE TRIGGER IF NOT EXISTS efficiency_result_update BEFORE UPDATE ON efficiency_results BEGIN SELECT RAISE(ABORT,'Efficiency result immutable'); END;
 CREATE TRIGGER IF NOT EXISTS efficiency_result_delete BEFORE DELETE ON efficiency_results BEGIN SELECT RAISE(ABORT,'Efficiency result immutable'); END;`);
}
/** Reservation-linked telemetry, never a second financial ledger or a receipt.
 * No prompts, outputs, credentials or customer identifiers are retained. */
export function beginEfficiencyObservation(db:Database,id:string,request:InferenceRequest,model:ModelEntry,reservedCents:number,baselineModel=model.modelId){
 efficiencySchema(db);
 const attribution=Object.fromEntries(['opportunityId','goalId','planId','strategyId','productId','taskId','agentId','executionId','outcomeId'].map(key=>{
  const value=request.costAttribution?.[key as keyof NonNullable<InferenceRequest['costAttribution']>]??null;
  if(value!==null&&(typeof value!=='string'||!/^[A-Za-z0-9_.:/-]{1,180}$/.test(value)))throw Error('Invalid cost attribution');
  return [key,value];
 }));
 const payload={sessionId:request.sessionId,turnId:request.turnId??null,experimentId:request.experimentId??null,
  attribution,
  routing:{baselineModel,selectedModel:model.modelId,basis:baselineModel===model.modelId?'configured_baseline':'verified_exact_context_lower_cost_v1'},
  taskType:request.taskType,provider:model.provider,model:model.modelId,pricingDigest:optimizationModelDigest(model),
  inputRate:model.costPer1kInput,outputRate:model.costPer1kOutput,reservedCents,costState:'RESERVED_COST',
  requestDigest:requestDigest(request),
  cachedTokens:null,computeCostCents:null,source:'inference_reservations'};
 assertNoKnownSecrets(payload);
 if(!integer(reservedCents))throw Error('Invalid efficiency reservation');
 db.prepare('INSERT INTO efficiency_observations VALUES(?,?,?,?,?,?,?,?)').run(id,request.sessionId,request.taskType,model.modelId,payload.pricingDigest,Date.now(),JSON.stringify(payload),digest(payload));
}
/** Only a completed, machine-checked existing optimization execution receipt can
 * label quality. Model assertions or manually entered scores do not qualify. */
export function collectEfficiencyVerification(db:Database,trialId:string,caseId:string,side:'baseline'|'candidate'){
 const session=optimizationSession(trialId,caseId,side),spec=optimizationCaseSpec(db,trialId,caseId);
 if(!spec.qualityRule)throw Error('Machine verified outcome required');
 const receipt=db.prepare('SELECT status,result_digest FROM obolus_optimization_attempts WHERE session_id=?').get(session) as {status:string;result_digest:string}|undefined;
 const result=db.prepare('SELECT payload,digest FROM obolus_optimization_results WHERE trial_id=? AND case_id=? AND side=?').get(trialId,caseId,side) as {payload:string;digest:string}|undefined;
 if(!receipt||receipt.status!=='recorded'||!result||receipt.result_digest!==result.digest||digest(JSON.parse(result.payload))!==result.digest)throw Error('Verified execution receipt required');
 const observation=db.prepare('SELECT id FROM efficiency_observations WHERE session_id=?').all(session) as {id:string}[];
 if(observation.length!==1)throw Error('Unambiguous execution attribution required');
 const evidence=JSON.parse(result.payload);
 if(evidence.qualityBasis!=='registered-output-digest-v1'||evidence.qualityScore!==(evidence.outputDigest===spec.qualityRule.expectedOutputDigest?100:0))throw Error('Invalid machine quality evidence');
 db.prepare('INSERT OR IGNORE INTO efficiency_verifications VALUES(?,?,?,?)').run(observation[0].id,trialId,result.digest,
  evidence.qualityScore===100&&evidence.completed===true&&evidence.safetyPassed===true?1:0);
}
/** Conservative exact-context learning. No extrapolation to unverified tasks,
 * no cross-provider data transfer, no budget/permission changes, no tool cache.
 * Any failed recent verified case removes that resource from consideration. */
export function chooseEfficientRoute(db:Database,request:InferenceRequest,baseline:ModelEntry,pool:ModelEntry[],now=Date.now()):{model:ModelEntry;expectedOutputDigest:string|null}{
 const unchanged={model:baseline,expectedOutputDigest:null};
 if(request.sessionId.startsWith('opt-')||request.taskType==='safety_check'||request.tools?.length||
  !db.prepare("SELECT 1 FROM sqlite_master WHERE name='efficiency_verifications'").get())return unchanged;
 const rows=db.prepare(`SELECT o.session_id,o.model,o.pricing_digest,o.created_ms,o.payload,o.digest,r.payload AS result,r.digest AS result_digest,v.passed,v.trial_id,v.result_digest AS verified_digest
  FROM efficiency_observations o LEFT JOIN efficiency_results r ON r.id=o.id LEFT JOIN efficiency_verifications v ON v.id=o.id
  WHERE o.task_type=? AND o.created_ms>=? ORDER BY o.created_ms DESC,o.id DESC LIMIT 1001`).all(request.taskType,now-7*86400000) as
  {session_id:string;model:string;pricing_digest:string;created_ms:number;payload:string;digest:string;result:string|null;result_digest:string|null;passed:number|null;trial_id:string|null;verified_digest:string|null}[];
 // A truncated window could hide adverse outcomes. Defer promotion rather
 // than treat a partial sample as complete evidence.
 if(rows.length>1000)return unchanged;
 const fingerprint=requestDigest(request);
 const decoded=rows.map(row=>{
  const start=JSON.parse(row.payload),result=row.result?JSON.parse(row.result):null;
  if(digest(start)!==row.digest||result&&digest(result)!==row.result_digest)throw Error('Efficiency evidence integrity failure');
  return {...row,start,measurement:result};
 });
 const profile=(model:ModelEntry)=>{
  const pricing=optimizationModelDigest(model);
  const matching=decoded.filter(row=>row.model===model.modelId&&row.pricing_digest===pricing&&row.start.requestDigest===fingerprint&&row.created_ms<=now);
  if(new Set(matching.filter(r=>r.passed===1).map(r=>r.trial_id)).size<3||matching.some(r=>r.passed===0||r.result===null))return null;
  const outputs=new Set<string>();
  for(const row of matching.filter(r=>r.passed===1)){
   const source=db.prepare('SELECT payload FROM obolus_optimization_results WHERE trial_id=? AND digest=?').get(row.trial_id,row.verified_digest) as {payload:string}|undefined;
   if(!source||digest(JSON.parse(source.payload))!==row.verified_digest)return null;
   const output=JSON.parse(source.payload).outputDigest;
   if(typeof output!=='string'||!/^[a-f0-9]{64}$/.test(output))return null;
   outputs.add(output);
   const costs=db.prepare('SELECT id,model,provider,input_tokens,output_tokens,cost_cents,latency_ms FROM inference_costs WHERE session_id=? ORDER BY id LIMIT 101').all(row.session_id);
   if(digest(costs)!==JSON.parse(source.payload).costDigest||db.prepare("SELECT 1 FROM inference_reservations WHERE session_id=? AND status='pending'").get(row.session_id))return null;
  }
  if(outputs.size!==1)return null;
  const results=matching.map(r=>r.measurement);
  if(results.some(r=>r.status!=='completed'||!integer(r.estimatedCents)))return null;
  // Recent latency/cost spike invalidates promotion rather than normalizing it.
  const costs=results.map(r=>r.estimatedCents).sort((a,b)=>a-b),times=results.map(r=>r.latencyMs).sort((a,b)=>a-b);
  if(costs.at(-1)!>Math.max(1,costs[0])*2||times.at(-1)!>Math.max(100,times[0])*3)return null;
  return {cost:costs.at(-1)!,latency:times.at(-1)!,outputDigest:[...outputs][0]};
 };
 const base=profile(baseline);if(!base)return unchanged;
 let selected=baseline,best=base.cost;
 for(const model of pool){
  if(!model.enabled||model.provider!==baseline.provider||!model.supportsTools&&baseline.supportsTools||model.modelId===baseline.modelId)continue;
  const score=profile(model);
  if(score&&score.outputDigest===base.outputDigest&&score.cost<best&&score.latency<=Math.max(100,base.latency)*1.25){selected=model;best=score.cost;}
 }
 return {model:selected,expectedOutputDigest:selected===baseline?null:base.outputDigest};
}
export function chooseEfficientModel(db:Database,request:InferenceRequest,baseline:ModelEntry,pool:ModelEntry[],now=Date.now()):ModelEntry{
 return chooseEfficientRoute(db,request,baseline,pool,now).model;
}
export interface EfficiencyMeasurement {status:'completed'|'failed'|'unknown';latencyMs:number;inputTokens?:number;outputTokens?:number;cachedInputTokens?:number;estimatedCents?:number;qualityVerified?:boolean}
export function finishEfficiencyObservation(db:Database,id:string,result:EfficiencyMeasurement){
 if(!integer(result.latencyMs)||!['completed','failed','unknown'].includes(result.status)||
  [result.inputTokens,result.outputTokens,result.cachedInputTokens,result.estimatedCents].some(n=>n!==undefined&&!integer(n))||
  result.cachedInputTokens!==undefined&&(result.inputTokens===undefined||result.cachedInputTokens>result.inputTokens))throw Error('Invalid efficiency measurement');
 const payload={...result,costState:result.estimatedCents===undefined?'UNKNOWN_COST':'ESTIMATED_COST',
  provenance:result.estimatedCents===undefined?'unresolved_provider_attempt':'measured_tokens_times_registered_price',
  actualCostCents:null,qualityVerified:result.qualityVerified??false,externalSavingsProven:false};
 const serialized=JSON.stringify(payload),hash=digest(payload);
 const old=db.prepare('SELECT payload FROM efficiency_results WHERE id=?').get(id) as {payload:string}|undefined;
 if(old){if(old.payload!==serialized)throw Error('Conflicting efficiency result');return;}
 if(!db.prepare('SELECT 1 FROM efficiency_observations WHERE id=?').get(id))throw Error('Missing efficiency reservation');
 db.prepare('INSERT INTO efficiency_results VALUES(?,?,?)').run(id,serialized,hash);
}
/** Cost provenance is additive information, not permission to release holds,
 * overwrite billing, declare realized profit or omit mandatory verification. */
export function efficiencySnapshot(db:Database,limit=1000){
 if(!Number.isSafeInteger(limit)||limit<1||limit>10000)throw Error('Bounded efficiency window required');
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='efficiency_observations'").get())return {attempts:0,unknownCosts:0,estimatedCents:0,actualCostCents:null,realizedExternalSavings:null,groups:[]};
 const rows=db.prepare('SELECT o.*,r.payload AS result,r.digest AS result_digest FROM efficiency_observations o LEFT JOIN efficiency_results r ON r.id=o.id ORDER BY o.created_ms DESC,o.id DESC LIMIT ?').all(limit+1) as {id:string;task_type:string;model:string;payload:string;digest:string;result:string|null;result_digest:string|null}[];
 const groups=new Map<string,{taskType:string;model:string;attempts:number;unknownCosts:number;estimatedCents:number;reservedCents:number;inputTokens:number;outputTokens:number;cachedInputTokens:number;unknownCachedTokenCalls:number;latencyMs:number;failed:number}>();
 const agents=new Map<string,{agentId:string;attempts:number;estimatedCents:number;unknownCosts:number;latencyMs:number;verifiedOutputs:number}>();
 for(const row of rows.slice(0,limit)){
  const start=JSON.parse(row.payload),result=row.result?JSON.parse(row.result):null;
  if(digest(start)!==row.digest||result&&digest(result)!==row.result_digest)throw Error('Efficiency evidence integrity failure');
  const key=JSON.stringify([row.task_type,row.model]);
  const g=groups.get(key)??{taskType:row.task_type,model:row.model,attempts:0,unknownCosts:0,estimatedCents:0,reservedCents:0,inputTokens:0,outputTokens:0,cachedInputTokens:0,unknownCachedTokenCalls:0,latencyMs:0,failed:0};
  g.attempts++;g.reservedCents+=start.reservedCents;
  if(result?.estimatedCents===undefined)g.unknownCosts++;else g.estimatedCents+=result.estimatedCents;
  g.inputTokens+=result?.inputTokens??0;g.outputTokens+=result?.outputTokens??0;g.latencyMs+=result?.latencyMs??0;
  if(result?.cachedInputTokens===undefined)g.unknownCachedTokenCalls++;else g.cachedInputTokens+=result.cachedInputTokens;
  if(result?.status==='failed')g.failed++;
  if(![g.estimatedCents,g.reservedCents,g.inputTokens,g.outputTokens,g.cachedInputTokens,g.latencyMs].every(integer))throw Error('Efficiency aggregate overflow');
  groups.set(key,g);
  const agentId=start.attribution.agentId;
  if(agentId){
   const agent=agents.get(agentId)??{agentId,attempts:0,estimatedCents:0,unknownCosts:0,latencyMs:0,verifiedOutputs:0};
   agent.attempts++;agent.estimatedCents+=result?.estimatedCents??0;agent.latencyMs+=result?.latencyMs??0;
   if(result?.estimatedCents===undefined)agent.unknownCosts++;
   if(result?.qualityVerified===true)agent.verifiedOutputs++;
   if(![agent.estimatedCents,agent.latencyMs].every(integer))throw Error('Agent efficiency aggregate overflow');
   agents.set(agentId,agent);
  }
 }
 const values=[...groups.values()];
 const childAllocations=db.prepare("SELECT 1 FROM sqlite_master WHERE name='obolus_child_funding'").get()?
  db.prepare('SELECT status,COUNT(*) allocations FROM obolus_child_funding GROUP BY status').all():[];
 return {attempts:Math.min(rows.length,limit),truncated:rows.length>limit,unknownCosts:values.reduce((n,g)=>n+g.unknownCosts,0),
  estimatedCents:values.reduce((n,g)=>n+g.estimatedCents,0),actualCostCents:null,realizedExternalSavings:null,groups:values,
  agents:[...agents.values()].sort((a,b)=>b.estimatedCents-a.estimatedCents||a.agentId.localeCompare(b.agentId)).slice(0,10),agentsTruncated:agents.size>10,
  toolMeasurementsSource:'operationalLearning.tools (existing durable tool call durations/errors)',childAllocations,childAccounting:'Funding is capital allocation, not incurred child operating expense or verified incremental value',
  limitation:'Token-priced estimates are not settled billing. Unknown usage/compute/cache costs stay unknown. Reservations are commitments, not expenses; do not add them to estimates.'};
}
/** Small numeric planning view. Detailed ledger attribution stays out of every turn. */
export function efficiencyContext(snapshot:ReturnType<typeof efficiencySnapshot>){
 return {attempts:snapshot.attempts,unknownCosts:snapshot.unknownCosts,estimatedCents:snapshot.estimatedCents,
  actualCostCents:null,realizedExternalSavings:null,
  groups:snapshot.groups.slice(0,3),agents:snapshot.agents?.slice(0,3)??[],
  truncated:!!snapshot.truncated||snapshot.groups.length>3||!!snapshot.agentsTruncated||(snapshot.agents?.length??0)>3,
  basis:'Bounded measured token/runtime history, price estimates and exact-output verification only. Not incremental agent value or realized net profit; mandatory checks and current permissions remain required.'};
}
