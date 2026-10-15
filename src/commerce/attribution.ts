import type {Database} from 'better-sqlite3';
import {createHash} from 'node:crypto';

/** Read the latest immutable refresh; the original observation remains an audit record. */
export function currentCommerceObservation(db:Database,original:{id:string;report:string;observed_ms:number}){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_commerce_refreshes'").get())return original;
  const refresh=db.prepare('SELECT report,observed_ms FROM obolus_commerce_refreshes WHERE observation_id=? ORDER BY observed_ms DESC LIMIT 1').get(original.id) as {report:string;observed_ms:number}|undefined;
  return refresh&&refresh.observed_ms>=original.observed_ms?refresh:original;
}

/** Reconcile already received webhook holds. Does not poll Stripe or unfreeze holds. */
export function syncCommerceHolds(source:Database,target:Database) {
  return source.transaction(()=>{
    const config=source.prepare('SELECT mode,account_id FROM commerce_stripe_config WHERE id=1').get() as {mode:string;account_id:string}|undefined;
    if(!config)throw new Error('Missing commerce account');
    return target.transaction(()=>{
      if(!target.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_commerce_observations'").get())return {checked:0,held:0};
      const rows=target.prepare('SELECT id,order_id FROM obolus_commerce_observations WHERE account_id=? AND mode=? LIMIT 1001').all(config.account_id,config.mode) as {id:string;order_id:string}[];
      if(rows.length>1000)throw new Error('Hold reconciliation requires a bounded batch');
      target.exec(`CREATE TABLE IF NOT EXISTS obolus_commerce_holds(observation_id TEXT PRIMARY KEY,reason TEXT NOT NULL,detected_at TEXT NOT NULL DEFAULT(datetime('now')));`);
      let held=0;
      for(const row of rows){
        const order=source.prepare('SELECT o.status,b.payment_intent FROM commerce_orders o LEFT JOIN commerce_payment_bindings b ON b.order_id=o.id WHERE o.id=?').get(row.order_id) as {status:string;payment_intent:string|null}|undefined;
        const reason=!order||!order.payment_intent?'missing_source_payment':order.status!=='paid'?'source_payment_not_paid':
          source.prepare('SELECT 1 FROM commerce_payment_holds WHERE payment_intent=?').get(order.payment_intent)?'refund_or_dispute':null;
        if(reason)target.prepare('INSERT OR IGNORE INTO obolus_commerce_holds(observation_id,reason) VALUES(?,?)').run(row.id,reason);
        if(target.prepare('SELECT 1 FROM obolus_commerce_holds WHERE observation_id=?').get(row.id))held++;
      }
      return {checked:rows.length,held};
    }).immediate();
  }).immediate();
}

/** Attribute a stored provider observation, never credit cash or claim net profit.
 * Commerce holds are checked under a source write lock; destination writes are atomic.
 */
export function attributeCommerceObservation(source:Database,target:Database,orderId:string,experimentId:string,allowTest=false) {
  return source.transaction(()=>{
    const config=source.prepare('SELECT mode,account_id FROM commerce_stripe_config WHERE id=1').get() as {mode:string;account_id:string}|undefined;
    if(!config||!['test','live'].includes(config.mode)||config.mode==='test'&&!allowTest)throw new Error('Explicit test observation permission required');
    const order=source.prepare('SELECT status,offer FROM commerce_orders WHERE id=?').get(orderId) as {status:string;offer:string}|undefined;
    const binding=source.prepare('SELECT payment_intent FROM commerce_payment_bindings WHERE order_id=?').get(orderId) as {payment_intent:string}|undefined;
    if(order?.status!=='paid'||!binding||source.prepare('SELECT 1 FROM commerce_payment_holds WHERE payment_intent=?').get(binding.payment_intent))throw new Error('Unheld payment required');
    const productId=JSON.parse(order.offer).productId;
    const productBinding=source.prepare("SELECT 1 FROM sqlite_master WHERE name='obolus_product_experiments' AND type='table'").get()
      ? source.prepare('SELECT experiment_id,operation_id,sha256 FROM obolus_product_experiments WHERE product_id=?').get(productId) as {experiment_id:string;operation_id:string;sha256:string}|undefined : undefined;
    if(productBinding&&productBinding.experiment_id!==experimentId)throw new Error('Product experiment attribution mismatch');
    const check=source.prepare('SELECT report,observed_ms FROM commerce_balance_checks WHERE order_id=? ORDER BY id DESC LIMIT 1').get(orderId) as {report:string;observed_ms:number}|undefined;
    if(!check||check.observed_ms>Date.now()||Date.now()-check.observed_ms>3600000)throw new Error('Fresh provider reconciliation required');
    const report=JSON.parse(check.report);
    if(report.orderId!==orderId||report.mode!==config.mode||report.observedAt!==check.observed_ms||
      !['usd','chf','eur'].includes(report.currency)||![report.grossCents,report.providerFeeCents,report.providerNetCents].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=100000000)||
      report.grossCents-report.providerFeeCents!==report.providerNetCents||!/^txn_[A-Za-z0-9]+$/.test(report.balanceTransactionId))throw new Error('Invalid stored provider observation');
    const id=createHash('sha256').update(JSON.stringify([config.account_id,config.mode,orderId])).digest('hex');
    return target.transaction(()=>{
      if(!target.prepare('SELECT 1 FROM revenue_experiments WHERE id=?').get(experimentId))throw new Error('Unknown revenue experiment');
      if(productBinding) {
        const operation=target.prepare('SELECT payload,status FROM obolus_reserved_operations WHERE id=?').get(productBinding.operation_id) as {payload:string;status:string}|undefined;
        if(!operation||operation.status!=='settled')throw new Error('Product registration requires reconciliation');
        const admitted=JSON.parse(operation.payload),purpose=JSON.parse(admitted.purpose);
        if(admitted.adapter!=='local-product'||admitted.experimentId!==experimentId||purpose.action!=='register-product'||
          purpose.productId!==productId||purpose.sha256!==productBinding.sha256||purpose.account!==config.account_id||purpose.mode!==config.mode)
          throw new Error('Product registration provenance mismatch');
      }
      target.exec(`CREATE TABLE IF NOT EXISTS obolus_commerce_observations(
        id TEXT PRIMARY KEY,experiment_id TEXT NOT NULL,account_id TEXT NOT NULL,mode TEXT NOT NULL,
        order_id TEXT NOT NULL,transaction_id TEXT NOT NULL,report TEXT NOT NULL,observed_ms INTEGER NOT NULL,
        UNIQUE(account_id,mode,transaction_id));`);
      const prior=target.prepare('SELECT experiment_id,transaction_id,report FROM obolus_commerce_observations WHERE id=?').get(id) as {experiment_id:string;transaction_id:string;report:string}|undefined;
      if(prior){
        const old=JSON.parse(prior.report);
        if(prior.experiment_id!==experimentId||prior.transaction_id!==report.balanceTransactionId||
          ['currency','grossCents','providerFeeCents','providerNetCents'].some(k=>old[k]!==report[k]))throw new Error('Conflicting payment attribution');
        // Append a fresh provider check without counting another order or replacing history.
        target.exec(`CREATE TABLE IF NOT EXISTS obolus_commerce_refreshes(observation_id TEXT NOT NULL,observed_ms INTEGER NOT NULL,report TEXT NOT NULL,PRIMARY KEY(observation_id,observed_ms));
          CREATE TRIGGER IF NOT EXISTS commerce_refresh_update BEFORE UPDATE ON obolus_commerce_refreshes BEGIN SELECT RAISE(ABORT,'Commerce refresh immutable'); END;
          CREATE TRIGGER IF NOT EXISTS commerce_refresh_delete BEFORE DELETE ON obolus_commerce_refreshes BEGIN SELECT RAISE(ABORT,'Commerce refresh immutable'); END;`);
        const previous=target.prepare('SELECT report FROM obolus_commerce_refreshes WHERE observation_id=? AND observed_ms=?').get(id,check.observed_ms) as {report:string}|undefined;
        if(previous&&previous.report!==check.report)throw new Error('Conflicting provider refresh');
        target.prepare('INSERT OR IGNORE INTO obolus_commerce_refreshes VALUES(?,?,?)').run(id,check.observed_ms,check.report);
        return {duplicate:true,capitalCreditedCents:0};
      }
      target.prepare('INSERT INTO obolus_commerce_observations VALUES(?,?,?,?,?,?,?,?)').run(id,experimentId,config.account_id,config.mode,orderId,report.balanceTransactionId,check.report,check.observed_ms);
      return {duplicate:false,capitalCreditedCents:0};
    }).immediate();
  }).immediate();
}
