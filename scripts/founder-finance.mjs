import {readStripeTransactions} from './stripe-account-check.mjs';
export function createFounderFinanceAdapter({file,read}={}){
 return {available:!!file||!!read,reason:file||read?null:'Kein verbundener lesender Stripe-Zugang.',maxCostRappen:0,retrySafe:true,
 async execute({signal,assertActive}){assertActive();const r=await (read?read({signal}):readStripeTransactions(file,{signal,windowDays:732}));assertActive();return {kind:'finance-report',...reconcileFounderFinance(r)};},
 verify:r=>r?.kind==='finance-report'&&['reconciled-provider','partial'].includes(r.status)&&typeof r.coverage?.complete==='boolean'&&r.confirmedBankReceipt===false};
}
export function reconcileFounderFinance({transactions,coverage}){
 if(!Array.isArray(transactions)||transactions.length>1000)throw Error('Invalid financial evidence');
 const seen=new Map(),currencies={},unknown=[],bookings=[];
 for(const t of transactions){
  if(!/^txn_[\w]+$/.test(t.id??'')||!['amount','fee','net','created'].every(k=>Number.isSafeInteger(t[k]))||t.net!==t.amount-t.fee||!/^[a-z]{3}$/.test(t.currency))throw Error('Invalid transaction');
  const payload=JSON.stringify([t.type,t.amount,t.fee,t.net,t.currency,t.created]);if(seen.has(t.id)){if(seen.get(t.id)!==payload)throw Error('Conflicting transaction');continue;}seen.set(t.id,payload);bookings.push(Object.fromEntries(['id','type','amount','fee','net','currency','created'].map(k=>[k,t[k]])));
  const c=currencies[t.currency]??={receiptsMinor:0,refundsMinor:0,feesMinor:0,payoutsMinor:0,balanceMovementMinor:0};
  c.feesMinor+=t.fee;c.balanceMovementMinor+=t.net;
  if(['charge','payment'].includes(t.type)&&t.amount>=0)c.receiptsMinor+=t.amount;
  else if(['refund','payment_refund'].includes(t.type)&&t.amount<=0)c.refundsMinor-=t.amount;
  else if(t.type==='payout'&&t.amount<=0)c.payoutsMinor-=t.amount;
  else if(t.type==='stripe_fee'&&t.amount<=0)c.feesMinor-=t.amount;
  else unknown.push({id:t.id,type:t.type});
 }
 return {status:coverage?.complete===true?'reconciled-provider':'partial',observedAt:new Date().toISOString(),coverage,transactions:bookings,currencies,count:seen.size,unknown,confirmedBankReceipt:false,netProfit:null,scope:'Stripe-Kontobewegungen; keine Zuordnung zu Aufträgen, kein bestätigter Bankeingang und kein Gesamtgewinn.'};
}
