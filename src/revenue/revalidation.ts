import type {Database} from 'better-sqlite3';
import {RevenueStore} from './store.js';
import {pendingInferenceCost} from '../inference/reservations.js';
import {pendingOperationCost} from './pending-operations.js';
import {assertNoKnownSecrets} from '../observability/redaction.js';

export interface RevalidationAllowance {
  opportunityId:string; experimentId:string; maximumCostCents:number; expiresAt:number; reviewedBy:string;
}
const canonical=(p:RevalidationAllowance)=>JSON.stringify({opportunityId:p.opportunityId,experimentId:p.experimentId,
  maximumCostCents:p.maximumCostCents,expiresAt:p.expiresAt,reviewedBy:p.reviewedBy});
const exists=(db:Database)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_revalidation_allowances'").get();
const valid=(p:RevalidationAllowance)=>p&&[p.opportunityId,p.experimentId,p.reviewedBy].every(s=>typeof s==='string'&&s.trim()===s&&s.length>0&&s.length<=100)&&
  Number.isSafeInteger(p.maximumCostCents)&&p.maximumCostCents>0&&p.maximumCostCents<=100000000&&Number.isSafeInteger(p.expiresAt)&&p.expiresAt>0;

/** Trusted Founder/operator policy, not an agent tool. One immutable lifetime
 * allowance per opportunity: new experiment IDs cannot replenish the ceiling.
 * Explicit reviewed migration is required for a later policy, never auto-renew. */
export function registerRevalidationAllowance(db:Database,input:RevalidationAllowance){
  if(!valid(input))throw new Error('Invalid revalidation allowance');
  const payload=canonical(input);
  assertNoKnownSecrets(payload);
  return db.transaction(()=>{
    if(exists(db)){
      const old=db.prepare('SELECT payload FROM obolus_revalidation_allowances WHERE opportunity_id=?').get(input.opportunityId) as {payload:string}|undefined;
      if(old){if(canonical(JSON.parse(old.payload))!==payload)throw new Error('Revalidation allowance is immutable');return {duplicate:true};}
    }
    const store=new RevenueStore(db),e=store.getExperiment(input.experimentId),now=Date.now();
    if(!e||e.opportunityId!==input.opportunityId||e.status!=='planned'||e.startedAt||e.taskId||!e.maxDurationHours||
      !e.successCriteria||!e.failureCriteria||!e.stopCondition||input.maximumCostCents>e.maxBudgetCents||
      input.expiresAt<=now||input.expiresAt-now>Math.min(e.maxDurationHours*3600000,7*86400000))
      throw new Error('Preregister bounded revalidation before work begins');
    if(db.prepare('SELECT 1 FROM economic_events WHERE experiment_id=?').get(e.id)||
      db.prepare('SELECT 1 FROM inference_costs WHERE experiment_id=?').get(e.id)||
      db.prepare('SELECT 1 FROM inference_reservations WHERE experiment_id=?').get(e.id)||store.hasUnresolvedOperation(e.id))
      throw new Error('Preregister revalidation before costs or reservations');
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_revalidation_allowances(opportunity_id TEXT PRIMARY KEY,experiment_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS revalidation_no_update BEFORE UPDATE ON obolus_revalidation_allowances BEGIN SELECT RAISE(ABORT,'Revalidation immutable'); END;
      CREATE TRIGGER IF NOT EXISTS revalidation_no_delete BEFORE DELETE ON obolus_revalidation_allowances BEGIN SELECT RAISE(ABORT,'Revalidation immutable'); END;`);
    // A successful future cohort may supersede ONLY the completed cohorts
    // explicitly present at this preregistration, never subsequently failed work.
    const prior=db.prepare("SELECT id FROM revenue_experiments WHERE opportunity_id=? AND status='completed' ORDER BY id LIMIT 1001").all(e.opportunityId) as {id:string}[];
    if(prior.length>1000)throw new Error('Revalidation history review capacity exceeded');
    db.prepare('INSERT INTO obolus_revalidation_allowances VALUES(?,?,?)').run(e.opportunityId,e.id,JSON.stringify({...JSON.parse(payload),priorExperimentIds:prior.map(row=>row.id)}));
    return {duplicate:false};
  }).immediate();
}

/** Read inside the caller's admission/reservation transaction. Null means no
 * exception exists. A configured ceiling applies even after demand recovers. */
export function revalidationAdmission(db:Database,experimentId:string,additionalCents:number){
  if(!exists(db))return null;
  const row=db.prepare('SELECT opportunity_id,payload FROM obolus_revalidation_allowances WHERE experiment_id=?').get(experimentId) as {opportunity_id:string;payload:string}|undefined;
  if(!row)return null;
  const p=JSON.parse(row.payload) as RevalidationAllowance;
  const store=new RevenueStore(db),e=store.getExperiment(experimentId);
  if(!valid(p)||p.experimentId!==experimentId||p.opportunityId!==row.opportunity_id||e?.opportunityId!==p.opportunityId)
    throw new Error('Corrupt revalidation policy');
  const cost=store.getForecastVsActual(experimentId)!.actualCostCents+pendingInferenceCost(db,{experimentId})+pendingOperationCost(db,experimentId);
  const allowed=['planned','running'].includes(e.status)&&Date.now()<p.expiresAt&&Number.isSafeInteger(cost)&&
    Number.isSafeInteger(additionalCents)&&additionalCents>=0&&cost+additionalCents<=p.maximumCostCents;
  return {allowed,maximumCostCents:p.maximumCostCents,usedAndReservedCents:cost,expiresAt:p.expiresAt,
    reason:allowed?null:'Revalidation allowance expired, exhausted or inactive'};
}
