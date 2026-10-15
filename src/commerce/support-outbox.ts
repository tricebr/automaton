import {securityTransaction} from '../security/action-gate.js';
import {createHash} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {assertNoKnownSecrets} from '../observability/redaction.js';
import {assertActionGate,actionContextDigest} from '../security/action-gate.js';
import {SUPPORT_ACKNOWLEDGEMENT} from './support-knowledge.js';

export const supportActionScope=(mailbox:string)=>({activity:'support-send',component:'support',dataClass:'PERSONAL' as const,
 contextDigest:actionContextDigest({mailbox:mailbox.toLowerCase(),purpose:'customer-support',processor:'gmail'})});

export interface SupportReply {id:string;mailbox:string;recipient:string;subject:string;body:string;inReplyTo:string;threadId:string}
/** Separate from mailbox permission: binds exact outgoing assertions and recipient.
 * Review content is stored only in the existing trusted ActionGate ledger. */
export const supportContentActionScope=(reply:SupportReply)=>({activity:'support-publication',component:'support',dataClass:'PERSONAL' as const,
 contextDigest:actionContextDigest(reply),claimInventory:[actionContextDigest(reply.body)]});
export interface SupportSendAuthorization {readonly kind:'outbox-send'}
const sendAuthorizations=new WeakMap<SupportSendAuthorization,{db:Database;payload:string;expiresAt:number}>();
/** Accepted provider implementations check immediately before I/O and consume
 * once. A plain object, stale permit or direct send cannot bypass admission. */
export function verifySupportSendAuthorization(reply:SupportReply,authorization:SupportSendAuthorization|undefined,consume=false){
 const permit=authorization&&sendAuthorizations.get(authorization);
 if(!permit||permit.expiresAt<=Date.now()||permit.payload!==JSON.stringify(reply))throw new SupportDeliveryNotStartedError();
 const {db}=permit;
 const policy=db.prepare('SELECT mailbox,paused FROM obolus_support_policy WHERE id=1').get() as {mailbox:string;paused:number}|undefined;
 const row=db.prepare('SELECT payload,status FROM obolus_support_replies WHERE id=?').get(reply.id) as {payload:string;status:string}|undefined;
 if(!policy||policy.paused!==0||policy.mailbox!==reply.mailbox||!row||row.status!=='sending'||row.payload!==permit.payload)throw new SupportDeliveryNotStartedError();
 try{
  assertActionGate(db,supportActionScope(reply.mailbox));
  if(reply.body!==SUPPORT_ACKNOWLEDGEMENT)assertActionGate(db,supportContentActionScope(reply));
 }catch{throw new SupportDeliveryNotStartedError();}
 if(consume)sendAuthorizations.delete(authorization!);
}
export interface SupportTransport {send(reply:SupportReply,authorization?:SupportSendAuthorization):Promise<{providerId:string}>}
/** Trusted transport assertion: failure occurred before initiating any remote delivery. */
export class SupportDeliveryNotStartedError extends Error {
  constructor(){super('Support delivery did not start; verify transport configuration');this.name='SupportDeliveryNotStartedError';}
}
const email=(s:unknown):s is string=>typeof s==='string'&&s.length<=254&&/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s);
const reference=(s:unknown):s is string=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(s);
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');

/** Operator-only withdrawal of an unsent draft. Never cancels or retries a remote delivery. */
export function cancelSupportReply(db:Database,id:string,reason:string){
  // oxlint-disable-next-line no-control-regex -- Intentionally reject or sanitize control characters at the security boundary.
  if(!/^[a-f0-9]{64}$/.test(id)||typeof reason!=='string'||!reason.trim()||reason.length>1000||/[\u0000-\u001f\u007f]/.test(reason))throw new Error('Valid reply ID and cancellation reason required');
  return securityTransaction(db,()=>{
    const policy=db.prepare('SELECT paused FROM obolus_support_policy WHERE id=1').get() as {paused:number}|undefined;
    if(policy?.paused!==1)throw new Error('Pause support before cancelling a draft');
    const row=db.prepare('SELECT inbox_id,status,attempted_ms FROM obolus_support_replies WHERE id=?').get(id) as {inbox_id:string;status:string;attempted_ms:number|null}|undefined;
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_support_cancellations(reply_id TEXT PRIMARY KEY,reason TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')));
      CREATE TRIGGER IF NOT EXISTS support_cancellation_update BEFORE UPDATE ON obolus_support_cancellations BEGIN SELECT RAISE(ABORT,'Support cancellation immutable'); END;
      CREATE TRIGGER IF NOT EXISTS support_cancellation_delete BEFORE DELETE ON obolus_support_cancellations BEGIN SELECT RAISE(ABORT,'Support cancellation immutable'); END;`);
    const prior=db.prepare('SELECT reason FROM obolus_support_cancellations WHERE reply_id=?').get(id) as {reason:string}|undefined;
    if(prior){if(prior.reason!==reason||row?.status!=='cancelled')throw new Error('Conflicting support cancellation');return {cancelled:true,duplicate:true};}
    if(!row||!['queued','deferred'].includes(row.status)||row.attempted_ms!==null)throw new Error('Only unsent support drafts can be cancelled');
    // Upgrade the old transition guard transactionally; terminal delivery states remain irreversible.
    db.exec(`DROP TRIGGER IF EXISTS support_reply_status;
      CREATE TRIGGER support_reply_status BEFORE UPDATE OF status ON obolus_support_replies
      WHEN NOT (OLD.status=NEW.status OR OLD.status IN ('queued','deferred') AND NEW.status='sending' OR OLD.status IN ('queued','deferred') AND NEW.status='cancelled' AND OLD.attempted_ms IS NULL AND EXISTS(SELECT 1 FROM obolus_support_cancellations WHERE reply_id=OLD.id) OR OLD.status='sending' AND NEW.status IN ('sent','uncertain','deferred') OR OLD.status='uncertain' AND NEW.status='sent')
      BEGIN SELECT RAISE(ABORT,'Invalid support send transition'); END;`);
    db.prepare('INSERT INTO obolus_support_cancellations(reply_id,reason) VALUES(?,?)').run(id,reason);
    db.prepare("UPDATE obolus_support_replies SET status='cancelled' WHERE id=?").run(id);
    db.prepare("UPDATE obolus_support_inbox SET status='needs_review' WHERE id=?").run(row.inbox_id);
    return {cancelled:true,duplicate:false};
  }).immediate();
}

/** Explicit operator setup. Replies start paused; reopening the store does not enable sending. */
export function configureSupportOutbox(db:Database,mailbox:string,maxDaily:number){
  if(!email(mailbox)||!Number.isSafeInteger(maxDaily)||maxDaily<1||maxDaily>100)throw new Error('Invalid support mailbox or daily ceiling');
  const canonical=mailbox.toLowerCase();
  securityTransaction(db,()=>{
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_support_policy(id INTEGER PRIMARY KEY CHECK(id=1),mailbox TEXT NOT NULL,max_daily INTEGER NOT NULL,paused INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS obolus_support_replies(id TEXT PRIMARY KEY,inbox_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',attempted_ms INTEGER,provider_id TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS support_provider_confirmation ON obolus_support_replies(provider_id);
      CREATE TRIGGER IF NOT EXISTS support_reply_status BEFORE UPDATE OF status ON obolus_support_replies
        WHEN NOT (OLD.status=NEW.status OR OLD.status IN ('queued','deferred') AND NEW.status='sending' OR OLD.status='sending' AND NEW.status IN ('sent','uncertain','deferred') OR OLD.status='uncertain' AND NEW.status='sent')
        BEGIN SELECT RAISE(ABORT,'Invalid support send transition'); END;
      CREATE TRIGGER IF NOT EXISTS support_reply_payload_update BEFORE UPDATE OF payload,inbox_id ON obolus_support_replies BEGIN SELECT RAISE(ABORT,'Support reply content immutable'); END;
      CREATE TRIGGER IF NOT EXISTS support_reply_delete BEFORE DELETE ON obolus_support_replies BEGIN SELECT RAISE(ABORT,'Support reply history immutable'); END;`);
    const old=db.prepare('SELECT mailbox FROM obolus_support_policy WHERE id=1').get() as {mailbox:string}|undefined;
    if(old&&old.mailbox!==canonical)throw new Error('Support mailbox binding is immutable');
    db.prepare('INSERT INTO obolus_support_policy(id,mailbox,max_daily,paused) VALUES(1,?,?,1) ON CONFLICT(id) DO UPDATE SET max_daily=MIN(max_daily,excluded.max_daily)').run(canonical,maxDaily);
  }).immediate();
}

/** Only a provider-side check can close an ambiguous send. Never re-executes delivery. */
export async function reconcileSupportReply(db:Database,id:string,providerId:string,verify:(reply:SupportReply,providerId:string)=>Promise<void>){
  if(!reference(id)||!reference(providerId))throw new Error('Invalid support reconciliation identifiers');
  const row=db.prepare('SELECT payload,status,provider_id FROM obolus_support_replies WHERE id=?').get(id) as {payload:string;status:string;provider_id:string|null}|undefined;
  if(!row||!['sending','uncertain','sent'].includes(row.status))throw new Error('Attempted support reply required');
  if(row.status==='sent'){
    if(row.provider_id!==providerId)throw new Error('Conflicting support delivery confirmation');
    return {duplicate:true,sent:true};
  }
  await verify(JSON.parse(row.payload),providerId);
  return securityTransaction(db,()=>{
    const current=db.prepare('SELECT payload,status,provider_id FROM obolus_support_replies WHERE id=?').get(id) as typeof row;
    if(!current||current.payload!==row.payload)throw new Error('Support reconciliation changed');
    if(current.status==='sent'){
      if(current.provider_id!==providerId)throw new Error('Conflicting support delivery confirmation');
      return {duplicate:true,sent:true};
    }
    if(!['sending','uncertain'].includes(current.status))throw new Error('Support delivery not eligible');
    db.prepare("UPDATE obolus_support_replies SET status='sent',provider_id=? WHERE id=?").run(providerId,id);
    return {duplicate:false,sent:true};
  }).immediate();
}

export function pauseSupportOutbox(db:Database,paused:boolean){
  if(typeof paused!=='boolean')throw new Error('Boolean support control required');
  if(db.prepare('UPDATE obolus_support_policy SET paused=? WHERE id=1').run(Number(paused)).changes!==1)throw new Error('Support mailbox not configured');
}

/** Trusted ingestion must bind provider-authenticated metadata to the existing local message.
 * Email content is not evidence of customer identity, payment, or execution authority.
 */
export function bindSupportReceipt(db:Database,inboxId:string,input:{mailbox:string;sender:string;messageId:string;threadId:string}){
  if(!reference(inboxId)||!email(input.mailbox)||!email(input.sender)||!reference(input.threadId)||
    typeof input.messageId!=='string'||input.messageId.length>200||!/^<[^<>\s@]+@[^<>\s@]+>$/.test(input.messageId))throw new Error('Invalid provider receipt metadata');
  const payload=JSON.stringify({...input,mailbox:input.mailbox.toLowerCase(),sender:input.sender.toLowerCase()});
  return securityTransaction(db,()=>{
    const source=db.prepare('SELECT payload FROM obolus_support_inbox WHERE id=?').get(inboxId) as {payload:string}|undefined;
    if(!source)throw new Error('Unknown support message');
    const stored=JSON.parse(source.payload);
    if(stored.mailbox.toLowerCase()!==input.mailbox.toLowerCase()||stored.from.toLowerCase()!==input.sender.toLowerCase())throw new Error('Support receipt mismatch');
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_support_receipts(inbox_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS support_receipt_update BEFORE UPDATE ON obolus_support_receipts BEGIN SELECT RAISE(ABORT,'Support receipt immutable'); END;
      CREATE TRIGGER IF NOT EXISTS support_receipt_delete BEFORE DELETE ON obolus_support_receipts BEGIN SELECT RAISE(ABORT,'Support receipt immutable'); END;`);
    const old=db.prepare('SELECT payload FROM obolus_support_receipts WHERE inbox_id=?').get(inboxId) as {payload:string}|undefined;
    if(old&&old.payload!==payload)throw new Error('Conflicting support receipt');
    db.prepare('INSERT OR IGNORE INTO obolus_support_receipts VALUES(?,?)').run(inboxId,payload);
  }).immediate();
}

/** Recipient, subject and thread come from the received message, never from model arguments. */
export function queueSupportReply(db:Database,inboxId:string,body:string){
  if(!reference(inboxId)||typeof body!=='string'||!body.trim()||Buffer.byteLength(body,'utf8')>20000||body.includes('\0'))throw new Error('Invalid bounded support reply');
  return securityTransaction(db,()=>{
    const policy=db.prepare('SELECT mailbox FROM obolus_support_policy WHERE id=1').get() as {mailbox:string}|undefined;
    const source=db.prepare('SELECT payload,status FROM obolus_support_inbox WHERE id=?').get(inboxId) as {payload:string;status:string}|undefined;
    const receipt=db.prepare('SELECT payload FROM obolus_support_receipts WHERE inbox_id=?').get(inboxId) as {payload:string}|undefined;
    if(!policy||!source||!receipt)throw new Error('Configured mailbox and authenticated receipt required');
    if(source.status==='reviewed')throw new Error('Support case already closed; no new reply permitted');
    const message=JSON.parse(source.payload),bound=JSON.parse(receipt.payload);
    if(bound.mailbox!==policy.mailbox||bound.sender===policy.mailbox)throw new Error('Support mailbox mismatch or self-reply');
    if(typeof message.subject!=='string'||Buffer.byteLength(message.subject,'utf8')>300||/[\r\n\0]/.test(message.subject))throw new Error('Invalid support subject');
    const id=digest(JSON.stringify([policy.mailbox,inboxId]));
    const reply:SupportReply={id,mailbox:policy.mailbox,recipient:bound.sender,subject:message.subject,body,inReplyTo:bound.messageId,threadId:bound.threadId};
    assertNoKnownSecrets(reply);
    const payload=JSON.stringify(reply);
    const old=db.prepare('SELECT payload,status FROM obolus_support_replies WHERE id=?').get(id) as {payload:string;status:string}|undefined;
    if(old){if(old.payload!==payload)throw new Error('Conflicting support reply; review before replacement');return {id,duplicate:true,status:old.status};}
    const count=db.prepare('SELECT COUNT(*) n FROM obolus_support_replies').get() as {n:number};
    if(count.n>=10000)throw new Error('Support outbox capacity reached');
    db.prepare('INSERT INTO obolus_support_replies(id,inbox_id,payload) VALUES(?,?,?)').run(id,inboxId,payload);
    return {id,duplicate:false,status:'queued'};
  }).immediate();
}

/** One exclusive durable send. Unclear attempts remain blocked across workers and restarts. */
export async function sendNextSupportReply(db:Database,transport:SupportTransport,options?:{requiredBody:string}|{requiredBodyFor:(reply:SupportReply)=>string}){
  const claim=securityTransaction(db,()=>{
    const policy=db.prepare('SELECT mailbox,max_daily,paused FROM obolus_support_policy WHERE id=1').get() as {mailbox:string;max_daily:number;paused:number}|undefined;
    if(!policy||policy.paused!==0)return null;
    if(!Number.isSafeInteger(policy.max_daily)||policy.max_daily<1||policy.max_daily>100)throw new Error('Invalid support daily ceiling; operator reconciliation required');
    if(db.prepare("SELECT 1 FROM obolus_support_replies WHERE status IN ('sending','uncertain') LIMIT 1").get())throw new Error('Uncertain support delivery requires reconciliation');
    const now=Date.now(),spent=db.prepare('SELECT COUNT(*) n FROM obolus_support_replies WHERE attempted_ms>=?').get(now-86400000) as {n:number};
    if(spent.n>=policy.max_daily)throw new Error('Support reply daily ceiling reached');
    const row=db.prepare("SELECT id,inbox_id,payload FROM obolus_support_replies WHERE status IN ('queued','deferred') ORDER BY rowid LIMIT 1").get() as {id:string;inbox_id:string;payload:string}|undefined;
    if(!row)return null;
    const inbox=db.prepare('SELECT status FROM obolus_support_inbox WHERE id=?').get(row.inbox_id) as {status:string}|undefined;
    if(!inbox||inbox.status==='reviewed')throw new Error('Closed or missing support case requires operator reconciliation');
    const reply=JSON.parse(row.payload) as SupportReply;
    assertNoKnownSecrets(reply);
    if(reply.mailbox!==policy.mailbox)throw new Error('Support reply account mismatch');
    if(options&&reply.body!==('requiredBody' in options?options.requiredBody:options.requiredBodyFor(reply)))throw new Error('Support reply requires operator delivery review');
    assertActionGate(db,supportActionScope(policy.mailbox),now);
    if(reply.body!==SUPPORT_ACKNOWLEDGEMENT)assertActionGate(db,supportContentActionScope(reply),now);
    db.prepare("UPDATE obolus_support_replies SET status='sending',attempted_ms=? WHERE id=?").run(now,row.id);
    return reply;
  }).immediate();
  if(!claim)return {sent:false};
  try{
    // Recheck after committing the claim. An already started remote send cannot be recalled.
    const control=db.prepare('SELECT paused FROM obolus_support_policy WHERE id=1').get() as {paused:number};
    if(control.paused!==0){
      db.prepare("UPDATE obolus_support_replies SET status='deferred',attempted_ms=NULL WHERE id=? AND status='sending'").run(claim.id);
      return {sent:false};
    }
    const authorization=Object.freeze({kind:'outbox-send' as const});
    sendAuthorizations.set(authorization,{db,payload:JSON.stringify(claim),expiresAt:Date.now()+30000});
    let result:{providerId:string};
    try{result=await transport.send(claim,authorization);}finally{sendAuthorizations.delete(authorization);}
    if(!reference(result?.providerId))throw new Error('Invalid provider confirmation');
    const updated=db.prepare("UPDATE obolus_support_replies SET status='sent',provider_id=? WHERE id=? AND status='sending'").run(result.providerId,claim.id);
    if(updated.changes!==1){
      const current=db.prepare('SELECT status,provider_id FROM obolus_support_replies WHERE id=?').get(claim.id) as {status:string;provider_id:string}|undefined;
      if(current?.status!=='sent'||current.provider_id!==result.providerId)throw new Error('Conflicting concurrent delivery confirmation');
    }
    return {sent:true,id:claim.id,providerId:result.providerId};
  }catch(error){
    if(error instanceof SupportDeliveryNotStartedError){
      securityTransaction(db,()=>{
        const changed=db.prepare("UPDATE obolus_support_replies SET status='deferred',attempted_ms=NULL WHERE id=? AND status='sending'").run(claim.id);
        if(changed.changes===1)db.prepare('UPDATE obolus_support_policy SET paused=1 WHERE id=1').run();
      }).immediate();
      throw new Error('Support delivery did not start; correct configuration before retry');
    }
    db.prepare("UPDATE obolus_support_replies SET status='uncertain' WHERE id=? AND status='sending'").run(claim.id);
    throw new Error('Support send uncertain; reconcile provider delivery before any retry');
  }
}
