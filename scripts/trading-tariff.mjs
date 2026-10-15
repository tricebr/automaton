import {readFileSync} from 'node:fs';
const profileUrl=new URL('../docs/trading/account-cost-profile.json',import.meta.url);
// Research estimates only. Published tariffs never attest fills or full costs.
export function tariffSummary(){
 const p=JSON.parse(readFileSync(profileUrl,'utf8'));
 return {...p,conflicts:p.publishedSchedule?.conflicts??[],liveAuthorized:false};
}
export function estimateCommission({region,units,price}={}){
 if(!Number.isFinite(units)||units<=0||!Number.isFinite(price)||price<=0)return null;
 const r=tariffSummary().publishedSchedule?.commissionsPerSide?.[region];if(!r)return null;
 const amount=Math.max(r.minimum,(r.basis==='units'?units:units*price)*r.rate);
 if(!Number.isFinite(amount))return null;
 return {amount,currency:r.currency,perSide:true,actual:false};
}
// Call only for an eligible individual stock/ETF CFD settlement component.
export function conversionCharge({settlementAmount,fxRate,from,to}={}){
 if(!Number.isFinite(settlementAmount)||!Number.isFinite(fxRate)||fxRate<=0||!/^[A-Z]{3}$/.test(from??'')||!/^[A-Z]{3}$/.test(to??''))return null;
 if(from===to||settlementAmount===0)return 0;
 const r=tariffSummary().publishedSchedule.conversion;
 const value=Math.abs(settlementAmount)*fxRate*r.rate;
 return Number.isFinite(value)?Math.max(r.minimumAccountCurrency,value):null;
}
