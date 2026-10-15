import type {Database} from 'better-sqlite3';
import type {AutomatonTool} from '../types.js';
import {queueSupportReply,sendNextSupportReply} from './support-outbox.js';
import {GmailSupportClient} from './gmail-support.js';
import {createGmailTokenProvider} from './gmail-credentials.js';
import {planSupportReply} from './support-knowledge.js';

/** Public, deterministic acknowledgement: no model context or customer text enters delivery. */
export {SUPPORT_ACKNOWLEDGEMENT} from './support-knowledge.js';

/** Read-only bounded inbox view. Local unbound imports are not eligible for automated replies. */
export function supportInboxSnapshot(db:Database){
  const exists=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if(!['obolus_support_policy','obolus_support_receipts','obolus_support_inbox','obolus_support_replies'].every(exists))return {configured:false,paused:true,actionable:false,items:[],truncated:false};
  const policy=db.prepare('SELECT paused,max_daily FROM obolus_support_policy WHERE id=1').get() as {paused:number;max_daily:number}|undefined;
  const rows=db.prepare(`SELECT i.id,CASE WHEN i.status='reviewed' OR r.status IN ('sent','cancelled') AND i.status='needs_review' THEN 'requires_operator_review' ELSE r.status END status FROM obolus_support_inbox i JOIN obolus_support_receipts a ON a.inbox_id=i.id
    LEFT JOIN obolus_support_replies r ON r.rowid=(SELECT MAX(h.rowid) FROM obolus_support_replies h WHERE h.inbox_id=i.id) WHERE (r.status IS NULL AND i.status<>'reviewed') OR r.status NOT IN ('sent','cancelled') OR i.status='needs_review'
    ORDER BY CASE WHEN r.status IS NULL THEN 0 WHEN r.status IN ('queued','deferred') THEN 1 ELSE 2 END,i.created_at,i.id LIMIT 21`).all() as {id:string;status:string|null}[];
  let actionable=!!policy&&rows.some(row=>row.status===null);
  if(!actionable&&policy?.paused===0&&Number.isSafeInteger(policy.max_daily)&&policy.max_daily>=1&&policy.max_daily<=100){
    const held=!!db.prepare("SELECT 1 FROM obolus_support_replies WHERE status IN ('sending','uncertain') LIMIT 1").get();
    const attempts=(db.prepare('SELECT COUNT(*) n FROM obolus_support_replies WHERE attempted_ms>=?').get(Date.now()-86400000) as {n:number}).n;
    const next=db.prepare("SELECT inbox_id,payload FROM obolus_support_replies WHERE status IN ('queued','deferred') ORDER BY rowid LIMIT 1").get() as {inbox_id:string;payload:string}|undefined;
    if(!held&&attempts<policy.max_daily&&next){
      try{
        const inbox=db.prepare('SELECT status FROM obolus_support_inbox WHERE id=?').get(next.inbox_id) as {status:string}|undefined;
        actionable=!!inbox&&inbox.status!=='reviewed'&&JSON.parse(next.payload).body===planSupportReply(db,next.inbox_id).body;
      }catch{actionable=false;}
    }
  }
  return {configured:!!policy,paused:policy?.paused!==0,actionable,items:rows.slice(0,20).map(row=>({id:row.id,status:row.status??'needs_reply'})),truncated:rows.length>20};
}

export function createSupportTools():AutomatonTool[]{
  let tokenProvider:ReturnType<typeof createGmailTokenProvider>|undefined;
  return [
    {name:'support_inbox',category:'revenue',riskLevel:'safe',description:'Read bounded pending support IDs and statuses. Customer content is isolated from this agent context.',parameters:{type:'object',properties:{}},
      execute:async(_args,ctx)=>JSON.stringify(supportInboxSnapshot(ctx.db.raw))},
    {name:'support_read_message',category:'revenue',riskLevel:'safe',description:'Check whether one authenticated support message exists. Returns no customer text or address. Substantive customer requests require operator review; only a fixed acknowledgement is automated.',
      parameters:{type:'object',properties:{inbox_id:{type:'string'}},required:['inbox_id'],additionalProperties:false},
      execute:async(args,ctx)=>{
        if(typeof args.inbox_id!=='string'||!/^[a-f0-9]{64}$/.test(args.inbox_id))throw new Error('Invalid support message ID');
        if(!ctx.db.raw.prepare("SELECT 1 FROM sqlite_master WHERE name='obolus_support_receipts'").get())throw new Error('Authenticated support intake required');
        const row=ctx.db.raw.prepare('SELECT i.id FROM obolus_support_inbox i JOIN obolus_support_receipts r ON r.inbox_id=i.id WHERE i.id=?').get(args.inbox_id) as {id:string}|undefined;
        if(!row)throw new Error('Unknown authenticated support message');
        return JSON.stringify({id:row.id,authenticatedIntake:true,contentIsolated:true,requiresOperatorReview:true});
      }},
    {name:'support_draft_reply',category:'revenue',riskLevel:'safe',description:'Persist an exact-match operator-public FAQ answer or a fixed acknowledgement. Accepts only an inbox ID, never model-authored text, recipients or instructions. Unknown requests need operator review.',
      parameters:{type:'object',properties:{inbox_id:{type:'string'}},required:['inbox_id'],additionalProperties:false},
      execute:async(args,ctx)=>{
        if(Object.keys(args).some(key=>key!=='inbox_id'))throw new Error('Only a fixed support acknowledgement is permitted');
        const plan=planSupportReply(ctx.db.raw,args.inbox_id as string);
        return JSON.stringify(ctx.db.raw.transaction(()=>{
          const reply=queueSupportReply(ctx.db.raw,args.inbox_id as string,plan.body);
          if(plan.requiresOperatorReview)ctx.db.raw.prepare("UPDATE obolus_support_inbox SET status='needs_review' WHERE id=? AND status='received'").run(args.inbox_id);
          return {...reply,requiresOperatorReview:plan.requiresOperatorReview,publicationId:plan.publicationId,publicationIds:plan.publicationIds};
        }).immediate());
      }},
    {name:'support_send_next',category:'revenue',riskLevel:'caution',description:'Send one queued support reply only when the operator has configured and enabled the mailbox. Shared daily ceiling, fixed recipient and persistent ambiguity guards apply. Never retry an uncertain delivery with a new message. No control, configuration or permission grants.',
      parameters:{type:'object',properties:{},additionalProperties:false},execute:async(_args,ctx)=>{
        if(!ctx.db.raw.prepare("SELECT 1 FROM sqlite_master WHERE name='obolus_support_policy'").get())throw new Error('Operator support setup required');
        const policy=ctx.db.raw.prepare('SELECT mailbox,paused FROM obolus_support_policy WHERE id=1').get() as {mailbox:string;paused:number}|undefined;
        if(!policy||policy.paused!==0)return JSON.stringify({sent:false,paused:true});
        tokenProvider??=createGmailTokenProvider();
        const client=new GmailSupportClient(policy.mailbox,process.env.OBOLUS_SUPPORT_LABEL??'',tokenProvider);
        return JSON.stringify(await sendNextSupportReply(ctx.db.raw,client,{requiredBodyFor:reply=>{
          const row=ctx.db.raw.prepare('SELECT inbox_id FROM obolus_support_replies WHERE id=?').get(reply.id) as {inbox_id:string}|undefined;
          if(!row)throw new Error('Unknown support reply');
          return planSupportReply(ctx.db.raw,row.inbox_id).body;
        }}));
      }}
  ];
}
