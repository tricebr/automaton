import {randomUUID,createHash} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {expireSupportCases} from './support-privacy.js';
import {assertActionGate,actionContextDigest,securityTransaction} from '../security/action-gate.js';

export const supportIntakeScope=(mailbox:string,label:string)=>({activity:'support-intake',component:'support',dataClass:'PERSONAL' as const,
 contextDigest:actionContextDigest({mailbox:mailbox.toLowerCase(),label,purpose:'customer-support-intake',processor:'gmail'})});

export interface SupportIntake {
  readonly intakeScope:{mailbox:string;label:string};
  listIncoming(cursor:string|null):Promise<{ids:string[];nextPageToken:string|null}>;
  receive(db:Database,id:string):Promise<{id:string;duplicate:boolean}>;
}

/** Explicitly started intake service. It never drafts, sends, starts agents or spends inference budget. */
export function startSupportPolling(db:Database,client:SupportIntake,intervalMs=60000){
  if(!Number.isSafeInteger(intervalMs)||intervalMs<60000||intervalMs>3600000)throw new Error('Invalid support polling interval');
  let stopped=false,running:Promise<void>|null=null;
  let health:{healthy:boolean;lastCompletedAt:number|null}={healthy:false,lastCompletedAt:null};
  const tick=()=>{
    if(stopped||running)return;
    try{expireSupportCases(db);}catch{health={...health,healthy:false};return;}
    running=pollSupportInbox(db,client).then(result=>{if(result.polled)health={healthy:true,lastCompletedAt:Date.now()};},()=>{health={...health,healthy:false};}).finally(()=>{running=null;});
  };
  const timer=setInterval(tick,intervalMs);tick();
  return {status:()=>({...health,stopped,running:running!==null}),close:async()=>{stopped=true;clearInterval(timer);await running;}};
}

const cursorDigest=(cursor:string|null)=>createHash('sha256').update(JSON.stringify(cursor)).digest('hex');
export function supportPollStatus(db:Database,scope:{mailbox:string;label:string}){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='obolus_support_poll'").get())return {configured:false};
  const row=db.prepare('SELECT cursor,lease_until,next_at,failures FROM obolus_support_poll WHERE scope=?').get(JSON.stringify(scope)) as {cursor:string|null;lease_until:number;next_at:number;failures:number}|undefined;
  const failedMessages=db.prepare("SELECT 1 FROM sqlite_master WHERE name='obolus_support_import_failures'").get()?
    db.prepare(`SELECT f.message_id FROM obolus_support_import_failures f WHERE f.scope=? AND NOT EXISTS
      (SELECT 1 FROM obolus_support_import_exclusions e WHERE e.scope=f.scope AND e.message_id=f.message_id) ORDER BY f.message_id LIMIT 21`).all(JSON.stringify(scope)) as {message_id:string}[]:[];
  return row?{configured:true,cursorDigest:cursorDigest(row.cursor),hasCursor:row.cursor!==null,busy:row.lease_until>Date.now(),nextAt:row.next_at,failures:row.failures,
    reviewMessageIds:failedMessages.slice(0,20).map(item=>item.message_id),reviewsTruncated:failedMessages.length>20}:{configured:false};
}

/** Only failed IDs in this mailbox/label can be excluded; original messages are never deleted. */
export function excludeSupportImport(db:Database,scope:{mailbox:string;label:string},messageId:string,reason:string){
  // oxlint-disable-next-line no-control-regex -- Intentionally reject or sanitize control characters at the security boundary.
  if(typeof messageId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(messageId)||typeof reason!=='string'||!reason.trim()||reason.length>500||/[\u0000-\u001f]/u.test(reason))throw new Error('Reviewed message ID and reason required');
  return db.transaction(()=>{
    const key=JSON.stringify(scope),policy=db.prepare('SELECT mailbox,paused FROM obolus_support_policy WHERE id=1').get() as {mailbox:string;paused:number}|undefined;
    if(!policy||policy.mailbox!==scope.mailbox||policy.paused!==1)throw new Error('Pause configured support before exclusion');
    const state=db.prepare('SELECT lease_until FROM obolus_support_poll WHERE scope=?').get(key) as {lease_until:number}|undefined;
    if(!state||state.lease_until>Date.now())throw new Error('Idle support poll required');
    if(!db.prepare('SELECT 1 FROM obolus_support_import_failures WHERE scope=? AND message_id=?').get(key,messageId))throw new Error('Previously failed message required');
    const old=db.prepare('SELECT reason FROM obolus_support_import_exclusions WHERE scope=? AND message_id=?').get(key,messageId) as {reason:string}|undefined;
    if(old){if(old.reason!==reason)throw new Error('Conflicting support exclusion');return {excluded:true,duplicate:true};}
    db.prepare('INSERT INTO obolus_support_import_exclusions VALUES(?,?,?,?)').run(key,messageId,reason,Date.now());
    return {excluded:true,duplicate:false};
  }).immediate();
}

/** Operator-only recovery. No in-flight claim, history, delay or imported message may be erased. */
export function resetSupportPollCursor(db:Database,scope:{mailbox:string;label:string},expectedDigest:string,reason:string){
  // oxlint-disable-next-line no-control-regex -- Intentionally reject or sanitize control characters at the security boundary.
  if(!/^[a-f0-9]{64}$/.test(expectedDigest)||typeof reason!=='string'||!reason.trim()||reason.length>500||/[\u0000-\u001f]/u.test(reason))throw new Error('Reviewed cursor digest and bounded reason required');
  return db.transaction(()=>{
    const policy=db.prepare('SELECT mailbox,paused FROM obolus_support_policy WHERE id=1').get() as {mailbox:string;paused:number}|undefined;
    if(!policy||policy.mailbox!==scope.mailbox||policy.paused!==1)throw new Error('Pause the configured support mailbox before recovery');
    const key=JSON.stringify(scope),row=db.prepare('SELECT cursor,lease_until FROM obolus_support_poll WHERE scope=?').get(key) as {cursor:string|null;lease_until:number}|undefined;
    if(!row||row.lease_until>Date.now())throw new Error('Existing idle support poll required');
    if(cursorDigest(row.cursor)!==expectedDigest)throw new Error('Support cursor changed; review current state');
    if(row.cursor===null)return {reset:false};
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_support_poll_recovery(id INTEGER PRIMARY KEY,scope TEXT NOT NULL,cursor_digest TEXT NOT NULL,reason TEXT NOT NULL,created_ms INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS support_poll_recovery_update BEFORE UPDATE ON obolus_support_poll_recovery BEGIN SELECT RAISE(ABORT,'Support recovery history immutable'); END;
      CREATE TRIGGER IF NOT EXISTS support_poll_recovery_delete BEFORE DELETE ON obolus_support_poll_recovery BEGIN SELECT RAISE(ABORT,'Support recovery history immutable'); END;`);
    if((db.prepare('SELECT COUNT(*) n FROM obolus_support_poll_recovery').get() as {n:number}).n>=1000)throw new Error('Support recovery audit capacity reached');
    db.prepare('INSERT INTO obolus_support_poll_recovery(scope,cursor_digest,reason,created_ms) VALUES(?,?,?,?)').run(key,expectedDigest,reason,Date.now());
    db.prepare('UPDATE obolus_support_poll SET cursor=NULL,owner=NULL,lease_until=0 WHERE scope=?').run(key);
    return {reset:true};
  }).immediate();
}
/** Read-only external intake: one bounded page, persistent pacing and cursor, renewable ownership.
 * Retrying a page after a crash is safe because authenticated message imports are idempotent.
 */
export async function pollSupportInbox(db:Database,client:SupportIntake){
  const owner=randomUUID(),scope=JSON.stringify(client.intakeScope);
  const claim=securityTransaction(db,()=>{
    const policy=db.prepare('SELECT mailbox,paused FROM obolus_support_policy WHERE id=1').get() as {mailbox:string;paused:number}|undefined;
    if(!policy||policy.mailbox!==client.intakeScope.mailbox)throw new Error('Support intake account mismatch');
    if(policy.paused!==0)return null;
    assertActionGate(db,supportIntakeScope(client.intakeScope.mailbox,client.intakeScope.label));
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_support_poll(scope TEXT PRIMARY KEY,cursor TEXT,owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0);`);
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_support_import_failures(scope TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(scope,message_id));
      CREATE TABLE IF NOT EXISTS obolus_support_import_exclusions(scope TEXT NOT NULL,message_id TEXT NOT NULL,reason TEXT NOT NULL,created_ms INTEGER NOT NULL,PRIMARY KEY(scope,message_id));
      CREATE TRIGGER IF NOT EXISTS support_exclusion_update BEFORE UPDATE ON obolus_support_import_exclusions BEGIN SELECT RAISE(ABORT,'Support exclusion immutable'); END;
      CREATE TRIGGER IF NOT EXISTS support_exclusion_delete BEFORE DELETE ON obolus_support_import_exclusions BEGIN SELECT RAISE(ABORT,'Support exclusion immutable'); END;`);
    db.prepare('INSERT OR IGNORE INTO obolus_support_poll(scope) VALUES(?)').run(scope);
    const row=db.prepare('SELECT cursor,lease_until,next_at FROM obolus_support_poll WHERE scope=?').get(scope) as {cursor:string|null;lease_until:number;next_at:number};
    const now=Date.now();if(row.lease_until>now||row.next_at>now)return null;
    db.prepare('UPDATE obolus_support_poll SET owner=?,lease_until=? WHERE scope=?').run(owner,now+300000,scope);
    return {cursor:row.cursor};
  }).immediate();
  if(!claim)return {polled:false,imported:0,duplicates:0};
  const check=()=>{
    assertActionGate(db,supportIntakeScope(client.intakeScope.mailbox,client.intakeScope.label));
    const policy=db.prepare('SELECT paused FROM obolus_support_policy WHERE id=1').get() as {paused:number};
    const state=db.prepare('SELECT owner,lease_until FROM obolus_support_poll WHERE scope=?').get(scope) as {owner:string;lease_until:number};
    if(policy.paused!==0||state.owner!==owner||state.lease_until<=Date.now())throw new Error('Support polling interrupted');
  };
  try{
    check();const page=await client.listIncoming(claim.cursor);check();
    if(!Array.isArray(page.ids)||page.ids.length>10||page.ids.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(id))||
      // oxlint-disable-next-line no-control-regex -- Intentionally reject or sanitize control characters at the security boundary.
      page.nextPageToken!==null&&(typeof page.nextPageToken!=='string'||!page.nextPageToken.length||page.nextPageToken.length>2048||/[\u0000-\u0020]/u.test(page.nextPageToken))||
      page.nextPageToken!==null&&page.nextPageToken===claim.cursor)throw new Error('Invalid support page');
    let imported=0,duplicates=0,excluded=0;
    for(const id of page.ids){
      check();
      if(db.prepare('SELECT 1 FROM obolus_support_import_exclusions WHERE scope=? AND message_id=?').get(scope,id)){excluded++;continue;}
      try{
        const received=await client.receive(db,id);check();if(received.duplicate)duplicates++;else imported++;
        db.prepare('DELETE FROM obolus_support_import_failures WHERE scope=? AND message_id=? AND NOT EXISTS(SELECT 1 FROM obolus_support_import_exclusions WHERE scope=? AND message_id=?)').run(scope,id,scope,id);
      }catch{
        db.transaction(()=>{
          check();
          if((db.prepare('SELECT COUNT(*) n FROM obolus_support_import_failures').get() as {n:number}).n>=10000)throw new Error('Support failure review capacity reached');
          db.prepare('INSERT OR IGNORE INTO obolus_support_import_failures VALUES(?,?)').run(scope,id);
        }).immediate();
        throw new Error('Support message needs review');
      }
    }
    db.transaction(()=>{
      check();db.prepare('UPDATE obolus_support_poll SET cursor=?,owner=NULL,lease_until=0,next_at=?,failures=0 WHERE scope=? AND owner=?')
        .run(page.nextPageToken,Date.now()+60000,scope,owner);
    }).immediate();
    return {polled:true,imported,duplicates,...(excluded?{excluded}: {})};
  }catch{
    db.prepare(`UPDATE obolus_support_poll SET owner=NULL,lease_until=0,failures=MIN(failures+1,15),
      next_at=?+MIN((failures+1)*60000,900000) WHERE scope=? AND owner=?`).run(Date.now(),scope,owner);
    throw new Error('Support intake incomplete; cursor retained and retry delayed');
  }
}
