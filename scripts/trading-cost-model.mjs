// Research scenarios in R, not confirmed account-currency expenses or fills.
export function estimateResearchCosts({row,side,entry,stop,profile,now=Date.now()}={}){
 const result={verified:false,slippageMeasured:false,extraR:null,stressExtraR:null,commissionR:null,financingReserveR:null,missing:[],source:'https://admiralmarkets.com/products/fees-and-charges',swapSource:'https://admirals.freshdesk.com/en/support/solutions/articles/201000071644-how-to-calculate-swap-',assumptions:['Published Trade.MT5 standard tariff; individual account applicability and swap-free/admin-fee regime unconfirmed.','Spread already included in bid/ask; extra slippage is a scenario, not observed execution.','Reserve three charged swap days even for two-hour observations; positive swap credits ignored. Current rates are not historical rates.','For current-price interest swaps, entry price is a projection proxy, not the unknown later rollover price or a guaranteed upper bound. R is measured in product profit-currency risk units, not confirmed account-currency cash charges.']};
 const t=row?.costTerms,d=Math.abs(entry-stop),positive=x=>Number.isFinite(x)&&x>0;
 if(!['BUY','SELL'].includes(side)||![entry,stop,d,row?.volumeMin,t?.contractSize].every(positive)||!Number.isFinite(now)||!Number.isFinite(t?.observedAt)||now-t.observedAt>60000||t.observedAt>now+1000||!Number.isFinite(row?.bid)||!Number.isFinite(row?.ask)||row.bid<=0||row.ask<row.bid){result.missing.push('fresh-valid-contract-and-prices');return result;}
 const units=t.contractSize*row.volumeMin,risk=units*d,spread=row.ask-row.bid;
 const forex=t.path?.startsWith('Forex\\'),us=t.path?.startsWith('Stock CFDs\\US ')&&t.profitCurrency==='USD';
 if(profile?.accountType!=='Trade.MT5'||(!forex&&!us)||!(/^[A-Z]{3}$/).test(t.profitCurrency??'')){result.missing.push('product-tariff-classification');return result;}
 result.currency=t.profitCurrency;result.commissionR=forex?0:2*Math.max(1,.02*units)/risk;
 const rate=t[side==='BUY'?'swapLong':'swapShort'],debit=Math.max(0,-rate);
 if(!Number.isFinite(rate))result.missing.push('swap-rate');
 else if(t.swapMode===0)result.financingReserveR=0;
 else if(t.swapMode===1&&positive(t.point))result.financingReserveR=3*units*debit*t.point/risk;
 else if([5,6].includes(t.swapMode))result.financingReserveR=3*units*debit*entry/36000/risk;
 else result.missing.push('swap-mode-or-currency-conversion');
 if(us)result.missing.push('settlement-conversion-and-dividends');
 result.slippageR=spread/d;result.stressSlippageR=2*spread/d;
 const total=result.commissionR+result.financingReserveR+result.slippageR;
 if(!result.missing.length&&[risk,total,result.stressSlippageR].every(Number.isFinite)&&risk>0){result.extraR=total;result.stressExtraR=result.commissionR+2*result.financingReserveR+result.stressSlippageR;}
 return result;
}
