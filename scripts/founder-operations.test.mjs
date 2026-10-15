import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openFounderOperations,boundedReader,readFounderReports} from './founder-operations.mjs';
import {createFounderStore,startFounderDashboard} from './founder-dashboard.mjs';
test('current nested monitor schema preserves fetch failures and checked_at',()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'reports-')),dir=path.join(base,'artifacts/order-monitor-20261013-0954');fs.mkdirSync(dir,{recursive:true});
 try{fs.writeFileSync(path.join(dir,'completion.json'),JSON.stringify({checked_at:'2026-10-13T09:56:54Z',prs:[{status:'fulfilled',value:{repo:'Specula-Labs/specula-api',n:23,state:'closed',merged:true,error:false}},{status:'rejected',reason:'network'}]}));const r=readFounderReports(base,Date.parse('2026-10-13T10:00:00Z')).orders;assert.equal(r.status,'partial');assert.equal(r.prs.length,1);assert.equal(r.prs[0].merged,true);assert.equal(r.failedFetches,1);assert.equal(r.at,'2026-10-13T09:56:54Z');}finally{fs.rmSync(base,{recursive:true,force:true});}
});

test('work and version reviews survive restart; stale revisions and evidence-free completion rejected',()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'numaron-'));let ops;
 try{
  fs.mkdirSync(path.join(base,'products'));fs.writeFileSync(path.join(base,'products/angebotscheck-v1.md'),'Evidence');
  ops=openFounderOperations(path.join(base,'operations.db'));let store=createFounderStore(base,ops);
  const product=store.snapshot().products[0];store.review({id:product.id,digest:product.digest});
  const id=ops.task({action:'create',title:'A real manual workflow'});
  const move=(revision,status,result='')=>ops.task({action:'transition',id,revision,status,result});
  move(0,'working');assert.throws(()=>move(0,'review','Old tab'));
  assert.throws(()=>move(1,'done','Skip review'));assert.throws(()=>move(1,'review'));
  move(1,'review','Checked local output');move(2,'done','Reviewed output');
  ops.close();ops=openFounderOperations(path.join(base,'operations.db'));store=createFounderStore(base,ops);
  assert.equal(store.snapshot().products[0].reviewed,true);assert.equal(ops.snapshot().tasks[0].status,'done');
  fs.writeFileSync(path.join(base,'products/angebotscheck-v1.md'),'Changed evidence');assert.equal(store.snapshot().products[0].reviewed,false);
  assert.equal(ops.snapshot().executionEnabled,false);assert.equal(ops.snapshot().budget.authorizedSpend,0);
 }finally{ops?.close();fs.rmSync(base,{recursive:true,force:true});}
});

test('hung provider cannot block forever or accumulate overlapping requests',async()=>{
 let calls=0,resolve;const reader=boundedReader(()=>{calls++;return new Promise(r=>{resolve=r;});},15);
 assert.equal((await reader()).reason,'timeout');assert.equal((await reader()).reason,'timeout');assert.equal(calls,1);
 resolve({observedAt:new Date().toISOString()});await new Promise(r=>setImmediate(r));
 assert.equal((await reader()).reason,'timeout');assert.equal(calls,2);resolve({});
});

test('unavailable and stale report evidence never appears current',()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'numaron-'));
 try{assert.equal(readFounderReports(base).orders.status,'unavailable');
  fs.mkdirSync(path.join(base,'artifacts/order-monitor-20260101-0000'),{recursive:true});
  fs.writeFileSync(path.join(base,'artifacts/order-monitor-20260101-0000/completion.json'),JSON.stringify({at:'2026-01-01T00:00:00Z',prs:[]}));
  assert.equal(readFounderReports(base,Date.parse('2026-10-12')).orders.status,'stale');
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});

test('task writes require session and CSRF and persist through HTTP workflow',async()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'numaron-'));const ops=openFounderOperations(path.join(base,'ops.db'));
 const ui=await startFounderDashboard({store:createFounderStore(base,ops)});
 try{
  const post=(route,body,headers={})=>fetch(ui.url+route,{method:'POST',headers:{Origin:ui.url,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await post('/api/task',{action:'create',title:'Test'})).status,401);
  const login=await post('/api/session',{token:new URL(ui.loginUrl).hash.slice(1)});const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
  assert.equal((await post('/api/task',{action:'create',title:'Test'},{Cookie:cookie})).status,403);
  assert.equal((await post('/api/task',{action:'create',title:'Test'},{Cookie:cookie,'X-Obolus-CSRF':csrf})).status,200);
  assert.equal(ops.snapshot().tasks.length,1);
 }finally{await ui.close();ops.close();fs.rmSync(base,{recursive:true,force:true});}
});


test('current summary-only monitor is a partial report, never fabricated PR or payment evidence',()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'summary-monitor-')),dir=path.join(base,'artifacts/order-monitor-20261015-1726');fs.mkdirSync(dir,{recursive:true});
 try{fs.writeFileSync(path.join(dir,'completion.json'),JSON.stringify({checkedAt:'2026-10-15T17:33:51Z',github:{tracked:25,newComments:0,stateChanges:0},newSubmissions:0}));const r=readFounderReports(base,Date.parse('2026-10-15T18:00:00Z')).orders;assert.equal(r.status,'partial');assert.equal(r.at,'2026-10-15T17:33:51Z');assert.deepEqual(r.prs,[]);assert.equal(r.summaryOnly,true);assert.match(r.payments,/nicht.*bestätigt/);
 fs.writeFileSync(path.join(dir,'completion.json'),JSON.stringify({checkedAt:'not-a-date',github:{tracked:25,newComments:0,stateChanges:0}}));assert.equal(readFounderReports(base).orders.status,'unavailable');
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
