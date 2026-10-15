import type {Database} from 'better-sqlite3';
import {RevenueStore} from './store.js';
import {ResearchStore,type ResearchOpportunity} from './research.js';
import {createHash} from 'node:crypto';
import {researchAdmissionBlock} from './research-admission.js';
import {economicCitationSummary} from './research-assumptions.js';
import {insertTask,getTaskById} from '../state/database.js';
import {ExperimentBudgetGovernor} from './budget-governor.js';
import {checkCapitalBudget} from './capital-budget.js';
import {readBudgetPolicy} from '../inference/budget-policy.js';
import {assignTask,getReadyTasks} from '../orchestration/task-graph.js';

/** A stopped lineage cannot regain execution rights by adding another child. */
export function researchTaskLineageBlock(db:Database,taskId:string):string|null {
  const cancellations=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_dispatch_cancellations'").get();
  const seen=new Set<string>();
  let current:string|null=taskId,goal:string|undefined;
  while(current){
    if(seen.has(current)||seen.size>=100)return 'Task ancestry requires reconciliation';
    seen.add(current);
    const row=db.prepare('SELECT parent_id,goal_id,status FROM task_graph WHERE id=?').get(current) as {parent_id:string|null;goal_id:string;status:string}|undefined;
    if(!row)return 'Task ancestry is missing';
    if(goal!==undefined&&goal!==row.goal_id)return 'Task ancestry crosses goals';
    goal=row.goal_id;
    if(['failed','cancelled'].includes(row.status))return 'Task ancestry is failed or cancelled';
    if(cancellations&&db.prepare('SELECT 1 FROM obolus_dispatch_cancellations WHERE task_id=?').get(current))return 'Task ancestry has a permanent cancellation';
    current=row.parent_id;
  }
  return null;
}

/** Enforce existing experiment ceilings, without inventing a commercial outcome. */
export function stopExhaustedResearchExperiments(db:Database):string[] {
  return db.transaction(()=>{
    const exists=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const base=exists('obolus_research_experiments'),revisions=exists('obolus_research_plan_revisions');
    if(!base&&!revisions)return [];
    const mappings=[base?'SELECT experiment_id FROM obolus_research_experiments':null,revisions?'SELECT experiment_id FROM obolus_research_plan_revisions':null].filter(Boolean).join(' UNION ');
    const rows=db.prepare(`SELECT e.id FROM revenue_experiments e WHERE e.status='running' AND e.id IN (${mappings}) ORDER BY e.id LIMIT 101`).all() as {id:string}[];
    if(rows.length>100)throw new Error('Research monitoring limit exceeded; review active experiments');
    const store=new RevenueStore(db),governor=new ExperimentBudgetGovernor(db),stopped:string[]=[];
    for(const {id} of rows){
      const experiment=store.getExperiment(id)!;
      const durationValid=Number.isFinite(experiment.maxDurationHours)&&experiment.maxDurationHours!>0;
      const durationAllowed=durationValid&&governor.checkDuration(id).allowed;
      const accounting=store.getForecastVsActual(id)!;
      // Reserved estimates can be released after settlement; they are not spent costs.
      const reason=!durationAllowed?'Experiment duration invalid or exhausted':
        Number.isSafeInteger(experiment.maxBudgetCents)&&experiment.maxBudgetCents>0&&accounting.actualCostCents>=experiment.maxBudgetCents?
          'Settled total cost reached the experiment ceiling':null;
      if(!reason)continue;
      store.transitionExperimentStatus(id,'stopped',`${reason}. Review evidence and actual outcomes before any new experiment; pending costs remain reserved.`);
      stopped.push(id);
    }
    return stopped;
  }).immediate();
}

/** Explicit operator policy; workers cannot increase the shared dispatch capacity. */
export function configureResearchDispatch(db:Database,maxWorkers:number) {
  if(!Number.isSafeInteger(maxWorkers)||maxWorkers<1||maxWorkers>10)throw new Error('Worker limit must be 1..10');
  db.transaction(()=>{
    db.exec('CREATE TABLE IF NOT EXISTS obolus_research_dispatch_policy(id INTEGER PRIMARY KEY CHECK(id=1),max_workers INTEGER NOT NULL)');
    db.prepare('INSERT INTO obolus_research_dispatch_policy VALUES(1,?) ON CONFLICT(id) DO UPDATE SET max_workers=MIN(max_workers,excluded.max_workers)').run(maxWorkers);
  }).immediate();
}

/** Select only explicitly handed-off tasks, never creates funding or starts a worker. */
function researchClaimCapacityBlock(db:Database,workerAddress:string):'capacity'|'worker_busy'|undefined {
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_research_dispatch_policy'").get())throw new Error('Research dispatch policy required');
    const policy=db.prepare('SELECT max_workers FROM obolus_research_dispatch_policy WHERE id=1').get() as {max_workers:number}|undefined;
    if(!policy||!Number.isSafeInteger(policy.max_workers)||policy.max_workers<1||policy.max_workers>10)throw new Error('Invalid research dispatch policy');
    // Count all live tasks conservatively, including legacy assignments and crash survivors.
    const active=db.prepare("SELECT COUNT(*) n FROM task_graph WHERE status IN ('assigned','running')").get() as {n:number};
    if(active.n>=policy.max_workers)return 'capacity';
    if(db.prepare("SELECT 1 FROM task_graph WHERE assigned_to=? AND status IN ('assigned','running')").get(workerAddress))return 'worker_busy';
}
export function claimNextResearchTask(db:Database,workerAddress:string) {
  if(typeof workerAddress!=='string'||!/^local:\/\/[A-Za-z0-9_-]{1,100}$/.test(workerAddress))throw new Error('Bounded local worker address required');
  return db.transaction(()=>{
    const capacityBlock=researchClaimCapacityBlock(db,workerAddress);
    if(capacityBlock)return {task:null,reason:capacityBlock,blocked:[]};
    const rows=db.prepare("SELECT id FROM task_graph WHERE status='pending' ORDER BY id LIMIT 101").all() as {id:string}[];
    if(rows.length>100)throw new Error('Dispatch candidate limit exceeded; review queue');
    const store=new RevenueStore(db),ready=new Map(getReadyTasks(db).map(task=>[task.id,task]));
    const candidates=rows.flatMap(row=>{
      const task=ready.get(row.id),experiment=store.getActiveExperimentForTask(row.id,true);
      return task&&experiment?.status==='running'&&experiment.goalId?[{task,experiment}]:[];
    });
    candidates.sort((a,b)=>store.getExperimentPriorityScore(b.experiment)-store.getExperimentPriorityScore(a.experiment)||a.task.id.localeCompare(b.task.id));
    const blocked:{experimentId:string;reason:string}[]=[];
    for(const {task,experiment:e} of candidates){
      try{
        const lineageBlock=researchTaskLineageBlock(db,task.id);
        if(lineageBlock)throw new Error(lineageBlock);
        // Descendants inherit the nearest experiment; validate its immutable root first.
        handoffResearchTask(db,e.id,e.goalId!);
        if(task.goalId!==e.goalId)throw new Error('Child task goal differs from its experiment');
        assignTask(db,task.id,workerAddress);
        return {task:{...task,status:'assigned' as const,assignedTo:workerAddress},reason:'claimed',blocked};
      }catch(error){blocked.push({experimentId:e.id,reason:error instanceof Error?error.message:'Admission denied'});}
    }
    return {task:null,reason:'no_admissible_task',blocked};
  }).immediate();
}

/** Durable exclusive claim. A crash after claim requires review, never automatic reassignment. */
export function claimResearchTask(db:Database,experimentId:string,goalId:string,workerAddress:string) {
  if(typeof workerAddress!=='string'||!/^local:\/\/[A-Za-z0-9_-]{1,100}$/.test(workerAddress))throw new Error('Bounded local worker address required');
  return db.transaction(()=>{
    const {taskId}=handoffResearchTask(db,experimentId,goalId);
    const task=getReadyTasks(db).find(row=>row.id===taskId);
    if(!task)throw new Error('Research task is not ready or already claimed; reconcile before retry');
    const capacityBlock=researchClaimCapacityBlock(db,workerAddress);
    if(capacityBlock)throw new Error(`Research dispatch ${capacityBlock}`);
    const lineageBlock=researchTaskLineageBlock(db,task.id);
    if(lineageBlock)throw new Error(lineageBlock);
    assignTask(db,taskId,workerAddress);
    return {...task,status:'assigned' as const,assignedTo:workerAddress};
  }).immediate();
}

/** Queue already funded work; never grants budgets, adapter permissions or worker execution. */
export function handoffResearchTask(db:Database,experimentId:string,goalId:string) {
  if(!experimentId||!goalId||experimentId.length>100||goalId.length>100)throw new Error('Experiment and goal required');
  return db.transaction(()=>{
    const store=new RevenueStore(db),experiment=store.getExperiment(experimentId);
    if(!experiment||experiment.status!=='running'||!experiment.startedAt||
      !Number.isFinite(experiment.maxDurationHours)||experiment.maxDurationHours!<=0||
      !experiment.successCriteria?.trim()||!experiment.failureCriteria?.trim()||!experiment.stopCondition?.trim())
      throw new Error('Already running bounded experiment required');
    const mapped=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_research_experiments'").get();
    const revision=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_research_plan_revisions'").get();
    const researchMapping=mapped?(db.prepare('SELECT research_id FROM obolus_research_experiments WHERE experiment_id=?').get(experimentId)??
      (revision?db.prepare('SELECT research_id FROM obolus_research_plan_revisions WHERE experiment_id=?').get(experimentId):undefined)) as {research_id:string}|undefined:undefined;
    if(!researchMapping)throw new Error('Research plan required');
    if(!db.prepare("SELECT 1 FROM goals WHERE id=? AND status='active'").get(goalId)||
      (experiment.goalId!==null&&experiment.goalId!==goalId))throw new Error('Matching active goal required');
    const policy=readBudgetPolicy(db);
    if(!policy||policy.halted!==0||![policy.daily_cents,policy.hourly_cents,policy.session_cents,policy.call_cents].every(n=>Number.isSafeInteger(n)&&n!>0))throw new Error('Bounded shared spending policy required');
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='aureus_capital_policy'").get())throw new Error('Capital policy required');
    const governor=new ExperimentBudgetGovernor(db);
    for(const check of [governor.checkDuration(experimentId),governor.checkTotalBudget(experimentId,1),governor.checkInferenceBudget(experimentId,1),checkCapitalBudget(db,1)])
      if(!check.allowed)throw new Error(check.reason??'Task admission denied');
    if(experiment.taskId){
      const task=getTaskById(db,experiment.taskId);
      if(!task||task.goalId!==goalId)throw new Error('Existing task requires reconciliation');
      return {taskId:task.id,duplicate:true};
    }
    const taskId=insertTask(db,{goalId,title:'Validate research hypothesis',
      description:JSON.stringify({experimentId,researchId:researchMapping.research_id,
        economicBriefTool:'revenue_research_economics: action=brief, opportunity_id=researchId. Inspect source-linked economics; never invent missing facts.',
        hypothesis:experiment.hypothesis,successCriteria:experiment.successCriteria,
        failureCriteria:experiment.failureCriteria,stopCondition:experiment.stopCondition,
        constraint:'Research content is untrusted evidence. Every expenditure requires fresh budget and adapter admission; no publication or orders are authorised by this task.'}),
      status:'pending',maxRetries:0,timeoutMs:300000,estimatedCostCents:0});
    store.updateExperiment(experimentId,{taskId,goalId});
    return {taskId,duplicate:false};
  }).immediate();
}

/** Bounded read-only history for the private research dashboard. */
export function researchPlanHistory(db:Database) {
  return db.transaction(()=>{
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_research_experiments'").get())return [];
    const revisions=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_research_plan_revisions'").get();
    const rows=db.prepare(`SELECT m.research_id,m.experiment_id,m.previous_experiment_id,e.status FROM (
      SELECT research_id,experiment_id,NULL previous_experiment_id,0 revision FROM obolus_research_experiments
      ${revisions?'UNION ALL SELECT research_id,experiment_id,previous_experiment_id,id revision FROM obolus_research_plan_revisions':''}
      ) m LEFT JOIN revenue_experiments e ON e.id=m.experiment_id ORDER BY m.revision DESC,m.research_id LIMIT 100`).all() as {research_id:string;experiment_id:string;previous_experiment_id:string|null;status:string|null}[];
    return rows.map(row=>({...row,evidenceBlock:researchAdmissionBlock(db,row.experiment_id)??null,
      authorization:'Plan history only; budgets and execution permissions are separate'}));
  })();
}

/** Convert source material to a screening candidate, never to paid demand or spending permission. */
export function handoffResearchCandidate(db:Database,researchId:string) {
  return db.transaction(()=>{
    const source=db.prepare('SELECT payload,digest FROM research_opportunities WHERE id=?').get(researchId) as {payload:string;digest:string}|undefined;
    if(!source)throw new Error('Unknown research candidate');
    if(createHash('sha256').update(source.payload).digest('hex')!==source.digest)throw new Error('Research candidate integrity mismatch');
    const evidenceRows=db.prepare('SELECT id,digest,payload FROM research_evidence WHERE opportunity_id=? ORDER BY id LIMIT 1001').all(researchId) as {id:string;digest:string;payload:string}[];
    if(!evidenceRows.length||evidenceRows.length>1000)throw new Error('Bounded source evidence required');
    // An existing handoff does not attest to today's source ledger integrity.
    const evidence=evidenceRows.map(row=>{
      try{
        if(createHash('sha256').update(row.payload).digest('hex')!==row.digest)throw Error();
        const value=JSON.parse(row.payload);
        if(!value||value.id!==row.id||value.opportunityId!==researchId)throw Error();
        return {id:row.id,digest:row.digest};
      }catch{throw new Error('Research evidence integrity mismatch');}
    });
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_research_handoffs(research_id TEXT PRIMARY KEY,opportunity_id TEXT NOT NULL UNIQUE REFERENCES revenue_opportunities(id),source_digest TEXT NOT NULL,evidence_snapshot TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')));`);
    const prior=db.prepare('SELECT opportunity_id,source_digest FROM obolus_research_handoffs WHERE research_id=?').get(researchId) as {opportunity_id:string;source_digest:string}|undefined;
    if(prior){if(prior.source_digest!==source.digest)throw new Error('Research source changed');return {opportunityId:prior.opportunity_id,duplicate:true};}
    const item=JSON.parse(source.payload) as ResearchOpportunity;
    const opportunityId=new RevenueStore(db).createOpportunity({goalId:null,name:item.title,niche:item.sector,status:'screening',
      evidenceLevel:'unverified-public-research',confidence:null,probabilitySuccess:null,expectedRevenueCents:0,expectedCostCents:0,
      expectedNetValueCents:0,timeToRevenueDays:null,maxExperimentBudgetCents:0,focusRank:null,hypothesis:item.hypothesis,
      killCondition:'Reject if reachable demand, delivery feasibility or positive all-in unit economics cannot be established',
      nextAction:'Review linked public evidence and establish a bounded validation plan. No paid execution authorised.'});
    db.prepare('INSERT INTO obolus_research_handoffs(research_id,opportunity_id,source_digest,evidence_snapshot) VALUES(?,?,?,?)').run(researchId,opportunityId,source.digest,JSON.stringify(evidence));
    return {opportunityId,duplicate:false};
  }).immediate();
}

/** Persist a reviewed validation proposal, with zero execution budgets and no status escalation. */
export function planResearchExperiment(db:Database,researchId:string,revisionReason?:string) {
  if(revisionReason!==undefined&&(typeof revisionReason!=='string'||!revisionReason.trim()||revisionReason.length>1000))throw new Error('Invalid plan revision reason');
  return db.transaction(()=>{
    const research=new ResearchStore(db);
    const ranked=research.rank().find(item=>item.id===researchId);
    if(!ranked||ranked.decision!=='validate')throw new Error('Current reviewed demand required');
    const plan=research.plan(ranked.proposedBudgetCents,Date.now(),researchId).plans[0];
    if(!plan)throw new Error('No bounded research proposal');
    const source=db.prepare('SELECT payload,digest FROM research_opportunities WHERE id=?').get(researchId) as {payload:string;digest:string};
    if(createHash('sha256').update(source.payload).digest('hex')!==source.digest)throw new Error('Research source integrity mismatch');
    const reviews=plan.evidenceIds.map(id=>db.prepare('SELECT id,evidence_id,evidence_digest,decision FROM research_reviews WHERE evidence_id=? ORDER BY id DESC LIMIT 1').get(id));
    const snapshot=JSON.stringify({sourceDigest:source.digest,plan,reviews,economicEvidenceDigest:economicCitationSummary(db,researchId).digest});
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_research_experiments(research_id TEXT PRIMARY KEY,experiment_id TEXT NOT NULL UNIQUE REFERENCES revenue_experiments(id),snapshot TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS research_experiment_no_update BEFORE UPDATE ON obolus_research_experiments BEGIN SELECT RAISE(ABORT,'Research experiment mapping immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_experiment_no_delete BEFORE DELETE ON obolus_research_experiments BEGIN SELECT RAISE(ABORT,'Research experiment mapping immutable'); END;
      CREATE TABLE IF NOT EXISTS obolus_research_plan_revisions(id INTEGER PRIMARY KEY,research_id TEXT NOT NULL,experiment_id TEXT NOT NULL UNIQUE REFERENCES revenue_experiments(id),previous_experiment_id TEXT NOT NULL,snapshot TEXT NOT NULL,reason TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS research_revision_no_update BEFORE UPDATE ON obolus_research_plan_revisions BEGIN SELECT RAISE(ABORT,'Research revision immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_revision_no_delete BEFORE DELETE ON obolus_research_plan_revisions BEGIN SELECT RAISE(ABORT,'Research revision immutable'); END;`);
    const old=(db.prepare('SELECT experiment_id,snapshot FROM obolus_research_plan_revisions WHERE research_id=? ORDER BY id DESC LIMIT 1').get(researchId)??
      db.prepare('SELECT experiment_id,snapshot FROM obolus_research_experiments WHERE research_id=?').get(researchId)) as {experiment_id:string;snapshot:string}|undefined;
    if(old){
      if(old.snapshot===snapshot)return {experimentId:old.experiment_id,duplicate:true};
      if(!revisionReason)throw new Error('Research review changed; explicit plan revision required');
      const count=db.prepare('SELECT COUNT(*) n FROM obolus_research_plan_revisions WHERE research_id=?').get(researchId) as {n:number};
      if(count.n>=10)throw new Error('Plan revision limit reached; reassess the research hypothesis');
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_reserved_operations'").get()&&
        db.prepare("SELECT 1 FROM obolus_reserved_operations WHERE json_extract(payload,'$.experimentId')=? LIMIT 1").get(old.experiment_id))
        throw new Error('Existing operation requires review before plan replacement');
      const prior=new RevenueStore(db).getExperiment(old.experiment_id);
      if(!prior||prior.status!=='planned'||prior.taskId||prior.startedAt||prior.actualCostCents!==0||prior.actualRevenueCents!==0||prior.maxBudgetCents!==0||prior.maxInferenceCostCents!==0||
        db.prepare('SELECT 1 FROM economic_events WHERE experiment_id=? LIMIT 1').get(old.experiment_id)||
        db.prepare('SELECT 1 FROM inference_costs WHERE experiment_id=? LIMIT 1').get(old.experiment_id)||
        db.prepare('SELECT 1 FROM inference_reservations WHERE experiment_id=? LIMIT 1').get(old.experiment_id))
        throw new Error('Only unstarted, unfunded plans without work or accounting may be revised');
    }
    const {opportunityId}=handoffResearchCandidate(db,researchId),store=new RevenueStore(db);
    if(!['discovered','screening','validating'].includes(store.getOpportunity(opportunityId)!.status))throw new Error('Opportunity not open for validation planning');
    const item=JSON.parse(source.payload) as ResearchOpportunity;
    const experimentId=store.createExperiment({opportunityId,goalId:null,taskId:null,status:'planned',hypothesis:plan.hypothesis,
      channel:item.economics?.channel??'To be selected after reachable-customer review',offer:item.economics?.offer??plan.action,maxBudgetCents:0,maxInferenceCostCents:0,maxDurationHours:168,
      successCriteria:plan.successCriteria,failureCriteria:'No qualified demand or no credible positive all-in economics within seven days',stopCondition:plan.stopCondition,
      forecastRevenueCents:item.forecast.revenueCents,forecastCostCents:item.forecast.costCents+item.forecast.validationBudgetCents,
      forecastProbabilitySuccess:item.forecast.probability,forecastTimeToRevenueHours:item.forecast.days*24,
      actualRevenueCents:0,actualCostCents:0,result:null,lesson:null,startedAt:null,completedAt:null});
    if(old)db.prepare('INSERT INTO obolus_research_plan_revisions(research_id,experiment_id,previous_experiment_id,snapshot,reason) VALUES(?,?,?,?,?)').run(researchId,experimentId,old.experiment_id,snapshot,revisionReason!);
    else db.prepare('INSERT INTO obolus_research_experiments VALUES(?,?,?)').run(researchId,experimentId,snapshot);
    return {experimentId,duplicate:false};
  }).immediate();
}
