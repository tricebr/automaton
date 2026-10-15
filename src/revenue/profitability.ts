import type {Database} from 'better-sqlite3';
import {RevenueStore} from './store.js';
import {opportunityDemandEvidence} from './outcome.js';
import {profitReconciliationBlocked,reconciledProfitEvidence,PROFIT_CONDITIONS,type ProfitCondition} from './profit-reconciliation.js';
import {businessLearningProjection,businessLearningReason} from './business-learning.js';
import {latestOpportunityProfile} from './opportunity-profile.js';
import {assertNoKnownSecrets} from '../observability/redaction.js';
import {createHash} from 'node:crypto';
import {activeLiveOrderPredicate} from './live-settlement.js';

export interface ProfitabilityPolicy {
  opportunityId:string;minimumSamples:number;minimumNetCents:number;maximumNetCents:number;
  maximumCumulativeLossCents:number;maximumDrawdownCents:number;maximumEvidenceAgeMs:number;
  capacityCents:number;maximumScaleCents:number;maximumValidationCents:number;forecastSuccessMeansPositiveNet:boolean;
  comparisonBasis:string;reviewedBy:string;
  regimeBounds?:{metric:ProfitCondition;minimum:number;maximum:number}[];
}
const table=(db:Database,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const evidenceKey=(e:ReturnType<typeof reconciledProfitEvidence>)=>createHash('sha256').update(JSON.stringify(e.map(s=>[s.experimentId,s.statementDigest]))).digest('hex');
/** Trusted operational/security acceptance, never an agent assertion. Each
 * review binds exact reconciled live evidence and an expiry. Further results
 * require remeasurement before another scale recommendation. */
export function registerScalingReview(db:Database,input:{reviewId:string;opportunityId:string;maximumCents:number;expiresAt:number;operationalReady:true;securityReady:true;reviewedBy:string}){
  if(!input||![input.reviewId,input.opportunityId,input.reviewedBy].every(s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(s))||
    !Number.isSafeInteger(input.maximumCents)||input.maximumCents<1||input.maximumCents>100000000||!Number.isSafeInteger(input.expiresAt)||
    input.expiresAt<=Date.now()||input.expiresAt>Date.now()+7*86400000||input.operationalReady!==true||input.securityReady!==true)throw new Error('Invalid scaling acceptance');
  assertNoKnownSecrets(input);
  return db.transaction(()=>{
    const evidence=reconciledProfitEvidence(db,input.opportunityId).filter(s=>s.mode==='live');
    if(!evidence.length||evidence.some(s=>!s.reconciled)||profitReconciliationBlocked(db,input.opportunityId))throw new Error('Reconciled live evidence required');
    const payload=JSON.stringify({...input,evidenceDigest:evidenceKey(evidence)});
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_scaling_reviews(sequence INTEGER PRIMARY KEY,review_id TEXT UNIQUE NOT NULL,opportunity_id TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS scaling_review_no_update BEFORE UPDATE ON obolus_scaling_reviews BEGIN SELECT RAISE(ABORT,'Scaling review immutable'); END;
      CREATE TRIGGER IF NOT EXISTS scaling_review_no_delete BEFORE DELETE ON obolus_scaling_reviews BEGIN SELECT RAISE(ABORT,'Scaling review immutable'); END;`);
    const old=db.prepare('SELECT payload FROM obolus_scaling_reviews WHERE review_id=?').get(input.reviewId) as {payload:string}|undefined;
    if(old){if(old.payload!==payload)throw new Error('Conflicting scaling acceptance');return;}
    db.prepare('INSERT INTO obolus_scaling_reviews(review_id,opportunity_id,payload) VALUES(?,?,?)').run(input.reviewId,input.opportunityId,payload);
  }).immediate();
}
function valid(p:ProfitabilityPolicy){
  const fields=['opportunityId','minimumSamples','minimumNetCents','maximumNetCents','maximumCumulativeLossCents','maximumDrawdownCents','maximumEvidenceAgeMs','capacityCents','maximumScaleCents','maximumValidationCents','forecastSuccessMeansPositiveNet','comparisonBasis','reviewedBy','regimeBounds'];
  return p&&Object.keys(p).every(k=>fields.includes(k))&&[p.opportunityId,p.comparisonBasis,p.reviewedBy].every(s=>typeof s==='string'&&s.trim().length>0&&s.length<=100)&&
    Number.isSafeInteger(p.minimumSamples)&&p.minimumSamples>=3&&p.minimumSamples<=500&&
    [p.minimumNetCents,p.maximumNetCents,p.maximumCumulativeLossCents,p.maximumDrawdownCents,p.maximumEvidenceAgeMs,p.capacityCents,p.maximumScaleCents,p.maximumValidationCents].every(Number.isSafeInteger)&&
    p.minimumNetCents<0&&p.minimumNetCents>=-100000000&&p.maximumNetCents>0&&p.maximumNetCents<=100000000&&
    p.maximumCumulativeLossCents>0&&p.maximumCumulativeLossCents<=100000000&&p.maximumDrawdownCents>0&&p.maximumDrawdownCents<=100000000&&
    p.maximumEvidenceAgeMs>=60000&&p.maximumEvidenceAgeMs<=90*86400000&&p.capacityCents>0&&p.capacityCents<=100000000&&
    p.maximumScaleCents>0&&p.maximumScaleCents<=p.capacityCents&&p.maximumValidationCents>0&&p.maximumValidationCents<=p.maximumScaleCents&&typeof p.forecastSuccessMeansPositiveNet==='boolean'&&
    (p.regimeBounds===undefined||Array.isArray(p.regimeBounds)&&p.regimeBounds.length<=PROFIT_CONDITIONS.length&&
      new Set(p.regimeBounds.map(r=>r.metric)).size===p.regimeBounds.length&&p.regimeBounds.every(r=>r&&PROFIT_CONDITIONS.includes(r.metric)&&
        Number.isSafeInteger(r.minimum)&&Number.isSafeInteger(r.maximum)&&r.minimum>=0&&r.maximum>=r.minimum&&r.maximum<=100000000));
}
/** Trusted forward-only registration. Existing history is preserved; only
 * experiments started after registration may establish statistical validation.
 * Earlier losses still count for capital protection. No execution permission. */
export function registerProfitabilityPolicy(db:Database,p:ProfitabilityPolicy){
  if(!valid(p))throw new Error('Invalid profitability policy');assertNoKnownSecrets(p);
  const payload=JSON.stringify(p);
  db.transaction(()=>{
    if(table(db,'obolus_profitability_policies')){
      const old=db.prepare('SELECT payload FROM obolus_profitability_policies WHERE opportunity_id=?').get(p.opportunityId) as {payload:string}|undefined;
      if(old&&old.payload!==payload)throw new Error('Profitability policy immutable');
    }
    if(!new RevenueStore(db).getOpportunity(p.opportunityId))throw new Error('Unknown profitability opportunity');
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_profitability_policies(opportunity_id TEXT PRIMARY KEY,payload TEXT NOT NULL,registered_at INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS profitability_policy_no_update BEFORE UPDATE ON obolus_profitability_policies BEGIN SELECT RAISE(ABORT,'Profitability policy immutable'); END;
      CREATE TRIGGER IF NOT EXISTS profitability_policy_no_delete BEFORE DELETE ON obolus_profitability_policies BEGIN SELECT RAISE(ABORT,'Profitability policy immutable'); END;
      CREATE TABLE IF NOT EXISTS obolus_profitability_families(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,opportunity_id TEXT UNIQUE NOT NULL);
      CREATE TRIGGER IF NOT EXISTS profitability_family_no_update BEFORE UPDATE ON obolus_profitability_families BEGIN SELECT RAISE(ABORT,'Profitability family immutable'); END;
      CREATE TRIGGER IF NOT EXISTS profitability_family_no_delete BEFORE DELETE ON obolus_profitability_families BEGIN SELECT RAISE(ABORT,'Profitability family immutable'); END;`);
    db.prepare('INSERT OR IGNORE INTO obolus_profitability_policies VALUES(?,?,?)').run(p.opportunityId,payload,Date.now());
    if(!db.prepare('SELECT 1 FROM obolus_profitability_families WHERE opportunity_id=?').get(p.opportunityId))
      db.prepare('INSERT INTO obolus_profitability_families(opportunity_id) VALUES(?)').run(p.opportunityId);
  }).immediate();
}

/** Descriptive calibration plus alpha-spending Hoeffding bounds. Applicability
 * requires independent comparable samples and preregistered bounded outcomes.
 * Error budget is split across mean and drift tests, with sequential spending.
 * The runtime further allocates it across immutable policy ordinals and modes.
 * None of this establishes independence, valid outcome bounds or causality. */
export function economicCalibration(samples:readonly {net:number;cost:number;forecastCost:number;probability:number|null}[],bounds:{minimum:number;maximum:number},successMeansNet:boolean,minimumSamples=3,lookIndex=Math.max(1,samples.length),seriesErrorBudget=0.05){
  if(samples.length>1000||!Number.isSafeInteger(bounds.minimum)||!Number.isSafeInteger(bounds.maximum)||bounds.minimum>=bounds.maximum||
    samples.some(s=>![s.net,s.cost,s.forecastCost].every(Number.isSafeInteger)||s.cost<0||s.forecastCost<0||
      s.probability!==null&&(!Number.isFinite(s.probability)||s.probability<0||s.probability>1)))throw new Error('Invalid calibration samples');
  if(!Number.isSafeInteger(minimumSamples)||minimumSamples<3||minimumSamples>1000)throw new Error('Invalid minimum sample count');
  if(!Number.isSafeInteger(lookIndex)||lookIndex<Math.max(1,samples.length)||lookIndex>1000000)throw new Error('Invalid sequential look index');
  if(!Number.isFinite(seriesErrorBudget)||seriesErrorBudget<=0||seriesErrorBudget>0.05)throw new Error('Invalid calibration error budget');
  const n=samples.length,mean=n?samples.reduce((a,s)=>a+s.net,0)/n:null;
  const outsideBounds=samples.some(s=>s.net<bounds.minimum||s.net>bounds.maximum);
  const radius=n?(bounds.maximum-bounds.minimum)*Math.sqrt(Math.log(4*lookIndex*(lookIndex+1)/seriesErrorBudget)/(2*n)):null;
  const paired=successMeansNet?samples.filter(s=>s.probability!==null):[];
  const half=Math.floor(n/2),older=samples.slice(0,half),recent=samples.slice(half);
  const avg=(s:typeof samples)=>s.reduce((a,v)=>a+v.net,0)/s.length;
  const driftThreshold=half>=3?(bounds.maximum-bounds.minimum)*(Math.sqrt(Math.log(4*lookIndex*(lookIndex+1)/seriesErrorBudget)/(2*half))+Math.sqrt(Math.log(4*lookIndex*(lookIndex+1)/seriesErrorBudget)/(2*(n-half)))):null;
  let total=0,firstPositiveBoundSample:number|null=null;
  if(!outsideBounds)for(let i=0;i<n;i++){
    total+=samples[i].net;const count=i+1;
    if(count>=minimumSamples&&firstPositiveBoundSample===null&&total/count-(bounds.maximum-bounds.minimum)*Math.sqrt(Math.log(4*Math.max(count,lookIndex)*(Math.max(count,lookIndex)+1)/seriesErrorBudget)/(2*count))>0)
      firstPositiveBoundSample=count;
  }
  return {samples:n,sequentialLookIndex:lookIndex,seriesErrorBudget,meanNetCents:mean,lowerNetCents:!outsideBounds&&mean!==null&&radius!==null?mean-radius:null,
    firstPositiveBoundSample,
    upperNetCents:!outsideBounds&&mean!==null&&radius!==null?mean+radius:null,outsideBounds,
    brierScore:paired.length?paired.reduce((a,s)=>a+(s.probability!-(s.net>0?1:0))**2,0)/paired.length:null,
    probabilityBias:paired.length?paired.reduce((a,s)=>a+s.probability!-(s.net>0?1:0),0)/paired.length:null,
    meanCostErrorCents:n?samples.reduce((a,s)=>a+s.cost-s.forecastCost,0)/n:null,
    recentMeanNetCents:half>=3?avg(recent):null,
    edgeDecay:!outsideBounds&&driftThreshold!==null&&avg(older)-avg(recent)>driftThreshold,
    limitation:'Conditional on preregistered bounds and comparable independent samples; repeated or selected results are not independent. Paper and live must be evaluated separately.'};
}
export type ProfitabilityState='HYPOTHESIS'|'RESEARCHED'|'PAPER_VALIDATING'|'PAPER_VALIDATED'|'LIVE_VALIDATING'|'VALIDATED_PROFITABLE'|'REPEATABLE'|'SCALABLE'|'EDGE_DECAY_DETECTED'|'REVALIDATING'|'PAUSED'|'TERMINATED';
export type ProfitabilityAction='REJECT'|'RESEARCH'|'VALIDATE'|'SIMULATE'|'PAPER_TEST'|'SMALL_LIVE_VALIDATION'|'CONTINUE'|'SCALE'|'REDUCE'|'PAUSE'|'REVALIDATE'|'TERMINATE';

/** One read-only lifecycle shared by agenda, allocator and spending admission.
 * State is derived from immutable evidence, never assigned by an LLM label. */
export function profitabilitySnapshot(db:Database,opportunityId:string){
  return db.transaction(()=>{
    const store=new RevenueStore(db),opportunity=store.getOpportunity(opportunityId);
    if(!opportunity)throw new Error('Unknown profitability opportunity');
    const row=table(db,'obolus_profitability_policies')?db.prepare('SELECT payload,registered_at FROM obolus_profitability_policies WHERE opportunity_id=?').get(opportunityId) as {payload:string;registered_at:number}|undefined:undefined;
    const policy=row?JSON.parse(row.payload) as ProfitabilityPolicy:null;
    const family=policy&&table(db,'obolus_profitability_families')?db.prepare('SELECT ordinal FROM obolus_profitability_families WHERE opportunity_id=?').get(opportunityId) as {ordinal:number}|undefined:undefined;
    if(policy&&!family)throw new Error('Re-register unchanged profitability policy for immutable statistical family allocation');
    if(policy&&(!valid(policy)||policy.opportunityId!==opportunityId||!Number.isSafeInteger(row!.registered_at)||row!.registered_at<0||row!.registered_at>Date.now()||
      !Number.isSafeInteger(family!.ordinal)||family!.ordinal<1||family!.ordinal>1000000))throw new Error('Corrupt profitability policy');
    const evidence=reconciledProfitEvidence(db,opportunityId),live=evidence.filter(e=>e.mode==='live'),paper=evidence.filter(e=>e.mode==='paper');
    const accounting=live.length?live:paper;
    const eligible=policy?accounting.filter(e=>e.startedAt>=row!.registered_at):accounting;
    // Deterministic freshness window. Old losses remain in survival accounting,
    // but stale success cannot validate today's edge or permanently poison all
    // future cohorts. Count expiry and correction events in the look budget.
    const selected=policy?eligible.filter(e=>Date.now()-e.observedAt<=policy.maximumEvidenceAgeMs):eligible;
    const expired=policy?evidence.filter(e=>Date.now()-e.observedAt>policy.maximumEvidenceAgeMs).length:0;
    const lookIndex=Math.max(1,evidence.length+expired+2*evidence.reduce((sum,e)=>sum+e.revision,0));
    const businessLearning=businessLearningProjection(selected);
    const incompatibleSamples=businessLearning.groups.length>1||selected.some(e=>e.business)&&selected.some(e=>!e.business)||new Set(selected.map(e=>e.sampleUnitId)).size!==selected.length||
      !!policy&&selected.some(e=>e.comparisonBasis!==policy.comparisonBasis);
    const samples=selected.filter(e=>e.mode!=='live'||!e.business||businessLearningReason(e)===null).map(e=>({net:e.netProfitCents,cost:e.costCents,forecastCost:e.baseline!.forecastCostCents,
      probability:e.baseline!.probability===null?null:e.baseline!.probability!>1?e.baseline!.probability!/100:e.baseline!.probability}));
    // Policies cannot be deleted/reordered. Sum_k 1/(k(k+1)) = 1; half for
    // each of paper/live, so adding strategies cannot reset a 5% error budget.
    const calibration=policy?economicCalibration(samples,{minimum:policy.minimumNetCents,maximum:policy.maximumNetCents},policy.forecastSuccessMeansPositiveNet,policy.minimumSamples,lookIndex,0.025/(family!.ordinal*(family!.ordinal+1))):null;
    let cumulative=0,peak=0,drawdown=0;
    for(const e of accounting){cumulative+=e.netProfitCents;peak=Math.max(peak,cumulative);drawdown=Math.max(drawdown,peak-cumulative);}
    const withinExperimentDrawdown=Math.max(0,...accounting.map(e=>e.deployment?.drawdownCents??0));
    const timePairs=selected.filter(e=>e.deployment?.timeToFirstRevenueHours!==null&&e.deployment?.timeToFirstRevenueHours!==undefined&&e.baseline?.timeHours!==null&&e.baseline?.timeHours!==undefined);
    const demand=opportunityDemandEvidence(db,opportunityId);
    let state:ProfitabilityState=selected.length?live.length?'LIVE_VALIDATING':'PAPER_VALIDATING':demand.state==='demand_observed'?'RESEARCHED':'HYPOTHESIS';
    let action:ProfitabilityAction=selected.length?'CONTINUE':'VALIDATE';
    const reasons:string[]=[];
    const regime=(policy?.regimeBounds??[]).map(bound=>{
      const latest=selected.at(-1),value=latest?.conditions[bound.metric]??null;
      return {...bound,value,observedAt:latest?.observedAt??null,inRange:value!==null&&value>=bound.minimum&&value<=bound.maximum};
    });
    if(policy&&calibration&&selected.length>=policy.minimumSamples&&calibration.lowerNetCents!==null&&calibration.lowerNetCents>0){
      state=live.length?'VALIDATED_PROFITABLE':'PAPER_VALIDATED';action=live.length?'CONTINUE':'PAPER_TEST';
      if(live.length&&selected.length>=policy.minimumSamples*2){
        state='REPEATABLE';
        const profile=latestOpportunityProfile(db,opportunityId);
        const reviewRow=table(db,'obolus_scaling_reviews')?db.prepare('SELECT payload FROM obolus_scaling_reviews WHERE opportunity_id=? ORDER BY sequence DESC LIMIT 1').get(opportunityId) as {payload:string}|undefined:undefined;
        const review=reviewRow?JSON.parse(reviewRow.payload) as {expiresAt:number;maximumCents:number;evidenceDigest:string;operationalReady:boolean;securityReady:boolean}:null;
        // Do not extrapolate from a cheap success to an untested allocation.
        const measuredCostCapacity=Math.max(0,...selected.map(e=>e.costCents));
        if(profile&&profile.capitalRequiredCents<=policy.maximumScaleCents&&profile.liquidityDays<=policy.maximumEvidenceAgeMs/86400000&&
          measuredCostCapacity>=policy.maximumScaleCents&&review&&review.expiresAt>Date.now()&&review.maximumCents>=policy.maximumScaleCents&&
          review.operationalReady===true&&review.securityReady===true&&review.evidenceDigest===evidenceKey(live)){state='SCALABLE';action='SCALE';}
        else reasons.push('scale_readiness_or_measured_capacity_missing');
      }
    }
    if(demand.blocked){state='REVALIDATING';action='REVALIDATE';reasons.push('demand_evidence_changed');}
    if(policy&&eligible.length>0&&selected.length===0){state='REVALIDATING';action='REVALIDATE';reasons.push('stale_profit_evidence');}
    if(calibration?.outsideBounds){state='REVALIDATING';action='REVALIDATE';reasons.push('outcome_outside_preregistered_bounds');}
    if(incompatibleSamples){state='REVALIDATING';action='REVALIDATE';reasons.push('incompatible_or_repeated_samples');}
    if(selected.some(e=>e.mode==='live'&&e.business&&businessLearningReason(e)!==null)){
      state='REVALIDATING';action='REVALIDATE';reasons.push('business_attribution_or_quality_unverified');
    }
    if(selected.length&&regime.some(r=>!r.inRange)){state='REVALIDATING';action='REVALIDATE';reasons.push('regime_missing_or_outside_bounds');}
    if(calibration?.edgeDecay){state='EDGE_DECAY_DETECTED';action='REDUCE';reasons.push('net_edge_decay');}
    if(calibration?.firstPositiveBoundSample&&calibration.lowerNetCents!==null&&calibration.lowerNetCents<=0&&!calibration.edgeDecay){state='REVALIDATING';action='REVALIDATE';reasons.push('positive_edge_confidence_lost');}
    if(policy&&(cumulative<=-policy.maximumCumulativeLossCents||Math.max(drawdown,withinExperimentDrawdown)>=policy.maximumDrawdownCents||
      selected.length>=policy.minimumSamples&&calibration?.upperNetCents!==null&&calibration?.upperNetCents!==undefined&&calibration.upperNetCents<0)){
      state='TERMINATED';action='TERMINATE';reasons.push('preregistered_loss_or_negative_edge_limit');
    }
    if(profitReconciliationBlocked(db,opportunityId)||evidence.some(e=>!e.reconciled)){state='PAUSED';action='PAUSE';reasons.push('reconciliation_discrepancy');}
    if(opportunity.status==='kill'){state='TERMINATED';action='TERMINATE';reasons.push('opportunity_inactive');}
    if(['paused','completed'].includes(opportunity.status)){state='PAUSED';action='PAUSE';reasons.push('opportunity_inactive');}
    return {opportunityId,state,action,reasons,policyConfigured:!!policy,liveSamples:live.length,paperSamples:paper.length,
      netProfitCents:accounting.length?cumulative:null,accountingMode:live.length?'live':paper.length?'paper':null,drawdownCents:drawdown,
      observedWithinExperimentDrawdownCents:accounting.some(e=>e.deployment!==null)?withinExperimentDrawdown:null,
      economicForecastCalibration:{netSamples:selected.length,meanNetErrorCents:selected.length?selected.reduce((sum,e)=>sum+e.netProfitCents-(e.baseline!.forecastRevenueCents-e.baseline!.forecastCostCents),0)/selected.length:null,
        timeSamples:timePairs.length,meanTimeToRevenueErrorHours:timePairs.length?timePairs.reduce((sum,e)=>sum+e.deployment!.timeToFirstRevenueHours!-e.baseline!.timeHours!,0)/timePairs.length:null,
        limitation:'Immutable start forecasts versus scoped reconciled results. Net forecast is conditional, not probability-weighted. Unknown first revenue timestamps do not become zero duration; drawdown is observed only where supplied by the accepted connector.'},
      deploymentObservations:selected.filter(e=>e.deployment!==null).slice(-20).map(e=>({experimentId:e.experimentId,mode:e.mode,metrics:e.deployment})),
      deploymentObservationsTruncated:selected.filter(e=>e.deployment!==null).length>20,
      calibration,regime,edgeHalfLifeHours:null,maximumScaleCents:state==='SCALABLE'?policy!.maximumScaleCents:null,executionAuthorized:false,
      historicalSamplesExcluded:accounting.length-selected.length,expiredSamples:expired,
      businessPerformance:selected.filter(e=>e.business!==null).slice(-20).map(e=>({experimentId:e.experimentId,mode:e.mode,reconciled:e.reconciled,observedAt:e.observedAt,metrics:e.business})),
      businessPerformanceTruncated:selected.filter(e=>e.business!==null).length>20,
      businessLearning,
      timeToStatisticalValidationHours:calibration?.firstPositiveBoundSample&&!incompatibleSamples?
        Math.max(0,(selected[calibration.firstPositiveBoundSample-1].observedAt-Math.min(...selected.map(e=>e.startedAt)))/3600000):null,
      perExperimentCeilingCents:policy?(state==='SCALABLE'?policy.maximumScaleCents:policy.maximumValidationCents):null,
      limitation:'Connector-authenticated scoped statements, conditional statistical evidence and policy recommendation; never capital, execution or profit guarantees.'};
  })();
}

export function profitabilityAdmission(db:Database,opportunityId:string){
  // No legacy behavior change in the absence of explicit economic policy.
  if(!table(db,'obolus_profitability_policies')||!db.prepare('SELECT 1 FROM obolus_profitability_policies WHERE opportunity_id=?').get(opportunityId))return {block:null,ceiling:null};
  const s=profitabilitySnapshot(db,opportunityId);
  let block:string|null=null;
  if(['PAUSED','TERMINATED','EDGE_DECAY_DETECTED'].includes(s.state))block=`Profitability governor: ${s.state}`;
  if(!block&&s.reasons.some(r=>['stale_profit_evidence','outcome_outside_preregistered_bounds','incompatible_or_repeated_samples','positive_edge_confidence_lost','regime_missing_or_outside_bounds'].includes(r)))block='Profitability governor: REVALIDATE';
  return {block,ceiling:s.perExperimentCeilingCents};
}

/** Operator linkage, not a model-selected escape from a stopped opportunity. */
export function registerStrategyEconomics(db:Database,strategyId:string,opportunityId:string){
  if(![strategyId,opportunityId].every(s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(s)))throw new Error('Invalid strategy economics binding');
  assertNoKnownSecrets({strategyId,opportunityId});
  db.transaction(()=>{
    if(!table(db,'obolus_profitability_policies')||!db.prepare('SELECT 1 FROM obolus_profitability_policies WHERE opportunity_id=?').get(opportunityId))throw new Error('Registered profitability policy required');
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_strategy_economics(strategy_id TEXT PRIMARY KEY,opportunity_id TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS strategy_economics_no_update BEFORE UPDATE ON obolus_strategy_economics BEGIN SELECT RAISE(ABORT,'Strategy economics immutable'); END;
      CREATE TRIGGER IF NOT EXISTS strategy_economics_no_delete BEFORE DELETE ON obolus_strategy_economics BEGIN SELECT RAISE(ABORT,'Strategy economics immutable'); END;`);
    const old=db.prepare('SELECT opportunity_id FROM obolus_strategy_economics WHERE strategy_id=?').get(strategyId) as {opportunity_id:string}|undefined;
    if(old&&old.opportunity_id!==opportunityId)throw new Error('Strategy economics cannot be rebound');
    db.prepare('INSERT OR IGNORE INTO obolus_strategy_economics VALUES(?,?)').run(strategyId,opportunityId);
  }).immediate();
}

/** Called inside the order gateway's existing IMMEDIATE transaction, before
 * capital is held or a provider is called. Existing configured installations
 * without any profitability policy retain legacy admission. Once introduced,
 * all new strategies require explicit linkage; renaming cannot evade a halt. */
export function strategyProfitabilityAdmission(db:Database,strategyId:string,additionalCents:number):string|null {
  if(!table(db,'obolus_profitability_policies')||!db.prepare('SELECT 1 FROM obolus_profitability_policies LIMIT 1').get())return null;
  const binding=table(db,'obolus_strategy_economics')?db.prepare('SELECT opportunity_id FROM obolus_strategy_economics WHERE strategy_id=?').get(strategyId) as {opportunity_id:string}|undefined:undefined;
  if(!binding)return 'Strategy requires an immutable economic attribution';
  const s=profitabilitySnapshot(db,binding.opportunity_id);
  if(!['PAPER_VALIDATED','LIVE_VALIDATING','VALIDATED_PROFITABLE','REPEATABLE','SCALABLE'].includes(s.state))return `Strategy profitability governor: ${s.state}`;
  const held=table(db,'obolus_live_order_holds')?(db.prepare(`SELECT COALESCE(SUM(h.usd_cents),0) n FROM obolus_live_order_holds h
    JOIN obolus_strategy_economics b ON b.strategy_id=h.strategy_id WHERE b.opportunity_id=? AND ${activeLiveOrderPredicate(db,'h')}`).get(binding.opportunity_id) as {n:number}).n:0;
  if(!Number.isSafeInteger(additionalCents)||additionalCents<0||!Number.isSafeInteger(held)||held<0||s.perExperimentCeilingCents===null||held+additionalCents>s.perExperimentCeilingCents)
    return 'Economic validation or scale capital ceiling exceeded';
  return null;
}
