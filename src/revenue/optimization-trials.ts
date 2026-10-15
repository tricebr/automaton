import {createHash} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {compareOptimization,type OptimizationComparison} from './optimization-comparison.js';
import {canonicalOptimizationRecipe,type OptimizationRecipe} from './optimization-recipe.js';
export interface ExactOutputRule {kind:'exact-output-sha256-v1';expectedOutputDigest:string;maxOutputBytes:number}
export type TrialManifest=Omit<OptimizationComparison,'cases'|'mode'>&{cases:{id:string;inputDigest:string;qualityRule?:ExactOutputRule}[];
 recipes?:{baseline:OptimizationRecipe;candidate:OptimizationRecipe};phase?:'exploration'|'replication';parentTrialId?:string;maxInferenceCostCents?:number};
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const exists=(db:Database)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='obolus_optimization_trials' AND type='table'").get();
export const optimizationSession=(trialId:string,caseId:string,side:'baseline'|'candidate')=>'opt-'+hash(JSON.stringify([trialId,caseId,side])).slice(0,40);
/** Bounded discovery in the main learning context; completeness never substitutes for assessment. */
export function optimizationTrialQueue(db:Database){
 if(!exists(db))return {trials:[],truncated:false};
 const rows=db.prepare('SELECT id FROM obolus_optimization_trials ORDER BY rowid DESC LIMIT 4').all() as {id:string}[];
 return {trials:rows.slice(0,3).map(({id})=>{
  try{
   const manifest=readTrial(db,id),recorded=(db.prepare('SELECT COUNT(*) n FROM obolus_optimization_results WHERE trial_id=?').get(id) as {n:number}).n;
   return {trialId:id,expectedResults:manifest.cases.length*2,recordedResults:recorded,nextAction:'Use revenue_optimization_trial action=assess to check current costs and remaining cases; do not infer success from counts',executionAuthorized:false};
  }catch{return {trialId:id,error:'Trial manifest requires reconciliation',executionAuthorized:false};}
 }),truncated:rows.length>3};
}
const placeholder={costCents:0,latencyMs:0,qualityScore:100,safetyPassed:true,completed:true};
function readTrial(db:Database,id:string){
 const row=exists(db)?db.prepare('SELECT payload,digest FROM obolus_optimization_trials WHERE id=?').get(id) as {payload:string;digest:string}|undefined:undefined;
 if(!row||hash(row.payload)!==row.digest||row.digest!==id)throw Error('Missing or changed trial manifest');
 return JSON.parse(row.payload) as TrialManifest;
}
export function optimizationCaseSpec(db:Database,id:string,caseId:string){
 const item=readTrial(db,id).cases.find(c=>c.id===caseId);
 if(!item)throw Error('Case absent from registered manifest');
 return item;
}
export function optimizationTrialRecipe(db:Database,id:string,side:'baseline'|'candidate'){
 return readTrial(db,id).recipes?.[side];
}
function costs(db:Database,session:string,recipe?:OptimizationRecipe){
 if(db.prepare("SELECT 1 FROM inference_reservations WHERE session_id=? AND status='pending' LIMIT 1").get(session))throw Error('Trial inference costs unresolved');
 const rows=db.prepare('SELECT id,model,provider,input_tokens,output_tokens,cost_cents,latency_ms FROM inference_costs WHERE session_id=? ORDER BY id LIMIT 101').all(session) as {id:string;model:string;provider:string;cost_cents:number;latency_ms:number}[];
 if(!rows.length||rows.length>100)throw Error('Trial requires 1..100 attributable settled inference records');
 if(recipe&&(rows.length!==1||rows.some(row=>row.model!==recipe.modelId||row.provider!==recipe.provider)))throw Error('Trial costs differ from bound execution recipe');
 let costCents=0,latencyMs=0;
 for(const row of rows){
  if(![row.cost_cents,row.latency_ms].every(n=>Number.isSafeInteger(n)&&n>=0))throw Error('Invalid trial costs');
  costCents+=row.cost_cents;latencyMs+=row.latency_ms;
  if(![costCents,latencyMs].every(Number.isSafeInteger))throw Error('Unsafe trial totals');
 }
 return {costCents,latencyMs,digest:hash(JSON.stringify(rows))};
}
/** Registers criteria before any attributed calls. Never starts or funds a provider. */
export function registerOptimizationTrial(db:Database,input:TrialManifest){
 compareOptimization({...input,mode:'recorded',cases:input.cases?.map(c=>({...c,baseline:placeholder,candidate:placeholder}))});
 const rules=input.cases.filter(c=>c.qualityRule!==undefined);
 if(rules.length&&rules.length!==input.cases.length)throw Error('Machine quality rules must cover every registered case');
 for(const c of rules){const r=c.qualityRule!;
  if(!r||r.kind!=='exact-output-sha256-v1'||!/^([a-f0-9]{64})$/.test(r.expectedOutputDigest)||!Number.isSafeInteger(r.maxOutputBytes)||r.maxOutputBytes<1||r.maxOutputBytes>16384)throw Error('Invalid bounded exact-output quality rule');
 }
 const recipes=input.recipes?{baseline:canonicalOptimizationRecipe(input.recipes.baseline),candidate:canonicalOptimizationRecipe(input.recipes.candidate)}:undefined;
 if(input.maxInferenceCostCents!==undefined&&(!Number.isSafeInteger(input.maxInferenceCostCents)||input.maxInferenceCostCents<1||input.maxInferenceCostCents>1000000))throw Error('Bounded positive trial cost ceiling required');
 if(recipes&&rules.length!==input.cases.length)throw Error('Bound recipes require machine quality rules');
 if(input.phase!==undefined&&!['exploration','replication'].includes(input.phase))throw Error('Invalid trial phase');
 if(input.phase==='replication'&&(!recipes||typeof input.parentTrialId!=='string'||!/^[a-f0-9]{64}$/.test(input.parentTrialId)))throw Error('Replication requires bound recipes and a parent trial');
 if(input.phase!=='replication'&&input.parentTrialId!==undefined)throw Error('Parent only permitted for replication');
 const manifest:TrialManifest={datasetDigest:input.datasetDigest,criteriaDigest:input.criteriaDigest,baseline:input.baseline,candidate:input.candidate,
  minimumQuality:input.minimumQuality,maximumQualityDrop:input.maximumQualityDrop,minimumSavingsPercent:input.minimumSavingsPercent,maximumLatencyRatio:input.maximumLatencyRatio,
  ...(recipes?{recipes}:{}),...(input.phase?{phase:input.phase}:{}),...(input.parentTrialId?{parentTrialId:input.parentTrialId}:{}),
  ...(input.maxInferenceCostCents!==undefined?{maxInferenceCostCents:input.maxInferenceCostCents}:{}),
  cases:input.cases.map(c=>({id:c.id,inputDigest:c.inputDigest,...(c.qualityRule?{qualityRule:{kind:c.qualityRule.kind,expectedOutputDigest:c.qualityRule.expectedOutputDigest,maxOutputBytes:c.qualityRule.maxOutputBytes}}:{})})).sort((a,b)=>a.id.localeCompare(b.id))};
 const payload=JSON.stringify(manifest),id=hash(payload);
 return db.transaction(()=>{
  if(manifest.phase==='replication'){
   const parent=readTrial(db,manifest.parentTrialId!);
   if(parent.phase==='replication'||!parent.recipes)throw Error('Replication parent must be an exploration with bound recipes');
   for(const key of ['recipes','criteriaDigest','baseline','candidate','minimumQuality','maximumQualityDrop','minimumSavingsPercent','maximumLatencyRatio'] as const)
    if(JSON.stringify(parent[key])!==JSON.stringify(manifest[key]))throw Error('Replication must retain parent recipes and criteria');
   if(manifest.datasetDigest===parent.datasetDigest||manifest.cases.some(c=>parent.cases.some(p=>p.inputDigest===c.inputDigest)))throw Error('Replication requires distinct held-out inputs');
   const assessment=assessOptimizationTrial(db,manifest.parentTrialId!);
   if(assessment.comparison?.decision!=='candidate_for_replication')throw Error('Parent must pass before replication');
  }
  if(exists(db)&&db.prepare('SELECT 1 FROM obolus_optimization_trials WHERE id=?').get(id)){readTrial(db,id);return {trialId:id,duplicate:true,executionAuthorized:false};}
  for(const c of manifest.cases)for(const side of ['baseline','candidate'] as const){
   const session=optimizationSession(id,c.id,side);
   if(db.prepare('SELECT 1 FROM inference_costs WHERE session_id=? LIMIT 1').get(session)||db.prepare('SELECT 1 FROM inference_reservations WHERE session_id=? LIMIT 1').get(session))throw Error('Register criteria before attributed inference');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS obolus_optimization_trials(id TEXT PRIMARY KEY,payload TEXT NOT NULL,digest TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS obolus_optimization_results(trial_id TEXT NOT NULL,case_id TEXT NOT NULL,side TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(trial_id,case_id,side));
   CREATE TRIGGER IF NOT EXISTS optimization_trial_immutable_update BEFORE UPDATE ON obolus_optimization_trials BEGIN SELECT RAISE(ABORT,'Trial immutable'); END;
   CREATE TRIGGER IF NOT EXISTS optimization_trial_immutable_delete BEFORE DELETE ON obolus_optimization_trials BEGIN SELECT RAISE(ABORT,'Trial immutable'); END;
   CREATE TRIGGER IF NOT EXISTS optimization_result_immutable_update BEFORE UPDATE ON obolus_optimization_results BEGIN SELECT RAISE(ABORT,'Trial result immutable'); END;
   CREATE TRIGGER IF NOT EXISTS optimization_result_immutable_delete BEFORE DELETE ON obolus_optimization_results BEGIN SELECT RAISE(ABORT,'Trial result immutable'); END;`);
  if((db.prepare('SELECT COUNT(*) n FROM obolus_optimization_trials').get() as {n:number}).n>=1000)throw Error('Trial storage limit reached');
  db.prepare('INSERT INTO obolus_optimization_trials VALUES(?,?,?)').run(id,payload,id);
  return {trialId:id,duplicate:false,executionAuthorized:false};
 }).immediate();
}
export interface TrialResult {trialId:string;caseId:string;side:'baseline'|'candidate';outputDigest?:string;qualityScore?:number;output?:string;safetyPassed:boolean;completed:boolean}
export function recordOptimizationResult(db:Database,input:TrialResult){
 if(!input||!['baseline','candidate'].includes(input.side)||typeof input.safetyPassed!=='boolean'||typeof input.completed!=='boolean')throw Error('Bounded result required');
 return db.transaction(()=>{
  const manifest=readTrial(db,input.trialId);
  const registered=manifest.cases.find(c=>c.id===input.caseId);
  if(!registered)throw Error('Case absent from registered manifest');
  let outputDigest=input.outputDigest,qualityScore=input.qualityScore;
  if(registered.qualityRule){
   const rule=registered.qualityRule;
   if(typeof input.output!=='string'||Buffer.byteLength(input.output,'utf8')>rule.maxOutputBytes)throw Error('Bounded actual output required for registered machine quality rule');
   outputDigest=hash(input.output);qualityScore=outputDigest===rule.expectedOutputDigest?100:0;
   if(input.outputDigest!==undefined&&input.outputDigest!==outputDigest||input.qualityScore!==undefined&&input.qualityScore!==qualityScore)throw Error('Reported quality or digest conflicts with machine evaluation');
  }else if(typeof outputDigest!=='string'||!/^[a-f0-9]{64}$/.test(outputDigest)||typeof qualityScore!=='number'||!Number.isFinite(qualityScore)||qualityScore<0||qualityScore>100)throw Error('Bounded legacy score and output digest required');
  const observed=costs(db,optimizationSession(input.trialId,input.caseId,input.side),manifest.recipes?.[input.side]);
  const payload=JSON.stringify({outputDigest,qualityScore,safetyPassed:input.safetyPassed,completed:input.completed,
   costCents:observed.costCents,latencyMs:observed.latencyMs,costDigest:observed.digest,...(registered.qualityRule?{qualityBasis:'registered-output-digest-v1'}:{})});
  const old=db.prepare('SELECT payload FROM obolus_optimization_results WHERE trial_id=? AND case_id=? AND side=?').get(input.trialId,input.caseId,input.side) as {payload:string}|undefined;
  if(old){if(old.payload!==payload)throw Error('Trial result cannot be rewritten');return {duplicate:true};}
  db.prepare('INSERT INTO obolus_optimization_results VALUES(?,?,?,?,?)').run(input.trialId,input.caseId,input.side,payload,hash(payload));
  return {duplicate:false};
 }).immediate();
}
export function assessOptimizationTrial(db:Database,id:string){
 return db.transaction(()=>{
  const manifest=readTrial(db,id),pending:{caseId:string;side:string;sessionId:string;attemptStatus:string}[]=[];
  const receiptsAvailable=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_optimization_attempts'").get()&&
   (db.prepare('PRAGMA table_info(obolus_optimization_attempts)').all() as {name:string}[]).some(c=>c.name==='result_digest');
  let directlyCollected=0;
  const cases=manifest.cases.map(c=>{
   const pair={...c,baseline:placeholder,candidate:placeholder};
   for(const side of ['baseline','candidate'] as const){
    const row=db.prepare('SELECT payload,digest FROM obolus_optimization_results WHERE trial_id=? AND case_id=? AND side=?').get(id,c.id,side) as {payload:string;digest:string}|undefined;
    const session=optimizationSession(id,c.id,side);
    if(!row){
     const attempt=receiptsAvailable?db.prepare('SELECT status FROM obolus_optimization_attempts WHERE session_id=?').get(session) as {status:string}|undefined:undefined;
     pending.push({caseId:c.id,side,sessionId:session,attemptStatus:attempt?.status??'not_started'});continue;
    }
    if(hash(row.payload)!==row.digest)throw Error('Trial result integrity failure');
    const receipt=receiptsAvailable?db.prepare('SELECT status,result_digest FROM obolus_optimization_attempts WHERE session_id=?').get(session) as {status:string;result_digest:string|null}|undefined:undefined;
    if(receipt?.result_digest){if(receipt.status!=='recorded'||receipt.result_digest!==row.digest)throw Error('Collector receipt conflicts with trial result');directlyCollected++;}
    const saved=JSON.parse(row.payload),current=costs(db,session,manifest.recipes?.[side]);
    if(c.qualityRule&&(saved.qualityBasis!=='registered-output-digest-v1'||typeof saved.outputDigest!=='string'||!/^[a-f0-9]{64}$/.test(saved.outputDigest)||
      saved.qualityScore!==(saved.outputDigest===c.qualityRule.expectedOutputDigest?100:0)))throw Error('Stored quality conflicts with registered machine rule');
    if(saved.costDigest!==current.digest||saved.costCents!==current.costCents||saved.latencyMs!==current.latencyMs)throw Error('Trial accounting changed; comparison requires reconciliation');
    pair[side]={costCents:saved.costCents,latencyMs:saved.latencyMs,qualityScore:saved.qualityScore,safetyPassed:saved.safetyPassed,completed:saved.completed};
   }
   return pair;
  });
  if(manifest.phase==='replication'&&assessOptimizationTrial(db,manifest.parentTrialId!).comparison?.decision!=='candidate_for_replication')throw Error('Parent evidence no longer supports replication');
  return {trialId:id,pending,phase:manifest.phase??'legacy',recipesBound:!!manifest.recipes,parentTrialId:manifest.parentTrialId??null,
   collection:{directlyCollected,expected:manifest.cases.length*2,allDirectlyCollected:directlyCollected===manifest.cases.length*2},
   qualityBasis:manifest.cases.every(c=>c.qualityRule)?'registered-output-digest-v1':'supplied-scores',comparison:pending.length?null:compareOptimization({...manifest,mode:'recorded',cases}),
   executionAuthorized:false,limitation:'Criteria registered locally before attributed inference. Costs are checked against local ledger entries, not independently authenticated provider receipts. Output digests and supplied quality/safety scores do not prove correct execution or quality. No automatic adoption.'};
 })();
}
