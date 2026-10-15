import {createHash} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {assertNoKnownSecrets} from '../observability/redaction.js';
import {supportErased} from './support-privacy.js';

export interface SupportMessage {mailbox:string;providerId:string;from:string;subject:string;body:string}
const bounded=(s:unknown,max:number):s is string=>typeof s==='string'&&s.length>0&&s.length<=max&&!s.includes('\0');
/** Local intake only. Message text is untrusted data, never authorization or executable instructions. */
export function receiveSupportMessage(db:Database,input:SupportMessage) {
  assertNoKnownSecrets(input);
  if(!input||!bounded(input.mailbox,200)||!bounded(input.providerId,300)||!bounded(input.from,320)||
    typeof input.subject!=='string'||input.subject.length>1000||input.subject.includes('\0')||!bounded(input.body,64000)||
    [input.mailbox,input.providerId,input.from].some(s=>s!==s.trim()||/[\r\n]/.test(s)))throw new Error('Invalid support message');
  const message={mailbox:input.mailbox,providerId:input.providerId,from:input.from,subject:input.subject,body:input.body};
  const id=createHash('sha256').update(JSON.stringify([message.mailbox,message.providerId])).digest('hex');
  if(supportErased(db,id))return {id,duplicate:true,status:'erased'};
  const payload=JSON.stringify(message);
  return db.transaction(()=>{
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_support_inbox(id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'received',created_at TEXT NOT NULL DEFAULT(datetime('now')));
      CREATE TRIGGER IF NOT EXISTS support_inbox_payload_update BEFORE UPDATE OF id,payload,created_at ON obolus_support_inbox BEGIN SELECT RAISE(ABORT,'Support message evidence immutable'); END;
      CREATE TRIGGER IF NOT EXISTS support_inbox_delete BEFORE DELETE ON obolus_support_inbox BEGIN SELECT RAISE(ABORT,'Support message history immutable'); END;`);
    const previous=db.prepare('SELECT payload,status FROM obolus_support_inbox WHERE id=?').get(id) as {payload:string;status:string}|undefined;
    if(previous){if(previous.payload!==payload)throw new Error('Conflicting support message');return {id,duplicate:true,status:previous.status};}
    const count=db.prepare('SELECT COUNT(*) n FROM obolus_support_inbox').get() as {n:number};
    if(count.n>=10000)throw new Error('Support inbox capacity reached');
    db.prepare('INSERT INTO obolus_support_inbox(id,payload) VALUES(?,?)').run(id,payload);
    return {id,duplicate:false,status:'received' as const};
  }).immediate();
}

/** Explicit operator resolution; closing a case is not proof of payment or delivery. */
export function closeSupportReview(db:Database,id:string,reason:string,reviewedBy:string){
  // oxlint-disable-next-line no-control-regex -- Intentionally reject or sanitize control characters at the security boundary.
  const boundedReview=(value:unknown,max:number)=>typeof value==='string'&&!!value.trim()&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
  if(!/^[a-f0-9]{64}$/.test(id)||!boundedReview(reason,2000)||!boundedReview(reviewedBy,200))throw new Error('Review ID, reason and reviewer required');
  return db.transaction(()=>{
    const row=db.prepare('SELECT status FROM obolus_support_inbox WHERE id=?').get(id) as {status:string}|undefined;
    if(!row)throw new Error('Unknown support review');
    const table=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if(table('obolus_support_replies')&&db.prepare("SELECT 1 FROM obolus_support_replies WHERE inbox_id=? AND status NOT IN ('sent','cancelled')").get(id))
      throw new Error('Resolve pending or uncertain support delivery before closing review');
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_support_review_resolutions(inbox_id TEXT PRIMARY KEY,reason TEXT NOT NULL,reviewed_by TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')));
      CREATE TRIGGER IF NOT EXISTS support_review_update BEFORE UPDATE ON obolus_support_review_resolutions BEGIN SELECT RAISE(ABORT,'Support review audit immutable'); END;
      CREATE TRIGGER IF NOT EXISTS support_review_delete BEFORE DELETE ON obolus_support_review_resolutions BEGIN SELECT RAISE(ABORT,'Support review audit immutable'); END;`);
    const previous=db.prepare('SELECT reason,reviewed_by FROM obolus_support_review_resolutions WHERE inbox_id=?').get(id) as {reason:string;reviewed_by:string}|undefined;
    if(previous){if(previous.reason!==reason||previous.reviewed_by!==reviewedBy||row.status!=='reviewed')throw new Error('Conflicting support review resolution');return {reviewed:true,duplicate:true};}
    if(row.status!=='needs_review')throw new Error('Open support review required');
    db.prepare('INSERT INTO obolus_support_review_resolutions(inbox_id,reason,reviewed_by) VALUES(?,?,?)').run(id,reason,reviewedBy);
    db.prepare("UPDATE obolus_support_inbox SET status='reviewed' WHERE id=?").run(id);
    return {reviewed:true,duplicate:false};
  }).immediate();
}
