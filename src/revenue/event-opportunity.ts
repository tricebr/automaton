/** Offline teaching diagnostic, never an order gate or source authenticator. */
export function eventOpportunityAudit(input:unknown){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Expected event case');
 const x=input as Record<string,unknown>;
 const n=(key:string,max=1e12)=>{const v=x[key];if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>max)throw Error(`Invalid ${key}`);return v;};
 const b=(key:string)=>{if(typeof x[key]!=='boolean')throw Error(`Missing boolean ${key}`);return x[key] as boolean;};
 const text=(key:string)=>{if(typeof x[key]!=='string'||!(x[key] as string).trim()||(x[key] as string).length>1000)throw Error(`Missing ${key}`);};
 for(const key of ['eventId','sourceUrl','invalidation','exitRule','probabilityBasis'])text(key);
 const source=new URL(x.sourceUrl as string);if(source.protocol!=='https:'||source.username||source.password)throw Error('HTTPS source required');
 const now=n('decisionMs'),published=n('publishedMs'),received=n('receivedMs'),processed=n('processedMs'),expires=n('expiresMs');
 const quote=n('quoteMs'),age=n('maxQuoteAgeMs'),latency=n('executionLatencyMs');
 const gain=n('gainIfRight'),loss=n('lossIfWrong'),cost=n('roundTripCost'),stressCost=n('stressedRoundTripCost');
 const lo=n('probabilityLow',1),hi=n('probabilityHigh',1),tail=n('stressLoss'),budget=n('lossBudget');
 if(lo>hi||stressCost<cost||tail<loss||loss===0||gain===0||budget===0||age===0)throw Error('Inconsistent event assumptions');
 const authenticated=b('sourceChecked'),publicInfo=b('publicInformation'),conflicting=b('conflictingEvidence');
 const halted=b('halted'),depth=b('depthSufficient'),exit=b('exitAvailable');
 const reasons:string[]=[];
 if(!authenticated||!publicInfo||conflicting)reasons.push('Source evidence unresolved');
 if(published>received||received>processed||processed>now)reasons.push('Information unavailable at decision or clocks inconsistent');
 if(now+latency>=expires)reasons.push('Opportunity expires before assumed execution');
 if(quote>now||now-quote+latency>age)reasons.push('Quote stale by assumed execution');
 if(halted||!depth||!exit)reasons.push('Executable entry or exit not established');
 if(tail+stressCost>budget)reasons.push('Stressed loss exceeds supplied budget');
 const expectedLow=lo*gain-(1-lo)*loss-cost;
 const expectedHigh=hi*gain-(1-hi)*loss-cost;
 const stressedExpectedLow=lo*gain-(1-lo)*tail-stressCost;
 if(stressedExpectedLow<=0)reasons.push('No positive lower-bound scenario value after stress');
 return {mode:'offline-event-diagnostic',liveAuthorized:false,inputsVerified:false,profitabilityProven:false,
  disposition:reasons.length?'do-not-promote':'paper-review-only',reasons,
  expectedLow,expectedHigh,stressedExpectedLow,breakEvenProbability:(loss+cost)/(gain+loss),
  limitation:'Caller-supplied total-position amounts in one currency, two-outcome model and subjective probability interval. No calibrated probability, authenticated source, actual executable liquidity or maximum loss guarantee. Rare events need not repeat; decision evidence must remain auditable.'};
}

export function eventOpportunityCurriculum(){return {
 version:1,reviewedAt:'2026-10-11',status:'knowledge-added-assessment-pending',expertiseProven:false,liveAuthorized:false,
 principle:'A unique event may be a valid hypothesis. Reproducibility applies to evidence available at the decision and the evaluation procedure, not to recurrence of the event. Novelty alone is not an edge.',
 sources:[
 {url:'https://www.nber.org/papers/w8959',access:'Indexed author abstract excerpt reviewed; direct page returned 403; full paper not reviewed',lesson:'Announcement surprise is the difference between expectations and realization. The indexed FX study links surprises with price jumps; it does not establish an executable Obolus strategy.'},
 {url:'https://www.nber.org/papers/w29939',access:'Indexed abstract excerpt reviewed; direct page returned 403; full paper not reviewed',lesson:'Pre-announcement information can explain part of measured policy surprises. Separate news impact from prior expectations and concurrent information.'},
 {url:'https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins/investor-5',access:'2021 SEC investor bulletin read; US stock context',lesson:'Information reliability and ability to trade remain material around suspensions; do not infer automatic executable exit or recovery from a suspension ending.'},
 {url:'https://www.cmegroup.com/articles/faqs/market-by-order-mbo.html',access:'Order identity and priority sections previously reviewed; CME-specific',lesson:'Queue priority and executable size cannot be inferred from a candle touch or an aggregated headline price.'}
 ],
 modules:[
 {topic:'Event identity',practice:'Record public primary URL, issuer, instrument, original publication time, receipt time, processing time and revision. Detect recycled headlines and corrections. Syndicated copies count as one origin, not independent corroboration.'},
 {topic:'Surprise and mechanism',practice:'Store the prior consensus with its timestamp. Explain the causal link from new information to the traded instrument, competing explanations and whether the price already reflects it. No invented consensus or causal certainty.'},
 {topic:'Opportunity expiry',practice:'Separate event, receipt, processing, decision and execution clocks. Use a bounded time-to-live plus a price-chase limit. Cancel the thesis when either expires; a lost opportunity is an acceptable outcome.'},
 {topic:'Execution economics',practice:'Use executable bid/ask, available size, fees, slippage, cancellation and settlement constraints. For cross-venue spreads include both legs, prefunded balances, legging and transfer risk. A displayed spread is not guaranteed arbitrage.'},
 {topic:'Uncertainty',practice:'Use explicitly justified scenario ranges; a model confidence score is not a calibrated win probability. Evaluate reversal, correction, no fill, partial fill and inability to exit. Positive expected value does not override a loss limit.'},
 {topic:'Limited evidence',practice:'Borrow only relevant mechanisms from analogous events and disclose regime differences. Preserve prospective decisions for all candidates, including rejected ones. Avoid hindsight-only event selection and missing-event survivorship bias.'},
 {topic:'Action discipline',practice:'Prepare evidence and paper plans ahead of time. Risk, account, halt and freshness controls stay independent of narrative urgency. Model a smaller size only when it resolves an economic constraint; small size cannot authenticate false news.'},
 {topic:'After-action learning',practice:'Separate prediction quality, fill quality and realized outcome. A profitable mistake remains a process error; a loss does not by itself refute a sound probabilistic decision. Update calibration on recorded cases, not on selected winners.'}
 ],
 assessment:{status:'not-administered',requiredCases:['Old headline republished now','Positive scenario value but stale quote','Multiple articles with one common source','Correct news already priced in','Cross-venue spread without executable second leg','Fresh unique event within assumptions','Unexpected halt and inaccessible exit'],
 grading:'Must identify decisive missing evidence, action expiry and invalidation before observing the outcome; must not equate an offline pass with live authorization.'},
 diagnostic:{tool:'paper_event_opportunity_audit',purpose:'Tests consistency and two-outcome arithmetic on supplied scenarios only.',units:'All amount fields are total-position amounts in one quote currency. Times are milliseconds on one normalized clock (0 to 1e12).',
 fields:'eventId, sourceUrl (HTTPS), invalidation, exitRule, probabilityBasis; decisionMs,publishedMs,receivedMs,processedMs,expiresMs,quoteMs,maxQuoteAgeMs,executionLatencyMs; gainIfRight,lossIfWrong,roundTripCost,stressedRoundTripCost,probabilityLow,probabilityHigh,stressLoss,lossBudget; sourceChecked,publicInformation,conflictingEvidence,halted,depthSufficient,exitAvailable.',
 limits:'No automatic news collector, source authentication, probability calibration or order execution. Boolean inputs are claims, not verification. A two-outcome model omits complex tails.'},
 workedExample:{kind:'synthetic-worked-example',gain:12,loss:8,cost:1,probabilityRange:[0.45,0.65],expectedRange:[0,4],stressLoss:15,stressCost:2,stressedLowerExpected:-4.85,
 conclusion:'Optimistic value is positive, but the lower bound and stressed case do not justify promotion. The event can be unique; the rejection follows the assumptions, not its uniqueness.'}
};}
