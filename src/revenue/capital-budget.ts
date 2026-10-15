import type { Database } from "better-sqlite3";
import { reconciledCashDelta } from "./capital-receipts.js";
import {activeLiveOrderPredicate,liveSettlementBlocked} from './live-settlement.js';
import {pendingChildFundingCost} from './pending-operations.js';

export interface CapitalPolicy {
  capitalChfCents: number;
  reserveChfCents: number;
  /** Conservative CHF cents per USD cent; explicit operator quote, never an implicit parity. */
  chfPerUsdNumerator: number;
  chfPerUsdDenominator: number;
  quoteExpiresAt: number;
}
const amount = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 100_000_000;

export interface CapitalQuoteRenewal {
  id: string;
  chfPerUsdNumerator: number;
  chfPerUsdDenominator: number;
  observedAt: number;
  expiresAt: number;
  source: string;
  reviewedBy: string;
}

/** Operator reconciliation boundary, never an agent tool or automatic market quote.
 * The highest historical CHF/USD ratio is retained until an explicit ledger migration:
 * a cheaper new quote cannot release capital reserved for existing obligations.
 */
export function renewCapitalQuote(db: Database, input: CapitalQuoteRenewal) {
  if (!input || !/^[A-Za-z0-9_-]{1,100}$/.test(input.id) ||
      ![input.chfPerUsdNumerator,input.chfPerUsdDenominator].every(n=>amount(n)&&n>0) ||
      ![input.observedAt,input.expiresAt].every(Number.isSafeInteger) ||
      input.observedAt<=0 || input.expiresAt<=input.observedAt ||
      ![input.source,input.reviewedBy].every(v=>typeof v==='string'&&v.trim().length>0&&v.length<=300))
    throw new Error("Invalid reviewed capital quote");
  const entry: CapitalQuoteRenewal = {id:input.id,chfPerUsdNumerator:input.chfPerUsdNumerator,
    chfPerUsdDenominator:input.chfPerUsdDenominator,observedAt:input.observedAt,expiresAt:input.expiresAt,
    source:input.source,reviewedBy:input.reviewedBy};
  const payload=JSON.stringify(entry);
  return db.transaction(()=>{
    const row=db.prepare("SELECT policy FROM aureus_capital_policy WHERE id=1").get() as {policy:string}|undefined;
    if(!row)throw new Error("Initialize capital policy before renewal");
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_capital_quotes(id TEXT PRIMARY KEY,payload TEXT NOT NULL,before_policy TEXT NOT NULL,after_policy TEXT NOT NULL);`);
    const previous=db.prepare("SELECT payload,after_policy FROM obolus_capital_quotes WHERE id=?").get(entry.id) as {payload:string;after_policy:string}|undefined;
    if(previous){if(previous.payload!==payload)throw new Error("Conflicting capital quote renewal");return {duplicate:true,appliedPolicy:JSON.parse(previous.after_policy) as CapitalPolicy};}
    const now=Date.now();
    if(entry.observedAt>now || entry.expiresAt<=now || now-entry.observedAt>86400000 || entry.expiresAt-entry.observedAt>86400000)
      throw new Error("Capital quote must be fresh and valid for at most 24 hours");
    const policy=JSON.parse(row.policy) as CapitalPolicy;
    if(![policy.chfPerUsdNumerator,policy.chfPerUsdDenominator].every(n=>amount(n)&&n>0))throw new Error("Invalid stored capital quote");
    const latest=db.prepare("SELECT MAX(json_extract(payload,'$.observedAt')) observed FROM obolus_capital_quotes").get() as {observed:number|null};
    if(latest.observed!==null && entry.observedAt<=latest.observed)throw new Error("Stale capital quote renewal");
    const higher=BigInt(entry.chfPerUsdNumerator)*BigInt(policy.chfPerUsdDenominator)>
      BigInt(policy.chfPerUsdNumerator)*BigInt(entry.chfPerUsdDenominator);
    const next:CapitalPolicy={...policy,quoteExpiresAt:entry.expiresAt,
      chfPerUsdNumerator:higher?entry.chfPerUsdNumerator:policy.chfPerUsdNumerator,
      chfPerUsdDenominator:higher?entry.chfPerUsdDenominator:policy.chfPerUsdDenominator};
    const after=JSON.stringify(next);
    db.prepare("INSERT INTO obolus_capital_quotes VALUES(?,?,?,?)").run(entry.id,payload,row.policy,after);
    db.prepare("UPDATE aureus_capital_policy SET policy=? WHERE id=1").run(after);
    return {duplicate:false,appliedPolicy:next};
  }).immediate();
}

/** Opt-in shared capital ceiling. No revenue claim automatically replenishes capital. */
export function initializeCapitalBudget(db: Database, input: CapitalPolicy): void {
  if (![input.capitalChfCents,input.reserveChfCents,input.chfPerUsdNumerator,input.chfPerUsdDenominator].every(amount) ||
      input.capitalChfCents <= 0 || input.reserveChfCents > input.capitalChfCents ||
      input.chfPerUsdNumerator <= 0 || input.chfPerUsdDenominator <= 0 || !Number.isSafeInteger(input.quoteExpiresAt) || input.quoteExpiresAt <= Date.now()) {
    throw new Error("Invalid capital policy or expired explicit FX quote");
  }
  const policy: CapitalPolicy = {capitalChfCents:input.capitalChfCents,reserveChfCents:input.reserveChfCents,
    chfPerUsdNumerator:input.chfPerUsdNumerator,chfPerUsdDenominator:input.chfPerUsdDenominator,quoteExpiresAt:input.quoteExpiresAt};
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS aureus_capital_policy(id INTEGER PRIMARY KEY CHECK(id=1), policy TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS aureus_capital_commitments(id TEXT PRIMARY KEY, purpose TEXT NOT NULL, usd_cents INTEGER NOT NULL CHECK(usd_cents>=0));
      CREATE TABLE IF NOT EXISTS aureus_capital_settlements(id TEXT PRIMARY KEY, actual_usd_cents INTEGER NOT NULL CHECK(actual_usd_cents>=0));`);
    const old=db.prepare("SELECT policy FROM aureus_capital_policy WHERE id=1").get() as {policy:string}|undefined;
    if(old && old.policy!==JSON.stringify(policy)) throw new Error("Capital policy is immutable; explicit reconciliation required");
    db.prepare("INSERT OR IGNORE INTO aureus_capital_policy VALUES(1,?)").run(JSON.stringify(policy));
  }).immediate();
}

export function checkCapitalBudget(db: Database, additionalUsdCents: number): {allowed:boolean; reason?:string; remainingChfCents?:number} {
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='obolus_paper_capital_stop'").get())return {allowed:false,reason:'Founder paper capital is disabled; no spending or financial execution'};
  if(!amount(additionalUsdCents)) return {allowed:false,reason:"Invalid capital charge"};
  pendingChildFundingCost(db); // Validate released child holds against their accounting.
  if(liveSettlementBlocked(db))
    return {allowed:false,reason:'Closed-order settlement requires reviewed recovery'};
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='obolus_payout_capital_holds'").get()&&db.prepare('SELECT 1 FROM obolus_payout_capital_holds LIMIT 1').get())
    return {allowed:false,reason:'Payout capital hold requires independent destination reconciliation'};
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='aureus_capital_policy'").get()) return {allowed:true};
  const row=db.prepare("SELECT policy FROM aureus_capital_policy WHERE id=1").get() as {policy:string}|undefined;
  if(!row) return {allowed:false,reason:"Missing shared capital policy"};
  let p:CapitalPolicy;
  try{p=JSON.parse(row.policy) as CapitalPolicy;}catch{return {allowed:false,reason:"Invalid stored capital policy"};}
  if(!p||![p.capitalChfCents,p.reserveChfCents,p.chfPerUsdNumerator,p.chfPerUsdDenominator].every(amount)||
    p.capitalChfCents<=0||p.reserveChfCents>p.capitalChfCents||p.chfPerUsdNumerator<=0||p.chfPerUsdDenominator<=0||
    !Number.isSafeInteger(p.quoteExpiresAt)||p.quoteExpiresAt<=0)return {allowed:false,reason:"Invalid stored capital policy"};
  if(Date.now()>=p.quoteExpiresAt) return {allowed:false,reason:"Capital FX quote expired; reconciliation required"};
  // Validate individual liabilities: a negative or fractional row must not cancel valid costs in SUM.
  const sources=[
    ['inference_costs','cost_cents','1=1'],
    ['inference_reservations','reserved_cents',"status='pending'"],
    ['economic_events','amount_cents',"event_type IN ('cost','refund')"],
    ['aureus_capital_commitments','usd_cents','id NOT IN (SELECT id FROM aureus_capital_settlements)'],
  ];
  const liveOrders=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_live_order_holds'").get();
  const livePredicate=liveOrders?activeLiveOrderPredicate(db):"status<>'rejected'";
  if(liveOrders)sources.push(['obolus_live_order_holds','usd_cents',livePredicate]);
  for(const [table,column,where] of sources){
    if(db.prepare(`SELECT 1 FROM ${table} WHERE (${where}) AND (${column} IS NULL OR typeof(${column}) NOT IN ('integer','real') OR ${column}<0 OR ${column}>9007199254740991 OR ${column}!=CAST(${column} AS INTEGER)) LIMIT 1`).get())
      return {allowed:false,reason:"Invalid individual capital cost; reconciliation required"};
  }
  if(db.prepare("SELECT 1 FROM economic_events WHERE event_type IN ('cost','refund') AND currency<>'USD' LIMIT 1").get())
    return {allowed:false,reason:"Unconverted economic costs block shared capital admission"};
  const sum=(sql:string)=>(db.prepare(sql).get() as {n:number}).n;
  const usd=sum("SELECT COALESCE(SUM(cost_cents),0) n FROM inference_costs")+
    sum("SELECT COALESCE(SUM(reserved_cents),0) n FROM inference_reservations WHERE status='pending'")+
    sum("SELECT COALESCE(SUM(amount_cents),0) n FROM economic_events WHERE event_type IN ('cost','refund')")+
    sum("SELECT COALESCE(SUM(usd_cents),0) n FROM aureus_capital_commitments WHERE id NOT IN (SELECT id FROM aureus_capital_settlements)")+
    (liveOrders?sum(`SELECT COALESCE(SUM(usd_cents),0) n FROM obolus_live_order_holds WHERE ${livePredicate}`):0)+additionalUsdCents;
  if(!Number.isSafeInteger(usd) || usd<0) return {allowed:false,reason:"Invalid aggregate capital costs"};
  const numerator=BigInt(usd)*BigInt(p.chfPerUsdNumerator),denominator=BigInt(p.chfPerUsdDenominator);
  const charged=(numerator+denominator-1n)/denominator;
  let cashDelta:number;
  try{cashDelta=reconciledCashDelta(db);}catch{return {allowed:false,reason:'Invalid reconciled cash ledger; reconciliation required'};}
  const available=BigInt(p.capitalChfCents-p.reserveChfCents+cashDelta);
  return charged>available ? {allowed:false,reason:"Shared capital exhausted across operating costs and all experiments",remainingChfCents:0} :
    {allowed:true,remainingChfCents:Number(available-charged)};
}

/** Record actual costs even above estimate. A failed ledger write leaves the commitment reserved. */
export function settleCapitalCommitment(db: Database,id:string,actualUsdCents:number,record:()=>void): void {
  if(!amount(actualUsdCents)) throw new Error("Invalid capital settlement");
  db.transaction(()=>{
    const prior=db.prepare("SELECT actual_usd_cents FROM aureus_capital_settlements WHERE id=?").get(id) as {actual_usd_cents:number}|undefined;
    if(prior) {if(prior.actual_usd_cents!==actualUsdCents) throw new Error("Conflicting capital settlement");return;}
    if(!db.prepare("SELECT 1 FROM aureus_capital_commitments WHERE id=?").get(id)) throw new Error("Missing capital commitment");
    const total=()=> (db.prepare("SELECT COALESCE(SUM(amount_cents),0) n FROM economic_events WHERE event_type IN ('cost','refund') AND currency='USD'").get() as {n:number}).n;
    const before=total();record();
    if(total()-before!==actualUsdCents) throw new Error("Capital settlement must record matching USD economic costs");
    db.prepare("INSERT INTO aureus_capital_settlements VALUES(?,?)").run(id,actualUsdCents);
  }).immediate();
}

/** Non-inference adapters reserve before side effects. Unresolved commitments never expire automatically. */
export function reserveCapitalCommitment(db: Database,id:string,purpose:string,usdCents:number): void {
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !purpose.trim() || purpose.length>1000 || !amount(usdCents)) throw new Error("Invalid capital commitment");
  db.transaction(() => {
    const previous=db.prepare("SELECT purpose,usd_cents FROM aureus_capital_commitments WHERE id=?").get(id) as {purpose:string;usd_cents:number}|undefined;
    if(previous) {if(previous.purpose!==purpose || previous.usd_cents!==usdCents) throw new Error("Conflicting capital commitment");return;}
    const check=checkCapitalBudget(db,usdCents);
    if(!check.allowed) throw new Error(check.reason);
    db.prepare("INSERT INTO aureus_capital_commitments VALUES(?,?,?)").run(id,purpose,usdCents);
  }).immediate();
}
