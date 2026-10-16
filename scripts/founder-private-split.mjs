import {createHash} from 'node:crypto';
import {createFounderWorker} from './founder-worker.mjs';
export const PRIVATE_PART_COST=50;
const kinds=new Set(['private-analysis','private-draft']);
export function splitPrivateTask(task,{compact=false}={}){
 if(!kinds.has(task.kind)||task.input?.splitAssembly||task.dependencies.length>17)throw Error('Invalid private decomposition');
 const key=createHash('sha256').update(task.id).digest('hex').slice(0,32);
 const version=compact?2:1;
 const parts=(compact?[0]:[0,1,2]).map(index=>({id:`private-part-${key}-${index}`,rootTaskId:task.rootTaskId,kind:'private-part',input:{title:task.input?.title,notBefore:task.input?.notBefore??0,splitPart:{version,parentId:task.id,targetKind:task.kind,index}},dependencies:[],resources:task.resources}));
 for(let i=0;i<parts.length;i++)parts[i].dependencies=[...task.dependencies,...(i?parts.slice(0,i).map(p=>p.id):[])];
 return {parts,parent:{...task,input:{...task.input,splitAssembly:{version,partIds:parts.map(t=>t.id)}},dependencies:parts.map(t=>t.id)}};
}
function validPart(r){const a=r?.analysis,p=r?.splitPart;return r?.kind==='private-part'&&r.status==='completed'&&[1,2].includes(p?.version)&&kinds.has(p.targetKind)&&Number.isInteger(p.index)&&p.index>=0&&p.index<(p.version===2?1:3)&&typeof p.parentId==='string'&&a&&typeof a.summary==='string'&&a.summary.length>=(p.version===2?300:p.index===0?100:150)&&a.summary.length<=(p.version===2?1800:900)&&typeof a.nextStep==='string'&&a.nextStep.length>10&&a.nextStep.length<=250&&Array.isArray(a.sourceIds)&&a.sourceIds.length>0&&a.sourceIds.every(id=>r.sources?.some(s=>s.id===id))&&Array.isArray(a.limitations)&&a.limitations.length>0&&a.limitations.length<=3&&a.limitations.every(x=>typeof x==='string'&&x.length<=200)&&JSON.stringify(a).length<=2200;}
export function appendPrivateLessons(dependencies,lessons,task){return lessons.length&&!task.input?.splitAssembly?[...dependencies,{sources:lessons}]:dependencies;}
export function createSplitPrivateAdapters(options){
 const worker=createFounderWorker({...options,purpose:'analysis',boundedPart:true});
 const part=Object.defineProperties({...worker,autoRetrySafe:false,async execute(ctx){const r=await worker.execute(ctx);return {...r,kind:'private-part',splitPart:ctx.task.input.splitPart};},verify:validPart},{available:{get:()=>worker.available},reason:{get:()=>worker.reason},accessRevision:{get:()=>worker.accessRevision}});
 const assembly=kind=>({maxCostRappen:0,planningMaxCostRappen:150,recoverVerify:createFounderWorker({purpose:kind==='private-draft'?'deliverable':'analysis'}).verify,async execute({task,dependencies,assertActive}){
  assertActive();const ids=task.input?.splitAssembly?.partIds,version=task.input?.splitAssembly?.version,count=version===2?1:3;
  if(![1,2].includes(version)||!Array.isArray(ids)||ids.length!==count||new Set(ids).size!==count||JSON.stringify(ids)!==JSON.stringify(task.dependencies)||dependencies.length!==count||dependencies.some((r,index)=>!validPart(r)||r.splitPart.version!==version||r.splitPart.index!==index||r.splitPart.parentId!==task.id||r.splitPart.targetKind!==kind))throw Error('Private parts missing or incomplete');
  const sources=[...new Map(dependencies.flatMap(r=>r.sources).map(s=>[s.id,s])).values()];
  const sourceIds=[...new Set(dependencies.flatMap(r=>r.analysis.sourceIds))];
  const content=(version===2?dependencies:dependencies.slice(1)).map((r,i)=>`## ${i+1}\n${r.analysis.summary}\n\n${r.analysis.nextStep}`).join('\n\n');
  const result={kind,status:'completed',observedAt:new Date().toISOString(),sources,analysis:{summary:(version===2?dependencies:dependencies.slice(1)).map(r=>r.analysis.summary).join('\n\n'),sourceIds,nextStep:dependencies.at(-1).analysis.nextStep,limitations:[...new Set(dependencies.flatMap(r=>r.analysis.limitations))],...(kind==='private-draft'?{deliverableMarkdown:content}:{})},split:{version,parts:ids},checks:{schemaChecked:true,independentFactualVerification:false}};
  assertActive();return result;
 },verify:r=>r?.kind===kind&&r.status==='completed'&&[1,2].includes(r.split?.version)&&r.split.parts?.length===(r.split.version===2?1:3)&&createFounderWorker({purpose:kind==='private-draft'?'deliverable':'analysis'}).verify(r)});
 return {'private-part':part,'private-analysis':assembly('private-analysis'),'private-draft':assembly('private-draft')};
}
