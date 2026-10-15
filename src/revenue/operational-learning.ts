import {createHash} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {optimizationTrialQueue} from './optimization-trials.js';
import {continuingEducation} from './continuing-education.js';

/** Reuses durable observations, without duplicating them or interpreting external text as instructions. */
export function operationalLearning(db:Database,limit=200){
  if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw Error('Operational learning sample must be 1..500');
  return db.transaction(()=>{
    const costs=db.prepare(`SELECT id,model,provider,task_type,input_tokens,output_tokens,cost_cents,latency_ms,cache_hit
      FROM inference_costs ORDER BY created_at DESC,id DESC LIMIT ?`).all(limit+1) as {id:string;model:string;provider:string;task_type:string;input_tokens:number;output_tokens:number;cost_cents:number;latency_ms:number;cache_hit:number}[];
    const calls=db.prepare(`SELECT id,name,duration_ms,CASE WHEN error IS NULL THEN 0 ELSE 1 END failed
      FROM tool_calls ORDER BY created_at DESC,id DESC LIMIT ?`).all(limit+1) as {id:string;name:string;duration_ms:number;failed:number}[];
    const label=(s:unknown)=>typeof s==='string'&&/^[A-Za-z0-9_.:/-]{1,100}$/.test(s)?s:'untrusted-label';
    const integer=(n:number)=>Number.isSafeInteger(n)&&n>=0;
    let invalid=0,totalCost=0;
    const groups=new Map<string,{provider:string;model:string;taskType:string;calls:number;costCents:number;inputTokens:number;outputTokens:number;latencyMs:number;cacheHits:number}>();
    for(const row of costs.slice(0,limit)){
      if(![row.cost_cents,row.input_tokens,row.output_tokens,row.latency_ms].every(integer)||![0,1].includes(row.cache_hit)){invalid++;continue;}
      const provider=label(row.provider),model=label(row.model),taskType=label(row.task_type),key=JSON.stringify([provider,model,taskType]);
      const g=groups.get(key)??{provider,model,taskType,calls:0,costCents:0,inputTokens:0,outputTokens:0,latencyMs:0,cacheHits:0};
      if(![totalCost+row.cost_cents,g.costCents+row.cost_cents,g.inputTokens+row.input_tokens,g.outputTokens+row.output_tokens,g.latencyMs+row.latency_ms].every(integer)){invalid++;continue;}
      g.calls++;g.costCents+=row.cost_cents;g.inputTokens+=row.input_tokens;g.outputTokens+=row.output_tokens;g.latencyMs+=row.latency_ms;g.cacheHits+=row.cache_hit;
      totalCost+=row.cost_cents;groups.set(key,g);
    }
    const toolGroups=new Map<string,{name:string;calls:number;errors:number;durationMs:number}>();
    for(const row of calls.slice(0,limit)){
      if(!integer(row.duration_ms)){invalid++;continue;}
      const name=label(row.name),g=toolGroups.get(name)??{name,calls:0,errors:0,durationMs:0};
      if(!integer(g.durationMs+row.duration_ms)){invalid++;continue;}
      g.calls++;g.errors+=row.failed;g.durationMs+=row.duration_ms;toolGroups.set(name,g);
    }
    const inference=[...groups.values()].sort((a,b)=>b.costCents-a.costCents||JSON.stringify(a).localeCompare(JSON.stringify(b))).slice(0,6);
    const tools=[...toolGroups.values()].sort((a,b)=>b.errors-a.errors||b.durationMs-a.durationMs||a.name.localeCompare(b.name)).slice(0,6);
    const suggestions:string[]=[];
    if(invalid)suggestions.push('Reconcile invalid or unsafe telemetry before drawing quantitative conclusions.');
    if(tools.some(t=>t.errors>=2))suggestions.push('Repeated tool errors: inspect the failure cause before repeating the same operation; uncertain financial results require reconciliation, never blind retry.');
    if(totalCost>0&&inference.length)suggestions.push('Inspect the largest inference cost group for redundant context or calls. Compare alternatives on matched tasks and quality before changing model or context policy.');
    const sampleId=createHash('sha256').update(JSON.stringify([costs.slice(0,limit),calls.slice(0,limit)])).digest('hex');
    const optimizationTrials=optimizationTrialQueue(db);
    const education=continuingEducation({sampleId,invalidRows:invalid,truncated:costs.length>limit||calls.length>limit,
      groupsTruncated:groups.size>6||toolGroups.size>6,inference,tools,optimizationTrials});
    return {sampleId,
      sampleLimit:limit,inferenceRows:Math.min(costs.length,limit),toolRows:Math.min(calls.length,limit),
      truncated:costs.length>limit||calls.length>limit,groupsTruncated:groups.size>6||toolGroups.size>6,
      invalidRows:invalid,validSampleCostCents:totalCost,inference,tools,suggestions,optimizationTrials,education,
      costConcentration:inference.map(g=>({provider:g.provider,model:g.model,taskType:g.taskType,costCents:g.costCents,shareOfObservedCost:totalCost?g.costCents/totalCost:0})),
      instruction:'Use recorded operating costs and errors alongside economic outcomes. Re-reading this sample is not a new observation. A call without a logged error is not proof of task quality, customer value or profit. Compare equivalent workloads; cheaper averages alone do not justify switching models or weakening safety.',
      authorization:'No model changes, retries, spending or safety changes are authorized by this report.',
      limitation:'Bounded recent telemetry, not all experience. Provider latency and token counts do not establish business success. Pending reservations remain separate liabilities.'};
  })();
}
