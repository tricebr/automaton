import {claimDigest} from '../commerce/claim-evidence.js';
import type {reconciledProfitEvidence} from './profit-reconciliation.js';

type Observation=ReturnType<typeof reconciledProfitEvidence>[number];
/** Projection of the existing settlement ledger. No parallel outcomes, authority,
 * cash postings, or forecast-to-real conversion. Missing lineage remains unknown. */
export function businessLearningReason(e:Observation):string|null {
  const b=e.business,a=b?.attribution;
  if(!b||!a)return 'missing_product_segment_channel_lineage';
  if(a.experimentId!==e.experimentId||a.hypothesisDigest!==claimDigest(e.baseline?.hypothesis))return 'experiment_hypothesis_mismatch';
  if(e.mode!=='live'||!e.reconciled||!['EXTERN_BEOBACHTET','ABGESTIMMT'].includes(a.provenance))return 'not_reconciled_external_observation';
  if(a.quality!=='passed')return 'quality_not_verified';
  if(!a.costsComplete||b.deliveryCostCents===null||b.supportCostCents===null||a.refundedOrders===null)return 'cost_or_refund_coverage_missing';
  if(!a.representativeSample)return 'sample_selection_unverified';
  if(a.activated===null||a.reused===null||a.supportCases===null||b.renewalEligible===null)return 'lifecycle_metrics_missing';
  return null;
}
export function businessLearningProjection(observations:Observation[]){
  const groups=new Map<string,{scope:unknown;rows:Observation[]}>();
  const excluded:{experimentId:string;reason:string;provenance:string}[]=[];
  for(const e of observations){
    if(!e.business)continue;
    const reason=businessLearningReason(e);
    if(reason){excluded.push({experimentId:e.experimentId,reason,provenance:e.business.attribution?.provenance??'UNBEKANNT'});continue;}
    const b=e.business,a=b.attribution!;
    const scope={productId:b.productId,productDigest:a.productDigest,requirementsDigest:a.requirementsDigest,
      qualityDecisionDigest:a.qualityDecisionDigest,audience:a.audience,language:a.language,region:a.region,channel:b.channelId,
      variant:a.variant,campaignId:a.campaignId,hypothesisId:a.hypothesisId,hypothesisDigest:a.hypothesisDigest,messageDigest:a.messageDigest,priceCents:b.priceCents,comparisonBasis:e.comparisonBasis};
    const key=claimDigest(scope),group=groups.get(key)??{scope,rows:[]};group.rows.push(e);groups.set(key,group);
  }
  return {groups:[...groups].map(([key,g])=>{
    const repeated=new Set(g.rows.map(e=>e.sampleUnitId)).size!==g.rows.length||new Set(g.rows.map(e=>e.business!.cohortId)).size!==g.rows.length;
    const overlaps=g.rows.some((a,i)=>g.rows.slice(i+1).some(b=>a.startedAt<b.closedAt&&b.startedAt<a.closedAt));
    const reasons=[...(repeated?['repeated_sample_or_cohort']:[]),...(overlaps?['overlapping_observation_windows']:[]),...(g.rows.length<20?['small_sample']:[])];
    return {key,scope:g.scope,samples:g.rows.length,realLearningEligible:!repeated&&!overlaps,
      meanNetContributionCents:repeated||overlaps?null:g.rows.reduce((n,e)=>n+e.netProfitCents,0)/g.rows.length,
      observations:g.rows.map(e=>({experimentId:e.experimentId,statementDigest:e.statementDigest,sourceId:e.sourceId,
        periodStart:e.startedAt,periodEnd:e.closedAt,costCents:e.costCents,netProfitCents:e.netProfitCents,metrics:e.business})),
      reasons,scalingAuthorized:false,revalidationRequired:reasons.length>0};
  }),excluded,executionAuthorized:false,
    limitation:'Descriptive reconciled cohorts only. A sample count is not a significance or causal test. Existing preregistered profitability calibration, quality, risk and release gates remain mandatory; no automatic scaling or model downgrade.'};
}
