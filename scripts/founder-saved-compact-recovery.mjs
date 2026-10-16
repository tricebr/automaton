// Offline recovery only. Caller attaches the existing workflow DB as recovery_workflow.
// No credentials, provider calls, budget writes, retries or power transitions.
import {createHash} from 'node:crypto';
import {createSplitPrivateAdapters} from './founder-private-split.mjs';
import {admissibleResearchSources} from './founder-knowledge.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
export async function recoverSavedCompactDraft({db,budget,power,partId,apply=false}){
 const active=()=>{if(power()?.enabled!==true||db.prepare('SELECT status FROM founder_control').get()?.status!=='running')throw Error('Running human-started session required');};
 active();
 const row=db.prepare('SELECT * FROM founder_jobs WHERE id=?').get(partId);
 if(!row||row.status!=='failed')throw Error('Failed saved part required');
 const task=JSON.parse(row.payload),attempt=db.prepare('SELECT * FROM founder_attempts WHERE run_id=? AND task_id=?').get(row.run_id,row.id);
 if(!attempt?.result||!attempt.receipt)throw Error('Saved response and receipt required');
 const saved=JSON.parse(attempt.result),receipt=JSON.parse(attempt.receipt),paid=budget.prepare('SELECT * FROM founder_reservations WHERE id=?').get(row.run_id);
 const checkSources=()=>{const knowledge=db.prepare('SELECT payload FROM recovery_knowledge.founder_knowledge LIMIT 1000').all().map(r=>JSON.parse(r.payload));const usable=admissibleResearchSources(saved.sources??[],knowledge);if(!usable.length||usable.length!==saved.sources?.length||!saved.analysis?.sourceIds?.every(id=>usable.some(s=>s.id===id)))throw Error('Saved sources stale, contradicted or missing');};
 checkSources();
 if(task.kind!=='private-part'||saved.splitPart?.version!==2||JSON.stringify(saved.splitPart)!==JSON.stringify(task.input.splitPart)||!Number.isSafeInteger(saved.costEvidence?.outputTokens)||saved.costEvidence.outputTokens>2000||paid?.root_task!==task.rootTaskId||!Number.isSafeInteger(paid?.actual_cost)||paid.actual_cost!==receipt.actualCostRappen||paid.receipt!==receipt.evidenceRef||saved.costReceipt?.actualCostRappen!==paid.actual_cost||saved.costReceipt?.evidenceRef!==paid.receipt)throw Error('Saved paid evidence mismatch');
 if(task.dependencies.some(id=>db.prepare('SELECT status FROM founder_jobs WHERE id=?').get(id)?.status!=='done'))throw Error('Source prerequisite incomplete');
 const parent=db.prepare('SELECT * FROM founder_jobs WHERE id=?').get(saved.splitPart.parentId);
 if(!parent||!['blocked','queued'].includes(parent.status)||parent.attempts!==0||parent.run_id!==null)throw Error('Unexecuted parent required');
 const parentTask=JSON.parse(parent.payload);if(parentTask.rootTaskId!==task.rootTaskId||parentTask.kind!=='private-draft'||JSON.stringify(parentTask.dependencies)!==JSON.stringify([partId]))throw Error('Parent provenance mismatch');
 const adapters=createSplitPrivateAdapters({});if(!adapters['private-part'].verify(saved))throw Error('Saved response still fails verification');
 const result=await adapters['private-draft'].execute({task:parentTask,dependencies:[saved],assertActive:active});
 if(!adapters['private-draft'].verify(result))throw Error('Assembled draft fails verification');
 const payload=JSON.stringify(result),at=new Date().toISOString(),evidence={action:'offline-saved-compact-recovery',run:row.run_id,receipt,originalResponseHash:hash(attempt.result),assembledHash:hash(payload),providerCalls:0,additionalCostRappen:0,previousPartStatus:row.status,previousParentStatus:parent.status};
 if(apply)db.transaction(()=>{
  active();
  checkSources();
  for(const original of [row,parent]){const current=db.prepare('SELECT * FROM founder_jobs WHERE id=?').get(original.id);if(JSON.stringify(current)!==JSON.stringify(original))throw Error('Concurrent task change');}
  if(JSON.stringify(db.prepare('SELECT * FROM founder_attempts WHERE run_id=? AND task_id=?').get(row.run_id,row.id))!==JSON.stringify(attempt)||JSON.stringify(budget.prepare('SELECT * FROM founder_reservations WHERE id=?').get(row.run_id))!==JSON.stringify(paid))throw Error('Concurrent evidence change');
  // Mark handled before exposing done: runtime must not schedule paid replanning or publication.
  db.prepare('INSERT OR IGNORE INTO recovery_workflow.decisions(id,payload,at) VALUES(?,?,?)').run(parent.id,JSON.stringify({kind:'private-draft',handled:true,offlineRecovery:true,providerCalls:0,reason:'Existing saved answer completed locally; no paid follow-up authorized.'}),Date.now());
  db.prepare("UPDATE founder_jobs SET status='done',reason=NULL,result=?,digest=?,next_retry_ms=NULL,updated_ms=? WHERE id=?").run(attempt.result,hash(attempt.result),Date.now(),row.id);
  db.prepare("UPDATE founder_jobs SET status='done',reason=NULL,result=?,digest=?,next_retry_ms=NULL,updated_ms=? WHERE id=?").run(payload,hash(payload),Date.now(),parent.id);
  for(const id of [row.id,parent.id]){db.prepare('INSERT INTO founder_reconciliations(task_id,at,evidence) VALUES(?,?,?)').run(id,at,JSON.stringify(evidence));db.prepare('INSERT INTO founder_events(at,task_id,action) VALUES(?,?,?)').run(at,id,evidence.action);}
 }).immediate();
 return {at,applied:apply,partId:row.id,parentId:parent.id,documentLength:result.analysis.deliverableMarkdown.length,...evidence};
}
