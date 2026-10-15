import type {Database} from 'better-sqlite3';
import {SOURCE_LIMITS} from './sources.js';
import {discoveryCandidates,HORIZON_TOPIC,inspectDiscoveryTrialEvidence} from './discovery.js';

/** Read-only scheduling from persisted history. Failed jobs require review, never retry. */
export function researchSchedule(db:Database) {
  return db.transaction(()=>{
    const quota=db.prepare(`SELECT
      SUM(CASE WHEN created_at>=datetime('now','-1 hour') THEN 1 ELSE 0 END) hourly,
      SUM(CASE WHEN created_at>=date('now') THEN 1 ELSE 0 END) daily FROM online_requests`).get() as {hourly:number;daily:number};
    if(quota.hourly+5>SOURCE_LIMITS.hourlyRequests||quota.daily+5>SOURCE_LIMITS.dailyRequests)
      return {reason:'source_quota',topic:null,revisit:false};
    if(db.prepare("SELECT 1 FROM online_jobs WHERE status IN ('pending','running') LIMIT 1").get())
      return {reason:'queued_work',topic:null,revisit:false};
    const count=db.prepare('SELECT (SELECT COUNT(*) FROM research_opportunities) opportunities,(SELECT COUNT(*) FROM research_evidence) evidence').get() as {opportunities:number;evidence:number};
    // A read can return five GitHub and three HN signals; never prune source history.
    if(count.evidence+8>1000)return {reason:'evidence_capacity_review',topic:null,revisit:false};
    const latest=(topic:string)=>db.prepare(`SELECT status,created_at<=datetime('now','-24 hours') due FROM online_jobs WHERE topic=? ORDER BY id DESC LIMIT 1`).get(topic) as {status:string;due:number}|undefined;
    const horizon=latest(HORIZON_TOPIC);
    if(!horizon||horizon.status==='done'&&horizon.due===1){
      if(!horizon&&count.opportunities>=200)return {reason:'opportunity_capacity_review',topic:null,revisit:false};
      return {reason:'market_discovery',topic:HORIZON_TOPIC,revisit:!!horizon};
    }
    for(const candidate of discoveryCandidates(db)){
      if(!candidate.reportedHosts)continue;
      if(!candidate.revalidationEligible&&(!['explore','hold'].includes(candidate.decision)||candidate.trials>=2))continue;
      const trial=db.prepare('SELECT job_id FROM online_discovery_trials WHERE topic=? ORDER BY job_id DESC LIMIT 1').get(candidate.topic) as {job_id:number}|undefined;
      if(trial&&!inspectDiscoveryTrialEvidence(db,trial.job_id).verified)continue;
      const job=latest(candidate.topic);
      if(job&&(job.status!=='done'||!job.due))continue;
      if(!job&&count.opportunities>=200)return {reason:'opportunity_capacity_review',topic:null,revisit:false};
      return {reason:candidate.revalidationEligible?'bounded_revalidation':job?'bounded_recheck':'derived_hypothesis',topic:candidate.topic,revisit:!!job};
    }
    return {reason:'cooldown_or_review',topic:null,revisit:false};
  })();
}
