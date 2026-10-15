import {createFounderWorker} from './founder-worker.mjs';import {createHash} from 'node:crypto';
const allowed=new Set(['research','exa-research','sofa-research','private-analysis','private-draft']);
export function validatePlan({candidates,capabilities,evidence,budget,now=Date.now()}){
 const accepted=[],rejected=[],seen=new Set(),ids=new Set(evidence.filter(e=>e.privacy!=='private').map(e=>e.id));let remaining=Math.min(budget?.dayRemainingRappen??0,budget?.remainingRappen??0);
 if(!Array.isArray(candidates)||candidates.length>4)return {accepted,rejected:[{reason:'Invalid candidate list'}]};
 for(const c of candidates){const cap=capabilities.find(x=>x.kind===c?.kind),review=Date.parse(c?.nextReviewAt),validText=x=>typeof x==='string'&&x.trim().length>=10&&x.length<=1000;
  if(!budget?.active||!allowed.has(c?.kind)||!cap||cap.status==='blocked'||c.maxCostRappen!==cap.maxCostRappen||!Number.isSafeInteger(c.maxCostRappen)||c.maxCostRappen<0||c.maxCostRappen>remaining||!Array.isArray(c.evidenceIds)||!c.evidenceIds.length||c.evidenceIds.length>8||!c.evidenceIds.every(id=>ids.has(id))||!validText(c.title)||!validText(c.expectedBenefit)||!validText(c.uncertainty)||!Number.isFinite(review)||review<now||review>now+7*86400000){rejected.push({kind:allowed.has(c?.kind)?c.kind:'unknown',reason:'Capability, evidence, time or budget check failed'});continue;}
  const fingerprint=createHash('sha256').update(JSON.stringify([c.kind,[...c.evidenceIds].sort(),c.title])).digest('hex').slice(0,32);if(seen.has(fingerprint)){rejected.push({reason:'Duplicate candidate'});continue;}seen.add(fingerprint);remaining-=c.maxCostRappen;
  accepted.push({kind:c.kind,title:c.title.slice(0,180),evidenceIds:c.evidenceIds,expectedBenefit:c.expectedBenefit,uncertainty:c.uncertainty,maxCostRappen:c.maxCostRappen,nextReviewAt:new Date(review).toISOString(),fingerprint});
 }return {accepted,rejected};
}
export function createFounderPlanner(options){const worker=createFounderWorker({...options,purpose:'planner'});return Object.defineProperties({...worker,execute:ctx=>worker.execute({...ctx,dependencies:ctx.dependencies.filter(r=>r.privacy!=='private')}),verify:r=>worker.verify(r)&&Array.isArray(r.analysis.candidates)&&r.analysis.candidates.length<=4}, {available:{get:()=>worker.available},reason:{get:()=>worker.reason}});}
