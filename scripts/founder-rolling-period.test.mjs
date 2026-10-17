import test from 'node:test';
import assert from 'node:assert/strict';
import {periodRange,financialSummary} from '../web/founder/model.mjs';
import {restoreFinancePeriod,saveFinancePeriod} from '../web/founder/finance-refresh.mjs';
test('rolling Zurich dates include today and clamp short months and leap years',()=>{
 const at=Date.parse('2026-10-17T10:00:00Z');
 assert.deepEqual(periodRange('month',at),{from:'2026-09-17',to:'2026-10-17'});
 assert.deepEqual(periodRange('year',at),{from:'2025-10-17',to:'2026-10-17'});
 assert.deepEqual(periodRange('week',at),{from:'2026-10-11',to:'2026-10-17'});
 assert.equal(periodRange('month',Date.parse('2024-03-31T10:00:00Z')).from,'2024-02-29');
 assert.equal(periodRange('year',Date.parse('2024-02-29T10:00:00Z')).from,'2023-02-28');
 assert.equal(periodRange('month',Date.parse('2026-10-16T22:30:00Z')).to,'2026-10-17');
});
test('since beginning includes oldest recorded evidence without certifying complete history',()=>{
 const s={financeBeginningDay:'2024-01-02',financeReport:{transactions:[]},financeLedger:{entries:[{kind:'income',day:'2024-01-02',amount:100},{kind:'income',day:'2026-10-16',amount:200}]}};
 const r=financialSummary(s,'all',Date.parse('2026-10-17T10:00:00Z'));
 assert.equal(r.from,'2024-01-02');assert.equal(r.knownReceiptsMinor,300);assert.equal(r.reconciled,false);
 const values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
 assert.equal(saveFinancePeriod(storage,'all'),true);assert.equal(restoreFinancePeriod(storage),'all');
});
