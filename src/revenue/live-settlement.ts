import type {Database} from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {assertNoKnownSecrets} from '../observability/redaction.js';

export interface ClosedOrderSettlement {
  clientOrderId:string;venueOrderId:string;accountRef:string;transactionRef:string;
  currency:'USD';orderFinal:true;positionQuantity:0;liabilitiesFinal:true;
  debitUsdCents:number;creditUsdCents:number;retainedUsdCents:number;
  observedAt:number;evidenceDigest:string;
}
/** Installed, independently accepted adapter. Must authenticate this configured
 * account, all fills/fees, final cash and a zero position. Never submits orders.
 * A returned boolean or hash alone does not authenticate external reality. */
export interface LiveSettlementAdapter {
  venueId:string;accountRef:string;
  readClosedSettlement(clientOrderId:string,signal:AbortSignal):Promise<ClosedOrderSettlement>;
}
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const money=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=100000000;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const table=(db:Database,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
export function liveSettlementBlocked(db:Database){
  if(!table(db,'obolus_live_settlement_issues'))return false;
  if(!table(db,'obolus_live_settlement_recoveries'))return !!db.prepare('SELECT 1 FROM obolus_live_settlement_issues LIMIT 1').get();
  return !!db.prepare(`SELECT 1 FROM obolus_live_settlement_issues i WHERE i.resolved_digest IS NULL OR NOT EXISTS(
    SELECT 1 FROM obolus_live_settlement_recoveries r JOIN obolus_live_order_settlements s ON s.client_id=r.client_id
    WHERE r.client_id=i.client_id AND r.generation=i.generation AND r.digest=i.resolved_digest AND s.digest=r.digest) LIMIT 1`).get();
}
export function flagLiveSettlementIssue(db:Database,clientOrderId:string){
  if(!id(clientOrderId))throw new Error('Invalid settlement incident');
  db.transaction(()=>{
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_live_order_halt(id INTEGER PRIMARY KEY CHECK(id=1)); INSERT OR IGNORE INTO obolus_live_order_halt VALUES(1);
      CREATE TABLE IF NOT EXISTS obolus_live_settlement_issues(client_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,resolved_digest TEXT);`);
    db.prepare(`INSERT INTO obolus_live_settlement_issues VALUES(?,1,NULL) ON CONFLICT(client_id) DO UPDATE SET generation=generation+1,resolved_digest=NULL`).run(clientOrderId);
  }).immediate();
}
function validate(s:ClosedOrderSettlement){
  if(!s||![s.clientOrderId,s.venueOrderId,s.accountRef,s.transactionRef].every(id)||s.currency!=='USD'||s.orderFinal!==true||s.positionQuantity!==0||s.liabilitiesFinal!==true||
    ![s.debitUsdCents,s.creditUsdCents,s.retainedUsdCents].every(money)||s.retainedUsdCents>s.creditUsdCents||
    !Number.isSafeInteger(s.observedAt)||s.observedAt<0||s.observedAt>Date.now()||!(/^[a-f0-9]{64}$/).test(s.evidenceDigest))throw new Error('Complete final USD settlement required');
}
export function registerLiveSettlementAccount(db:Database,venueId:string,accountRef:string){
  if(!id(venueId)||!id(accountRef))throw new Error('Invalid settlement account');assertNoKnownSecrets({venueId,accountRef});
  db.transaction(()=>{
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_live_settlement_accounts(venue_id TEXT PRIMARY KEY,account_ref TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS live_settlement_account_no_update BEFORE UPDATE ON obolus_live_settlement_accounts BEGIN SELECT RAISE(ABORT,'Settlement account immutable'); END;
      CREATE TRIGGER IF NOT EXISTS live_settlement_account_no_delete BEFORE DELETE ON obolus_live_settlement_accounts BEGIN SELECT RAISE(ABORT,'Settlement account immutable'); END;
      CREATE TABLE IF NOT EXISTS obolus_live_order_settlements(client_id TEXT PRIMARY KEY,account_ref TEXT NOT NULL,transaction_ref TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,loss_event_id TEXT NOT NULL,UNIQUE(account_ref,transaction_ref));
      CREATE TRIGGER IF NOT EXISTS live_settlement_no_update BEFORE UPDATE ON obolus_live_order_settlements BEGIN SELECT RAISE(ABORT,'Settlement immutable'); END;
      CREATE TRIGGER IF NOT EXISTS live_settlement_no_delete BEFORE DELETE ON obolus_live_order_settlements BEGIN SELECT RAISE(ABORT,'Settlement immutable'); END;`);
    const old=db.prepare('SELECT account_ref FROM obolus_live_settlement_accounts WHERE venue_id=?').get(venueId) as {account_ref:string}|undefined;
    if(old&&old.account_ref!==accountRef)throw new Error('Settlement account cannot change');
    db.prepare('INSERT OR IGNORE INTO obolus_live_settlement_accounts VALUES(?,?)').run(venueId,accountRef);
  }).immediate();
}
/** One liability predicate for gateway, treasury and observability. Corrupt or
 * unbooked releases fail closed. Original order holds remain immutable history. */
export function activeLiveOrderPredicate(db:Database,alias=''){
  if(alias&&!/^[a-z]+$/.test(alias))throw new Error('Invalid internal order alias');
  const prefix=alias?`${alias}.`:'';
  if(!table(db,'obolus_live_order_settlements'))return `${prefix}status<>'rejected'`;
  const rows=db.prepare('SELECT * FROM obolus_live_order_settlements LIMIT 1001').all() as {client_id:string;account_ref:string;transaction_ref:string;payload:string;digest:string;loss_event_id:string}[];
  if(rows.length>1000)throw new Error('Settlement review capacity exceeded');
  for(const row of rows){
    const s=JSON.parse(row.payload) as ClosedOrderSettlement;validate(s);
    const {observedAt:_observedAt,...identity}=s;
    const loss=Math.max(0,s.debitUsdCents-s.creditUsdCents+s.retainedUsdCents);
    const event=db.prepare('SELECT amount_cents,event_type,currency,opportunity_id,metadata_json FROM economic_events WHERE id=?').get(row.loss_event_id) as {amount_cents:number;event_type:string;currency:string;opportunity_id:string|null;metadata_json:string}|undefined;
    const hold=db.prepare('SELECT intent,digest,venue_order_id FROM obolus_live_order_holds WHERE client_id=?').get(row.client_id) as {intent:string;digest:string;venue_order_id:string|null}|undefined;
    if(s.clientOrderId!==row.client_id||s.accountRef!==row.account_ref||s.transactionRef!==row.transaction_ref||hash(identity)!==row.digest||
      row.loss_event_id!==`live-settlement-${hash(row.client_id)}`||!hold||hash(JSON.parse(hold.intent))!==hold.digest||hold.venue_order_id!==null&&hold.venue_order_id!==s.venueOrderId||
      !event||event.amount_cents!==loss||event.event_type!=='cost'||event.currency!=='USD')throw new Error('Settlement capital accounting mismatch');
    const metadata=JSON.parse(event.metadata_json);
    if(metadata.clientOrderId!==row.client_id||metadata.evidenceDigest!==s.evidenceDigest||metadata.attributionVersion===1&&
      (metadata.strategyId!==JSON.parse(hold.intent).strategyId||metadata.opportunityId!==event.opportunity_id))throw new Error('Settlement attribution mismatch');
  }
  return `${prefix}status<>'rejected' AND ${prefix}client_id NOT IN (SELECT client_id FROM obolus_live_order_settlements)`;
}

export async function reconcileClosedOrder(db:Database,clientOrderId:string,adapter:LiveSettlementAdapter){
  if(!id(clientOrderId)||!table(db,'obolus_live_settlement_accounts'))throw new Error('Registered settlement account required');
  const account=db.prepare('SELECT account_ref FROM obolus_live_settlement_accounts WHERE venue_id=?').get(adapter.venueId) as {account_ref:string}|undefined;
  const control=db.prepare('SELECT policy FROM obolus_live_order_control WHERE id=1').get() as {policy:string}|undefined;
  if(!account||account.account_ref!==adapter.accountRef||!control||JSON.parse(control.policy).venueId!==adapter.venueId)throw new Error('Settlement venue/account mismatch');
  const before=db.prepare('SELECT digest,intent,venue_order_id,status FROM obolus_live_order_holds WHERE client_id=?').get(clientOrderId) as {digest:string;intent:string;venue_order_id:string|null;status:string}|undefined;
  if(!before)throw new Error('Existing order required');
  let timer:ReturnType<typeof setTimeout>|undefined;const controller=new AbortController();
  try{
    const raw=await Promise.race([adapter.readClosedSettlement(clientOrderId,controller.signal),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Settlement timeout'));},15000);})]);
    validate(raw);
    if(raw.clientOrderId!==clientOrderId||raw.accountRef!==account.account_ref||Date.now()-raw.observedAt>300000||before.venue_order_id&&raw.venueOrderId!==before.venue_order_id)throw new Error('Settlement scope mismatch');
    const s:ClosedOrderSettlement={clientOrderId,venueOrderId:raw.venueOrderId,accountRef:raw.accountRef,transactionRef:raw.transactionRef,currency:'USD',orderFinal:true,positionQuantity:0,liabilitiesFinal:true,
      debitUsdCents:raw.debitUsdCents,creditUsdCents:raw.creditUsdCents,retainedUsdCents:raw.retainedUsdCents,observedAt:raw.observedAt,evidenceDigest:raw.evidenceDigest};
    assertNoKnownSecrets(s);
    return db.transaction(()=>{
      const current=db.prepare('SELECT digest,intent,venue_order_id,status FROM obolus_live_order_holds WHERE client_id=?').get(clientOrderId) as typeof before;
      if(!current||JSON.stringify(current)!==JSON.stringify(before)||hash(JSON.parse(current.intent))!==current.digest)throw new Error('Order changed during settlement');
      if(table(db,'obolus_trading_observations')){
        const row=db.prepare('SELECT observation FROM obolus_trading_observations WHERE id=?').get(clientOrderId) as {observation:string}|undefined;
        const observation=row?JSON.parse(row.observation):null;
        if(!observation||observation.clientOrderId!==clientOrderId||observation.venueOrderId!==s.venueOrderId||
          !['closed','cancelled','rejected'].includes(observation.state)||observation.positionQuantity!==0||
          !Number.isSafeInteger(observation.observedAt)||observation.observedAt>s.observedAt||s.observedAt-observation.observedAt>300000)
          throw new Error('Reconcile final order and zero position before settlement');
      }
      const {observedAt:_observedAt,...identity}=s,digest=hash(identity);
      const prior=db.prepare('SELECT digest FROM obolus_live_order_settlements WHERE client_id=?').get(clientOrderId) as {digest:string}|undefined;
      if(prior){if(prior.digest!==digest)throw new Error('Conflicting settlement');activeLiveOrderPredicate(db);return {duplicate:true,capitalGainCreditedCents:0};}
      const loss=Math.max(0,s.debitUsdCents-s.creditUsdCents+s.retainedUsdCents),eventId=`live-settlement-${hash(clientOrderId)}`;
      const intent=JSON.parse(current.intent);
      const binding=table(db,'obolus_strategy_economics')?db.prepare('SELECT opportunity_id FROM obolus_strategy_economics WHERE strategy_id=?').get(intent.strategyId) as {opportunity_id:string}|undefined:undefined;
      // Replacement of the full hold by actual net capital depletion. This is
      // not gross trade accounting and does not credit gains or forecast income.
      db.prepare(`INSERT INTO economic_events(id,opportunity_id,event_type,category,amount_cents,currency,metadata_json) VALUES(?,?,'cost','settled-capital-loss',?,'USD',?)`)
        .run(eventId,binding?.opportunity_id??null,loss,JSON.stringify({clientOrderId,evidenceDigest:s.evidenceDigest,attributionVersion:1,strategyId:intent.strategyId,opportunityId:binding?.opportunity_id??null}));
      db.prepare('INSERT INTO obolus_live_order_settlements VALUES(?,?,?,?,?,?)').run(clientOrderId,s.accountRef,s.transactionRef,JSON.stringify(s),digest,eventId);
      const riskBreach=s.debitUsdCents>intent.notionalUsdCents+intent.maximumFeesUsdCents||loss>intent.plannedLossUsdCents;
      if(riskBreach)flagLiveSettlementIssue(db,clientOrderId);
      return {duplicate:false,capitalGainCreditedCents:0,capitalLossUsdCents:loss,
        riskBreach,
        uncreditedNetGainUsdCents:Math.max(0,s.creditUsdCents-s.retainedUsdCents-s.debitUsdCents)};
    }).immediate();
  }catch{
    flagLiveSettlementIssue(db,clientOrderId);
    throw new Error('Closed-order reconciliation failed; live orders halted and prior accounting preserved');
  }finally{if(timer)clearTimeout(timer);}
}

/** Reviewed recovery needs another authenticated matching final receipt. Does
 * not clear the independent gateway emergency stop or authorize trading. */
export async function reviewClosedSettlementRecovery(db:Database,clientOrderId:string,adapter:LiveSettlementAdapter,reviewedBy:string){
  if(!id(reviewedBy))throw new Error('Reviewed recovery identity required');assertNoKnownSecrets(reviewedBy);
  const issue=db.prepare('SELECT generation FROM obolus_live_settlement_issues WHERE client_id=?').get(clientOrderId) as {generation:number}|undefined;
  if(!issue)throw new Error('No closed-order issue to review');
  await reconcileClosedOrder(db,clientOrderId,adapter);
  return db.transaction(()=>{
    const current=db.prepare('SELECT generation FROM obolus_live_settlement_issues WHERE client_id=?').get(clientOrderId) as {generation:number};
    const receipt=db.prepare('SELECT digest FROM obolus_live_order_settlements WHERE client_id=?').get(clientOrderId) as {digest:string}|undefined;
    if(current.generation!==issue.generation||!receipt)throw new Error('Settlement changed during recovery');
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_live_settlement_recoveries(client_id TEXT NOT NULL,generation INTEGER NOT NULL,digest TEXT NOT NULL,reviewed_by TEXT NOT NULL,PRIMARY KEY(client_id,generation));
      CREATE TRIGGER IF NOT EXISTS live_recovery_no_update BEFORE UPDATE ON obolus_live_settlement_recoveries BEGIN SELECT RAISE(ABORT,'Recovery immutable'); END;
      CREATE TRIGGER IF NOT EXISTS live_recovery_no_delete BEFORE DELETE ON obolus_live_settlement_recoveries BEGIN SELECT RAISE(ABORT,'Recovery immutable'); END;`);
    db.prepare('INSERT OR IGNORE INTO obolus_live_settlement_recoveries VALUES(?,?,?,?)').run(clientOrderId,issue.generation,receipt.digest,reviewedBy);
    db.prepare('UPDATE obolus_live_settlement_issues SET resolved_digest=? WHERE client_id=?').run(receipt.digest,clientOrderId);
    return {recovered:true,executionAuthorized:false};
  }).immediate();
}
