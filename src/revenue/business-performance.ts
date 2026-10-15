/** Scoped connector observations. Counts are unique within this cohort/window,
 * not additive across overlapping cohorts. Costs reference the same settled
 * statement; this module never books cash or turns a forecast into evidence. */
import {OBSERVATION_CLASSES,type PublicationContext} from '../commerce/claim-evidence.js';
import {validatePublicationContext} from '../commerce/claim-evidence.js';
export interface BusinessAttribution extends PublicationContext {
  productDigest:string;requirementsDigest:string;qualityDecisionDigest:string;
  hypothesisId:string;campaignId:string;messageDigest:string;evidenceDigest:string;
  experimentId:string;hypothesisDigest:string;
  provenance:typeof OBSERVATION_CLASSES[number];quality:'passed'|'failed'|'unknown';
  activated:number|null;reused:number|null;refundedOrders:number|null;supportCases:number|null;
  representativeSample:boolean;costsComplete:boolean;
}
export interface BusinessCohort {
  cohortId:string;channelId:string;productId:string;priceCents:number;
  exposures:number|null;leads:number|null;customers:number;newCustomers:number;
  orders:number;renewalEligible:number|null;renewed:number|null;
  subscriptionRevenueCents:number|null;deliveryCostCents:number|null;supportCostCents:number|null;
  attribution?:BusinessAttribution;
}
const keys=['cohortId','channelId','productId','priceCents','exposures','leads','customers','newCustomers','orders','renewalEligible','renewed','subscriptionRevenueCents','deliveryCostCents','supportCostCents'] as const;
const bounded=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=100000000;
const attributionKeys=['audience','language','region','channel','variant','productDigest','requirementsDigest','qualityDecisionDigest','hypothesisId','campaignId','messageDigest','evidenceDigest','experimentId','hypothesisDigest','provenance','quality','activated','reused','refundedOrders','supportCases','representativeSample','costsComplete'];
export function canonicalBusinessCohort(b:BusinessCohort,revenueCents:number,totalCostCents:number,acquisitionCostCents:number):BusinessCohort {
  if(!bounded(revenueCents)||!bounded(acquisitionCostCents)||!Number.isSafeInteger(totalCostCents)||totalCostCents<acquisitionCostCents||totalCostCents>1700000000||
    !b||keys.some(k=>!Object.hasOwn(b,k))||Object.keys(b).some(k=>k!=='attribution'&&!(keys as readonly string[]).includes(k))||
    ![b.cohortId,b.channelId,b.productId].every(s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(s))||
    ![b.priceCents,b.customers,b.newCustomers,b.orders].every(bounded)||b.priceCents===0||b.newCustomers>b.customers||b.customers>b.orders||
    ![b.exposures,b.leads,b.renewalEligible,b.renewed,b.subscriptionRevenueCents,b.deliveryCostCents,b.supportCostCents].every(n=>n===null||bounded(n))||
    b.exposures!==null&&(b.exposures<b.customers||b.leads!==null&&b.leads>b.exposures)||b.leads!==null&&b.leads<b.customers||
    (b.renewalEligible===null)!==(b.renewed===null)||b.renewed!==null&&(b.renewed>b.renewalEligible!||b.renewed>b.customers)||
    b.subscriptionRevenueCents!==null&&b.subscriptionRevenueCents>revenueCents||
    (b.deliveryCostCents??0)+(b.supportCostCents??0)+acquisitionCostCents>totalCostCents||
    revenueCents>0&&b.orders===0)throw new Error('Invalid scoped business cohort');
  const a=b.attribution;
  if(a!==undefined){
    if(!a||Object.keys(a).length!==attributionKeys.length||Object.keys(a).some(k=>!attributionKeys.includes(k)))throw Error('Exact bounded business attribution required');
    validatePublicationContext(a);
    if(![a.productDigest,a.requirementsDigest,a.qualityDecisionDigest,a.messageDigest,a.evidenceDigest,a.hypothesisDigest].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))||
      ![a.hypothesisId,a.campaignId,a.experimentId].every(v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v))||
      !OBSERVATION_CLASSES.includes(a.provenance)||!['passed','failed','unknown'].includes(a.quality)||
      typeof a.representativeSample!=='boolean'||typeof a.costsComplete!=='boolean'||a.channel!==b.channelId||
      ![a.activated,a.reused,a.refundedOrders,a.supportCases].every(n=>n===null||bounded(n))||
      a.activated!==null&&a.activated>b.customers||a.reused!==null&&(a.activated===null||a.reused>a.activated)||
      a.refundedOrders!==null&&a.refundedOrders>b.orders)throw Error('Invalid product, segment and channel attribution');
  }
  return {...Object.fromEntries(keys.map(k=>[k,b[k]])),...(a?{attribution:structuredClone(a)}:{})} as unknown as BusinessCohort;
}
export function businessPerformance(b:BusinessCohort,revenueCents:number,totalCostCents:number,acquisitionCostCents:number,periodStart:number,periodEnd:number){
  canonicalBusinessCohort(b,revenueCents,totalCostCents,acquisitionCostCents);
  if(![periodStart,periodEnd].every(n=>Number.isSafeInteger(n)&&n>=0)||periodEnd<periodStart)throw new Error('Invalid business observation window');
  const ratio=(numerator:number,denominator:number)=>denominator>0?numerator/denominator:null;
  const net=revenueCents-totalCostCents;
  return {...b,currency:'USD',revenueCents,totalCostCents,netProfitCents:net,
    conversionRate:b.exposures===null?null:ratio(b.customers,b.exposures),
    leadConversionRate:b.leads===null?null:ratio(b.customers,b.leads),
    observedRevenuePerCustomerCents:ratio(revenueCents,b.customers),
    observedNetPerCustomerCents:ratio(net,b.customers),
    acquisitionCostPerNewCustomerCents:ratio(acquisitionCostCents,b.newCustomers),
    renewalRate:b.renewalEligible===null?null:ratio(b.renewed!,b.renewalEligible),
    churnRate:b.renewalEligible===null?null:ratio(b.renewalEligible-b.renewed!,b.renewalEligible),
    netMargin:ratio(net,revenueCents),
    windowHours:(periodEnd-periodStart)/3600000,
    realizedNetPerHour:periodEnd>periodStart?net/((periodEnd-periodStart)/3600000):null,
    lifetimeValueCents:null,paybackHours:null,causalPriceEffect:null,
    limitation:'Observed cohort/window economics only. No extrapolated lifetime value, acquisition payback time, price elasticity or causal attribution. Counts across overlapping cohorts must not be summed. Retention uses renewal-eligible customers, not all customers.'};
}
