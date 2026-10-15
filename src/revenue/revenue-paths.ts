import type {Database} from 'better-sqlite3';
import {actionContextDigest,evaluateActionGate} from '../security/action-gate.js';
import {assertModelPrivacy} from '../security/privacy-egress.js';
import {assertNoPersonnelCostInputs} from './personnel-cost-policy.js';

/** Metadata triage only: matching words are not delivery evidence or permission.
 * Retain every notice; ambiguous or mixed scopes require the existing full gates. */
export function preselectDigitalTender(title:string,description:string){
 const inputValid=typeof title==='string'&&typeof description==='string'&&title.length<=2000&&description.length<=20000;
 const text=inputValid?`${title} ${description}`.normalize('NFKC').toLowerCase():'';
 const digital=[['software',/\b(software|api|website|web application)\b/],['data',/\b(csv|data conversion|data cleansing|data migration)\b/],['quality',/\b(software testing|accessibility audit|automated testing)\b/],['research',/\b(desk research|public data analysis|digital report)\b/]] as const;
 const constraints=[['physical-delivery',/\b(delivery and installation|supply and delivery|supply, delivery|on[- ]site|hvac|furniture|construction|laser cameras)\b/],['regulated-service',/\b(microbiology|clinical|patient|falls prevention|legal advice|investment advice|insurance advice)\b/],['ongoing-operations',/\b(24\/7|managed service|managed services|emergency response)\b/]] as const;
 const signals=digital.filter(([,pattern])=>pattern.test(text)).map(([name])=>name);
 const conflicts=constraints.filter(([,pattern])=>pattern.test(text)).map(([name])=>name);
 return {version:'digital-tender-triage-v1',state:'HOLD' as const,priority:!inputValid?'unknown' as const:conflicts.length?'defer' as const:signals.length?'review-first' as const:'unknown' as const,signals,conflicts,
  reason:!inputValid?'INVALID_METADATA':conflicts.length?'DELIVERY_CONSTRAINT_INDICATOR':signals.length?'DIGITAL_SCOPE_INDICATOR_ONLY':'NO_CLEAR_DIGITAL_SCOPE',
  requiredChecks:['primary-notice','open-status-and-deadline','bounded-scope','eligibility','delivery-mode','data-access','rights-and-terms','cash-economics','delivery-evidence'],
  executionAuthorized:false as const,verifiedDemand:false as const};
}

/** Evidence profiles, not sectors, execution connectors or commercial permissions. */
export const REVENUE_PATHS = {
  'company-pilot':['bounded-deliverable','acceptance-and-refund'],
  'research-qa-subcontract':['bounded-deliverable','subcontract-permission','acceptance-and-refund'],
  'public-report':['source-reuse-rights','report-provenance'],
  'referral':['compensation-rule','disclosure-rule'],
  'licensing':['ownership-chain','licensing-authority','usage-scope'],
  'white-label-oem':['ownership-chain','licensing-authority','usage-scope','component-stability','maintenance-scope'],
  'public-tender':['eligibility','deadline','procurement-terms','notice-status','bounded-scope','delivery-mode','data-access'],
  'free-innovation-contest':['eligibility','deadline','zero-entry-fee','prize-and-ip-terms'],
} as const;
export type RevenuePath = keyof typeof REVENUE_PATHS;
export interface ProcurementNotice {
  kind:'open'|'award'|'closed'|'cancelled'|'unknown';
  deadlineAt:number|null;
  sourceType:'primary'|'secondary'|'unknown';
  boundedScope:'supported'|'unmet'|'unknown';
  eligibility:'supported'|'unmet'|'unknown';
  deliveryMode:'autonomous-compatible'|'human-required'|'unknown';
  dataAccess:'public'|'authorized-restricted'|'unauthorized'|'unknown';
  personalDataRequired:boolean|null;
}
export interface RevenuePathAssessment {
  contest?: {deadlineAt:number|null; status:'open'|'closed'|'unknown'; sourceType:'primary'|'secondary'|'unknown'};
  rewardedTask?: {
    status:'open'|'closed'|'unknown'; deadlineAt:number|null;
    agentUse:'allowed'|'human-review-required'|'forbidden'|'unknown';
    humanReviewAvailable:boolean;
    claim:'not-required'|'confirmed'|'required'|'unknown';
    acceptance:'explicit'|'ambiguous'|'unknown';
    payout:'documented'|'unknown';
  };
  procurement?:ProcurementNotice;
  path:RevenuePath; region:string; sourceUrl:string; retrievedAt:number;
  provenance:'public-indicator'|'customer-reaction'|'synthetic';
  demand:string[]; counterEvidence:string[]; prerequisites:string[]; deliveryEvidence:string[];
  conditions:{requirement:string;sourceUrl:string;digest:string;observedAt:number;expiresAt:number;state:'supported'|'unknown'|'contradictory'}[];
  forecast:{currency:'CHF'|'USD'|'EUR';receiptsCents:number|null;directCashCents:number|null;feesCents:number|null;refundsCents:number|null;openCosts:string[];probability:number|null;estimateSource:string;uncertainty:'unknown'|'high'|'medium'|'low'};
  entryFeeCents:number|null; effortMinutes:number|null; nextSafeCheck:string; blockers:string[];
  // Deliberately limited to non-regulated research/software work.
  activityClass:'research'|'software'|'quality-assurance'|'data-report'|'template';
}
const baseRequirements=['jurisdiction','contract-terms','platform-terms','rights','privacy','delivery-capability'];
export const revenuePathRequirements=(path:RevenuePath,rewardedTask=false)=>[...baseRequirements,...REVENUE_PATHS[path],
  ...(rewardedTask?['task-status','agent-use','task-claim','task-acceptance','reward-payment']:[])];
const boundedText=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=2000;
const money=(v:unknown)=>v===null||Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=100_000_000;
function exact(value:object,keys:string[]){if(Object.keys(value).some(k=>!keys.includes(k)))throw Error('Unknown revenue path field');}
function url(value:string){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||value.length>2000)throw Error('Invalid public evidence URL');}
export function validateRevenuePath(a:RevenuePathAssessment){
  if(!a||typeof a!=='object')throw Error('Revenue path assessment required');
  exact(a,['contest','rewardedTask','procurement','path','region','sourceUrl','retrievedAt','provenance','demand','counterEvidence','prerequisites','deliveryEvidence','conditions','forecast','entryFeeCents','effortMinutes','nextSafeCheck','blockers','activityClass']);
  assertNoPersonnelCostInputs(a);assertModelPrivacy(a);
  if(!Object.hasOwn(REVENUE_PATHS,a.path)||!boundedText(a.region)||!boundedText(a.nextSafeCheck)||!Number.isSafeInteger(a.retrievedAt)||a.retrievedAt<0||
    !['public-indicator','customer-reaction','synthetic'].includes(a.provenance)||!['research','software','quality-assurance','data-report','template'].includes(a.activityClass))throw Error('Invalid revenue path');
  url(a.sourceUrl);
  if(a.contest!==undefined){
    const c=a.contest;
    if(a.path!=='free-innovation-contest'||!c||typeof c!=='object'||Array.isArray(c))throw Error('Invalid contest');
    exact(c,['deadlineAt','status','sourceType']);
    if(c.deadlineAt!==null&&(!Number.isSafeInteger(c.deadlineAt)||c.deadlineAt<0)||
      !['open','closed','unknown'].includes(c.status)||!['primary','secondary','unknown'].includes(c.sourceType))throw Error('Invalid contest fields');
  }
  if(a.rewardedTask!==undefined){
    const t=a.rewardedTask;
    if(!t||typeof t!=='object'||Array.isArray(t)||!['research-qa-subcontract','free-innovation-contest'].includes(a.path))throw Error('Invalid rewarded task');
    exact(t,['status','deadlineAt','agentUse','humanReviewAvailable','claim','acceptance','payout']);
    if(!['open','closed','unknown'].includes(t.status)||
      t.deadlineAt!==null&&(!Number.isSafeInteger(t.deadlineAt)||t.deadlineAt<0)||
      !['allowed','human-review-required','forbidden','unknown'].includes(t.agentUse)||typeof t.humanReviewAvailable!=='boolean'||
      !['not-required','confirmed','required','unknown'].includes(t.claim)||!['explicit','ambiguous','unknown'].includes(t.acceptance)||
      !['documented','unknown'].includes(t.payout))throw Error('Invalid rewarded task fields');
  }
  if(a.procurement!==undefined){
    const p=a.procurement;
    if(a.path!=='public-tender'||!p||typeof p!=='object'||Array.isArray(p))throw Error('Invalid procurement notice');
    exact(p,['kind','deadlineAt','sourceType','boundedScope','eligibility','deliveryMode','dataAccess','personalDataRequired']);
    if(!['open','award','closed','cancelled','unknown'].includes(p.kind)||
      p.deadlineAt!==null&&(!Number.isSafeInteger(p.deadlineAt)||p.deadlineAt<0)||
      !['primary','secondary','unknown'].includes(p.sourceType)||
      !['supported','unmet','unknown'].includes(p.boundedScope)||!['supported','unmet','unknown'].includes(p.eligibility)||
      !['autonomous-compatible','human-required','unknown'].includes(p.deliveryMode)||
      !['public','authorized-restricted','unauthorized','unknown'].includes(p.dataAccess)||
      p.personalDataRequired!==null&&typeof p.personalDataRequired!=='boolean')throw Error('Invalid procurement notice fields');
  }
  for(const list of [a.demand,a.counterEvidence,a.prerequisites,a.deliveryEvidence,a.blockers,a.forecast?.openCosts])if(!Array.isArray(list)||list.length>30||!list.every(boundedText))throw Error('Bounded revenue path evidence required');
  if(!a.forecast||typeof a.forecast!=='object')throw Error('Forecast required');
  exact(a.forecast,['currency','receiptsCents','directCashCents','feesCents','refundsCents','openCosts','probability','estimateSource','uncertainty']);
  const f=a.forecast;
  if(!['CHF','USD','EUR'].includes(f.currency)||![f.receiptsCents,f.directCashCents,f.feesCents,f.refundsCents,a.entryFeeCents].every(money)||
    f.probability!==null&&(!Number.isFinite(f.probability)||f.probability<0||f.probability>1)||!boundedText(f.estimateSource)||!['unknown','high','medium','low'].includes(f.uncertainty)||
    a.effortMinutes!==null&&(!Number.isSafeInteger(a.effortMinutes)||a.effortMinutes<0||a.effortMinutes>525600))throw Error('Invalid uncertain cash forecast');
  if(!Array.isArray(a.conditions)||a.conditions.length>30)throw Error('Bounded conditions required');
  const seen=new Set<string>();
  for(const c of a.conditions){
    exact(c,['requirement','sourceUrl','digest','observedAt','expiresAt','state']);
    if(!revenuePathRequirements(a.path,!!a.rewardedTask).includes(c.requirement)||seen.has(c.requirement)||!/^([a-f0-9]{64})$/.test(c.digest)||
      !Number.isSafeInteger(c.observedAt)||c.observedAt<0||!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=c.observedAt||c.expiresAt-c.observedAt>7*86400000||
      !['supported','unknown','contradictory'].includes(c.state))throw Error('Invalid or duplicate condition');
    seen.add(c.requirement);url(c.sourceUrl);
  }
}
export function revenuePathScope(a:RevenuePathAssessment){return {activity:'revenue-path-local-preparation',component:'research',contextDigest:actionContextDigest(a),dataClass:'PUBLIC' as const};}
/** Read-only; a supported claim never authorizes itself. Revisions invalidate scoped reviews. */
export function assessRevenuePath(db:Database,a:RevenuePathAssessment,now=Date.now()){
  validateRevenuePath(a);
  const blockers=[...a.blockers];
  if(!Number.isSafeInteger(now)||now<a.retrievedAt||now-a.retrievedAt>7*86400000)blockers.push('SOURCE_STALE_OR_INVALID');
  if(a.provenance==='synthetic')blockers.push('SYNTHETIC_NOT_DEMAND');
  if(!a.demand.length)blockers.push('DEMAND_ABSENT');
  if(!a.deliveryEvidence.length)blockers.push('DELIVERY_UNPROVEN');
  const task=a.rewardedTask,source=new URL(a.sourceUrl);
  // A delivery PR must not drop the task evidence required by its issue.
  const taskSource=source.hostname==='github.com'&&/^\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+\/?$/.test(source.pathname)||
    ['superteam.fun','earn.superteam.fun'].includes(source.hostname)&&/^\/(?:earn\/)?listing\//.test(source.pathname)||
    source.hostname==='api.trybounty.ai'&&/^\/v1\/agent\/bounties\/[A-Za-z0-9_-]+\/?$/.test(source.pathname)||
    source.hostname==='app.opire.dev'&&/^\/issues\/[A-Za-z0-9_-]+\/?$/.test(source.pathname)||
    source.hostname==='algora.io'&&/^\/challenges\/[^/]+\/?$/.test(source.pathname);
  if(taskSource&&!task)blockers.push('REWARDED_TASK_DETAILS_ABSENT');
  if(task){
    if(task.status!=='open')blockers.push('TASK_NOT_VERIFIED_OPEN');
    if(task.deadlineAt===null)blockers.push('TASK_DEADLINE_UNKNOWN');
    else if(task.deadlineAt<=now)blockers.push('TASK_DEADLINE_PASSED');
    if(task.agentUse==='forbidden'||task.agentUse==='unknown')blockers.push('TASK_AGENT_USE_UNAPPROVED');
    if(task.agentUse==='human-review-required'&&!task.humanReviewAvailable)blockers.push('TASK_HUMAN_REVIEW_UNAVAILABLE');
    if(!['not-required','confirmed'].includes(task.claim))blockers.push('TASK_CLAIM_UNCONFIRMED');
    if(task.acceptance!=='explicit')blockers.push('TASK_ACCEPTANCE_UNCLEAR');
    if(task.payout!=='documented')blockers.push('TASK_PAYOUT_UNVERIFIED');
  }
  for(const requirement of revenuePathRequirements(a.path,!!task)){
    const c=a.conditions.find(c=>c.requirement===requirement);
    if(!c||c.state!=='supported'||c.observedAt>now||c.expiresAt<=now)blockers.push(`UNREVIEWED:${requirement}`);
  }
  if(a.path==='free-innovation-contest'&&a.entryFeeCents!==0)blockers.push('FREE_ENTRY_NOT_ESTABLISHED');
  if(a.path==='free-innovation-contest'){
    if(!a.contest)blockers.push('CONTEST_DETAILS_ABSENT');
    else{
      if(a.contest.deadlineAt===null)blockers.push('CONTEST_DEADLINE_UNKNOWN');
      else if(a.contest.deadlineAt<=now)blockers.push('CONTEST_DEADLINE_PASSED');
      if(a.contest.status!=='open')blockers.push('CONTEST_NOT_VERIFIED_OPEN');
      if(a.contest.sourceType!=='primary')blockers.push('CONTEST_PRIMARY_TERMS_UNVERIFIED');
    }
  }
  const procurementBlockers:string[]=[];
  if(a.path==='public-tender'){
    const p=a.procurement;
    if(!p)procurementBlockers.push('PROCUREMENT_DETAILS_ABSENT');
    else{
      if(p.kind!=='open')procurementBlockers.push(p.kind==='unknown'?'NOTICE_STATUS_UNKNOWN':'NOTICE_NOT_OPEN');
      if(p.deadlineAt===null)procurementBlockers.push('DEADLINE_UNKNOWN');
      else if(p.deadlineAt<=now)procurementBlockers.push('DEADLINE_PASSED');
      if(p.sourceType!=='primary')procurementBlockers.push('PRIMARY_NOTICE_UNVERIFIED');
      if(p.boundedScope!=='supported')procurementBlockers.push('BOUNDED_SCOPE_'+p.boundedScope.toUpperCase());
      if(p.eligibility!=='supported')procurementBlockers.push('ELIGIBILITY_'+p.eligibility.toUpperCase());
      if(p.deliveryMode!=='autonomous-compatible')procurementBlockers.push(p.deliveryMode==='human-required'?'HUMAN_DELIVERY_REQUIRED':'DELIVERY_MODE_UNKNOWN');
      if(p.dataAccess!=='public')procurementBlockers.push(p.dataAccess==='unauthorized'?'DATA_ACCESS_UNAUTHORIZED':'DATA_ACCESS_SEPARATE_REVIEW_REQUIRED');
      if(p.personalDataRequired!==false)procurementBlockers.push('PERSONAL_DATA_CLEARANCE_REQUIRED');
    }
  }
  blockers.push(...procurementBlockers);
  const f=a.forecast;
  const complete=[f.receiptsCents,f.directCashCents,f.feesCents,f.refundsCents,a.entryFeeCents].every(v=>v!==null)&&!f.openCosts.length;
  const forecastCashContributionCents=complete?f.receiptsCents!-f.directCashCents!-f.feesCents!-f.refundsCents!-a.entryFeeCents!:null;
  if(forecastCashContributionCents===null||f.probability===null||f.uncertainty==='unknown')blockers.push('ECONOMICS_UNKNOWN');
  if(forecastCashContributionCents!==null&&forecastCashContributionCents<=0)blockers.push('NONPOSITIVE_FORECAST');
  // Task rewards are contingent on acceptance/winning AND payment. Conservatively
  // charge all forecast cash outlays even on failure; never book this as revenue.
  const expectedTaskCashContributionCents=task&&complete&&f.probability!==null?
    Math.floor(f.receiptsCents!*f.probability)-f.directCashCents!-f.feesCents!-f.refundsCents!-a.entryFeeCents!:null;
  if(expectedTaskCashContributionCents!==null&&expectedTaskCashContributionCents<=0)blockers.push('NONPOSITIVE_EXPECTED_TASK_CONTRIBUTION');
  const gate=evaluateActionGate(db,revenuePathScope(a),now,revenuePathRequirements(a.path,!!task));
  if(gate.state!=='APPROVED')blockers.push(`${gate.state}:${gate.reason}`);
  // Comparable downside sensitivity for every profile, not just task rewards.
  // Assumes all declared cash costs are incurred even without success. It is
  // a forecast diagnostic, not calibrated demand or a spending permission.
  const cashOutlay=complete?f.directCashCents!+f.feesCents!+f.refundsCents!+a.entryFeeCents!:null;
  const expectedCashCents=cashOutlay!==null&&f.probability!==null?Math.floor(f.receiptsCents!*f.probability)-cashOutlay:null;
  return {path:a.path,status:blockers.length?'HOLD':'LOCAL_PREPARATION_ONLY',blockers:[...new Set(blockers)],forecastCashContributionCents,expectedTaskCashContributionCents,
    cashSensitivity:{allCostsIncurredOnFailure:true,expectedCashCents,
      breakEvenProbability:cashOutlay!==null&&f.receiptsCents!>0?cashOutlay/f.receiptsCents!:null,
      assessment:expectedCashCents===null?'UNKNOWN':expectedCashCents>0?'POSITIVE_FORECAST_ONLY':'NONPOSITIVE_EXPECTATION',
      personnelCostsIncluded:false,realized:false},
    procurementDisposition:a.path!=='public-tender'?null:procurementBlockers.some(b=>['NOTICE_NOT_OPEN','DEADLINE_PASSED','BOUNDED_SCOPE_UNMET','ELIGIBILITY_UNMET','HUMAN_DELIVERY_REQUIRED','DATA_ACCESS_UNAUTHORIZED'].includes(b))?'REJECT_CURRENT_CANDIDATE':procurementBlockers.length?'HOLD':'CHECK_OTHER_GATES',
    forecastIsRealized:false,realizedCashNetCents:null,accounting:'Use reconciled Profit Ledger receipts minus actual cash expenses; never import forecasts as cash',
    effortMinutes:a.effortMinutes,maxAuthorizedSpendCents:0,externalExecutionAllowed:false,liveReady:false,productionAccepted:false,nextSafeCheck:a.nextSafeCheck};
}

/** Local working document only. Evidence strings are claims, never endorsements. */
export function prepareRevenuePathDraft(db:Database,a:RevenuePathAssessment,now=Date.now()){
  const assessment=assessRevenuePath(db,a,now);
  return {kind:'UNSENT_WORKING_DRAFT' as const,contextDigest:actionContextDigest(a),path:a.path,
    region:a.region,source:{url:a.sourceUrl,retrievedAt:a.retrievedAt,provenance:a.provenance},
    suppliedClaims:{demand:[...a.demand],counterEvidence:[...a.counterEvidence],prerequisites:[...a.prerequisites],deliveryEvidence:[...a.deliveryEvidence]},
    requirementChecklist:revenuePathRequirements(a.path,!!a.rewardedTask).map(requirement=>({requirement,
      evidence:a.conditions.find(c=>c.requirement===requirement)??null})),
    forecastAssumptions:structuredClone(a.forecast),effortMinutes:a.effortMinutes,assessment,
    recipient:null,sendAllowed:false,spendLimitCents:0,
    nextCheck:a.nextSafeCheck,warning:'Unverified working claims; not a customer offer, rights approval, reference or payment record.'};
}
