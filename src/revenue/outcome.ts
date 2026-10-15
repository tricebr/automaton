import {createHash} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {RevenueStore} from './store.js';
import {ExperimentBudgetGovernor} from './budget-governor.js';
import {currentCommerceObservation} from '../commerce/attribution.js';

export interface OutcomeContract {
  minimumQualifiedCustomers:number;
  minimumPaidOrders:number;
  evidenceMaxAgeMs:number;
  mode:'live'|'test';
  reviewedBy:string;
}
const table=(db:Database,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
// oxlint-disable-next-line no-control-regex -- Intentionally reject or sanitize control characters at the security boundary.
const boundedText=(s:unknown)=>typeof s==='string'&&s.trim()===s&&s.length>0&&s.length<=200&&!/[\u0000-\u001f\u007f]/.test(s);
const hash=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);

/** Trusted operator boundary: preregistration does not grant execution or funding. */
export function registerOutcomeContract(db:Database,experimentId:string,contract:OutcomeContract){
  if(!boundedText(experimentId)||!contract||!boundedText(contract.reviewedBy)||
    !Number.isSafeInteger(contract.minimumQualifiedCustomers)||contract.minimumQualifiedCustomers<3||contract.minimumQualifiedCustomers>100||
    !Number.isSafeInteger(contract.minimumPaidOrders)||contract.minimumPaidOrders<1||contract.minimumPaidOrders>100||
    !Number.isSafeInteger(contract.evidenceMaxAgeMs)||contract.evidenceMaxAgeMs<60000||contract.evidenceMaxAgeMs>30*86400000||
    !['live','test'].includes(contract.mode))throw new Error('Invalid preregistered demand criteria');
  const payload=JSON.stringify({minimumQualifiedCustomers:contract.minimumQualifiedCustomers,minimumPaidOrders:contract.minimumPaidOrders,
    evidenceMaxAgeMs:contract.evidenceMaxAgeMs,mode:contract.mode,reviewedBy:contract.reviewedBy});
  return db.transaction(()=>{
    const experiment=new RevenueStore(db).getExperiment(experimentId);
    if(!experiment)throw new Error('Unknown experiment');
    if(table(db,'obolus_outcome_contracts')){
      const old=db.prepare('SELECT payload FROM obolus_outcome_contracts WHERE experiment_id=?').get(experimentId) as {payload:string}|undefined;
      if(old){if(old.payload!==payload)throw new Error('Outcome contract is immutable');return {duplicate:true};}
    }
    if(experiment.status!=='planned'||experiment.startedAt||experiment.taskId)throw new Error('Preregister criteria before starting or assigning work');
    if(db.prepare('SELECT 1 FROM economic_events WHERE experiment_id=? LIMIT 1').get(experimentId)||
      db.prepare('SELECT 1 FROM inference_costs WHERE experiment_id=? LIMIT 1').get(experimentId)||
      db.prepare('SELECT 1 FROM inference_reservations WHERE experiment_id=? LIMIT 1').get(experimentId)||
      table(db,'obolus_reserved_operations')&&db.prepare("SELECT 1 FROM obolus_reserved_operations WHERE json_extract(payload,'$.experimentId')=? LIMIT 1").get(experimentId))
      throw new Error('Preregister criteria before any execution or accounting');
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_outcome_contracts(experiment_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS outcome_contract_update BEFORE UPDATE ON obolus_outcome_contracts BEGIN SELECT RAISE(ABORT,'Outcome contract immutable'); END;
      CREATE TRIGGER IF NOT EXISTS outcome_contract_delete BEFORE DELETE ON obolus_outcome_contracts BEGIN SELECT RAISE(ABORT,'Outcome contract immutable'); END;
      CREATE TABLE IF NOT EXISTS obolus_customer_evidence(id TEXT PRIMARY KEY,experiment_id TEXT NOT NULL,customer_hash TEXT NOT NULL,payload TEXT NOT NULL,sequence INTEGER NOT NULL UNIQUE);
      CREATE TRIGGER IF NOT EXISTS customer_evidence_update BEFORE UPDATE ON obolus_customer_evidence BEGIN SELECT RAISE(ABORT,'Customer evidence immutable'); END;
      CREATE TRIGGER IF NOT EXISTS customer_evidence_delete BEFORE DELETE ON obolus_customer_evidence BEGIN SELECT RAISE(ABORT,'Customer evidence immutable'); END;
      CREATE TABLE IF NOT EXISTS obolus_outcome_assessments(id TEXT PRIMARY KEY,experiment_id TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')));
      CREATE TRIGGER IF NOT EXISTS outcome_assessment_update BEFORE UPDATE ON obolus_outcome_assessments BEGIN SELECT RAISE(ABORT,'Outcome assessment immutable'); END;
      CREATE TRIGGER IF NOT EXISTS outcome_assessment_delete BEFORE DELETE ON obolus_outcome_assessments BEGIN SELECT RAISE(ABORT,'Outcome assessment immutable'); END;`);
    db.prepare('INSERT INTO obolus_outcome_contracts VALUES(?,?)').run(experimentId,payload);
    return {duplicate:false};
  }).immediate();
}

/** Caller independently reviews the interview. A digest alone does not authenticate it.
 * New evidence for the same customer supersedes earlier qualification, including revocation.
 */
export function recordCustomerEvidence(db:Database,input:{id:string;experimentId:string;customerHash:string;evidenceSha256:string;qualified:boolean;observedAt:number;reviewedBy:string}){
  if(!input||!boundedText(input.id)||!boundedText(input.experimentId)||!boundedText(input.reviewedBy)||!hash(input.customerHash)||!hash(input.evidenceSha256)||
    typeof input.qualified!=='boolean'||!Number.isSafeInteger(input.observedAt)||input.observedAt<0||input.observedAt>Date.now())throw new Error('Invalid reviewed customer evidence');
  const payload=JSON.stringify({customerHash:input.customerHash,evidenceSha256:input.evidenceSha256,qualified:input.qualified,observedAt:input.observedAt,reviewedBy:input.reviewedBy});
  return db.transaction(()=>{
    if(!table(db,'obolus_outcome_contracts')||!db.prepare('SELECT 1 FROM obolus_outcome_contracts WHERE experiment_id=?').get(input.experimentId))throw new Error('Outcome contract required');
    const old=db.prepare('SELECT experiment_id,payload FROM obolus_customer_evidence WHERE id=?').get(input.id) as {experiment_id:string;payload:string}|undefined;
    if(old){if(old.experiment_id!==input.experimentId||old.payload!==payload)throw new Error('Conflicting customer evidence');return {duplicate:true};}
    db.prepare('INSERT INTO obolus_customer_evidence VALUES(?,?,?,?,(SELECT COALESCE(MAX(sequence),0)+1 FROM obolus_customer_evidence))')
      .run(input.id,input.experimentId,input.customerHash,payload);
    return {duplicate:false};
  }).immediate();
}

/** Deterministic demand assessment. Never credits capital or authorizes scaling. */
export function assessExperimentOutcome(db:Database,experimentId:string){
  return evaluateOutcome(db,experimentId,true);
}

/** Current evidence view without creating an assessment or changing experiment status. */
export function previewExperimentOutcome(db:Database,experimentId:string){
  return evaluateOutcome(db,experimentId,false);
}

/** Current proof, not historical completion or model confidence. Read-only and
 * deliberately limited to demand: payments do not establish reconciled profit. */
export function opportunityDemandEvidence(db:Database,opportunityId:string){
  if(!table(db,'obolus_outcome_contracts'))return {state:'unvalidated' as const,blocked:false,experiments:0};
  const rows=db.prepare(`SELECT e.id FROM obolus_outcome_contracts c JOIN revenue_experiments e ON e.id=c.experiment_id
    WHERE e.opportunity_id=? AND e.status='completed' ORDER BY e.id LIMIT 101`).all(opportunityId) as {id:string}[];
  if(rows.length>100)return {state:'revalidation_required' as const,blocked:true,experiments:rows.length};
  if(!rows.length)return {state:'unvalidated' as const,blocked:false,experiments:0};
  const superseded=new Set<string>();
  if(table(db,'obolus_revalidation_allowances')){
    const allowance=db.prepare('SELECT experiment_id,payload FROM obolus_revalidation_allowances WHERE opportunity_id=?').get(opportunityId) as {experiment_id:string;payload:string}|undefined;
    if(allowance&&rows.some(r=>r.id===allowance.experiment_id)&&previewExperimentOutcome(db,allowance.experiment_id)?.decision==='demand_criteria_met'){
      const p=JSON.parse(allowance.payload);
      if(p.opportunityId!==opportunityId||p.experimentId!==allowance.experiment_id||p.priorExperimentIds!==undefined&&
        (!Array.isArray(p.priorExperimentIds)||p.priorExperimentIds.length>1000||p.priorExperimentIds.some((id:unknown)=>typeof id!=='string'||id===allowance.experiment_id)))
        throw new Error('Revalidation scope requires reconciliation');
      const store=new RevenueStore(db),e=store.getExperiment(allowance.experiment_id)!;
      if(Number.isSafeInteger(p.maximumCostCents)&&p.maximumCostCents>0&&Number.isSafeInteger(p.expiresAt)&&
        Date.parse(e.completedAt!)<=p.expiresAt&&store.getForecastVsActual(e.id)!.actualCostCents<=p.maximumCostCents)
        for(const id of p.priorExperimentIds??[])superseded.add(id);
    }
  }
  const blocked=rows.some(row=>{
    const result=previewExperimentOutcome(db,row.id);
    if(result?.blockers.some(b=>['provider_payment_hold','unresolved_inference_cost','unresolved_operation'].includes(b)))return true;
    return !superseded.has(row.id)&&result?.decision!=='demand_criteria_met';
  });
  return {state:blocked?'revalidation_required' as const:'demand_observed' as const,blocked,experiments:rows.length};
}

function evaluateOutcome(db:Database,experimentId:string,apply:boolean){
  const transaction=db.transaction(()=>{
    if(!table(db,'obolus_outcome_contracts'))return null;
    const row=db.prepare('SELECT payload FROM obolus_outcome_contracts WHERE experiment_id=?').get(experimentId) as {payload:string}|undefined;
    if(!row)return null;
    const contract=JSON.parse(row.payload) as OutcomeContract;
    const store=new RevenueStore(db),experiment=store.getExperiment(experimentId);
    if(!experiment)throw new Error('Outcome experiment missing');
    const review=store.getExperimentReview(experimentId)!;
    const blockers=[...review.blockers],now=Date.now();
    if(review.tasks.some(task=>task.status!=='completed'||task.reportedSuccess!==true))blockers.push('task_success_not_established');
    if(!Number.isFinite(experiment.maxDurationHours)||experiment.maxDurationHours!<=0)blockers.push('missing_bounded_duration');
    const started=experiment.startedAt?Date.parse(experiment.startedAt):NaN;
    if(!Number.isFinite(started))blockers.push('experiment_not_started');
    const rows=db.prepare('SELECT id,customer_hash,payload FROM obolus_customer_evidence WHERE experiment_id=? ORDER BY sequence DESC LIMIT 1001').all(experimentId) as {id:string;customer_hash:string;payload:string}[];
    if(rows.length>1000)blockers.push('customer_evidence_truncated');
    const seen=new Set<string>(),digests=new Set<string>(),customers:string[]=[];
    for(const evidence of rows){
      if(seen.has(evidence.customer_hash))continue;
      seen.add(evidence.customer_hash);
      const item=JSON.parse(evidence.payload);
      if(item.qualified===true&&item.observedAt>=started&&item.observedAt<=now&&now-item.observedAt<=contract.evidenceMaxAgeMs&&!digests.has(item.evidenceSha256)){
        digests.add(item.evidenceSha256);customers.push(evidence.id);
      }
    }
    const payments=table(db,'obolus_commerce_observations')?db.prepare('SELECT id,mode,report,observed_ms FROM obolus_commerce_observations WHERE experiment_id=? ORDER BY id LIMIT 101').all(experimentId) as {id:string;mode:string;report:string;observed_ms:number}[]:[];
    if(payments.length>100)blockers.push('payment_evidence_truncated');
    const paid:string[]=[];
    const paymentSnapshots:{observationId:string;observedAt:number;digest:string}[]=[];
    for(const payment of payments){
      const current=currentCommerceObservation(db,payment),report=JSON.parse(current.report);
      const held=table(db,'obolus_commerce_holds')&&db.prepare('SELECT 1 FROM obolus_commerce_holds WHERE observation_id=?').get(payment.id);
      if(!held&&payment.mode===contract.mode&&report.mode===contract.mode&&current.observed_ms>=started&&current.observed_ms<=now&&
        now-current.observed_ms<=Math.min(contract.evidenceMaxAgeMs,3600000)&&report.observedAt===current.observed_ms&&
        Number.isSafeInteger(report.providerNetCents)&&report.providerNetCents>0){
        paid.push(payment.id);
        paymentSnapshots.push({observationId:payment.id,observedAt:current.observed_ms,digest:createHash('sha256').update(current.report).digest('hex')});
      }
    }
    if(customers.length<contract.minimumQualifiedCustomers)blockers.push('qualified_customer_threshold_not_met');
    if(paid.length<contract.minimumPaidOrders)blockers.push('paid_order_threshold_not_met');
    if(experiment.status==='running'&&!new ExperimentBudgetGovernor(db).checkDuration(experimentId).allowed)blockers.push('experiment_deadline_exhausted');
    const decision=blockers.length?'review_required':contract.mode==='test'?'simulation_criteria_met':'demand_criteria_met';
    const assessment={experimentId,decision,contract,customerEvidence:customers.sort(),paymentEvidence:paid.sort(),paymentSnapshots,blockers: [...new Set(blockers)].sort(),
      accounting:review.accounting,capitalCreditedCents:0,scalingAuthorized:false,
      limitation:'Reviewed interviews and point-in-time provider payments establish only the specified demand criteria. No proof of payout receipt, sustained profit or future performance.'};
    const payload=JSON.stringify(assessment),id=createHash('sha256').update(payload).digest('hex');
    if(apply)db.prepare('INSERT OR IGNORE INTO obolus_outcome_assessments(id,experiment_id,payload) VALUES(?,?,?)').run(id,experimentId,payload);
    if(apply&&decision==='demand_criteria_met'&&experiment.status==='running')store.transitionExperimentStatus(experimentId,'completed',
      `Preregistered demand criteria met; assessment ${id}. No scaling or capital authorization.`,
      'Distinct reviewed customer evidence and attributed provider payments met the preregistered demand thresholds. Profitability and payout remain separately unverified.');
    return {...assessment,assessmentId:id};
  });
  return apply?transaction.immediate():transaction();
}

export function assessRunningOutcomeContracts(db:Database){
  if(!table(db,'obolus_outcome_contracts'))return [];
  const rows=db.prepare("SELECT c.experiment_id FROM obolus_outcome_contracts c JOIN revenue_experiments e ON e.id=c.experiment_id WHERE e.status='running' ORDER BY c.experiment_id LIMIT 101").all() as {experiment_id:string}[];
  if(rows.length>100)throw new Error('Outcome monitoring limit exceeded');
  return db.transaction(()=>rows.map(row=>assessExperimentOutcome(db,row.experiment_id))).immediate();
}
