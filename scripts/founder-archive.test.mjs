import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openFounderController} from './founder-controller.mjs';
import {openFounderBudget} from './founder-budget.mjs';
import {startFounderDashboard} from './founder-dashboard.mjs';

test('archive persists verified completed jobs beyond the live snapshot and pages without duplicates',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'founder-archive-')),file=path.join(dir,'controller.db'),budget=openFounderBudget(path.join(dir,'budget.db'));
 budget.activate({startAt:Date.now()-100,authorizationRef:'archive-test'});
 const adapters={local:{maxCostRappen:0,execute:async()=>({summary:'Verified local result'}),verify:()=>true}};
 let c=openFounderController({file,budget,adapters});
 try{
  for(let i=0;i<146;i++)c.enqueue({id:'done-'+i,rootTaskId:'done-'+i,kind:'local',input:{title:'Completed '+i},dependencies:[],resources:[]});
  c.enqueue({id:'waiting',rootTaskId:'waiting',kind:'local',input:{notBefore:Date.now()+86400000},dependencies:[],resources:[]});
  c.control('start');for(let i=0;i<37;i++)await c.tick();
  assert.equal(c.snapshot().tasks.length,100);
  const budgetBefore=JSON.stringify(budget.snapshot()),ids=[];let cursor=null;
  do{const page=c.archive({limit:17,cursor});assert.equal(page.total,146);assert.ok(page.items.every(t=>t.status==='done'&&t.digest));ids.push(...page.items.map(t=>t.id));cursor=page.nextCursor;}while(cursor);
  assert.equal(ids.length,146);assert.equal(new Set(ids).size,146);assert.ok(!ids.includes('waiting'));assert.equal(JSON.stringify(budget.snapshot()),budgetBefore);
  for(const args of [{limit:0},{limit:51},{cursor:'invalid'},{cursor:'-1:task'},{cursor:'1:../../file'},{unexpected:true}])assert.throws(()=>c.archive(args));
  await c.close();c=openFounderController({file,budget,adapters});assert.equal(c.archive().total,146);assert.deepEqual(c.result(ids[0]),{summary:'Verified local result'});
 }finally{await c.close();budget.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('archive HTTP route requires private session and never starts work',async()=>{
 let reads=0;const ui=await startFounderDashboard({readUsage:async()=>({status:'unavailable'}),autonomy:{archive(input){reads++;assert.deepEqual(input,{limit:2,cursor:null});return {items:[],total:0,nextCursor:null};}}});
 try{
  assert.equal((await fetch(ui.url+'/api/archive?limit=2')).status,401);assert.equal(reads,0);
  const login=await fetch(ui.url+'/api/session',{method:'POST',headers:{Origin:ui.url,'Content-Type':'application/json'},body:JSON.stringify({token:new URL(ui.loginUrl).hash.slice(1)})});const cookie=login.headers.get('set-cookie').split(';')[0];
  const response=await fetch(ui.url+'/api/archive?limit=2',{headers:{Cookie:cookie}});assert.equal(response.status,200);assert.equal((await response.json()).archive.total,0);assert.equal(reads,1);
  const invalid=await fetch(ui.url+'/api/archive?unknown=value',{headers:{Cookie:cookie}});assert.equal(invalid.status,400);assert.equal(reads,1);
 }finally{await ui.close();}
});
