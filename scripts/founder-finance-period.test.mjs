import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreFinancePeriod,saveFinancePeriod} from '../web/founder/finance-refresh.mjs';
test('chosen period survives reload and invalid stored periods use week',()=>{
 const values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
 assert.equal(restoreFinancePeriod(storage),'week');
 for(const period of ['today','week','month','year','all']){assert.equal(saveFinancePeriod(storage,period),true);assert.equal(restoreFinancePeriod(storage),period);}
 assert.equal(saveFinancePeriod(storage,'invalid'),false);assert.equal(restoreFinancePeriod({getItem:()=> 'invalid'}),'week');
});
test('blocked browser storage does not break finance updates',()=>{
 const storage={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};
 assert.equal(restoreFinancePeriod(storage),'week');assert.equal(saveFinancePeriod(storage,'week'),false);
});
