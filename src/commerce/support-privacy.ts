import {securityTransaction} from '../security/action-gate.js';
import type {Database} from 'better-sqlite3';
import {assertActionGate,actionContextDigest} from '../security/action-gate.js';

export const supportErasureScope=(id:string)=>({activity:'support-erasure',component:'support',dataClass:'PERSONAL' as const,contextDigest:actionContextDigest({id})});
export const supportRetentionScope=(days:number)=>({activity:'support-retention',component:'support',dataClass:'PERSONAL' as const,contextDigest:actionContextDigest({days,terminalCasesOnly:true})});
/** Operator configuration; the matching fresh legal/privacy review is separately required. */
export function configureSupportRetention(db:Database,days:number){
 if(!Number.isSafeInteger(days)||days<1||days>365)throw Error('Retention must be 1..365 days');
 securityTransaction(db,()=>{assertActionGate(db,supportRetentionScope(days));
  db.exec('CREATE TABLE IF NOT EXISTS obolus_support_retention(id INTEGER PRIMARY KEY CHECK(id=1),days INTEGER NOT NULL)');
  db.prepare('INSERT INTO obolus_support_retention VALUES(1,?) ON CONFLICT(id) DO UPDATE SET days=excluded.days').run(days);
 }).immediate();
}
/** Bounded maintenance, no network. Unresolved cases are never silently erased. */
export function expireSupportCases(db:Database,limit=20){
 if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Bounded retention batch required');
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='obolus_support_retention'").get())return {configured:false,erased:0};
 return securityTransaction(db,()=>{
  const policy=db.prepare('SELECT days FROM obolus_support_retention WHERE id=1').get() as {days:number}|undefined;
  if(!policy||!Number.isSafeInteger(policy.days)||policy.days<1||policy.days>365)throw Error('Invalid retention policy');
  assertActionGate(db,supportRetentionScope(policy.days));
  const rows=db.prepare("SELECT id FROM obolus_support_inbox WHERE status='reviewed' AND created_at<=datetime('now',?) ORDER BY created_at LIMIT ?").all(`-${policy.days} days`,limit) as {id:string}[];
  for(const row of rows)eraseCase(db,row.id,true,()=>assertActionGate(db,supportRetentionScope(policy.days)));
  return {configured:true,erased:rows.length};
 }).immediate();
}
export function supportErased(db:Database,id:string){
 return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='obolus_support_erasure'").get()&&
  !!db.prepare('SELECT 1 FROM obolus_support_erasure WHERE inbox_id=?').get(id);
}
/** Trusted privacy-maintenance boundary, NOT an agent tool. A case-specific
 * reviewed retention/legal decision is required. Never touches financial rows,
 * remote mail, WAL copies or backups; physical/media erasure needs separate care. */
export function eraseSupportCase(db:Database,id:string){
 return eraseCase(db,id,false,()=>assertActionGate(db,supportErasureScope(id)));
}
function eraseCase(db:Database,id:string,retention:boolean,authorize:()=>void){
 if(!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid support erasure reference');
 return securityTransaction(db,()=>{
  if(supportErased(db,id))return {erased:true,duplicate:true};
  authorize();
  const exists=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const policy=db.prepare('SELECT paused FROM obolus_support_policy WHERE id=1').get() as {paused:number}|undefined;
  const inbox=db.prepare('SELECT status FROM obolus_support_inbox WHERE id=?').get(id) as {status:string}|undefined;
  if(!retention&&policy?.paused!==1||inbox?.status!=='reviewed')throw Error('Pause support and resolve the case before erasure');
  if(exists('obolus_support_replies')&&db.prepare("SELECT 1 FROM obolus_support_replies WHERE inbox_id=? AND status NOT IN ('sent','cancelled')").get(id))
   throw Error('Pending or uncertain delivery blocks erasure');
  const replyIds=exists('obolus_support_replies')?(db.prepare('SELECT id FROM obolus_support_replies WHERE inbox_id=?').all(id) as {id:string}[]).map(row=>row.id):[];
  // Temporarily remove only the exact table-local triggers inside this write
  // transaction; restore their original definitions before committing. Any
  // unexpected constraint/error rolls back data AND all trigger changes.
  const remove=(table:string,column:string,values:string[])=>{
   if(!exists(table)||!values.length)return;
   const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(table) as {name:string;sql:string}[];
   for(const trigger of triggers)db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"','""')}"`);
   const statement=db.prepare(`DELETE FROM ${table} WHERE ${column}=?`);
   for(const value of values)statement.run(value);
   for(const trigger of triggers)db.exec(trigger.sql);
  };
  remove('obolus_support_followups','previous_id',replyIds);
  remove('obolus_support_cancellations','reply_id',replyIds);
  remove('obolus_support_replies_v1_archive','inbox_id',[id]);
  remove('obolus_support_replies','inbox_id',[id]);
  remove('obolus_support_receipts','inbox_id',[id]);
  remove('obolus_support_review_resolutions','inbox_id',[id]);
  remove('obolus_support_inbox','id',[id]);
  db.exec(`CREATE TABLE IF NOT EXISTS obolus_support_erasure(inbox_id TEXT PRIMARY KEY,erased_ms INTEGER NOT NULL);
   CREATE TRIGGER IF NOT EXISTS support_erasure_delete BEFORE DELETE ON obolus_support_erasure BEGIN SELECT RAISE(ABORT,'Erasure marker immutable'); END;
   CREATE TRIGGER IF NOT EXISTS support_erasure_update BEFORE UPDATE ON obolus_support_erasure BEGIN SELECT RAISE(ABORT,'Erasure marker immutable'); END;`);
  db.prepare('INSERT INTO obolus_support_erasure VALUES(?,?)').run(id,Date.now());
  return {erased:true,duplicate:false};
 }).immediate();
}
