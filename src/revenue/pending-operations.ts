import type {Database} from 'better-sqlite3';
/** Validates closed allocations before allowing their holds to disappear.
 * Actual provider-credit balances are not liquid returned capital. */
export function pendingChildFundingCost(db:Database,experimentId?:string):number {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_child_funding'").get())return 0;
  const closures=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_child_funding_closures'").get();
  const rows=db.prepare('SELECT id,payload FROM obolus_child_funding').all() as {id:string;payload:string}[];
  let total=0;
  for(const row of rows){
    const input=JSON.parse(row.payload),n=input.amountCents;
    if(!Number.isSafeInteger(n)||n<=0)throw new Error('Invalid child capital allocation');
    const closed=closures?db.prepare('SELECT payload FROM obolus_child_funding_closures WHERE operation_id=?').get(row.id) as {payload:string}|undefined:undefined;
    if(closed){
      const receipt=JSON.parse(closed.payload);
      const settlement=db.prepare('SELECT actual_usd_cents FROM aureus_capital_settlements WHERE id=?').get(row.id) as {actual_usd_cents:number}|undefined;
      const event=db.prepare('SELECT amount_cents,experiment_id,event_type,currency FROM economic_events WHERE id=?').get(`child-cost:${row.id}`) as {amount_cents:number;experiment_id:string;event_type:string;currency:string}|undefined;
      if(!Number.isSafeInteger(receipt.actualCostUsdCents)||receipt.actualCostUsdCents<0||!Number.isSafeInteger(receipt.returnedLiquidUsdCents)||receipt.returnedLiquidUsdCents<0||
        !Number.isSafeInteger(receipt.additionalDebitUsdCents)||receipt.additionalDebitUsdCents<0||
        receipt.actualCostUsdCents+receipt.returnedLiquidUsdCents!==n+receipt.additionalDebitUsdCents||
        settlement?.actual_usd_cents!==receipt.actualCostUsdCents||event?.amount_cents!==receipt.actualCostUsdCents||event?.experiment_id!==input.experimentId||event?.event_type!=='cost'||event?.currency!=='USD')throw new Error('Child funding settlement accounting mismatch');
    }else{
      if(db.prepare('SELECT 1 FROM aureus_capital_settlements WHERE id=?').get(row.id))throw new Error('Child funding closure evidence missing');
      if(experimentId===undefined||input.experimentId===experimentId)total+=n;
    }
  }
  if(!Number.isSafeInteger(total))throw new Error('Invalid child allocation total');
  return total;
}
export function pendingOperationCost(db:Database,experimentId:string):number {
  let total=0;
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_reserved_operations'").get()){
    const rows=db.prepare(`SELECT payload,status FROM obolus_reserved_operations
      WHERE json_extract(payload,'$.experimentId')=?`).all(experimentId) as {payload:string;status:string}[];
    for(const row of rows){
      if(row.status==='settled')continue;
      if(row.status!=='pending')throw new Error('Invalid pending operation status');
      // Validate each hold before summing: corrupt negative/fractional values
      // must not cancel valid reservations or disappear through SQL SUM(NULL).
      const cost:unknown=JSON.parse(row.payload).maxCostUsdCents;
      if(typeof cost!=='number'||!Number.isSafeInteger(cost)||cost<0)throw new Error('Invalid pending operation costs');
      total+=cost;
      if(!Number.isSafeInteger(total))throw new Error('Invalid pending operation total');
    }
  }
  total+=pendingChildFundingCost(db,experimentId);
  if(!Number.isSafeInteger(total))throw new Error('Invalid pending operation total');
  return total;
}
