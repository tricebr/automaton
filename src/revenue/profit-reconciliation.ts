import type {Database} from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {RevenueStore} from './store.js';
import {COST_CATEGORIES} from './profit-ledger.js';
import {assertNoKnownSecrets} from '../observability/redaction.js';
import {canonicalBusinessCohort,businessPerformance,type BusinessCohort} from './business-performance.js';
export const PROFIT_CONDITIONS=['feeBps','slippageBps','spreadBps','fillBps','volatilityBps','conversionBps','retentionBps','acquisitionCostCents','supportCostCents'] as const;
export type ProfitCondition=typeof PROFIT_CONDITIONS[number];
export interface DeploymentObservation {
  peakCapitalCents:number;capitalHoursCents:number;drawdownCents:number;
  firstRevenueAt:number|null;settledAt:number;
}

export interface ProfitStatement {
  statementId:string; experimentId:string; mode:'paper'|'live'; currency:'USD';
  sampleUnitId:string; comparisonBasis:string;
  periodStart:number; periodEnd:number; observedAt:number; revenueCents:number;
  costs:Record<typeof COST_CATEGORIES[number],number>;
  cashSettled:true; liabilitiesComplete:true; evidenceDigest:string;
  /** Connector-observed scoped metrics, never LLM-generated measurements.
   * Missing metrics remain missing. Bps uses 10000 as 100 percent. */
  conditions?:Partial<Record<ProfitCondition,number>>;
  business?:BusinessCohort;
  deployment?:DeploymentObservation;
}
/** Trusted installed connector, NOT a model-supplied object or agent tool.
 * A live implementation must authenticate the account and verify external
 * records including liabilities. Neither a digest nor this interface proves
 * that conformance; each installed connector requires separate acceptance. */
export interface ProfitStatementAdapter {
  sourceId:string;
  readVerifiedStatement(experimentId:string,signal:AbortSignal):Promise<ProfitStatement>;
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const money=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=100000000;
const table=(db:Database,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** Operator-only registration does not enable execution, spend or credit cash. */
export function registerProfitSource(db:Database,sourceId:string,mode:'paper'|'live'){
  if(!id(sourceId)||!['paper','live'].includes(mode))throw new Error('Invalid profit evidence source');
  assertNoKnownSecrets(sourceId);
  db.transaction(()=>{
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_profit_sources(id TEXT PRIMARY KEY,mode TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS profit_source_no_update BEFORE UPDATE ON obolus_profit_sources BEGIN SELECT RAISE(ABORT,'Profit source immutable'); END;
      CREATE TRIGGER IF NOT EXISTS profit_source_no_delete BEFORE DELETE ON obolus_profit_sources BEGIN SELECT RAISE(ABORT,'Profit source immutable'); END;
      CREATE TABLE IF NOT EXISTS obolus_profit_statements(experiment_id TEXT PRIMARY KEY,source_id TEXT NOT NULL,statement_id TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,baseline_digest TEXT NOT NULL,UNIQUE(source_id,statement_id));
      CREATE TRIGGER IF NOT EXISTS profit_statement_no_update BEFORE UPDATE ON obolus_profit_statements BEGIN SELECT RAISE(ABORT,'Profit statement immutable'); END;
      CREATE TRIGGER IF NOT EXISTS profit_statement_no_delete BEFORE DELETE ON obolus_profit_statements BEGIN SELECT RAISE(ABORT,'Profit statement immutable'); END;
      CREATE TABLE IF NOT EXISTS obolus_profit_corrections(experiment_id TEXT NOT NULL,revision INTEGER NOT NULL,parent_digest TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,reviewed_by TEXT NOT NULL,PRIMARY KEY(experiment_id,revision));
      CREATE TRIGGER IF NOT EXISTS profit_correction_no_update BEFORE UPDATE ON obolus_profit_corrections BEGIN SELECT RAISE(ABORT,'Profit correction immutable'); END;
      CREATE TRIGGER IF NOT EXISTS profit_correction_no_delete BEFORE DELETE ON obolus_profit_corrections BEGIN SELECT RAISE(ABORT,'Profit correction immutable'); END;
      CREATE TABLE IF NOT EXISTS obolus_profit_incidents(experiment_id TEXT PRIMARY KEY,reason TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS obolus_profit_recoveries(experiment_id TEXT NOT NULL,incident_at INTEGER NOT NULL,statement_digest TEXT NOT NULL,reviewed_by TEXT NOT NULL,PRIMARY KEY(experiment_id,incident_at));
      CREATE TRIGGER IF NOT EXISTS profit_recovery_no_update BEFORE UPDATE ON obolus_profit_recoveries BEGIN SELECT RAISE(ABORT,'Profit recovery immutable'); END;
      CREATE TRIGGER IF NOT EXISTS profit_recovery_no_delete BEFORE DELETE ON obolus_profit_recoveries BEGIN SELECT RAISE(ABORT,'Profit recovery immutable'); END;`);
    const old=db.prepare('SELECT mode FROM obolus_profit_sources WHERE id=?').get(sourceId) as {mode:string}|undefined;
    if(old&&old.mode!==mode)throw new Error('Profit source cannot change mode');
    db.prepare('INSERT OR IGNORE INTO obolus_profit_sources VALUES(?,?)').run(sourceId,mode);
  }).immediate();
}
function incident(db:Database,experimentId:string){
  db.prepare(`INSERT INTO obolus_profit_incidents VALUES(?,'statement_unavailable_or_inconsistent',?)
    ON CONFLICT(experiment_id) DO UPDATE SET at=MAX(obolus_profit_incidents.at+1,excluded.at)`).run(experimentId,Date.now());
}
function statementConditions(s:ProfitStatement):Partial<Record<ProfitCondition,number>> {
  const values={...s.conditions},b=s.business;
  for(const key of ['conversionBps','retentionBps','fillBps'] as const)
    if(values[key]!==undefined&&values[key]!>10000)throw new Error('Impossible observed rate');
  if(b){
    const derived:Partial<Record<ProfitCondition,number>>={};
    if(b.exposures!==null&&b.exposures>0)derived.conversionBps=Math.floor(10000*b.customers/b.exposures);
    if(b.renewalEligible!==null&&b.renewalEligible>0)derived.retentionBps=Math.floor(10000*b.renewed!/b.renewalEligible);
    if(b.newCustomers>0)derived.acquisitionCostCents=Math.ceil(s.costs.acquisition/b.newCustomers);
    if(b.supportCostCents!==null)derived.supportCostCents=b.supportCostCents;
    for(const [key,value] of Object.entries(derived) as [ProfitCondition,number][]){
      if(values[key]!==undefined&&values[key]!==value)throw new Error('Business metrics contradict scoped observed rates');
      values[key]=value;
    }
  }
  return Object.fromEntries(PROFIT_CONDITIONS.filter(k=>values[k]!==undefined).map(k=>[k,values[k]]));
}
function canonicalDeployment(s:ProfitStatement):DeploymentObservation|undefined {
  const d=s.deployment;if(d===undefined)return undefined;
  const fields=['peakCapitalCents','capitalHoursCents','drawdownCents','firstRevenueAt','settledAt'];
  if(!d||Object.keys(d).length!==fields.length||Object.keys(d).some(k=>!fields.includes(k))||
    !money(d.peakCapitalCents)||!money(d.drawdownCents)||!Number.isFinite(d.capitalHoursCents)||d.capitalHoursCents<0||
    d.capitalHoursCents>d.peakCapitalCents*((s.periodEnd-s.periodStart)/3600000)||
    !Number.isSafeInteger(d.settledAt)||d.settledAt<s.periodEnd||d.settledAt>s.observedAt||
    d.firstRevenueAt!==null&&(!Number.isSafeInteger(d.firstRevenueAt)||d.firstRevenueAt<s.periodStart||d.firstRevenueAt>s.periodEnd||s.revenueCents===0))
    throw new Error('Invalid scoped deployment observation');
  return {peakCapitalCents:d.peakCapitalCents,capitalHoursCents:d.capitalHoursCents,drawdownCents:d.drawdownCents,firstRevenueAt:d.firstRevenueAt,settledAt:d.settledAt};
}
function validateStatement(s:ProfitStatement,experimentId:string,mode:string,fresh=true){
  if(!s||!id(s.statementId)||s.experimentId!==experimentId||s.mode!==mode||s.currency!=='USD'||
    !id(s.sampleUnitId)||!id(s.comparisonBasis)||
    ![s.periodStart,s.periodEnd,s.observedAt].every(n=>Number.isSafeInteger(n)&&n>=0)||s.periodStart>s.periodEnd||s.periodEnd>s.observedAt||
    s.observedAt>Date.now()||fresh&&Date.now()-s.observedAt>300000||!money(s.revenueCents)||s.cashSettled!==true||s.liabilitiesComplete!==true||
    typeof s.evidenceDigest!=='string'||!/^[a-f0-9]{64}$/.test(s.evidenceDigest)||!s.costs||
    Object.keys(s.costs).length!==COST_CATEGORIES.length||!COST_CATEGORIES.every(key=>money(s.costs[key]))||
    s.conditions!==undefined&&(!s.conditions||typeof s.conditions!=='object'||Array.isArray(s.conditions)||
      Object.entries(s.conditions).some(([k,v])=>!(PROFIT_CONDITIONS as readonly string[]).includes(k)||!money(v))))
    throw new Error('Complete authenticated settlement statement required');
  if(s.business!==undefined)canonicalBusinessCohort(s.business,s.revenueCents,Object.values(s.costs).reduce((a,b)=>a+b,0),s.costs.acquisition);
  if(s.mode==='live'&&s.business?.attribution&&!['EXTERN_BEOBACHTET','ABGESTIMMT'].includes(s.business.attribution.provenance))
    throw Error('Synthetic or unknown attribution cannot enter live settlement');
  statementConditions(s);
  canonicalDeployment(s);
}

/** One complete experiment lifetime per statement prevents overlapping period
 * totals. Reconciliation is read-only at the provider; it never submits orders.
 * Concurrent duplicate ingestion is idempotent. Mismatch latches the affected
 * opportunity; a new source or changed forecast cannot overwrite its history. */
export async function reconcileProfit(db:Database,experimentId:string,adapter:ProfitStatementAdapter){
  return ingestProfit(db,experimentId,adapter);
}
/** Reviewed correction, for example a subsequently reported refund. Retains
 * the original and each prior revision. Does not clear the discrepancy latch;
 * fresh recovery remains a separate reviewed step. No cash is credited. */
export async function reconcileProfitCorrection(db:Database,experimentId:string,adapter:ProfitStatementAdapter,expectedDigest:string,reviewedBy:string){
  if(!/^[a-f0-9]{64}$/.test(expectedDigest)||!reviewedBy?.trim()||reviewedBy.length>100)throw new Error('Reviewed correction and prior digest required');
  assertNoKnownSecrets(reviewedBy);
  return ingestProfit(db,experimentId,adapter,{expectedDigest,reviewedBy});
}
type StoredStatement={experiment_id:string;source_id:string;payload:string;digest:string;baseline_digest:string};
function currentStatement(db:Database,original:StoredStatement){
  const revisions=table(db,'obolus_profit_corrections')?db.prepare('SELECT * FROM obolus_profit_corrections WHERE experiment_id=? ORDER BY revision LIMIT 101').all(original.experiment_id) as
    {revision:number;parent_digest:string;payload:string;digest:string}[]:[];
  if(revisions.length>100)throw new Error('Profit correction review capacity exceeded');
  let row=original,revision=0;
  for(const next of revisions){
    const {observedAt:_at,...identity}=JSON.parse(row.payload) as ProfitStatement;
    if(digest(identity)!==row.digest||next.revision!==revision+1||next.parent_digest!==row.digest)throw new Error('Profit correction chain mismatch');
    row={...row,payload:next.payload,digest:next.digest};revision=next.revision;
  }
  const {observedAt:_at,...identity}=JSON.parse(row.payload) as ProfitStatement;
  if(digest(identity)!==row.digest)throw new Error('Profit evidence integrity mismatch');
  return {...row,revision};
}
async function ingestProfit(db:Database,experimentId:string,adapter:ProfitStatementAdapter,correction?:{expectedDigest:string;reviewedBy:string}){
  if(!id(experimentId)||!table(db,'obolus_profit_sources'))throw new Error('Registered profit source required');
  const source=db.prepare('SELECT mode FROM obolus_profit_sources WHERE id=?').get(adapter.sourceId) as {mode:string}|undefined;
  if(!source)throw new Error('Registered profit source required');
  const store=new RevenueStore(db),e=store.getExperiment(experimentId),baseline=store.getExperimentBaseline(experimentId);
  if(!e||!['completed','failed','stopped'].includes(e.status)||!e.startedAt||!e.completedAt||!baseline)
    throw new Error('Terminal experiment and immutable forecast required');
  const start=Date.parse(e.startedAt),end=Date.parse(e.completedAt);
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    const raw=await Promise.race([adapter.readVerifiedStatement(experimentId,controller.signal),new Promise<never>((_resolve,reject)=>{
      timer=setTimeout(()=>{controller.abort();reject(new Error('Statement timeout'));},15000);
    })]);
    validateStatement(raw,experimentId,source.mode);
    if(raw.business?.attribution&&(raw.business.attribution.experimentId!==experimentId||raw.business.attribution.hypothesisDigest!==digest(baseline.hypothesis)||
      e.channel&&raw.business.channelId!==e.channel))throw Error('Business attribution does not match the experiment start hypothesis or channel');
    const s:ProfitStatement={statementId:raw.statementId,experimentId,mode:raw.mode,currency:'USD',sampleUnitId:raw.sampleUnitId,comparisonBasis:raw.comparisonBasis,periodStart:raw.periodStart,
      periodEnd:raw.periodEnd,observedAt:raw.observedAt,revenueCents:raw.revenueCents,
      costs:Object.fromEntries(COST_CATEGORIES.map(key=>[key,raw.costs[key]])) as ProfitStatement['costs'],
      ...(raw.business?{business:canonicalBusinessCohort(raw.business,raw.revenueCents,Object.values(raw.costs).reduce((a,b)=>a+b,0),raw.costs.acquisition)}:{}),
      ...(raw.deployment?{deployment:canonicalDeployment(raw)}:{}),
      ...(raw.conditions||raw.business?{conditions:statementConditions(raw)}:{}),
      cashSettled:true,liabilitiesComplete:true,evidenceDigest:raw.evidenceDigest};
    assertNoKnownSecrets(s);
    return db.transaction(()=>{
      const current=store.getExperiment(experimentId)!;
      if(current.startedAt!==e.startedAt||current.completedAt!==e.completedAt||current.status!==e.status||digest(store.getExperimentBaseline(experimentId))!==digest(baseline)||
        !Number.isFinite(start)||!Number.isFinite(end)||s.periodStart!==start||s.periodEnd!==end||end<start||
        db.prepare("SELECT 1 FROM inference_reservations WHERE experiment_id=? AND status='pending'").get(experimentId)||store.hasUnresolvedOperation(experimentId))
        throw new Error('Settlement scope or unresolved liabilities');
      const costs=Object.values(s.costs).reduce((a,b)=>a+b,0),known=store.getForecastVsActual(experimentId)!;
      if(!Number.isSafeInteger(costs)||costs<known.actualCostCents)throw new Error('Statement understates recorded costs');
      // observedAt is freshness, not transaction identity; repeated read cannot
      // increase sample count or change monetary history.
      const {observedAt:_observedAt,...identity}=s;
      const h=digest(identity),original=db.prepare('SELECT * FROM obolus_profit_statements WHERE experiment_id=?').get(experimentId) as StoredStatement|undefined;
      const old=original?currentStatement(db,original):undefined;
      if(old){
        if(old.source_id!==adapter.sourceId)throw new Error('Conflicting settled source');
        if(old.digest===h)return {duplicate:true};
        if(!correction||correction.expectedDigest!==old.digest||old.revision>=100)throw new Error('Conflicting settled outcome');
        const previous=JSON.parse(old.payload) as ProfitStatement;
        if(previous.statementId!==s.statementId||previous.sampleUnitId!==s.sampleUnitId||previous.comparisonBasis!==s.comparisonBasis||
          previous.mode!==s.mode||previous.periodStart!==s.periodStart||previous.periodEnd!==s.periodEnd)throw new Error('Correction cannot redefine sample scope');
        db.prepare('INSERT INTO obolus_profit_corrections VALUES(?,?,?,?,?,?)').run(experimentId,old.revision+1,old.digest,JSON.stringify(s),h,correction.reviewedBy);
        incident(db,experimentId);
        return {duplicate:false};
      }
      if(correction)throw new Error('Original statement required before correction');
      db.prepare('INSERT INTO obolus_profit_statements VALUES(?,?,?,?,?,?)').run(experimentId,adapter.sourceId,s.statementId,JSON.stringify(s),h,digest(baseline));
      return {duplicate:false};
    }).immediate();
  }catch{incident(db,experimentId);throw new Error('Profit reconciliation failed; affected opportunity paused');}
  finally{if(timer)clearTimeout(timer);}
}

export function profitReconciliationBlocked(db:Database,opportunityId:string){
  if(!table(db,'obolus_profit_incidents'))return false;
  const issues=db.prepare(`SELECT i.experiment_id,i.at FROM obolus_profit_incidents i JOIN revenue_experiments e ON e.id=i.experiment_id
    WHERE e.opportunity_id=? LIMIT 1001`).all(opportunityId) as {experiment_id:string;at:number}[];
  if(issues.length>1000)return true;
  return issues.some(issue=>{
    const original=db.prepare('SELECT * FROM obolus_profit_statements WHERE experiment_id=?').get(issue.experiment_id) as StoredStatement|undefined;
    const current=original?currentStatement(db,original):undefined;
    return !current||!db.prepare('SELECT 1 FROM obolus_profit_recoveries WHERE experiment_id=? AND incident_at=? AND statement_digest=?').get(issue.experiment_id,issue.at,current.digest);
  });
}

/** Explicit reviewed recovery after a fresh authenticated read matching the
 * immutable statement. Does not waive spending/market-data/trading halts. */
export async function reviewProfitRecovery(db:Database,experimentId:string,adapter:ProfitStatementAdapter,reviewedBy:string){
  if(typeof reviewedBy!=='string'||!reviewedBy.trim()||reviewedBy.length>100)throw new Error('Reviewed recovery identity required');
  assertNoKnownSecrets(reviewedBy);
  const issue=db.prepare('SELECT at FROM obolus_profit_incidents WHERE experiment_id=?').get(experimentId) as {at:number}|undefined;
  if(!issue)throw new Error('No profit incident to review');
  await reconcileProfit(db,experimentId,adapter);
  return db.transaction(()=>{
    const current=db.prepare('SELECT at FROM obolus_profit_incidents WHERE experiment_id=?').get(experimentId) as {at:number};
    const original=db.prepare('SELECT * FROM obolus_profit_statements WHERE experiment_id=?').get(experimentId) as StoredStatement|undefined;
    const stored=original?currentStatement(db,original):undefined;
    const e=new RevenueStore(db).getExperiment(experimentId)!;
    if(current.at!==issue.at||!stored||!reconciledProfitEvidence(db,e.opportunityId).find(s=>s.experimentId===experimentId)?.reconciled)
      throw new Error('Recovery state changed; review again');
    db.prepare('INSERT OR IGNORE INTO obolus_profit_recoveries VALUES(?,?,?,?)').run(experimentId,issue.at,stored.digest,reviewedBy);
    return {recovered:true,executionAuthorized:false};
  }).immediate();
}

/** Read-only authenticated-source projection, never credits the cash ledger.
 * Paper evidence remains paper even when positive and repeatedly observed. */
export function reconciledProfitEvidence(db:Database,opportunityId:string){
  if(!table(db,'obolus_profit_statements'))return [];
  const rows=db.prepare(`SELECT s.* FROM obolus_profit_statements s JOIN revenue_experiments e ON e.id=s.experiment_id WHERE e.opportunity_id=? ORDER BY e.completed_at,e.id LIMIT 1001`).all(opportunityId) as
    {experiment_id:string;source_id:string;payload:string;digest:string;baseline_digest:string}[];
  if(rows.length>1000)throw new Error('Profit evidence review capacity exceeded');
  const store=new RevenueStore(db);
  return rows.map(original=>{
    const row=currentStatement(db,original);
    const s=JSON.parse(row.payload) as ProfitStatement,{observedAt:_observedAt,...identity}=s;
    const source=db.prepare('SELECT mode FROM obolus_profit_sources WHERE id=?').get(row.source_id) as {mode:string}|undefined;
    if(!source)throw new Error('Profit source missing');
    validateStatement(s,row.experiment_id,source.mode,false);
    const baseline=store.getExperimentBaseline(row.experiment_id);
    const experiment=store.getExperiment(row.experiment_id)!;
    if(s.business?.attribution&&(s.business.attribution.experimentId!==row.experiment_id||s.business.attribution.hypothesisDigest!==digest(baseline?.hypothesis)||
      experiment.channel&&s.business.channelId!==experiment.channel))throw Error('Business experiment attribution integrity mismatch');
    if(!['completed','failed','stopped'].includes(experiment.status)||Date.parse(experiment.startedAt!)!==s.periodStart||Date.parse(experiment.completedAt!)!==s.periodEnd)
      throw new Error('Profit experiment scope changed');
    if(digest(identity)!==row.digest||digest(baseline)!==row.baseline_digest)throw new Error('Profit evidence integrity mismatch');
    const costs=Object.values(s.costs).reduce((a,b)=>a+b,0);
    const currentCost=store.getForecastVsActual(row.experiment_id)!.actualCostCents;
    return {experimentId:row.experiment_id,sourceId:row.source_id,statementDigest:row.digest,revision:row.revision,mode:s.mode,revenueCents:s.revenueCents,costCents:costs,
      sampleUnitId:s.sampleUnitId,comparisonBasis:s.comparisonBasis,
      conditions:statementConditions(s),
      business:s.business?businessPerformance(s.business,s.revenueCents,costs,s.costs.acquisition,s.periodStart,s.periodEnd):null,
      deployment:s.deployment?{...s.deployment,
        timeToFirstRevenueHours:s.deployment.firstRevenueAt===null?null:(s.deployment.firstRevenueAt-s.periodStart)/3600000,
        settlementDelayHours:(s.deployment.settledAt-s.periodEnd)/3600000,
        netReturnOnPeakCapital:s.deployment.peakCapitalCents>0?(s.revenueCents-costs)/s.deployment.peakCapitalCents:null,
        netProfitPerCapitalHour:s.deployment.capitalHoursCents>0?(s.revenueCents-costs)/s.deployment.capitalHoursCents:null}:null,
      netProfitCents:s.revenueCents-costs,startedAt:s.periodStart,closedAt:s.periodEnd,observedAt:s.observedAt,baseline,
      reconciled:costs>=currentCost&&!store.hasUnresolvedOperation(row.experiment_id)&&!db.prepare("SELECT 1 FROM inference_reservations WHERE experiment_id=? AND status='pending'").get(row.experiment_id)};
  });
}
