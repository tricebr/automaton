import type {Database} from 'better-sqlite3';
import {assessCustomerAnalysis,type CustomerAnalysis,type CustomerClaim} from './customer-analysis.js';
import {assessMarketingPlan,type MarketingPlan} from './marketing.js';

/** Read-only extension of the existing economic brief. Weights describe review
 * attention, not an executable score or calibrated probability of success. */
export function marketDecisionReport(db:Database,id:string,analysis:CustomerAnalysis|undefined,plan:MarketingPlan|undefined,now=Date.now()) {
  const customer=assessCustomerAnalysis(db,id,analysis,now);
  const economics=plan?assessMarketingPlan(plan):null;
  const scenarios=plan?assessMarketingPlan(plan,[
    {id:'pessimistic',priceBps:9000,salesBps:5000,variableCostBps:12000,fixedCostBps:12000},
    {id:'central',priceBps:10000,salesBps:10000,variableCostBps:10000,fixedCostBps:10000},
    {id:'positive_sensitivity',priceBps:10000,salesBps:12000,variableCostBps:10000,fixedCostBps:10000},
  ]).stress:null;
  const all=[...customer.claims,...customer.marketClaims];
  const dimension=(name:string,weight:number,fields:CustomerClaim['field'][])=>{
    const claims=all.filter(c=>fields.includes(c.field));
    return {name,weight,score:null,claims,
      unknown:claims.filter(c=>['UNBEKANNT','ANNAHME','VERALTET'].includes(c.state)).map(c=>c.field),
      counterevidence:claims.filter(c=>c.state==='WIDERSPRÜCHLICH'),
      evidenceClass:'public_indicator_or_assumption',customerResponseVerified:false};
  };
  const dimensions=[
    dimension('demand',35,['segment','job','frequency','urgency','impact','willingnessToPay','purchaseIntent','reachableMarket','purchaseFrequency']),
    dimension('supply',20,['workaround','competitorQuality','competitorAudience','competitorChannel','customerExperience','marketSaturation','entryBarriers','noActionAlternative']),
    dimension('differentiation',20,['differentiation','alternativeWeakness','measurableBenefit']),
    {...dimension('economic_fit',25,['channel']),economics},
  ];
  const unknown=[...new Set(dimensions.flatMap(d=>d.unknown))];
  const contradictions=dimensions.flatMap(d=>d.counterevidence).map(c=>c.field);
  const warnings=[
    ...unknown.map(field=>`Unresolved market claim: ${field}`),
    ...contradictions.map(field=>`Counterevidence requires review: ${field}`),
    ...(!customer.comparable?['Comparable current alternative terms missing']:[]),
    ...(economics?.blockers??['Complete unit economics missing']),
    'No authenticated customer response or reconciled profit is inferred from research quotations',
  ];
  const selected=plan?.campaign?.channels.find(c=>c.name===plan.channel);
  const recommendation=contradictions.length?'pause_and_resolve':economics?.blockers.length?'redesign_or_stop':'research_further';
  return {version:1,opportunityId:id,assessedAt:now,dimensions,totalScore:null,
    weightingPurpose:'35/20/20/25 review dimensions requested by Founder; no existing ranking weights or thresholds changed. Missing evidence is never zero-filled or renormalized.',
    offer:plan?{product:plan.product,productDigest:plan.campaign?.productDigest??null,requirementsDigest:plan.campaign?.requirementsDigest??null,
      audience:plan.audience,offer:plan.offer,priceCents:plan.priceCents,currency:plan.currency,channel:plan.channel}:null,
    reachablePilot:selected?{reachableCustomers:selected.reachableAudience,conversion:selected.conversionEstimate,
      expectedSales:Math.floor(selected.reachableAudience*selected.conversionEstimate),
      priceCents:plan!.priceCents,currency:plan!.currency,state:'ASSUMPTION',
      purchaseFrequency:null,measuredMarketSize:null}:null,
    alternatives:customer.alternatives,unknown,contradictions,recommendation,reasonsAgainst:warnings,
    scenarios,scenarioBasis:'Illustrative sensitivity only: downside uses existing joint stress; central holds the supplied plan; upside assumes 20% more sales with unchanged unit costs. No scenario probability, verified demand or permission is inferred.',
    cashflow:{availableCapital:null,runwayDays:null,timeToBreakEvenDays:null,
      reason:'Requires actual dated cash receipts, obligations and spending pace from the existing reconciled ledgers; forecasts cannot supply these facts.'},
    nextTest:{action:contradictions.length?'Resolve conflicting sources before further selection':unknown.length?
      `Obtain current attributable evidence for ${unknown[0]}`:'Verify customer response and complete comparable unit economics',
      success:'Exact claim, source, date, scope and counterevidence reviewed; public interest never substitutes for payment',
      stop:plan?.stopCriterion??'Stop when evidence cannot resolve the hypothesis within the separately authorized limit',
      plannedBudgetCents:plan?.availableTestBudgetCents??null,authorizedSpendCents:0,
      startsAt:plan?.campaign?.startsAt??null,endsAt:plan?.campaign?.endsAt??null},
    gates:['product_quality','legal','privacy','security','permission','capital','execution_backend'].map(gate=>({gate,status:'NOT_EVALUATED',passed:false})),
    gateBoundary:'This read-only research projection does not evaluate or override existing version-bound release, action, budget, capital or runtime gates. Approval requires their actual independent checks.',
    executionAuthorized:false,scalingAuthorized:false,profitabilityProven:false,
    limitations:['Public sources are untrusted observations, not verified customers or paid demand.',
      'Competitor count, popularity and search volume cannot establish profitability or market saturation.',
      'Source quality and freshness are visible per citation; exact quotation matching does not authenticate truth.',
      'Historical outcomes, full cashflow, runway and portfolio dependencies remain in existing economic-state, profitability and allocation APIs.'],
  };
}
