import type {Database} from 'better-sqlite3';
import {SOURCE_LIMITS} from '../online/sources.js';

/** Research dimensions, not a fixed commercial sector selection or instructions from sources. */
export const RESEARCH_FRONTIERS=[
 {id:'quality',topic:'reliable delivery validation methods',question:'Which method improves correctness and first-pass acceptance for current deliverables?',check:'Independent task-specific acceptance and regression cases; preserve all requirements.'},
 {id:'cost',topic:'efficient automation context reuse methods',question:'Which reusable method reduces full cash cost for an observed repeated workload?',check:'Matched cost/quality comparison, distinct holdout, full learning costs and existing payback.'},
 {id:'speed',topic:'workflow latency batching methods',question:'Which approach shortens delivery or settlement time without reducing quality?',check:'Comparable end-to-end measurements, failure recovery and full overhead; time is not cash.'},
 {id:'security',topic:'secure automation isolation validation methods',question:'Which method prevents relevant failures or improves isolation and data protection?',check:'Threat-specific positive/negative cases and independent applicable security review; no new access rights.'},
 {id:'business',topic:'recurring business service demand alternatives',question:'Which new reachable buyer problem could support repeatable net contribution?',check:'Payer, offer, permitted channel, cash economics, counterevidence and bounded preregistered demand test.'},
 {id:'delivery',topic:'reusable data software delivery methods',question:'Which new deliverable can be implemented reliably with current resources?',check:'Local demonstrator, rights and capability checks, independent quality and attributable full costs.'}
] as const;
export const improvementTopic=(topic:string)=>RESEARCH_FRONTIERS.find(item=>item.topic===topic);

/** Read-only fallback for an already enabled autonomous public-research runtime.
 * Uses existing jobs/quotas; no new permission, provider or paid model call. */
export function improvementResearchSchedule(db:Database){
 return db.transaction(()=>{
  const none=(reason:string)=>({reason,topic:null as string|null,revisit:false});
  if(db.prepare("SELECT 1 FROM online_jobs WHERE status IN ('pending','running') LIMIT 1").get())return none('queued_work');
  const requests=db.prepare(`SELECT SUM(created_at>=datetime('now','-1 hour')) hourly,SUM(created_at>=date('now')) daily FROM online_requests`).get() as {hourly:number|null;daily:number|null};
  // Same headroom as the existing scheduler, never a separate quota.
  if((requests.hourly??0)+5>SOURCE_LIMITS.hourlyRequests||(requests.daily??0)+5>SOURCE_LIMITS.dailyRequests)return none('source_quota');
  const totals=db.prepare('SELECT (SELECT COUNT(*) FROM research_opportunities) opportunities,(SELECT COUNT(*) FROM research_evidence) evidence').get() as {opportunities:number;evidence:number};
  if(totals.opportunities>=200||totals.evidence+8>1000)return none('research_capacity_review');
  const names=RESEARCH_FRONTIERS.map(item=>item.topic),placeholders=names.map(()=>'?').join(',');
  const history=db.prepare(`SELECT topic,status,created_at<=datetime('now','-24 hours') due FROM online_jobs WHERE topic IN (${placeholders}) ORDER BY id DESC LIMIT 101`).all(...names) as {topic:string;status:string;due:number}[];
  if(history.length>100)return none('improvement_history_review');
  if(history[0]&&!history[0].due)return none('improvement_cooldown');
  // Establish a small existing discovery history before spending source quota on expansion.
  const reads=db.prepare(`SELECT COUNT(DISTINCT topic) n FROM online_jobs WHERE status='done' AND topic NOT IN (${placeholders})`).get(...names) as {n:number};
  if(reads.n<3)return none('initial_market_research_first');
  for(const frontier of RESEARCH_FRONTIERS){
   const attempts=history.filter(row=>row.topic===frontier.topic);
   if(attempts.some(row=>row.status!=='done')||attempts.length>=2)continue;
   // A repeat requires new completed non-method research since the prior attempt.
   if(attempts.length){
    const newer=db.prepare(`SELECT 1 FROM online_jobs WHERE status='done' AND topic NOT IN (${placeholders})
      AND id>(SELECT MAX(id) FROM online_jobs WHERE topic=?) LIMIT 1`).get(...names,frontier.topic);
    if(!newer)continue;
   }
   return {reason:'proactive_improvement_research',topic:frontier.topic,revisit:attempts.length>0};
  }
  return none('improvement_review_required');
 })();
}

export function proactiveResearchAgenda(){
 return {mode:'active-discovery-and-method-research',frontiers:RESEARCH_FRONTIERS,
  instruction:'Proactively look for current better methods and new commercial paths, even without an observed defect. Within existing limits compare the best sourced candidate against the current approach and doing nothing. Adapt queries to the actual business task. Prioritize existing delivery and incomplete trials; use the bounded autonomous source fallback when enabled.',
  selection:'Resolve permissions and delivery feasibility first, then evidence quality, conservative net contribution, learning value, capital at risk and time to usable cash. Unknown inputs stay unknown; no unsupported numeric success score.',
  nextTools:['revenue_research_economics','revenue_information_value','revenue_assess_marketing','revenue_optimization_trial','revenue_optimization_payback','revenue_profitability'],
  executionAuthorized:false,profitabilityProven:false,
  limitation:'Public method indicators are not verified improvement, customer demand or safe code. Existing approved sources and budgets remain binding; adoption requires appropriate experiments, independent checks and release gates.'};
}
