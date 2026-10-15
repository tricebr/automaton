/** Founder planning rule. Historical cash accounting is not rewritten. */
export const PERSONNEL_COST_POLICY = Object.freeze({
  personnelCostsIncluded: false,
  imputedHourlyRateCents: 0,
  instruction: 'Do not budget or include employee/personnel costs, salaries, human labour charges or imputed Founder time in opportunity, product, pricing or profitability forecasts. Never apply a CHF 35/hour rate. Delivery, acquisition, support and operating allowances must contain non-personnel costs only. Report necessary human intervention in minutes, without monetary valuation. This planning rule does not authorize spending or deletion of actual ledger entries.',
});

export function assertNoPersonnelCostInputs(plan: unknown): void {
  const seen=new WeakSet<object>();let nodes=0;
  const forbidden=/personnel|employee|salary|salaries|payroll|labou?r|hourlyrate|staffcost|humancost|foundercost|personalkosten|mitarbeiterkosten|stundenlohn|stundensatz/;
  const normalize=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[\s_-]/g,'');
  const visit=(value:unknown,depth:number):void=>{
    if(!value||typeof value!=='object')return;
    if(depth>30||++nodes>10000||seen.has(value))throw new Error('Invalid cyclic or oversized economic cost input');
    seen.add(value);
    for(const [key,item] of Object.entries(value)){
      const normalized=normalize(key);
      if(forbidden.test(normalized)||(['category','costtype','costcategory'].includes(normalized)&&typeof item==='string'&&forbidden.test(normalize(item))))
        throw new Error('Personnel costs and hourly rates are not permitted in forecasts; report humanInterventionMinutes only');
      visit(item,depth+1);
    }
    seen.delete(value);
  };
  visit(plan,0);
}
