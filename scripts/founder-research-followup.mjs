import {createHash} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
// Operator-requested annotations preserve original evidence and scheduling identity.
// No budget, task status, lease, retry or workflow-decision writes.
export function annotateResearch(db,{taskId,expectedDigest,followUp}){
 return db.transaction(()=>{
  const row=db.prepare('SELECT status,result,digest FROM founder_jobs WHERE id=?').get(taskId);
  if(row?.status!=='done'||!row.result||row.digest!==expectedDigest||hash(row.result)!==row.digest)throw Error('Completed result changed or integrity missing');
  const result=JSON.parse(row.result);
  if(result.kind!=='research'||result.target!==followUp?.target||followUp.schema!=='numaron-research-followup-v1'||!Number.isFinite(Date.parse(followUp.observedAt))||Date.parse(followUp.observedAt)<Date.parse(result.observedAt))throw Error('Follow-up binding missing');
  const payload=JSON.stringify({...result,operatorFollowUp:followUp});if(Buffer.byteLength(payload)>262144)throw Error('Annotated result too large');
  const digest=hash(payload);if(digest===row.digest)return {digest,duplicate:true};
  db.prepare('INSERT INTO founder_reconciliations(task_id,at,evidence) VALUES(?,?,?)').run(taskId,followUp.observedAt,JSON.stringify({action:'operator-research-followup',originalResult:row.result,originalDigest:row.digest,newDigest:digest,scope:'Presentation supplement only; sources, goal, status, attempts, retries, budgets and workflow identity preserved'}));
  const changed=db.prepare("UPDATE founder_jobs SET result=?,digest=? WHERE id=? AND status='done' AND digest=?").run(payload,digest,taskId,expectedDigest).changes;if(changed!==1)throw Error('Result changed');
  return {digest,duplicate:false};
 }).immediate();
}
