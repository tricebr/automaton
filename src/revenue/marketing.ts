/** Offline unit economics. Forecasts never authorize publication or spending. */
import {assessCampaignDesign,type CampaignDesign} from './campaign-design.js';
import {assertNoPersonnelCostInputs,PERSONNEL_COST_POLICY} from './personnel-cost-policy.js';
export interface MarketingPlan {
  currency: "USD" | "CHF" | "EUR";
  product: string;
  audience: string;
  channel: string;
  offer: string;
  successCriterion: string;
  stopCriterion: string;
  priceCents: number;
  deliveryCostCents: number;
  paymentFeeCents: number;
  refundAllowanceCents: number;
  taxAllowanceCents: number;
  acquisitionCostPerSaleCents: number;
  fixedTestCostCents: number;
  operatingCostCents: number;
  availableTestBudgetCents: number;
  conservativeSales: number;
  /** Time/automation indicator only. Never converted to money. */
  humanInterventionMinutes?: number;
  campaign?:CampaignDesign;
  /** Additional, non-overlapping forecast costs. Do not repeat amounts already
   * included in deliveryCostCents or operatingCostCents. Null remains unknown. */
  additionalCosts?: {category:'support'|'fulfillment'|'failure'|'infrastructure'|'research';basis:'per_sale'|'fixed';cents:number|null}[];
}
export interface MarketingStressScenario {
  id:string;priceBps:number;salesBps:number;variableCostBps:number;fixedCostBps:number;
}
const DEFAULT_STRESS:MarketingStressScenario[]=[
  {id:'half_sales',priceBps:10000,salesBps:5000,variableCostBps:10000,fixedCostBps:10000},
  {id:'joint_downside',priceBps:9000,salesBps:5000,variableCostBps:12000,fixedCostBps:12000},
];
export function assessMarketingPlan(p: MarketingPlan,scenarios:MarketingStressScenario[]=DEFAULT_STRESS) {
  if(p && typeof p==='object')assertNoPersonnelCostInputs(p);
  if(p?.humanInterventionMinutes!==undefined&&(!Number.isSafeInteger(p.humanInterventionMinutes)||p.humanInterventionMinutes<0||p.humanInterventionMinutes>1_000_000))throw new Error('Invalid human intervention minutes');
  if (!p || !["USD","CHF","EUR"].includes(p.currency) ||
      ![p.product,p.audience,p.channel,p.offer,p.successCriterion,p.stopCriterion].every(s=>typeof s==="string" && s.trim().length>0 && s.length<=2000) ||
      ![p.priceCents,p.deliveryCostCents,p.paymentFeeCents,p.refundAllowanceCents,p.taxAllowanceCents,p.acquisitionCostPerSaleCents,
        p.fixedTestCostCents,p.operatingCostCents,p.availableTestBudgetCents,p.conservativeSales].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=100_000_000) ||
      p.priceCents===0 || p.conservativeSales>10000) throw new Error("Invalid marketing plan: explicit currency, complete offer, bounded costs and criteria required");
  const additional=p.additionalCosts??[];
  if(!Array.isArray(additional)||additional.length>10||new Set(additional.map(c=>c&&`${c.category}:${c.basis}`)).size!==additional.length||
    additional.some(c=>!c||!['support','fulfillment','failure','infrastructure','research'].includes(c.category)||!['per_sale','fixed'].includes(c.basis)||
      c.cents!==null&&(!Number.isSafeInteger(c.cents)||c.cents<0||c.cents>100_000_000)))throw Error('Bounded, non-overlapping additional cost allowances required');
  const unknownCosts=additional.filter(c=>c.cents===null).map(c=>`${c.category}:${c.basis}`);
  const perSale=additional.filter(c=>c.basis==='per_sale').reduce((n,c)=>n+(c.cents??0),0);
  const additionalFixed=additional.filter(c=>c.basis==='fixed').reduce((n,c)=>n+(c.cents??0),0);
  if(!Array.isArray(scenarios)||scenarios.length>20||new Set(scenarios.map(s=>s.id)).size!==scenarios.length||
    scenarios.some(s=>!s||typeof s.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(s.id)||
      ![s.priceBps,s.salesBps,s.variableCostBps,s.fixedCostBps].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=50000)))throw new Error('Invalid marketing stress scenarios');
  const beforeAcquisition=p.priceCents-p.deliveryCostCents-p.paymentFeeCents-p.refundAllowanceCents-p.taxAllowanceCents-perSale;
  const contribution=beforeAcquisition-p.acquisitionCostPerSaleCents;
  const fixed=p.fixedTestCostCents+p.operatingCostCents+additionalFixed;
  const outlay=fixed+p.conservativeSales*(p.deliveryCostCents+p.paymentFeeCents+p.refundAllowanceCents+p.taxAllowanceCents+p.acquisitionCostPerSaleCents+perSale);
  const net=contribution*p.conservativeSales-fixed;
  const variable=p.priceCents-contribution;
  const stress=scenarios.map(s=>{
    const sales=Math.floor(p.conservativeSales*s.salesBps/10000),price=Math.floor(p.priceCents*s.priceBps/10000),
      unitCost=Math.ceil(variable*s.variableCostBps/10000),fixedCost=Math.ceil(fixed*s.fixedCostBps/10000);
    const netCents=sales*(price-unitCost)-fixedCost,outlayCents=sales*unitCost+fixedCost;
    return {id:s.id,assumptions:{...s},sales,netCents,outlayCents,positiveNet:netCents>0,withinBudget:outlayCents<=p.availableTestBudgetCents};
  });
  const costDrivers=[['delivery',p.deliveryCostCents*p.conservativeSales],['payment',p.paymentFeeCents*p.conservativeSales],
    ['refunds',p.refundAllowanceCents*p.conservativeSales],['tax',p.taxAllowanceCents*p.conservativeSales],['acquisition',p.acquisitionCostPerSaleCents*p.conservativeSales],
    ['fixed_test',p.fixedTestCostCents],['operations',p.operatingCostCents],
    ...additional.filter(c=>c.cents!==null).map(c=>[`${c.category}:${c.basis}`,c.cents!*(c.basis==='per_sale'?p.conservativeSales:1)])].map(([category,cost])=>({category:category as string,costCents:cost as number}))
      .sort((a,b)=>b.costCents-a.costCents||a.category.localeCompare(b.category));
  // Strictly positive integer-cent net, not merely break-even. Hold the other
  // declared inputs constant; price changes may change demand or fee schedules.
  const fixedPerSale=p.conservativeSales>0?Math.floor(fixed/p.conservativeSales):null;
  const maximumCac=fixedPerSale===null?null:beforeAcquisition-fixedPerSale-1;
  const thresholds={
    minimumPriceForPositiveNetCents:fixedPerSale===null?null:p.priceCents-contribution+fixedPerSale+1,
    maximumAcquisitionCostForPositiveNetCents:maximumCac===null||maximumCac<0?null:maximumCac,
    minimumSalesForPositiveNet:contribution>0?Math.floor(fixed/contribution)+1:null,
    requiredNetImprovementCents:Math.max(0,1-net),
    netChangePerOneCentPriceIncrease:p.conservativeSales,
    netChangePerOneCentUnitCostReduction:p.conservativeSales,
    netChangePerOneCentFixedCostReduction:1,
    basis:'Conditional forecast sensitivity with all other inputs fixed. Unknown demand response, capacity and percentage fees must be revalidated. Null means no finite supported threshold under these assumptions.',
  };
  const blockers:string[]=[];
  const campaign=assessCampaignDesign(p.campaign,p);
  if(campaign.state==='BLOCKED')blockers.push(...campaign.blockers);
  if(unknownCosts.length)blockers.push('Unknown attributable costs require estimation before bounded validation');
  if(contribution<=0) blockers.push("Nonpositive contribution after acquisition and fulfilment costs");
  if(net<=0) blockers.push("No positive conservative net forecast");
  if(outlay>p.availableTestBudgetCents) blockers.push("Gross test outlay exceeds budget; forecast receipts cannot fund admission");
  return {mode:"marketing-decision-support",currency:p.currency,decision:blockers.length?"redesign_or_stop":"candidate_for_bounded_validation",
    personnelCostPolicy:PERSONNEL_COST_POLICY,humanInterventionMinutes:p.humanInterventionMinutes??null,
    contributionPerSaleCents:contribution,breakEvenSales:contribution>0?Math.ceil(fixed/contribution):null,
    acquisitionCostForZeroUnitMarginCents:Math.max(0,beforeAcquisition),forecastNetCents:net,grossOutlayCents:outlay,blockers,
    plan:structuredClone(p),thresholds,campaign,
    costTruth:{state:unknownCosts.length?'UNKNOWN':'ESTIMATED',unknownCosts,
      completeNetForecast:unknownCosts.length===0,knownComponentsNetCents:net,
      limitation:'All amounts are planning allowances, never settled costs. With unknown costs, numeric totals and sensitivities include known components only and cannot support admission. Existing delivery/operations allowances must include omitted categories; additional allowances must not duplicate them.'},
    bottleneck:outlay>p.availableTestBudgetCents?'available_test_capital':p.conservativeSales===0?'demand':contribution<=0?'unit_margin':net<=0?'volume_or_fixed_cost':'unvalidated_demand_and_execution',
    costDrivers,stress:{scenarios:stress,worstNetCents:stress.length?Math.min(...stress.map(s=>s.netCents)):null,
      basis:'Deterministic hypothetical stress, not probability-weighted forecasts or independent evidence. Default scenarios halve sales, then jointly cut price 10% and raise costs 20%. Fixed per-sale fee/tax allowances must be revalidated when pricing changes.',
      permission:'No stress result grants spending or removes a hard limit.'},
    execution:"Create a bounded revenue experiment and attributable task; reserve shared capital before any paid action. This assessment neither reserves funds nor publishes content.",
    evidence:"All supplied sales and costs are forecasts. No verified demand, payment, profitability or permission to scale is inferred."};
}
