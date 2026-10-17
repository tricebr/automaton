import test from 'node:test';
import assert from 'node:assert/strict';
import {periodRange, financialSummary, workGroups, founderControls} from '../web/founder/model.mjs';

test('self-directed overview asks only for explicit personal exceptions and preserves technical issues',()=>{
 const s={autonomy:{autonomyContract:{mode:'self-directed',exceptions:[{taskId:'technical',requiresHuman:false},{taskId:'personal',requiresHuman:true}]},tasks:[{id:'technical',status:'failed'},{id:'personal',status:'failed'}]},operations:{tasks:[{id:'legacy',status:'review'}]},products:[{available:true,reviewed:false}]};
 const g=workGroups(s);assert.deepEqual(g.attention.map(t=>t.id),['personal']);assert.deepEqual(g.managedIssues.map(t=>t.id),['technical']);assert.deepEqual(g.legacy.map(t=>t.id),['legacy']);assert.equal(g.checks.length,1);
 assert.deepEqual(founderControls('running').map(x=>x[0]),['pause','stop','emergency-stop']);assert.deepEqual(founderControls('emergency_stopped').map(x=>x[0]),['start']);
});

test('Zurich periods use local midnight, inclusive seven days and rolling month/year',()=>{
 const now=Date.parse('2026-10-13T10:00:00Z');
 assert.deepEqual(periodRange('today',now),{from:'2026-10-13',to:'2026-10-13'});
 assert.deepEqual(periodRange('week',now),{from:'2026-10-07',to:'2026-10-13'});
 assert.deepEqual(periodRange('month',now),{from:'2026-09-13',to:'2026-10-13'});
 assert.deepEqual(periodRange('year',now),{from:'2025-10-13',to:'2026-10-13'});
 assert.equal(periodRange('today',Date.parse('2026-10-12T22:30:00Z')).from,'2026-10-13');
});
test('metrics and attention use the same exact task subsets',()=>{
 const s={autonomy:{tasks:[{id:'a',status:'running'},{id:'b',status:'failed'},{id:'c',status:'done'}]},operations:{tasks:[{id:'d',status:'review'},{id:'e',status:'blocked'}]},products:[{id:'p',available:true,reviewed:false},{id:'q',available:false}]};
 const g=workGroups(s);assert.deepEqual(g.active.map(t=>t.id),['a']);assert.deepEqual(g.attention.map(t=>t.id),['b','d','e']);assert.equal(g.checks.length,4);assert.equal(g.results.length,2);
});
test('financial summary dates and separates currencies, refunds, payouts, reservations and incomplete profit',()=>{
 const created=Math.floor(Date.parse('2026-10-13T10:00Z')/1000);
 const tx=(id,type,amount,fee=0,currency='chf')=>({id,type,amount,fee,net:amount-fee,currency,created});
 const s={financeReport:{transactions:[tx('a','charge',10000,300),tx('b','refund',-1000),tx('c','payout',-5000),tx('d','charge',500,0,'usd')],coverage:{complete:true,from:created-86400,to:created+86400}},autonomy:{budget:{entries:[{day:'2026-10-13',actualCostRappen:200,maxCostRappen:300},{day:'2026-10-13',actualCostRappen:null,maxCostRappen:500}]}}};
 const r=financialSummary(s,'today',created*1000);assert.equal(r.currencies.chf.receiptsMinor,10000);assert.equal(r.currencies.chf.refundsMinor,1000);assert.equal(r.currencies.chf.feesMinor,300);assert.equal(r.costMinor,200);assert.equal(r.reservedMinor,500);assert.equal(r.knownNetMinor,8500);assert.equal(r.profitMinor,null);assert.equal(r.currencies.usd.receiptsMinor,500);
 assert.equal(financialSummary({...s,financeReport:undefined},'today',created*1000).receiptsMinor,null);
 assert.equal(financialSummary(s,'year',created*1000).receiptsMinor,null);
});

test('legacy aggregates never become zero revenue, and truncated cost journals cannot establish a total',()=>{
 const now=Date.parse('2026-10-13T10:00Z'),coverage={complete:true,from:Math.floor(now/1000)-10*86400,to:Math.floor(now/1000)};
 assert.equal(financialSummary({financeReport:{currencies:{chf:{receiptsMinor:100}},coverage}},'today',now).receiptsMinor,null);
 assert.equal(financialSummary({financeReport:{transactions:[],coverage},autonomy:{budget:{entries:[],entriesComplete:false}}},'today',now).costMinor,null);
});
