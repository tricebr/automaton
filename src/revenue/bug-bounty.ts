import {createHash} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {assertModelPrivacy} from '../security/privacy-egress.js';
import {assertActionGate,actionContextDigest,securityTransaction} from '../security/action-gate.js';
import {inferencePhaseSnapshot,observeInferencePhase} from '../inference/phase-budget.js';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function bountyProgramUrl(raw:string):string{
 const u=new URL(raw);if(u.protocol!=='https:'||u.port||u.username||u.password||u.search||u.hash)throw Error('Canonical program URL required');
 const valid=u.hostname==='hackerone.com'&&/^\/[a-z0-9_-]{2,80}$/.test(u.pathname)&&!['/login','/signup','/directory','/security','/users','/hacktivity','/reports'].includes(u.pathname)||
  ['bugcrowd.com','www.bugcrowd.com'].includes(u.hostname)&&/^\/engagements\/[a-z0-9_-]{2,100}$/.test(u.pathname)||u.hostname==='app.intigriti.com'&&/^\/programs\/[a-z0-9_-]{1,100}\/[a-z0-9_-]{1,100}(?:\/detail)?$/.test(u.pathname);
 if(!valid)throw Error('Reviewed platform program URL required');return u.href;
}
/** Listing is discovery only, never scope or testing authorization. */
export function extractBountyPrograms(html:unknown):{url:string;name:string}[]{
 if(typeof html!=='string'||Buffer.byteLength(html)>1000000)throw Error('Bounded public directory required');
 const clean=html.replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/gi,'');
 const result=new Map<string,{url:string;name:string}>();
 for(const match of clean.matchAll(/\bhref\s*=\s*["'](https:\/\/[^"'\s<>]+)["']/gi)){
  try{const url=bountyProgramUrl(match[1]);result.set(url,{url,name:new URL(url).hostname==='app.intigriti.com'?new URL(url).pathname.replace(/\/detail$/,'').split('/').slice(2).join('-'):new URL(url).pathname.split('/').at(-1)!});}catch{/* Arbitrary links and queries never become targets. */}
  if(result.size>=20)break;
 }
 return [...result.values()];
}
export function recordBountyCandidates(db:Database,programs:{sourceUrl:string;retrievedAt:string;sourceId:string}[]){
 db.exec('CREATE TABLE IF NOT EXISTS bounty_candidates(id TEXT PRIMARY KEY,program_url TEXT NOT NULL UNIQUE,source_id TEXT NOT NULL,retrieved_ms INTEGER NOT NULL,status TEXT NOT NULL CHECK(status=\'UNREVIEWED\'))');
 if(programs.length>20)throw Error('Bounded candidate batch required');
 for(const p of programs){const url=bountyProgramUrl(p.sourceUrl),at=Date.parse(p.retrievedAt);if(!Number.isFinite(at)||at>Date.now()||Date.now()-at>86400000)throw Error('Fresh directory receipt required');
  if(!db.prepare('SELECT 1 FROM bounty_candidates WHERE program_url=?').get(url)&&(db.prepare('SELECT COUNT(*) n FROM bounty_candidates').get() as {n:number}).n>=200)throw Error('Bounty candidate capacity requires review');
  db.prepare("INSERT INTO bounty_candidates VALUES(?,?,?,?,'UNREVIEWED') ON CONFLICT(program_url) DO UPDATE SET retrieved_ms=excluded.retrieved_ms,source_id=excluded.source_id").run(hash(url),url,p.sourceId,at);
 }
}
export interface BountyPlan {programUrl:string;policyDigest:string;policyObservedAt:number;policyExpiresAt:number;participantEligible:boolean;automationAllowed:boolean;
 targetUrl:string;allowedChecks:readonly ['response-header-review'];maxLocalChecks:number;currency:'USD'|'CHF'|'EUR';externalBudgetCents:0;}
function validate(plan:BountyPlan,now:number){
 if(!plan||Object.keys(plan).sort().join(',')!=='allowedChecks,automationAllowed,currency,externalBudgetCents,maxLocalChecks,participantEligible,policyDigest,policyExpiresAt,policyObservedAt,programUrl,targetUrl')throw Error('Explicit bounded bounty plan required');
 bountyProgramUrl(plan.programUrl);assertModelPrivacy(plan);
 const target=new URL(plan.targetUrl);
 if(target.href!==plan.targetUrl||target.protocol!=='https:'||target.username||target.password||target.port||target.hash||target.search||target.hostname==='localhost'||target.hostname.endsWith('.local')||!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(target.hostname))throw Error('Exact public target URL required');
 if(!/^[a-f0-9]{64}$/.test(plan.policyDigest)||!Number.isSafeInteger(now)||![plan.policyObservedAt,plan.policyExpiresAt].every(Number.isSafeInteger)||plan.policyObservedAt<0||plan.policyObservedAt>now||plan.policyExpiresAt<=now||plan.policyExpiresAt-plan.policyObservedAt>7*86400000)throw Error('Fresh program policy required');
 if(plan.participantEligible!==true||plan.automationAllowed!==true||JSON.stringify(plan.allowedChecks)!=='["response-header-review"]'||!Number.isSafeInteger(plan.maxLocalChecks)||plan.maxLocalChecks<1||plan.maxLocalChecks>100||plan.externalBudgetCents!==0||!['USD','CHF','EUR'].includes(plan.currency))throw Error('Missing or unsupported bounty permission');
}
export const bountyCheckScope=(plan:BountyPlan)=>({activity:'bug-bounty-local-check',component:'founder-security-research',dataClass:'PUBLIC' as const,contextDigest:actionContextDigest(plan)});
/** No network, shell, exploit, submission or payout connector. Executes a real
 * bounded local response-artifact check; observations are never paid findings. */
export function runBountyOfflineCheck(db:Database,jobId:string,plan:BountyPlan,artifact:{targetUrl:string;capturedAt:number;headers:Record<string,string>;cookies:{secure:boolean;httpOnly:boolean}[]}){
 const now=Date.now();validate(plan,now);
 if((db.prepare('SELECT status FROM online_control WHERE id=1').get() as {status:string}|undefined)?.status!=='running')throw Error('Local research is stopped');observeInferencePhase(db);const phase=inferencePhaseSnapshot(db);
 if(!phase||phase.halted||now<phase.starts_ms||now>=phase.ends_ms)throw Error('Active bounded research phase required');
 if(!/^bounty_[a-z0-9_-]{1,60}$/.test(jobId)||!artifact||Object.keys(artifact).sort().join(',')!=='capturedAt,cookies,headers,targetUrl'||artifact.targetUrl!==plan.targetUrl||!Number.isSafeInteger(artifact.capturedAt)||artifact.capturedAt>now||now-artifact.capturedAt>86400000)throw Error('Bounded matching artifact required');
 if(!artifact.headers||typeof artifact.headers!=='object'||Array.isArray(artifact.headers)||Object.keys(artifact.headers).some(k=>!['strict-transport-security','content-security-policy','x-content-type-options','x-frame-options'].includes(k))||Object.values(artifact.headers).some(v=>typeof v!=='string'||v.length>4000)||!Array.isArray(artifact.cookies)||artifact.cookies.length>20||artifact.cookies.some(c=>!c||Object.keys(c).sort().join(',')!=='httpOnly,secure'||typeof c.secure!=='boolean'||typeof c.httpOnly!=='boolean'))throw Error('Only minimized response metadata accepted');
 assertModelPrivacy(artifact);
 return securityTransaction(db,()=>{
  const admittedAt=Date.now();validate(plan,admittedAt);observeInferencePhase(db);const admittedPhase=inferencePhaseSnapshot(db);
  if((db.prepare('SELECT status FROM online_control WHERE id=1').get() as {status:string}|undefined)?.status!=='running'||!admittedPhase||admittedPhase.halted||admittedAt<admittedPhase.starts_ms||admittedAt>=admittedPhase.ends_ms)throw Error('Local research stopped or phase expired');
  assertActionGate(db,bountyCheckScope(plan),admittedAt,['bounty-program-scope','bounty-automation-rules','bounty-participant-eligibility','bounty-reporting-rules']);
  db.exec('CREATE TABLE IF NOT EXISTS bounty_checks(id TEXT PRIMARY KEY,plan_digest TEXT NOT NULL,artifact_digest TEXT NOT NULL,result TEXT NOT NULL,result_digest TEXT NOT NULL,created_ms INTEGER NOT NULL)');
  const planHash=hash(plan),artifactHash=hash(artifact),prior=db.prepare('SELECT plan_digest,artifact_digest,result,result_digest FROM bounty_checks WHERE id=?').get(jobId) as {plan_digest:string;artifact_digest:string;result:string;result_digest:string}|undefined;
  if(prior){if(prior.plan_digest!==planHash||prior.artifact_digest!==artifactHash)throw Error('Conflicting bounty replay');const stored=JSON.parse(prior.result);if(hash(stored)!==prior.result_digest||stored.jobId!==jobId||stored.artifactDigest!==artifactHash||stored.confirmedVulnerability!==false||stored.reportReady!==false||stored.bountyEarned!==false||stored.externalCalls!==0||stored.realizedRevenueCents!==0)throw Error('Bounty receipt integrity failure');return stored;}
  if((db.prepare('SELECT COUNT(*) n FROM bounty_checks WHERE plan_digest=?').get(planHash) as {n:number}).n>=plan.maxLocalChecks)throw Error('Bounty local-work limit reached');
  const observations:string[]=[];
  if(!artifact.headers['strict-transport-security'])observations.push('HSTS_NOT_OBSERVED');
  if(!artifact.headers['content-security-policy'])observations.push('CSP_NOT_OBSERVED');
  const hsts=artifact.headers['strict-transport-security'];
  if(hsts){
   const ages=hsts.split(';').map(v=>v.trim()).filter(v=>/^max-age\s*=/i.test(v));
   if(ages.length!==1||!/^max-age\s*=\s*[0-9]+$/i.test(ages[0])||!Number.isSafeInteger(Number(ages[0].split('=')[1])))observations.push('HSTS_MAX_AGE_UNVERIFIABLE');
   else if(Number(ages[0].split('=')[1])===0)observations.push('HSTS_DISABLED');
  }
  // Metadata observations only: a missing or weak header is not a proven
  // exploitable vulnerability or evidence of program eligibility/payout.
  const csp=artifact.headers['content-security-policy'];
  if(csp&&csp.split(';').every(v=>!/^\s*(?:default-src|script-src)\s+/i.test(v)))observations.push('CSP_SCRIPT_RESTRICTION_NOT_OBSERVED');
  if(artifact.cookies.some(c=>!c.secure))observations.push('COOKIE_SECURE_FLAG_NOT_OBSERVED');
  if(artifact.cookies.some(c=>!c.httpOnly))observations.push('COOKIE_HTTPONLY_FLAG_NOT_OBSERVED');
  const result={jobId,mode:'local-artifact-review',observations,artifactDigest:artifactHash,confirmedVulnerability:false,reportReady:false,bountyEarned:false,realizedRevenueCents:0,externalCalls:0,
   nextStep:'Check program exclusions and reproduce material security impact in an authorized isolated environment before any submission'};
  db.prepare('INSERT INTO bounty_checks VALUES(?,?,?,?,?,?)').run(jobId,planHash,artifactHash,JSON.stringify(result),hash(result),now);
  db.prepare("INSERT INTO online_audit(action,detail) VALUES('bounty_local_receipt',?)").run(JSON.stringify({jobId,planHash,artifactHash,resultDigest:hash(result)}));
  return result;
 }).immediate();
}
/** Optional estimates, never a payout promise; no employee or imputed wages. */
export function bountyEconomics(input:{rewardCents:number|null;validProbability:number|null;uniqueProbability:number|null;paidProbability:number|null;externalCostCents:number|null}){
 if(!input||Object.keys(input).sort().join(',')!=='externalCostCents,paidProbability,rewardCents,uniqueProbability,validProbability')throw Error('Explicit bounty economics required');
 for(const key of ['rewardCents','externalCostCents'] as const)if(input[key]!==null&&(!Number.isSafeInteger(input[key])||input[key]!<0||input[key]!>100000000))throw Error('Invalid cost or reward');
 for(const key of ['validProbability','uniqueProbability','paidProbability'] as const)if(input[key]!==null&&(!Number.isFinite(input[key])||input[key]!<0||input[key]!>1))throw Error('Invalid probability');
 if(Object.values(input).some(v=>v===null))return {decision:'HOLD',expectedNetCents:null,realizedRevenueCents:0};
 const net=Math.floor(input.rewardCents!*input.validProbability!*input.uniqueProbability!*input.paidProbability!)-input.externalCostCents!;
 return {decision:net>0?'RESEARCH_ONLY':'HOLD',expectedNetCents:net,realizedRevenueCents:0};
}
/** Three caller-documented forecasts; no inferred probability or paid permission. */
export function bountyEconomicScenarios(input:{currency:'CHF'|'USD'|'EUR';scenarios:Record<'conservative'|'middle'|'positive',Parameters<typeof bountyEconomics>[0]>;timeMinutes:Record<'conservative'|'middle'|'positive',number|null>}){
 const names=['conservative','middle','positive'] as const;
 if(!input||Object.keys(input).sort().join(',')!=='currency,scenarios,timeMinutes'||!['CHF','USD','EUR'].includes(input.currency)||!input.scenarios||Object.keys(input.scenarios).sort().join(',')!=='conservative,middle,positive'||!input.timeMinutes||Object.keys(input.timeMinutes).sort().join(',')!=='conservative,middle,positive')throw Error('Explicit three-scenario forecast required');
 const scenarios=names.map(name=>{const minutes=input.timeMinutes[name];if(minutes!==null&&(!Number.isFinite(minutes)||minutes<0||minutes>100000))throw Error('Invalid effort estimate');return {name,...bountyEconomics(input.scenarios[name]),timeMinutes:minutes};});
 const values=scenarios.map(s=>s.expectedNetCents);if(values.every((v):v is number=>v!==null)&&(values[0]>values[1]||values[1]>values[2]))throw Error('Contradictory scenario order');
 return {currency:input.currency,provenance:'forecast',scenarios,minimumExpectedNetCents:values.some(v=>v===null)?null:Math.min(...values as number[]),realizedProfitCents:null,executionAuthorized:false,personnelCostsIncluded:false};
}

/** Read-only bounded visibility, without exposing original response content. */
export function bountySnapshot(db:Database){
 const exists=(name:string)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
 return {candidates:exists('bounty_candidates')?db.prepare('SELECT program_url,source_id,retrieved_ms,status FROM bounty_candidates ORDER BY retrieved_ms DESC LIMIT 200').all():[],
 checks:exists('bounty_checks')?db.prepare('SELECT id,result,created_ms FROM bounty_checks ORDER BY created_ms DESC LIMIT 100').all():[],
 liveTargetTesting:false,automaticSubmission:false,confirmedRevenueCents:0};
}
