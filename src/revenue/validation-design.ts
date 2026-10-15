import type {MarketingPlan} from './marketing.js';
import type {EconomicField} from './research-assumptions.js';

/** Expected value of PERFECT information is an upper bound, not a forecast of
 * what a research task will deliver. Each action includes all execution costs;
 * preserve-capital with zero incremental payoff is always available. */
export function informationValue(input:{probabilities:number[];actions:{id:string;netCents:number[]}[];researchCostCents:number}){
  if(!input||!Array.isArray(input.probabilities)||input.probabilities.length<2||input.probabilities.length>20||
    input.probabilities.some(p=>!Number.isFinite(p)||p<0||p>1)||Math.abs(input.probabilities.reduce((a,b)=>a+b,0)-1)>1e-9||
    !Number.isSafeInteger(input.researchCostCents)||input.researchCostCents<0||input.researchCostCents>100000000||
    !Array.isArray(input.actions)||!input.actions.length||input.actions.length>20||new Set(input.actions.map(a=>a.id)).size!==input.actions.length||
    input.actions.some(a=>!a||typeof a.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(a.id)||!Array.isArray(a.netCents)||a.netCents.length!==input.probabilities.length||
      a.netCents.some(n=>!Number.isSafeInteger(n)||Math.abs(n)>100000000)))throw new Error('Invalid information-value scenario model');
  const current=Math.max(0,...input.actions.map(a=>a.netCents.reduce((sum,n,i)=>sum+n*input.probabilities[i],0)));
  const perfect=input.probabilities.reduce((sum,p,i)=>sum+p*Math.max(0,...input.actions.map(a=>a.netCents[i])),0);
  const upper=Math.max(0,perfect-current);
  return {currentBestExpectedNetCents:current,perfectInformationExpectedNetCents:perfect,informationValueUpperBoundCents:upper,
    netInformationValueUpperBoundCents:upper-input.researchCostCents,
    maximumResearchCostForPositiveUpperBoundCents:Math.max(0,Math.ceil(upper)-1),
    decision:upper<=input.researchCostCents?'do_not_buy_information':'estimate_actual_information_value_first',executionAuthorized:false,
    limitation:'Conditional supplied scenario model, not evidence or an estimate of research effectiveness. Positive upper bound alone never justifies spending.'};
}

/** A bounded next-test proposal. Ordering is a heuristic, never a measured optimum. */
export function designValidation(input:{decision:'hold'|'reject'|'validate';reason:string;economics?:MarketingPlan;
  missingFields:readonly EconomicField[];evidenceBlock:string|null;contradictoryFields:readonly EconomicField[];days:number;
  forecast?:{revenueCents:number;costCents:number;probability:number}}) {
  const f=input.forecast;
  const information=f?informationValue({probabilities:[f.probability,1-f.probability],actions:[{id:'execute',netCents:[f.revenueCents-f.costCents,-f.costCents]}],researchCostCents:0}):null;
  const base={version:1,executionAuthorized:false,maxAuthorizedSpendCents:0,profitabilityProven:false,
    informationValue:information,
    selectionBasis:'Resolve blockers, identify a payer and offer, then inspect the largest unsupported cost assumption before a pilot. Heuristic, not a proven cheapest test.',
    deadlineHours:Math.min(168,Math.max(1,input.days*24))};
  if(input.evidenceBlock)return {...base,stage:'review' as const,target:input.contradictoryFields[0]??null,
    action:'Review the conflicting or invalid source and revise the hypothesis only with materially new evidence',
    success:'A documented current evidence review addresses every blocker; changed plans require explicit revision',
    failure:'No valid new evidence: retain the hold and do not repeat paid attempts',reason:input.evidenceBlock,outcomeContractProposal:null};
  if(input.decision==='reject')return {...base,stage:'stop' as const,target:null,action:'Record the failed economic assumption and stop this proposal',
    success:'Failure and all incurred costs are documented without inventing a replacement forecast',failure:'No new spending under this proposal',reason:input.reason,outcomeContractProposal:null};
  const commercial: EconomicField[]=['payer','offer','channel','price'];
  const p=input.economics;
  const costWeights:Partial<Record<EconomicField,number>>=p?{
    deliveryCost:p.deliveryCostCents*p.conservativeSales,paymentFees:p.paymentFeeCents*p.conservativeSales,
    refundAllowance:p.refundAllowanceCents*p.conservativeSales,taxAllowance:p.taxAllowanceCents*p.conservativeSales,
    acquisitionCost:p.acquisitionCostPerSaleCents*p.conservativeSales,fixedTestCost:p.fixedTestCostCents,operatingCost:p.operatingCostCents}:{};
  const target=commercial.find(f=>input.missingFields.includes(f))??
    [...input.missingFields].sort((a,b)=>(costWeights[b]??0)-(costWeights[a]??0)||a.localeCompare(b))[0];
  if(target||!p){
    const field=target??'payer';
    const actions:Partial<Record<EconomicField,string>>={
      payer:'Identify a reachable buyer and a concrete recurring problem in attributable sources',
      offer:'Draft one smallest deliverable tied to the buyer problem and cite evidence for its value',
      channel:'Identify one permitted route to reachable buyers and its access constraints',
      price:'Find an attributable willingness-to-pay signal for the scoped deliverable; do not infer payment from clicks',
      probability:'Document the uncertainty and counterexamples behind the success estimate; one observation is not calibration',
      conservativeSales:'Estimate a conservative reachable buyer count without treating duplicated sources as independent demand',
      timeToRevenue:'Trace acquisition, delivery and settlement delays before estimating time to usable cash'};
    return {...base,stage:'research' as const,target:field,action:actions[field]??`Obtain an attributable quote or measured estimate for ${field}, including units, exclusions and uncertainty`,
      success:`Record a literal source citation and a separate interpretation for ${field}; revise the complete economics if assumptions change`,
      failure:'No usable source within the existing task/time ceiling: record uncertainty and stop; do not fill the gap with an invented number',
      reason:'An unsupported assumption must be investigated before proposing a paid pilot',outcomeContractProposal:null};
  }
  if(input.decision!=='validate')return {...base,stage:'review' as const,target:null,action:'Complete the outstanding research admission review',
    success:'Current research admission checks pass',failure:'Retain the hold while required evidence is missing',reason:input.reason,outcomeContractProposal:null};
  return {...base,stage:'pilot-design' as const,target:null,
    action:`Prepare one scoped pilot: ${p.offer}. Use the proposed channel only after its existing permissions and spending gates pass`,
    success:p.successCriterion,failure:p.stopCriterion,reason:'Current citations support designing a test, not proven demand or authority to execute it',
    outcomeContractProposal:{minimumQualifiedCustomers:3,minimumPaidOrders:1,evidenceMaxAgeMs:Math.min(30*86400000,base.deadlineHours*3600000),
      requiresPreregistration:true,modeMustBeSelected:true,reviewedByMustBeProvided:true},
    limitations:'These minimum demand thresholds do not evaluate arbitrary textual success criteria, settled net profit, delivery quality or reinvestment. They are not a registered contract.'};
}
