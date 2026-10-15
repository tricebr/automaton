import {createHash} from "node:crypto";
import type {Database} from "better-sqlite3";
import {assertNoKnownSecrets} from '../observability/redaction.js';

export interface ReconciledCashEntry {
  /** Stable external account/transaction references; not forecast or checkout IDs. */
  accountRef:string;
  transactionRef:string;
  kind:"receipt"|"debit";
  cashChfCents:number;
  retainedChfCents:number;
  evidenceSha256:string;
  reviewedBy:string;
}
const bounded=(n:number)=>Number.isSafeInteger(n)&&n>=0&&n<=100_000_000;
// oxlint-disable-next-line no-control-regex -- Intentionally reject or sanitize control characters at the security boundary.
const reference=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=200&&value===value.trim()&&!/[\u0000-\u001f\u007f]/.test(value);

/** Trusted reconciliation boundary only, intentionally not exposed as an agent tool.
 * Caller must independently check cash/wallet evidence and explicit CHF valuation. A hash alone is not verification.
 */
export function recordReconciledCash(db:Database,input:ReconciledCashEntry) {
  if(!input||![input.accountRef,input.transactionRef,input.reviewedBy].every(v=>typeof v==="string"&&v.trim().length>0&&v.length<=200)||
    !reference(input.accountRef)||!reference(input.transactionRef)||
    !["receipt","debit"].includes(input.kind)||!bounded(input.cashChfCents)||input.cashChfCents===0||!bounded(input.retainedChfCents)||
    input.retainedChfCents>input.cashChfCents||(input.kind==="debit"&&input.retainedChfCents!==0)||! /^[a-f0-9]{64}$/.test(input.evidenceSha256)) throw new Error("Invalid reconciled CHF cash entry");
  const entry:ReconciledCashEntry={accountRef:input.accountRef,transactionRef:input.transactionRef,kind:input.kind,cashChfCents:input.cashChfCents,
    retainedChfCents:input.retainedChfCents,evidenceSha256:input.evidenceSha256,reviewedBy:input.reviewedBy};
  assertNoKnownSecrets(entry);
  const id=createHash("sha256").update(JSON.stringify([entry.accountRef,entry.transactionRef])).digest("hex"),payload=JSON.stringify(entry);
  return db.transaction(()=>{
    if(!db.prepare("SELECT 1 FROM aureus_capital_policy WHERE id=1").get())throw new Error("Initialize capital policy before cash reconciliation");
    db.exec(`CREATE TABLE IF NOT EXISTS aureus_reconciled_cash(id TEXT PRIMARY KEY,payload TEXT NOT NULL,delta_chf_cents INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')));`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS reconciled_cash_no_update BEFORE UPDATE ON aureus_reconciled_cash
      BEGIN SELECT RAISE(ABORT,'Reconciled cash is immutable; append a correction'); END;
      CREATE TRIGGER IF NOT EXISTS reconciled_cash_no_delete BEFORE DELETE ON aureus_reconciled_cash
      BEGIN SELECT RAISE(ABORT,'Reconciled cash is immutable; append a correction'); END;`);
    const previous=db.prepare("SELECT payload FROM aureus_reconciled_cash WHERE id=?").get(id) as {payload:string}|undefined;
    if(previous){
      if(previous.payload!==payload)throw new Error("Conflicting external cash transaction");
      // Idempotency must not turn damaged persisted evidence into a success.
      reconciledCashDelta(db);return {duplicate:true};
    }
    // Do not credit a canonical reference again if a legacy record used padding.
    if(db.prepare(`SELECT 1 FROM aureus_reconciled_cash
      WHERE trim(json_extract(payload,'$.accountRef'))=? AND trim(json_extract(payload,'$.transactionRef'))=? LIMIT 1`)
      .get(entry.accountRef,entry.transactionRef))throw new Error('Legacy cash reference requires explicit reconciliation');
    const delta=entry.kind==="receipt"?entry.cashChfCents-entry.retainedChfCents:-entry.cashChfCents;
    const total=reconciledCashDelta(db)+delta;
    if(!Number.isSafeInteger(total)||Math.abs(total)>100_000_000)throw new Error("Reconciled capital arithmetic limit");
    db.prepare("INSERT INTO aureus_reconciled_cash(id,payload,delta_chf_cents) VALUES(?,?,?)").run(id,payload,delta);
    return {duplicate:false};
  }).immediate();
}

export function reconciledCashDelta(db:Database):number {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='aureus_reconciled_cash'").get())return 0;
  let delta=0;
  for(const row of db.prepare('SELECT id,payload,delta_chf_cents FROM aureus_reconciled_cash').iterate() as Iterable<{id:string;payload:string;delta_chf_cents:number}>){
    let entry:ReconciledCashEntry;
    try{entry=JSON.parse(row.payload) as ReconciledCashEntry;}catch{throw new Error('Invalid reconciled cash ledger');}
    if(!entry||!reference(entry.accountRef)||!reference(entry.transactionRef)||typeof entry.reviewedBy!=='string'||!entry.reviewedBy.trim()||entry.reviewedBy.length>200||
      !['receipt','debit'].includes(entry.kind)||!bounded(entry.cashChfCents)||entry.cashChfCents===0||!bounded(entry.retainedChfCents)||
      entry.retainedChfCents>entry.cashChfCents||(entry.kind==='debit'&&entry.retainedChfCents!==0)||typeof entry.evidenceSha256!=='string'||!/^[a-f0-9]{64}$/.test(entry.evidenceSha256))
      throw new Error('Invalid reconciled cash ledger');
    const expectedId=createHash('sha256').update(JSON.stringify([entry.accountRef,entry.transactionRef])).digest('hex');
    const expectedDelta=entry.kind==='receipt'?entry.cashChfCents-entry.retainedChfCents:-entry.cashChfCents;
    if(row.id!==expectedId||row.delta_chf_cents!==expectedDelta)throw new Error('Inconsistent reconciled cash ledger');
    delta+=row.delta_chf_cents;
    if(!Number.isSafeInteger(delta))throw new Error('Invalid reconciled cash ledger');
  }
  if(!Number.isSafeInteger(delta)||Math.abs(delta)>100_000_000)throw new Error("Invalid reconciled cash ledger");
  return delta;
}
