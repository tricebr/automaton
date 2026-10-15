import type {Database} from 'better-sqlite3';
import type {LocalWorkerPool} from './local-worker.js';
import {claimNextResearchTask,researchTaskLineageBlock,stopExhaustedResearchExperiments} from '../revenue/research-handoff.js';
import {ulid} from 'ulid';
import {RevenueStore} from '../revenue/store.js';
import {ExperimentBudgetGovernor} from '../revenue/budget-governor.js';
import {assessRunningOutcomeContracts} from '../revenue/outcome.js';

type DispatchState='stopped'|'running'|'paused'|'emergency';

/** Research ownership excludes legacy assignment and automatic crash retries. */
export function isResearchManagedTask(db:Database,taskId:string):boolean{
  const table=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const dispatched=table('obolus_dispatched_tasks'),plans=table('obolus_research_experiments'),revisions=table('obolus_research_plan_revisions');
  if(!dispatched&&!plans&&!revisions)return false;
  const seen=new Set<string>();let current:string|null=taskId;
  while(current){
    if(seen.has(current)||seen.size>=100)return true;
    seen.add(current);
    if(dispatched&&db.prepare('SELECT 1 FROM obolus_dispatched_tasks WHERE task_id=?').get(current))return true;
    if(plans&&db.prepare('SELECT 1 FROM revenue_experiments e JOIN obolus_research_experiments p ON p.experiment_id=e.id WHERE e.task_id=?').get(current))return true;
    if(revisions&&db.prepare('SELECT 1 FROM revenue_experiments e JOIN obolus_research_plan_revisions p ON p.experiment_id=e.id WHERE e.task_id=?').get(current))return true;
    current=(db.prepare('SELECT parent_id FROM task_graph WHERE id=?').get(current) as {parent_id:string|null}|undefined)?.parent_id??null;
  }
  return false;
}

/** Authenticated UI may restrict execution, never start it or clear emergency state. */
export function restrictResearchDispatch(db:Database,state:'paused'|'stopped'|'emergency'){
  if(!['paused','stopped','emergency'].includes(state))throw new Error('Only restrictive dispatch controls are available');
  return db.transaction(()=>{
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_dispatch_control'").get())throw new Error('Dispatcher not configured in this database');
    const current=db.prepare('SELECT state FROM obolus_dispatch_control WHERE id=1').get() as {state:string}|undefined;
    if(!current)throw new Error('Dispatcher not configured in this database');
    if(current.state==='emergency'&&state!=='emergency')throw new Error('Emergency reset requires operator review');
    if(current.state==='stopped'&&state==='paused')throw new Error('Stopped dispatcher cannot be paused');
    db.exec("CREATE TABLE IF NOT EXISTS obolus_dispatch_control_audit(id INTEGER PRIMARY KEY,state TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')))");
    db.prepare('UPDATE obolus_dispatch_control SET state=? WHERE id=1').run(state);
    db.prepare('INSERT INTO obolus_dispatch_control_audit(state) VALUES(?)').run(state);
    return {state,scope:'Blocks new inference and tool boundaries; in-flight actions require reconciliation'};
  }).immediate();
}

/** Read-only, bounded diagnostics; must not construct a dispatcher or recover its state. */
export function researchDispatchSnapshot(db:Database){
  return db.transaction(()=>{
    const exists=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const control=exists('obolus_dispatch_control')?db.prepare('SELECT state FROM obolus_dispatch_control WHERE id=1').get() as {state:string}|undefined:undefined;
    const policy=exists('obolus_research_dispatch_policy')?db.prepare('SELECT max_workers FROM obolus_research_dispatch_policy WHERE id=1').get() as {max_workers:number}|undefined:undefined;
    const active=(db.prepare("SELECT COUNT(*) n FROM task_graph WHERE status IN ('assigned','running')").get() as {n:number}).n;
    const rows=exists('obolus_dispatched_tasks')?db.prepare(`SELECT d.task_id,t.status,d.worker_address,
      CASE WHEN d.error IS NOT NULL THEN 1 ELSE 0 END start_uncertain
      FROM obolus_dispatched_tasks d LEFT JOIN task_graph t ON t.id=d.task_id
      ORDER BY CASE WHEN t.status IS NULL OR t.status IN ('assigned','running') THEN 0 ELSE 1 END,d.task_id DESC LIMIT 101`).all() as {task_id:string;status:string|null;worker_address:string|null;start_uncertain:number}[]:[];
    return {state:control?.state??'unconfigured',maxWorkers:policy?.max_workers??null,activeTasks:active,
      tasks:rows.slice(0,100).map(row=>({...row,review:row.status===null?'Aufgabe fehlt':row.start_uncertain?'Start unklar; prüfen':
        row.status==='assigned'||row.status==='running'?'Zuweisung vorhanden; Prozessstatus separat prüfen':'Abgeschlossen oder beendet'})),
      truncated:rows.length>100,scope:'Nur diese Datenbank; keine Prozess-Lebendprüfung oder Ausführungsfreigabe'};
  })();
}

/** Explicit private execution controller. Construction never resumes execution. */
export class ResearchDispatcher {
  constructor(private readonly db:Database,private readonly pool:Pick<LocalWorkerPool,'spawn'|'shutdown'>){
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_dispatch_control(id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL);
      INSERT OR IGNORE INTO obolus_dispatch_control VALUES(1,'stopped');
      UPDATE obolus_dispatch_control SET state='paused' WHERE state='running';
      CREATE TABLE IF NOT EXISTS obolus_dispatched_tasks(task_id TEXT PRIMARY KEY,claimed_address TEXT NOT NULL,worker_address TEXT,error TEXT);`);
  }
  get state():DispatchState{return (this.db.prepare('SELECT state FROM obolus_dispatch_control WHERE id=1').get() as {state:DispatchState}).state;}
  async control(next:DispatchState){
    if(!['stopped','running','paused','emergency'].includes(next))throw new Error('Invalid dispatch state');
    this.db.transaction(()=>{
      if(this.state==='emergency'&&next!=='emergency'&&next!=='stopped')throw new Error('Stop and review emergency before restart');
      this.db.prepare('UPDATE obolus_dispatch_control SET state=? WHERE id=1').run(next);
    }).immediate();
    if(next==='stopped'||next==='emergency')await this.pool.shutdown();
  }
  /** One bounded dispatch; caller owns scheduling. No automatic claim recovery. */
  tick(){
    const selection=this.db.transaction(()=>{
      if(this.state!=='running')return null;
      stopExhaustedResearchExperiments(this.db);
      assessRunningOutcomeContracts(this.db);
      const claim=claimNextResearchTask(this.db,`local://dispatch-${ulid()}`);
      if(claim.task)this.db.prepare('INSERT INTO obolus_dispatched_tasks(task_id,claimed_address) VALUES(?,?)').run(claim.task.id,claim.task.assignedTo);
      return claim;
    }).immediate();
    if(!selection?.task)return selection;
    try{
      const worker=this.pool.spawn(selection.task);
      this.db.prepare('UPDATE obolus_dispatched_tasks SET worker_address=? WHERE task_id=?').run(worker.address,selection.task.id);
    }catch{
      // Claim is deliberately retained: a throwing spawn cannot prove no work began.
      this.db.prepare('UPDATE obolus_dispatched_tasks SET error=? WHERE task_id=?').run('Worker start uncertain; reconcile before retry',selection.task.id);
      throw new Error('Worker start uncertain; claim retained for reconciliation');
    }
    return selection;
  }
}

export function researchDispatchAllowsInference(db:Database,taskId:string):boolean{
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_dispatched_tasks'").get())return true;
  // Descendants inherit the execution control of their dispatched ancestor.
  const mapped=db.prepare(`WITH RECURSIVE ancestors(id) AS (
    SELECT ? UNION SELECT t.parent_id FROM task_graph t JOIN ancestors a ON t.id=a.id WHERE t.parent_id IS NOT NULL LIMIT 101
  ) SELECT a.id,d.task_id FROM ancestors a LEFT JOIN obolus_dispatched_tasks d ON d.task_id=a.id`).all(taskId) as {id:string;task_id:string|null}[];
  if(mapped.length>100)return false;
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_dispatch_cancellations'").get()&&
    mapped.some(row=>db.prepare('SELECT 1 FROM obolus_dispatch_cancellations WHERE task_id=?').get(row.id)))return false;
  if(!mapped.some(row=>row.task_id))return true;
  if(researchTaskLineageBlock(db,taskId))return false;
  const experiment=new RevenueStore(db).getActiveExperimentForTask(taskId,true);
  if(!experiment||experiment.status!=='running'||!Number.isFinite(experiment.maxDurationHours)||experiment.maxDurationHours!<=0)return false;
  const governor=new ExperimentBudgetGovernor(db);
  if(!governor.checkDuration(experiment.id).allowed||!governor.checkTotalBudget(experiment.id,0).allowed)return false;
  const control=db.prepare('SELECT state FROM obolus_dispatch_control WHERE id=1').get() as {state:string}|undefined;
  return control?.state==='running';
}

/** Trusted operator reconciliation, never automatic recovery or retry. */
export function cancelReviewedDispatch(db:Database,taskId:string,reason:string,workersStopped:boolean){
  if(typeof taskId!=='string'||!taskId||taskId.length>100||typeof reason!=='string'||!reason.trim()||reason.length>1000||workersStopped!==true)
    throw new Error('Task, bounded review reason and explicit stopped-worker attestation required');
  return db.transaction(()=>{
    const state=db.prepare('SELECT state FROM obolus_dispatch_control WHERE id=1').get() as {state:string}|undefined;
    if(!state||!['stopped','emergency'].includes(state.state))throw new Error('Stop dispatch before reconciliation');
    if(!db.prepare('SELECT 1 FROM obolus_dispatched_tasks WHERE task_id=?').get(taskId))throw new Error('Unknown dispatch claim');
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_dispatch_cancellations(task_id TEXT PRIMARY KEY,reason TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')));
      CREATE TRIGGER IF NOT EXISTS dispatch_cancellation_no_update BEFORE UPDATE ON obolus_dispatch_cancellations BEGIN SELECT RAISE(ABORT,'Cancellation immutable'); END;
      CREATE TRIGGER IF NOT EXISTS dispatch_cancellation_no_delete BEFORE DELETE ON obolus_dispatch_cancellations BEGIN SELECT RAISE(ABORT,'Cancellation immutable'); END;`);
    const old=db.prepare('SELECT reason FROM obolus_dispatch_cancellations WHERE task_id=?').get(taskId) as {reason:string}|undefined;
    if(old){if(old.reason!==reason.trim())throw new Error('Conflicting cancellation review');return {cancelled:true,duplicate:true};}
    const task=db.prepare('SELECT status FROM task_graph WHERE id=?').get(taskId) as {status:string}|undefined;
    if(!task||!['assigned','running','failed'].includes(task.status))throw new Error('Claim is not eligible for cancellation');
    const descendants=db.prepare(`WITH RECURSIVE children(id) AS (SELECT id FROM task_graph WHERE parent_id=?
      UNION SELECT t.id FROM task_graph t JOIN children c ON t.parent_id=c.id LIMIT 101)
      SELECT t.status FROM task_graph t JOIN children c ON c.id=t.id`).all(taskId) as {status:string}[];
    if(descendants.length>100||descendants.some(t=>!['completed','failed','cancelled'].includes(t.status)))throw new Error('Unresolved child tasks prevent cancellation');
    if(db.prepare("SELECT 1 FROM inference_reservations WHERE status='pending' LIMIT 1").get())throw new Error('Unresolved inference costs prevent cancellation');
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_reserved_operations'").get()&&
      db.prepare("SELECT 1 FROM obolus_reserved_operations WHERE status!='settled' LIMIT 1").get())throw new Error('Unresolved operations prevent cancellation');
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='aureus_capital_commitments'").get()&&
      db.prepare('SELECT 1 FROM aureus_capital_commitments WHERE id NOT IN (SELECT id FROM aureus_capital_settlements) LIMIT 1').get())throw new Error('Unresolved capital commitments prevent cancellation');
    db.prepare('INSERT INTO obolus_dispatch_cancellations(task_id,reason) VALUES(?,?)').run(taskId,reason.trim());
    db.prepare("UPDATE task_graph SET status='cancelled',completed_at=datetime('now') WHERE id=?").run(taskId);
    return {cancelled:true,duplicate:false};
  }).immediate();
}
