import {createHash} from 'node:crypto';
import type {Database} from 'better-sqlite3';

export const SUPPORT_ACKNOWLEDGEMENT='Vielen Dank für Ihre Nachricht. Sie wurde im Support erfasst. Diese automatische Eingangsbestätigung bestätigt keine Zahlung, Erstattung oder Vertragsänderung.';
export interface PublicSupportAnswer {questions:string[];answer:string}
const normalize=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase();

/** Operator-only publication of text explicitly suitable for every customer. No model writer. */
export function publishSupportAnswer(db:Database,input:PublicSupportAnswer){
  if(!input||!Array.isArray(input.questions)||input.questions.length<1||input.questions.length>20||
    // oxlint-disable-next-line no-control-regex -- Intentionally reject or sanitize control characters at the security boundary.
    input.questions.some(q=>typeof q!=='string'||!q.trim()||Buffer.byteLength(q)>1000||/[\u0000-\u001f]/u.test(q))||
    typeof input.answer!=='string'||!input.answer.trim()||Buffer.byteLength(input.answer)>16000||input.answer.includes('\0'))throw new Error('Invalid public support answer');
  const questions=[...new Set(input.questions.map(normalize))].sort(),answer=input.answer;
  const id=createHash('sha256').update(JSON.stringify({questions,answer})).digest('hex');
  return db.transaction(()=>{
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_support_public_answers(question TEXT PRIMARY KEY,answer TEXT NOT NULL,publication_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS obolus_support_public_revocations(publication_id TEXT PRIMARY KEY);
      CREATE TRIGGER IF NOT EXISTS support_public_revocation_update BEFORE UPDATE ON obolus_support_public_revocations BEGIN SELECT RAISE(ABORT,'Support revocation immutable'); END;
      CREATE TRIGGER IF NOT EXISTS support_public_revocation_delete BEFORE DELETE ON obolus_support_public_revocations BEGIN SELECT RAISE(ABORT,'Support revocation immutable'); END;
      CREATE TRIGGER IF NOT EXISTS support_public_answer_update BEFORE UPDATE ON obolus_support_public_answers BEGIN SELECT RAISE(ABORT,'Public support answer immutable'); END;
      CREATE TRIGGER IF NOT EXISTS support_public_answer_delete BEFORE DELETE ON obolus_support_public_answers BEGIN SELECT RAISE(ABORT,'Public support answer immutable'); END;`);
    const count=(db.prepare('SELECT COUNT(*) n FROM obolus_support_public_answers').get() as {n:number}).n;
    let additions=0;
    for(const question of questions){
      const old=db.prepare('SELECT answer,publication_id FROM obolus_support_public_answers WHERE question=?').get(question) as {answer:string;publication_id:string}|undefined;
      if(old&&(old.answer!==answer||old.publication_id!==id))throw new Error('Conflicting public support publication');
      if(!old)additions++;
    }
    if(count+additions>1000)throw new Error('Public support knowledge capacity reached');
    for(const question of questions)db.prepare('INSERT OR IGNORE INTO obolus_support_public_answers VALUES(?,?,?)').run(question,answer,id);
    return {id,questions:questions.length,duplicate:additions===0};
  }).immediate();
}

export function revokeSupportAnswer(db:Database,id:string){
  if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw new Error('Invalid publication ID');
  return db.transaction(()=>{
    const revisionExists=db.prepare("SELECT 1 FROM sqlite_master WHERE name='obolus_support_public_revisions'").get()&&db.prepare('SELECT 1 FROM obolus_support_public_revisions WHERE id=?').get(id);
    if(!db.prepare('SELECT 1 FROM obolus_support_public_answers WHERE publication_id=?').get(id)&&!revisionExists)throw new Error('Unknown support publication');
    return {revoked:true,duplicate:db.prepare('INSERT OR IGNORE INTO obolus_support_public_revocations VALUES(?)').run(id).changes===0};
  }).immediate();
}

/** Explicit operator revision with compare-and-swap ancestry. Original publications remain intact. */
export function replaceSupportAnswer(db:Database,previousId:string,answer:string){
  if(typeof previousId!=='string'||!/^[a-f0-9]{64}$/.test(previousId)||typeof answer!=='string'||!answer.trim()||Buffer.byteLength(answer)>16000||answer.includes('\0'))throw new Error('Invalid reviewed support revision');
  return db.transaction(()=>{
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_support_public_revisions(id TEXT PRIMARY KEY,root_id TEXT NOT NULL,previous_id TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,answer TEXT NOT NULL,UNIQUE(root_id,revision));
      CREATE TRIGGER IF NOT EXISTS support_revision_update BEFORE UPDATE ON obolus_support_public_revisions BEGIN SELECT RAISE(ABORT,'Support revision immutable'); END;
      CREATE TRIGGER IF NOT EXISTS support_revision_delete BEFORE DELETE ON obolus_support_public_revisions BEGIN SELECT RAISE(ABORT,'Support revision immutable'); END;`);
    const predecessor=db.prepare('SELECT root_id,revision FROM obolus_support_public_revisions WHERE id=?').get(previousId) as {root_id:string;revision:number}|undefined;
    const root=predecessor?.root_id??previousId;
    if(!db.prepare('SELECT 1 FROM obolus_support_public_answers WHERE publication_id=?').get(root))throw new Error('Unknown support publication');
    if(db.prepare('SELECT 1 FROM obolus_support_public_revocations WHERE publication_id=?').get(root))throw new Error('Root publication revoked');
    const id=createHash('sha256').update(JSON.stringify({previousId,answer})).digest('hex');
    const old=db.prepare('SELECT id FROM obolus_support_public_revisions WHERE previous_id=?').get(previousId) as {id:string}|undefined;
    if(old){if(old.id!==id)throw new Error('Support publication changed; review latest revision');return {id,duplicate:true};}
    const latest=db.prepare('SELECT id FROM obolus_support_public_revisions WHERE root_id=? ORDER BY revision DESC LIMIT 1').get(root) as {id:string}|undefined;
    if((latest?.id??root)!==previousId)throw new Error('Support publication changed; review latest revision');
    if((db.prepare('SELECT COUNT(*) n FROM obolus_support_public_revisions').get() as {n:number}).n>=10000)throw new Error('Support revision capacity reached');
    db.prepare('INSERT INTO obolus_support_public_revisions VALUES(?,?,?,?,?)').run(id,root,previousId,(predecessor?.revision??0)+1,answer);
    return {id,duplicate:false};
  }).immediate();
}

/** Pure bounded retrieval from a single authenticated message and operator-public text.
 * Exact whole-message matching intentionally avoids interpreting instructions or taking actions.
 */
export function planSupportReply(db:Database,inboxId:string){
  if(typeof inboxId!=='string'||!/^[a-f0-9]{64}$/.test(inboxId))throw new Error('Invalid support message ID');
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='obolus_support_receipts'").get())throw new Error('Authenticated support intake required');
  const row=db.prepare('SELECT i.payload FROM obolus_support_inbox i JOIN obolus_support_receipts r ON r.inbox_id=i.id WHERE i.id=?').get(inboxId) as {payload:string}|undefined;
  if(!row)throw new Error('Unknown authenticated support message');
  const message=JSON.parse(row.payload);
  const fallback={body:SUPPORT_ACKNOWLEDGEMENT,publicationId:null,publicationIds:[] as string[],requiresOperatorReview:true};
  if(typeof message.body!=='string'||Buffer.byteLength(message.body)>5000||!db.prepare("SELECT 1 FROM sqlite_master WHERE name='obolus_support_public_answers'").get())return fallback;
  const lookup=(question:string)=>{
    if(Buffer.byteLength(question)>1000)return undefined;
    let match=db.prepare(`SELECT answer,publication_id FROM obolus_support_public_answers a WHERE question=?
      AND NOT EXISTS(SELECT 1 FROM obolus_support_public_revocations r WHERE r.publication_id=a.publication_id)`).get(normalize(question)) as {answer:string;publication_id:string}|undefined;
    if(match&&db.prepare("SELECT 1 FROM sqlite_master WHERE name='obolus_support_public_revisions'").get()){
      const revision=db.prepare('SELECT id,answer FROM obolus_support_public_revisions WHERE root_id=? ORDER BY revision DESC LIMIT 1').get(match.publication_id) as {id:string;answer:string}|undefined;
      if(revision)match=db.prepare('SELECT 1 FROM obolus_support_public_revocations WHERE publication_id=?').get(revision.id)?undefined:{answer:revision.answer,publication_id:revision.id};
    }
    return match;
  };
  const whole=lookup(message.body);
  if(whole)return {body:whole.answer,publicationId:whole.publication_id,publicationIds:[whole.publication_id],requiresOperatorReview:false};
  // Every nonempty line must be an exact approved question. Unknown additions reject the entire composition.
  const questions=message.body.split(/\r?\n/u).map((s:string)=>s.trim()).filter(Boolean) as string[];
  if(questions.length<2||questions.length>5)return fallback;
  const answers=new Map<string,string>();
  for(const question of questions){const match=lookup(question);if(!match)return fallback;answers.set(match.publication_id,match.answer);}
  const body=[...answers.values()].join('\n\n'),publicationIds=[...answers.keys()];
  if(Buffer.byteLength(body)>20000)return fallback;
  return {body,publicationId:publicationIds.length===1?publicationIds[0]:null,publicationIds,requiresOperatorReview:false};
}
