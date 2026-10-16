import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import Database from 'better-sqlite3';
import {createFounderResearch} from './founder-research.mjs';
import {openFounderController} from './founder-controller.mjs';
import {openFounderBudget} from './founder-budget.mjs';

const repo='Specula-Labs/specula-api';
const source={url:'https://github.com/Specula-Labs/specula-api/pull/23',claim:'Public contribution',privacy:'public'};
const task={id:'selected-specula',rootTaskId:'root',kind:'research',input:{title:repo+': Bounty-, Payment- und Funding-Hinweise prüfen',consolidatedResearch:[{input:{title:'README und CONTRIBUTING prüfen'}},{input:{title:'Issues, Discussions und Org-Profil prüfen'}}]},dependencies:['prior'],resources:['research']};
const context=()=>({task:structuredClone(task),dependencies:[{sources:[source]}],signal:new AbortController().signal,assertActive(){},grant:{reservationId:'fake',maxCostRappen:0}});
function fixture(request){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'targeted-research-'));let clock=Date.now();const a=createFounderResearch({directory:path.join(dir,'research'),request,now:()=>clock});const db=new Database(path.join(dir,'research/research.db'));return {a,db,dir,advance:ms=>clock+=ms,close(){a.close();db.close();fs.rmSync(dir,{recursive:true,force:true});}};}
function transport(calls,{status=200}={}){return async(input,init)=>{
 const u=new URL(input);calls.push(u.href);assert.equal(init.method,'GET');assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.equal(new Headers(init.headers).has('authorization'),false);
 if(status!==200)return new Response('{}',{status,headers:{'retry-after':'1800'}});
 if(u.hostname==='github.com')return new Response('<html><body>Discussions: bounty policy</body></html>');
 if(u.pathname==='/repos/'+repo)return Response.json({full_name:repo,private:false,has_discussions:true});
 if(u.pathname==='/users/Specula-Labs')return Response.json({login:'Specula-Labs',bio:'Public organisation',html_url:'https://github.com/Specula-Labs'});
 if(u.pathname.endsWith('/issues'))return Response.json([{number:4,html_url:'https://github.com/'+repo+'/issues/4',title:'Bounty policy',body:'No payment promise',state:'open'}]);
 if(u.pathname.includes('CONTRIBUTING'))return new Response('{}',{status:404});
 const p=u.pathname.endsWith('/readme')?'README.md':u.pathname.split('/contents/')[1];
 const r=u.pathname.includes('/.github/contents/')?'Specula-Labs/.github':repo;
 return Response.json({type:'file',encoding:'base64',path:p,size:25,content:Buffer.from('Funding is not escrow.').toString('base64'),html_url:'https://github.com/'+r+'/blob/main/'+p});
};}

test('concrete Specula task reads only its evidenced repository and preserves both merged goals',async()=>{
 const calls=[],f=fixture(transport(calls));try{
  const r=await f.a.execute(context());assert.equal(r.target,repo);assert.equal(r.researchGoal,task.input.title);assert.equal(r.requestedChecks.length,2);
  assert.ok(calls.includes('https://api.github.com/repos/Specula-Labs/specula-api/readme'));
  assert.ok(calls.includes('https://github.com/Specula-Labs/specula-api/discussions'));
  assert.ok(calls.every(u=>u.startsWith('https://api.github.com/repos/Specula-Labs/')||u==='https://api.github.com/users/Specula-Labs'||u==='https://github.com/'+repo+'/discussions'));
  assert.equal(r.sources.some(s=>s.url.includes('ycombinator')),false);assert.ok(f.a.verify(r));
  assert.equal(r.checks.paymentConfirmed,false);assert.equal(r.checks.coverageComplete,false);
  assert.equal(r.coverage.find(c=>c.area==='contributing').status,'not_found');
  assert.equal(f.db.prepare('SELECT count(*) n FROM online_requests').get().n,calls.length);
  assert.equal(f.db.prepare('SELECT count(*) n FROM online_jobs').get().n,0);
 }finally{f.close();}
});

test('targeted waits are repository-specific, survive reopen and never reuse the generic topic pause',async()=>{
 const calls=[],f=fixture(transport(calls));try{
  assert.equal(typeof f.a.waitStateFor,'function');assert.equal(f.a.waitStateFor(context()),null);
  await f.a.execute(context());const w=f.a.waitStateFor(context());assert.equal(w.code,'target_cooldown');assert.ok(w.until>Date.now()+23*3600000);
  const reopened=createFounderResearch({directory:path.join(f.dir,'research'),request:transport(calls)});try{assert.equal(reopened.waitStateFor(context()).until,w.until);}finally{reopened.close();}
  const count=calls.length;await assert.rejects(f.a.execute(context()),/wait|pause|cooldown/i);assert.equal(calls.length,count);
  const other=context();other.task.input.title='Other-Labs/other: Payment prüfen';other.dependencies=[{sources:[{url:'https://github.com/Other-Labs/other/pull/1'}]}];assert.equal(f.a.waitStateFor(other),null);
  f.advance(86400000);assert.equal(f.a.waitStateFor(context()),null);
 }finally{f.close();}
});

test('unbound/private targets and planned work cannot fall back to unrelated market research',async()=>{
 const calls=[],f=fixture(transport(calls));try{
  for(const deps of [[],[{privacy:'private',sources:[source]}],[{sources:[{...source,privacy:'private'}]}],[{sources:[{url:'https://github.com/Other/repo/issues/1'}]}]]){
   const ctx=context();ctx.dependencies=deps;await assert.rejects(f.a.execute(ctx));
  }
  const ctx=context();ctx.task.input.notBefore=Date.now()+3600000;await assert.rejects(f.a.execute(ctx));
  assert.equal(calls.length,0);
 }finally{f.close();}
});

test('payment hints beyond a long introduction remain in the bounded evidence excerpt',async()=>{
 const base=transport([]),f=fixture(async(input,init)=>{
  if(new URL(input).pathname.endsWith('/readme')){const content='Introduction '.repeat(500)+' Maintainer policy: bounty USD 1000 only after agreed acceptance.';return Response.json({type:'file',encoding:'base64',path:'README.md',size:Buffer.byteLength(content),content:Buffer.from(content).toString('base64'),html_url:'https://github.com/'+repo+'/blob/main/README.md'});}
  return base(input,init);
 });
 try{const r=await f.a.execute(context()),s=r.sources.find(s=>s.url.endsWith('/README.md')&&s.url.includes('/specula-api/'));assert.match(s.claim,/bounty USD 1000/);assert.ok(s.claim.length<=4000);assert.equal(s.truncated,true);assert.equal(r.checks.paymentConfirmed,false);}finally{f.close();}
});

test('shared source quota prevents a targeted run before any request or attempt is consumed',async()=>{
 const calls=[],f=fixture(transport(calls));try{
  f.db.prepare("INSERT INTO online_requests(source,status) VALUES('api.github.com','received')").run();
  for(let i=0;i<50;i++)f.db.prepare("INSERT INTO online_requests(source,status) VALUES('api.github.com','received')").run();
  assert.equal(f.a.waitStateFor(context()).code,'source_quota');await assert.rejects(f.a.execute(context()));assert.equal(calls.length,0);
 }finally{f.close();}
});

test('rate limiting pauses the same target for provider Retry-After without broad fallback',async()=>{
 const calls=[],f=fixture(transport(calls,{status:429}));try{
  await assert.rejects(f.a.execute(context()));assert.equal(calls.length,1);
  const w=f.a.waitStateFor(context());assert.equal(w.code,'target_retry');assert.ok(w.until>Date.now()+29*60000);
  await assert.rejects(f.a.execute(context()));assert.equal(calls.length,1);f.advance(1800000);assert.equal(f.a.waitStateFor(context()),null);
 }finally{f.close();}
});

test('even a successful HTTP status with Retry-After defers the target, rather than treating it as source evidence',async()=>{
 const calls=[],f=fixture(async()=>{calls.push('read');return new Response('{}',{status:200,headers:{'retry-after':'7200'}});});
 try{await assert.rejects(f.a.execute(context()));assert.ok(f.a.waitStateFor(context()).until>Date.now()+119*60000);assert.equal(calls.length,1);}finally{f.close();}
});

test('permanent access failure waits for review and cannot be retried by the generic free-read retry loop',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return new Response('{}',{status:401});});
 try{await assert.rejects(f.a.execute(context()));f.advance(86400000);assert.equal(f.a.waitStateFor(context()).code,'target_review');assert.ok(f.a.nextReadyAtFor(context())>Date.now());await assert.rejects(f.a.execute(context()));assert.equal(calls,1);}finally{f.close();}
});

test('provider restriction on HTTP 403 expires at Retry-After instead of becoming a permanent access block',async()=>{
 const f=fixture(transport([],{status:403}));try{await assert.rejects(f.a.execute(context()));assert.equal(f.a.waitStateFor(context()).code,'target_retry');f.advance(1800000);assert.equal(f.a.waitStateFor(context()),null);}finally{f.close();}
});

test('an aborted targeted run performs no further reads and waits for review',async()=>{
 const abort=new AbortController();let calls=0;const f=fixture(async()=>{calls++;abort.abort();return Response.json({full_name:repo,private:false});});
 try{const ctx=context();ctx.signal=abort.signal;await assert.rejects(f.a.execute(ctx));assert.equal(calls,1);assert.equal(f.a.waitStateFor(context()).code,'target_review');}finally{f.close();}
});

test('controller uses task-specific readiness for claim and dashboard, keeping dependencies and notBefore',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'target-controller-'));const budget=openFounderBudget(path.join(dir,'budget.db'));budget.activate({startAt:Date.now()-1000,authorizationRef:'isolated-test'});let calls=0;
 const a={maxCostRappen:0,nextReadyAt:Date.now()+86400000,waitState:{code:'generic',reason:'Generic pause',checkAt:Date.now()+60000},nextReadyAtFor:()=>0,waitStateFor:()=>null,execute:async()=>{calls++;return {ok:true};},verify:()=>true};
 const c=openFounderController({file:path.join(dir,'controller.db'),budget,adapters:{research:a}});
 try{
  c.enqueue({...task,id:'ready',dependencies:[]});c.enqueue({...task,id:'future',dependencies:[],input:{notBefore:Date.now()+3600000}});c.enqueue({...task,id:'dependency',dependencies:['missing']});
  c.control('start');assert.equal(c.snapshot().tasks.find(t=>t.id==='ready').waitState.code,'worker');await c.tick();
  assert.equal(calls,1);assert.equal(c.snapshot().tasks.find(t=>t.id==='ready').status,'done');assert.equal(c.snapshot().tasks.find(t=>t.id==='future').status,'queued');assert.equal(c.snapshot().tasks.find(t=>t.id==='dependency').status,'queued');
  assert.equal(budget.snapshot().spentRappen,0);
 }finally{await c.close();budget.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('real controller passes verified prerequisite results to the targeted adapter and settles only zero-cost work',async()=>{
 const calls=[],f=fixture(transport(calls)),budget=openFounderBudget(path.join(f.dir,'budget.db'));budget.activate({startAt:Date.now()-1000,authorizationRef:'isolated-test'});
 const c=openFounderController({file:path.join(f.dir,'controller.db'),budget,adapters:{research:f.a,prior:{maxCostRappen:0,execute:async()=>({sources:[source]}),verify:r=>r.sources.length===1}}});
 try{
  c.enqueue({id:'prior',rootTaskId:'root',kind:'prior',input:{},dependencies:[],resources:[]});c.enqueue(task);
  await c.tick();assert.equal(calls.length,0);c.control('start');assert.equal(c.snapshot().tasks.find(t=>t.id===task.id).waitState.code,'dependency');
  await c.tick();assert.equal(c.snapshot().tasks.find(t=>t.id===task.id).waitState.code,'worker');await c.tick();
  assert.equal(c.snapshot().tasks.find(t=>t.id===task.id).status,'done');assert.equal(c.result(task.id).target,repo);assert.equal(budget.snapshot().heldRappen,0);assert.equal(budget.snapshot().spentRappen,0);
 }finally{await c.close();budget.close();f.close();}
});

test('failed prerequisites become an explicit blocked state before a moving targeted review gate',async()=>{
 const calls=[],f=fixture(transport(calls)),budget=openFounderBudget(path.join(f.dir,'budget.db'));budget.activate({startAt:Date.now()-1000,authorizationRef:'isolated-test'});
 const c=openFounderController({file:path.join(f.dir,'controller.db'),budget,adapters:{research:f.a,prior:{maxCostRappen:0,execute:async()=>{throw Error('Fixture failed prerequisite');},verify:()=>false}}});
 try{c.enqueue({id:'prior',rootTaskId:'root',kind:'prior',input:{},dependencies:[],resources:[]});c.enqueue(task);c.control('start');await c.tick();await c.tick();const t=c.snapshot().tasks.find(t=>t.id===task.id);assert.equal(t.status,'blocked');assert.match(t.reason,/Voraussetzung/);assert.equal(calls.length,0);}finally{await c.close();budget.close();f.close();}
});
